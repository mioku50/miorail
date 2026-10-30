import { hashApprovedCallsV1, stableHashV1 } from '@mioagent/route-domain';
import { buildMorphoRepayPlanV1 } from '@mioagent/rwa-issuer/morphoRepayPlan';
import { morphoRepayProjectionV1, type MorphoRepayAmountV1 } from '@mioagent/rwa-issuer/morphoRepayMath';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import type { SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import { readRepayStandingV1, STILL_REPAY_BLUE_BUNDLES_V1 } from './stillRepayStanding.js';
import { buildMorphoRepayProbesV1, verifyMorphoRepayPoststateV1 } from './morphoRepayPoststate.js';
import { buildSimulationChainV1, runSimulationChainV1, type SimulationChainV1 } from './swapSimulation.js';
import { lendingSigningTermsFactsV1, type LendingRunV1, type LendingFactsV1 } from './lendingReview.js';

export interface MorphoRepayRequestV1 {
  collateralTokenAddress: string;
  marketId: string;
  walletAddress: string;
  amount: MorphoRepayAmountV1;
  maximumAssets: bigint;
}
export interface MorphoRepayRunDepsV1 {
  read?: typeof readRepayStandingV1;
  chain?: SimulationChainV1;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}
const fail = (refusal: string, detail: string): LendingRunV1 => ({ state: 'refused', refusal, detail });

/** A canonical repayment has no dependency on the oracle, Still's new-loan
 * ceiling, market liquidity or an API's optional post-repay health buffer.
 * Verified protocol bytes enforce the maximum debit even with old allowances.
 * The very same simulation must then prove debt reduction and preserved assets.
 * This prepares unsigned calls only; it never signs or broadcasts. */
export async function runMorphoRepayV1(request: MorphoRepayRequestV1, deps: MorphoRepayRunDepsV1 = {}): Promise<LendingRunV1> {
  const now = deps.now ?? (() => new Date());
  const reading = await (deps.read ?? readRepayStandingV1)({
    collateralTokenAddress: request.collateralTokenAddress, marketId: request.marketId, walletAddress: request.walletAddress,
  });
  if (reading.state === 'refused') return fail(reading.refusal, reading.detail);
  const s = reading.standing;
  if (s.walletAddress.toLowerCase() !== request.walletAddress.toLowerCase() || s.marketId !== request.marketId.toLowerCase() ||
    s.collateral.address.toLowerCase() !== request.collateralTokenAddress.toLowerCase()) return fail('repay_question_mismatch', 'The measured owner or market differs from this repayment question.');
  const amount = request.amount;
  const encodedMaximum = amount.mode === 'assets' ? amount.assets : request.maximumAssets;
  const projected = morphoRepayProjectionV1({ totals: { ...s.storedTotals, ...s.accruedTotals }, position: s.position,
    amount, maximumAssets: request.maximumAssets });
  if (!projected.ok) return fail(projected.refusal, projected.refusal === 'nothing_to_repay'
    ? 'No debt shares were recorded in this market at the reading block.' : 'The exact repayment and maximum USDC budget could not be established.');
  if (s.walletLoanAssets < encodedMaximum) return fail('repay_usdc_insufficient', 'Your USDC balance is below the maximum this repayment must fund before any refund.');
  const planned = buildMorphoRepayPlanV1({ marketId: s.marketId, walletAddress: s.walletAddress, marketParams: s.params,
    amount, maximumAssets: request.maximumAssets, runtimeCodeHash: s.blueBundlesRuntimeHash, now: now() });
  if (!planned.ok) return fail(planned.refusal, planned.detail ?? 'The canonical repayment calls were refused.');
  const plan = planned.plan;
  if (plan.encodedMaximumAssets !== encodedMaximum) return fail('repay_plan_maximum_mismatch', 'The calldata maximum changed from the exact repayment budget.');
  const probes = buildMorphoRepayProbesV1({ marketId: s.marketId, walletAddress: s.walletAddress,
    loanTokenAddress: s.loan.address, collateralTokenAddress: s.collateral.address });
  if (!probes.ok) return fail(probes.refusal, probes.detail);
  const callsHash = hashApprovedCallsV1(plan.calls);
  const simulationRequest: SimulationProviderRequestV1 = {
    chainId: 8453, walletAddress: s.walletAddress,
    blueprintHash: stableHashV1('morpho-repay-request/v1', { wallet: s.walletAddress, marketId: s.marketId,
      mode: amount.mode, assets: amount.mode === 'assets' ? amount.assets.toString() : null, maximumAssets: request.maximumAssets.toString() }),
    callsHash, calls: plan.calls, observations: probes.observations,
  };
  const answer = await runSimulationChainV1({ chain: deps.chain ?? buildSimulationChainV1(deps.env ?? process.env),
    request: simulationRequest, nowIso: now().toISOString(), label: 'Repayment simulation', logContext: { marketId: s.marketId, callsHash } });
  if (!answer.ok) return fail(answer.errorCode, 'The exact repayment could not be simulated. No executable review is available.');
  if (answer.response.status !== 'success') return fail('repay_simulation_reverted', 'The repayment reverted in simulation. No executable review is available.');
  const changes = answer.response.assetChanges;
  if (!changes || changes.status !== 'available') return fail('repay_effects_unread', 'The simulation did not establish all wallet asset movements.');
  let debit = 0n, grossDebit = 0n;
  for (const change of changes.changes) {
    if (!/^(0|[1-9][0-9]{0,77})$/.test(change.amountAtomic)) return fail('repay_effects_unread', 'A wallet asset movement could not be read exactly.');
    const atoms = BigInt(change.amountAtomic);
    if (atoms === 0n) continue;
    if (change.token.toLowerCase() !== ADDRESSES.usdc.toLowerCase()) return fail('repay_unrequested_asset_change', 'An asset other than USDC moved in this repayment.');
    if (change.counterparty?.toLowerCase() !== STILL_REPAY_BLUE_BUNDLES_V1 || change.kind !== 'erc20_transfer') return fail('repay_transfer_counterparty_mismatch', 'The USDC funding or refund did not come from the reviewed repayment contract.');
    if (change.direction === 'out') { debit += atoms; grossDebit += atoms; }
    else if (change.direction === 'in') debit -= atoms;
    else return fail('repay_effects_unread', 'The direction of a wallet movement could not be read.');
  }
  if (debit <= 0n || debit > encodedMaximum || grossDebit !== encodedMaximum) return fail('repay_maximum_mismatch', 'The measured USDC funding and refund do not match the calldata maximum.');
  const measured = verifyMorphoRepayPoststateV1({ request: simulationRequest, response: answer.response,
    expected: { marketId: s.marketId, loanTokenAddress: s.loan.address, collateralTokenAddress: s.collateral.address,
      amount, maximumAssets: encodedMaximum, position: s.position, blockNumber: Number(s.block.number) } });
  if (!measured.ok) return fail(measured.refusal, measured.detail);
  if (measured.repaidAssets !== debit) return fail('repay_effects_mismatch', 'USDC movements and the independently measured debt reduction disagree.');
  const facts: LendingFactsV1 = { operation: 'repay', venue: 'morpho', collateralTokenAddress: s.collateral.address,
    collateralSymbol: s.collateral.symbol, collateralDecimals: s.collateral.decimals, marketId: s.marketId,
    amountMode: amount.mode, requestedAssets: amount.mode === 'assets' ? amount.assets.toString() : null,
    maximumDebitAssets: encodedMaximum.toString(), collateralSupplyAssets: '0',
    debtBeforeAssets: measured.before.debtAssets.toString(), debtAfterAssets: measured.after.debtAssets.toString(),
    collateralBeforeAssets: measured.before.position.collateral.toString(), collateralAfterAssets: measured.after.position.collateral.toString(),
    debtBeforeShares: measured.before.position.borrowShares.toString(), debtAfterShares: measured.after.position.borrowShares.toString(),
    blockNumber: answer.response.blockNumber,
    warnings: ['Collateral stays deposited. This repayment does not withdraw it.',
      'The maximum USDC amount is funded before the unused remainder is refunded in the same atomic batch.',
      'Calls are prepared from the verified protocol ABI and independently simulated. No standing authorization is requested.'] };
  const signingTermsHash = stableHashV1('still-repay-signing-terms/v1', {
    wallet: s.walletAddress,
    callsHash,
    facts: lendingSigningTermsFactsV1(facts),
  });
  const expiry = Math.min(now().getTime() + 30_000, Number(plan.deadline) * 1000);
  if (expiry <= now().getTime()) return fail('repay_expired', 'The prepared repayment expired during measurement. Read it again.');
  return { state: 'ready', facts, calls: plan.calls, callsHash, signingTermsHash, expiresAt: new Date(expiry).toISOString(),
    atomicRequired: true, steps: plan.steps.map(row => ({ index: row.index, to: row.to, reading: row.reading })),
    measured: { provider: answer.providerId, blockNumber: answer.response.blockNumber, loanDeltaAssets: (-debit).toString() } };
}
