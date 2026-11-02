import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { hashApprovedCallsV1, stableHashV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import type { SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import { atomicToDecimalStringV1 } from '@mioagent/rwa-issuer';
import { ADDRESSES } from '@mioagent/still-engine/registry';

import type { LendingPaymentV1 } from './lendingDraft.js';
import type { LendingFactsV1, LendingRunV1 } from './lendingReview.js';
import { STILL_SPEND_REVIEW_MARGIN_MS_V1 } from './stillSpendOrders.js';
import { buildSimulationChainV1, runSimulationChainV1, type SimulationChainV1 } from './swapSimulation.js';

// ---------------------------------------------------------------------------
// Still Spend, stage 3: the loan's USDC pays a Bitrefill invoice in the same
// batch.
//
// The loan is prepared and proven exactly as on Get money, by its own runner
// and its own simulation; nothing here touches that. This adds one call after
// it, a USDC transfer of the invoice's exact amount to the invoice's address,
// and executes the whole batch once more against current state. The batch is
// ready only if, in that one execution, the loan's USDC arrived, the chosen
// collateral left and nothing else moved but the payment itself. The approved
// calls and the signing terms are hashed again over both.
//
// The address and the amount come from the signed lending question, which the
// server wrote from Bitrefill's own answer; never from the browser.
//
// For a wallet that cannot send a batch (Rabby; Coinbase Wallet with an
// imported key) the same calls go as steps, the payment last; the whole
// sequence is still executed once here, as the wallet will send it, and the
// server checks the invoice again before the wallet is asked for the payment.
// ---------------------------------------------------------------------------

export interface SpendPaymentDepsV1 {
  chain?: SimulationChainV1;
  env?: NodeJS.ProcessEnv;
}

const lower = (value: string) => value.toLowerCase();

export function spendPayeeRefusedV1(payTo: string, wallet: string, facts: LendingFactsV1, calls: readonly ExecutionCallV1[]): boolean {
  const known = [wallet, ADDRESSES.usdc, ADDRESSES.aaveHub, ADDRESSES.aaveSpoke, ADDRESSES.morpho, ADDRESSES.weth, facts.collateralTokenAddress,
    '0x0000000000000000000000000000000000000000'].map(lower);
  return !/^0x[0-9a-f]{40}$/.test(payTo) || known.includes(payTo) || calls.some((call) => lower(call.to) === payTo);
}

export async function attachSpendPaymentV1(
  input: { walletAddress: string; run: LendingRunV1; payment: LendingPaymentV1; now: Date },
  deps: SpendPaymentDepsV1 = {},
): Promise<LendingRunV1> {
  const { run, payment, now } = input;
  if (run.state !== 'ready') return run;
  const facts = run.facts, wallet = lower(input.walletAddress), payTo = lower(payment.payTo), assets = BigInt(payment.assets);
  const fail = (refusal: string, detail: string): LendingRunV1 => ({ state: 'refused', refusal, detail, facts });
  if (facts.operation !== 'borrow' || facts.nativeFunding || facts.requestedAssets !== payment.assets || assets <= 0n) {
    return fail('spend_payment_question_mismatch', 'The loan measured is not the exact amount of this Bitrefill invoice. Nothing can be signed.');
  }
  if (spendPayeeRefusedV1(payTo, wallet, facts, run.calls)) {
    return fail('spend_payee_refused', 'Bitrefill’s invoice address is not one Still can pay. Nothing can be signed.');
  }
  if (!(Date.parse(payment.expiresAt) - now.getTime() >= STILL_SPEND_REVIEW_MARGIN_MS_V1)) {
    return fail('spend_invoice_expiring', 'Bitrefill holds this price for less than two more minutes. Open a new invoice from Spend.');
  }

  const transfer: ExecutionCallV1 = {
    index: run.calls.length, callType: 'transfer', to: lower(ADDRESSES.usdc) as Address, valueWei: '0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [payTo as Address, assets] }),
    asset: null, amountAtomic: payment.assets, recipient: payTo as Address, spender: null,
  };
  const calls = [...run.calls, transfer];
  const callsHash = hashApprovedCallsV1(calls);
  const request: SimulationProviderRequestV1 = {
    chainId: 8453, walletAddress: wallet,
    blueprintHash: stableHashV1('still-spend-payment/v1', { wallet, loanCallsHash: run.callsHash, payment }),
    callsHash, calls,
    // The loan's own figures (its position, Still's limit, the Spoke's code) were proved at its simulated
    // block, so the loan and the payment are run on that same state, not on a newer one.
    baseBlockNumber: run.measured.blockNumber - 1,
  };
  const answer = await runSimulationChainV1({
    chain: deps.chain ?? buildSimulationChainV1(deps.env ?? process.env), request, nowIso: now.toISOString(),
    label: 'Still Spend payment simulation', logContext: { callsHash },
  });
  if (!answer.ok) return fail(answer.errorCode, 'The loan and the payment could not be executed together in simulation. Nothing can be signed.');
  if (answer.response.blockNumber !== run.measured.blockNumber) {
    return fail('spend_simulation_moved', 'The loan and the payment could not be checked on the same Base state as the loan’s own figures. Nothing can be signed; open the review again.');
  }
  if (answer.response.status !== 'success') return fail('spend_simulation_reverted', 'The loan and the payment reverted together in simulation. Nothing can be signed.');
  const changes = answer.response.assetChanges;
  if (!changes || changes.status !== 'available') return fail('spend_effects_unread', 'The simulation did not establish every movement of the loan and the payment.');

  const usdc = lower(ADDRESSES.usdc), collateral = lower(facts.collateralTokenAddress);
  let arrived = 0n, paid = 0n, pledged = 0n;
  for (const change of changes.changes) {
    if (!/^(0|[1-9][0-9]{0,77})$/.test(change.amountAtomic)) return fail('spend_effects_unread', 'A wallet movement could not be read exactly.');
    const amount = BigInt(change.amountAtomic);
    if (amount === 0n) continue;
    const token = lower(change.token), counterparty = change.counterparty === null ? null : lower(change.counterparty);
    const fromPayment = change.callIndex === transfer.index;
    if (change.kind !== 'erc20_transfer') return fail('spend_unrequested_asset_change', 'Something other than a token transfer moved in this batch.');
    if (token === usdc && change.direction === 'out' && fromPayment && counterparty === payTo) paid += amount;
    else if (token === usdc && change.direction === 'in' && !fromPayment && counterparty !== null && counterparty !== payTo) arrived += amount;
    else if (token === collateral && change.direction === 'out' && !fromPayment) pledged += amount;
    else return fail('spend_unrequested_asset_change', 'An asset moved outside the loan and the payment you chose.');
  }
  if (paid !== assets || arrived !== assets || pledged !== BigInt(facts.collateralSupplyAssets)) {
    return fail('spend_effects_mismatch', 'The simulated loan and payment do not match the invoice and the loan you chose.');
  }

  const usdcText = `${atomicToDecimalStringV1(assets, 6)} USDC`;
  const short = `${payTo.slice(0, 6)}…${payTo.slice(-4)}`;
  // A face value says its currency: a top-up of "10" is 10 INR.
  const packageText = payment.faceCurrency && /^\d+(?:\.\d+)?$/.test(payment.packageValue) ? `${payment.packageValue} ${payment.faceCurrency}` : payment.packageValue;
  const sequential = run.atomicRequired === false;
  const paying: LendingFactsV1 = {
    ...facts,
    payment,
    warnings: [
      ...facts.warnings,
      sequential
        ? `The last step then pays ${usdcText} to Bitrefill’s invoice address ${short} for ${payment.productName} · ${packageText}. Still reads the invoice again before your wallet is asked for it; if Bitrefill no longer waits for this payment, it is not sent and the loan stays yours to repay. A payment sent cannot be taken back by Still; if Bitrefill cannot deliver, its support handles the refund.`
        : `The same transaction then pays ${usdcText} to Bitrefill’s invoice address ${short} for ${payment.productName} · ${packageText}. A payment sent cannot be taken back by Still; if Bitrefill cannot deliver, its support handles the refund.`,
    ],
  };
  const signingTermsHash = stableHashV1('still-spend-signing-terms/v1', { wallet, callsHash, loanSigningTermsHash: run.signingTermsHash, payment });
  const expiresAt = Math.min(Date.parse(run.expiresAt), Date.parse(payment.expiresAt) - STILL_SPEND_REVIEW_MARGIN_MS_V1);
  return {
    state: 'ready', facts: paying, calls, callsHash, signingTermsHash, expiresAt: new Date(expiresAt).toISOString(),
    ...(sequential ? { atomicRequired: false as const, delivery: 'sequential' as const } : { atomicRequired: true as const }),
    steps: [...run.steps, { index: transfer.index, to: transfer.to, reading: `Pay Bitrefill: send ${usdcText} to the invoice address ${short}` }],
    measured: run.measured,
  };
}
