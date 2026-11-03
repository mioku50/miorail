import { decodeEventLog, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { hashApprovedCallsV1, stableHashV1, type ExecutionCallV1, type HashV1 } from '@mioagent/route-domain';
import type { SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import type { VerifiedReceiptLogV1, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { atomicToDecimalStringV1 } from '@mioagent/rwa-issuer';
import { ADDRESSES } from '@mioagent/still-engine/registry';

import type { BaseChainReaderV1, BaseTransactionSourceV1 } from './baseReceiptReader.js';
import type { LendingPaymentV1 } from './lendingDraft.js';
import { bindLoanTransactionV1, receiptFingerprintV1, type LoanTransactionBindingV1 } from './loanExecutionStatus.js';
import type { LoanOwnerV1 } from './loanExecutionStore.js';
import { readStockHoldingV1 } from './stockTokenRead.js';
import { STILL_SPEND_CAP_ATOMIC_V1, STILL_SPEND_REVIEW_MARGIN_MS_V1 } from './stillSpendOrders.js';
import { spendPayeeRefusedV1 } from './stillSpendPayment.js';
import type { SpendWalletPaymentV1, SpendWalletStoreV1 } from './stillSpendWalletStore.js';
import { buildSimulationChainV1, runSimulationChainV1, type SimulationChainV1 } from './swapSimulation.js';

// ---------------------------------------------------------------------------
// Still Spend: a Bitrefill invoice paid from the USDC already in the wallet.
//
// The operator asked on 2026-11-03 why Spend offered $0.20 while their wallet
// held the 2 USDC a loan had just paid out: Spend paid only with a new loan.
// This pays an invoice with one call and no loan, a USDC transfer of the
// invoice's exact amount to the invoice's address, read from Bitrefill's own
// answer by the server and never from the browser.
//
// The review reads the wallet's USDC at one block and executes the transfer on
// that same state. It is ready only if exactly the invoice amount leaves the
// wallet, to exactly the invoice address, and nothing else moves. The result
// is read from the chain: the approved call in the transaction, and its USDC
// Transfer to the invoice.
// ---------------------------------------------------------------------------

export interface SpendWalletFactsV1 {
  payment: LendingPaymentV1;
  /** The wallet's USDC at `blockNumber`, before and after this payment. */
  usdcBeforeAtomic: string;
  usdcAfterAtomic: string;
  blockNumber: number;
  warnings: string[];
}
export interface SpendWalletReadyV1 {
  state: 'ready';
  facts: SpendWalletFactsV1;
  calls: ExecutionCallV1[];
  callsHash: HashV1;
  signingTermsHash: HashV1;
  expiresAt: string;
  steps: Array<{ index: number; to: string; reading: string }>;
}
export type SpendWalletRunV1 = SpendWalletReadyV1 | { state: 'refused'; refusal: string; detail: string };

export interface SpendWalletDepsV1 {
  /** The wallet's USDC at one block; null when it was not read. Never a zero for a failed read. */
  readUsdc?: (wallet: string) => Promise<{ balanceAtomic: string; blockNumber: string } | null>;
  chain?: SimulationChainV1;
  env?: NodeJS.ProcessEnv;
}

const lower = (value: string) => value.toLowerCase();
const usdcText = (atomic: bigint) => `${atomicToDecimalStringV1(atomic, 6)} USDC`;

async function readWalletUsdcV1(wallet: string): Promise<{ balanceAtomic: string; blockNumber: string } | null> {
  const held = await readStockHoldingV1(ADDRESSES.usdc, wallet);
  return held.ok && held.decimals === 6 ? { balanceAtomic: held.balanceAtomic, blockNumber: held.blockNumber } : null;
}

export async function prepareSpendWalletPaymentV1(
  input: { walletAddress: string; payment: LendingPaymentV1; now: Date },
  deps: SpendWalletDepsV1 = {},
): Promise<SpendWalletRunV1> {
  const { payment, now } = input;
  const wallet = lower(input.walletAddress), payTo = lower(payment.payTo);
  const fail = (refusal: string, detail: string): SpendWalletRunV1 => ({ state: 'refused', refusal, detail });
  if (!/^[1-9][0-9]{0,11}$/.test(payment.assets) || BigInt(payment.assets) > STILL_SPEND_CAP_ATOMIC_V1) {
    return fail('spend_payment_question_mismatch', 'This invoice’s amount is not one Still can pay. Nothing can be signed.');
  }
  const assets = BigInt(payment.assets);
  if (spendPayeeRefusedV1(payTo, wallet, null, [])) return fail('spend_payee_refused', 'Bitrefill’s invoice address is not one Still can pay. Nothing can be signed.');
  if (!(Date.parse(payment.expiresAt) - now.getTime() >= STILL_SPEND_REVIEW_MARGIN_MS_V1)) {
    return fail('spend_invoice_expiring', 'Bitrefill holds this price for less than two more minutes. Open a new invoice from Spend.');
  }
  const held = await (deps.readUsdc ?? readWalletUsdcV1)(wallet).catch(() => null);
  if (!held || !/^(0|[1-9][0-9]{0,77})$/.test(held.balanceAtomic) || !/^[1-9][0-9]{0,15}$/.test(held.blockNumber)) {
    return fail('spend_wallet_usdc_unread', 'Your wallet’s USDC could not be read just now, so nothing can be paid from it. Try again in a minute.');
  }
  const before = BigInt(held.balanceAtomic), block = Number(held.blockNumber);
  if (before < assets) {
    return fail('spend_wallet_usdc_short', `Your wallet holds ${usdcText(before)} and this invoice is ${usdcText(assets)}. Nothing can be paid from it; a loan from Still can pay it instead.`);
  }

  const transfer: ExecutionCallV1 = {
    index: 0, callType: 'transfer', to: lower(ADDRESSES.usdc) as Address, valueWei: '0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [payTo as Address, assets] }),
    asset: null, amountAtomic: payment.assets, recipient: payTo as Address, spender: null,
  };
  const calls = [transfer];
  const callsHash = hashApprovedCallsV1(calls);
  const request: SimulationProviderRequestV1 = {
    chainId: 8453, walletAddress: wallet,
    blueprintHash: stableHashV1('still-spend-wallet-payment/v1', { wallet, payment }),
    callsHash, calls,
    // The balance shown was read at this block, so the payment is run on that same state.
    baseBlockNumber: block,
  };
  const answer = await runSimulationChainV1({
    chain: deps.chain ?? buildSimulationChainV1(deps.env ?? process.env), request, nowIso: now.toISOString(),
    label: 'Still Spend wallet payment simulation', logContext: { callsHash },
  });
  if (!answer.ok) return fail(answer.errorCode, 'The payment could not be executed in simulation. Nothing can be signed.');
  if (answer.response.blockNumber !== block + 1) {
    return fail('spend_simulation_moved', 'The payment could not be checked on the same Base state as your wallet’s balance. Nothing can be signed; open the review again.');
  }
  if (answer.response.status !== 'success') return fail('spend_simulation_reverted', 'The payment reverted in simulation. Nothing can be signed.');
  const changes = answer.response.assetChanges;
  if (!changes || changes.status !== 'available') return fail('spend_effects_unread', 'The simulation did not establish every movement of the payment.');
  const usdc = lower(ADDRESSES.usdc);
  let paid = 0n;
  for (const change of changes.changes) {
    if (!/^(0|[1-9][0-9]{0,77})$/.test(change.amountAtomic)) return fail('spend_effects_unread', 'A wallet movement could not be read exactly.');
    const amount = BigInt(change.amountAtomic);
    if (amount === 0n) continue;
    const counterparty = change.counterparty === null ? null : lower(change.counterparty);
    if (change.kind === 'erc20_transfer' && lower(change.token) === usdc && change.direction === 'out' && change.callIndex === 0 && counterparty === payTo) paid += amount;
    else return fail('spend_unrequested_asset_change', 'Something other than this payment moved in simulation. Nothing can be signed.');
  }
  if (paid !== assets) return fail('spend_effects_mismatch', 'The simulated payment does not match the invoice.');

  const short = `${payTo.slice(0, 6)}…${payTo.slice(-4)}`;
  // A face value says its currency: a top-up of "10" is 10 INR.
  const packageText = payment.faceCurrency && /^\d+(?:\.\d+)?$/.test(payment.packageValue) ? `${payment.packageValue} ${payment.faceCurrency}` : payment.packageValue;
  const facts: SpendWalletFactsV1 = {
    payment, usdcBeforeAtomic: before.toString(), usdcAfterAtomic: (before - assets).toString(), blockNumber: block,
    warnings: [`Your wallet sends ${usdcText(assets)} of its own to Bitrefill’s invoice address ${short} for ${payment.productName} · ${packageText}. No loan is taken. A payment sent cannot be taken back by Still; if Bitrefill cannot deliver, its support handles the refund.`],
  };
  // What the person agrees to: this wallet pays this invoice, this amount, with this call.
  const signingTermsHash = stableHashV1('still-spend-wallet-signing-terms/v1', { wallet, callsHash, payment });
  const expiresAt = Math.min(now.getTime() + 120_000, Date.parse(payment.expiresAt) - STILL_SPEND_REVIEW_MARGIN_MS_V1);
  return {
    state: 'ready', facts, calls, callsHash, signingTermsHash, expiresAt: new Date(expiresAt).toISOString(),
    steps: [{ index: 0, to: transfer.to, reading: `Pay Bitrefill: send ${usdcText(assets)} to the invoice address ${short}` }],
  };
}

const transferEventAbi = erc20Abi.filter((item) => item.type === 'event' && item.name === 'Transfer');

/** The payment's own logs carry exactly one USDC Transfer to the invoice address: from this wallet, of the invoice amount. */
export function spendWalletTransferMatchedV1(payment: SpendWalletPaymentV1, logs: readonly VerifiedReceiptLogV1[]): boolean {
  const wallet = lower(payment.walletAddress), invoice = payment.run.facts.payment, payTo = lower(invoice.payTo), usdc = lower(ADDRESSES.usdc);
  const toInvoice = logs.flatMap((log) => {
    try {
      const event = decodeEventLog({ abi: transferEventAbi, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
      const args = event.args as { from: string; to: string; value: bigint };
      return lower(args.to) === payTo ? [{ token: lower(log.address), from: lower(args.from), value: args.value }] : [];
    } catch { return []; }
  });
  return toInvoice.length === 1 && toInvoice[0]!.token === usdc && toInvoice[0]!.from === wallet && toInvoice[0]!.value === BigInt(invoice.assets);
}

export interface SpendWalletStatusDepsV1 {
  store: SpendWalletStoreV1;
  reader: BaseChainReaderV1;
  readBatchHashes: (batchId: string) => Promise<HashV1[] | null>;
  now: () => Date;
}

/** Reads a payment's result from the chain and records it. Read-only with respect to wallets and the chain: neither a
 * wallet's status nor anything the browser says can make it confirmed, only the approved call in a receipt and its transfer. */
export async function refreshSpendWalletPaymentV1(input: { owner: LoanOwnerV1; orderId: string }, deps: SpendWalletStatusDepsV1): Promise<SpendWalletPaymentV1 | null> {
  const record = await deps.store.get(input);
  if (!record || record.state === 'ready' || record.errorCode === 'conflicting_wallet_answers') return record;
  if (record.state === 'awaiting_wallet' && !record.batchId && !record.transactionHash) return record;
  const set = async (state: 'confirmed' | 'failed' | 'unknown', transactionHash: HashV1 | null, proof: Record<string, unknown> | null, errorCode: string | null) => {
    const next = await deps.store.recordVerification({ ...input, expectedVersion: record.version, state, transactionHash, proof, errorCode, now: deps.now() });
    // A conflicting concurrent update must never cause a stale confirmed view.
    return next ?? { ...record, state: 'unknown' as const, errorCode: 'spend_wallet_changed_while_reading' };
  };
  const hints = record.transactionHash ? [record.transactionHash] : record.batchId ? await deps.readBatchHashes(record.batchId).catch(() => null) : null;
  if (!hints?.length || hints.length > 16 || hints.some((value) => !/^0x[0-9a-f]{64}$/.test(value))) {
    return record.state === 'confirmed' || record.state === 'failed' ? set('unknown', record.transactionHash, null, 'spend_wallet_receipt_unavailable') : record;
  }
  const candidates: Array<{ hash: HashV1; receipt: VerifiedReceiptSourceV1; transaction: BaseTransactionSourceV1; binding: Exclude<LoanTransactionBindingV1, { state: 'unknown' }> }> = [];
  for (const hash of [...new Set(hints)]) {
    let receipt: VerifiedReceiptSourceV1 | null, transaction: BaseTransactionSourceV1 | null;
    try { [receipt, transaction] = await Promise.all([deps.reader.getTransactionReceipt(hash), deps.reader.getTransaction(hash)]); }
    catch { continue; }
    if (!receipt || !transaction || receipt.transactionHash.toLowerCase() !== hash) continue;
    if (record.transactionHash === hash && record.verification?.receiptFingerprint && record.verification.receiptFingerprint !== receiptFingerprintV1(receipt)) {
      return set('unknown', hash, null, 'spend_wallet_receipt_changed');
    }
    const binding = bindLoanTransactionV1({ execution: record, receipt, transaction });
    if (binding.state !== 'unknown') candidates.push({ hash, receipt, transaction, binding });
  }
  if (candidates.length !== 1) {
    return set('unknown', record.transactionHash, null, candidates.length > 1 ? 'spend_wallet_multiple_matching_transactions' : 'spend_wallet_receipt_not_matched');
  }
  const candidate = candidates[0]!;
  const proof = { receiptFingerprint: receiptFingerprintV1(candidate.receipt), blockNumber: candidate.receipt.blockNumber.toString(), callsHash: record.run.callsHash };
  if (candidate.binding.state === 'failed') return set('failed', candidate.hash, proof, candidate.binding.errorCode);
  if (candidate.receipt.blockNumber < BigInt(record.run.facts.blockNumber)) return set('unknown', candidate.hash, null, 'spend_wallet_receipt_predates_review');
  if (!spendWalletTransferMatchedV1(record, candidate.binding.logs)) return set('unknown', candidate.hash, null, 'spend_wallet_transfer_mismatch');
  const invoice = record.run.facts.payment;
  return set('confirmed', candidate.hash, { ...proof, operationNonce: candidate.binding.operationNonce,
    payment: { merchant: invoice.merchant, orderId: invoice.orderId, payTo: invoice.payTo, assets: invoice.assets } }, null);
}

/** What the owner's page sees of a payment. Calls only while it can still be armed. */
export function spendWalletWireV1(record: SpendWalletPaymentV1): Record<string, unknown> {
  const run = record.run;
  return {
    orderId: record.orderId, state: record.state, attemptId: record.attemptId, batchId: record.batchId, transactionHash: record.transactionHash,
    errorCode: record.errorCode, updatedAt: record.updatedAt, facts: run.facts,
    ...(record.state === 'ready'
      ? { calls: run.calls.map((call) => ({ to: call.to, value: call.valueWei, data: call.data })), callsHash: run.callsHash, signingTermsHash: run.signingTermsHash,
          expiresAt: run.expiresAt, steps: run.steps }
      : {}),
  };
}

const invoiceLocks = new Map<string, Promise<void>>();
/** One invoice is paid once, by a loan or by the wallet's own USDC. Arming either
 * reads the other kind first; this runs those reads and the arm one at a time per
 * invoice. Spend's invoices live in this process (spendOrderStoreV1: a restart
 * forgets them and nothing can pay one then), so its lock is this process's. */
export async function withSpendInvoiceLockV1<T>(orderId: string, work: () => Promise<T>): Promise<T> {
  const key = orderId.toLowerCase();
  const before = invoiceLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const mine = before.then(() => held);
  invoiceLocks.set(key, mine);
  await before;
  try {
    return await work();
  } finally {
    release();
    if (invoiceLocks.get(key) === mine) invoiceLocks.delete(key);
  }
}
