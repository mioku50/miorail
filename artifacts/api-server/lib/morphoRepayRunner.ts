import { hashApprovedCallsV1, stableHashV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import { MORPHO_BLUE_BASE_V1 } from '@mioagent/rwa-issuer/morphoRepayPlan';
import { morphoDirectRepayPlanV1 } from '@mioagent/rwa-issuer/morphoDirectPlan';
import { toAssetsUpV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { morphoRepayProjectionV1, type MorphoRepayAmountV1 } from '@mioagent/rwa-issuer/morphoRepayMath';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import { repayAllBoundAtomicV1, repayAllMinimumAtomicV1 } from '@mioagent/still-engine/repay';
import type { SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import { readRepayStandingV1 } from './stillRepayStanding.js';
import { MORPHO_DIRECT_CALLS_WARNING_V1, morphoStepsWarningV1 } from './morphoDirectWords.js';
import { buildMorphoRepayProbesV1, verifyMorphoRepayPoststateV1 } from './morphoRepayPoststate.js';
import { buildSimulationChainV1, runSimulationChainV1, type SimulationChainV1 } from './swapSimulation.js';
import { lendingSigningTermsFactsV1, type LendingRunV1, type LendingFactsV1 } from './lendingReview.js';
import { repayExactOverDebtWordsV1, repayExactRoundsToZeroWordsV1, repayMaximumBelowDebtWordsV1, repayWalletBelowMaximumWordsV1 } from './repayWords.js';
import { morphoCollateralHoldOfV1, morphoCollateralHoldWordsV1 } from './morphoCollateralHold.js';

export interface MorphoRepayRequestV1 {
  collateralTokenAddress: string;
  marketId: string;
  walletAddress: string;
  amount: MorphoRepayAmountV1;
  maximumAssets: bigint;
  /** Repay all, then take the whole collateral back to the wallet; with no debt left, only that. */
  returnCollateral?: boolean;
  /** One batch (the default), or one transaction per call for a wallet that cannot send a batch. */
  delivery?: 'atomic' | 'sequential';
  /** A repayment in steps, reviewed again: read at a block no earlier than the step that just landed. */
  atLeastBlock?: bigint;
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
 * It is the wallet's own calls to Morpho Blue (2026-11-07): an allowance set to
 * exactly the cap bounds what Morpho Blue may take, and nothing is refunded
 * because nothing beyond the debt is taken. The very same simulation must then
 * prove debt reduction and preserved assets. This prepares unsigned calls only;
 * it never signs or broadcasts. */
export async function runMorphoRepayV1(request: MorphoRepayRequestV1, deps: MorphoRepayRunDepsV1 = {}): Promise<LendingRunV1> {
  const now = deps.now ?? (() => new Date());
  const sequential = request.delivery === 'sequential';
  const reading = await (deps.read ?? readRepayStandingV1)({
    collateralTokenAddress: request.collateralTokenAddress, marketId: request.marketId, walletAddress: request.walletAddress,
    ...(request.atLeastBlock !== undefined ? { atLeastBlock: request.atLeastBlock } : {}),
  });
  if (reading.state === 'refused') return fail(reading.refusal, reading.detail);
  const s = reading.standing;
  if (s.walletAddress.toLowerCase() !== request.walletAddress.toLowerCase() || s.marketId !== request.marketId.toLowerCase() ||
    s.collateral.address.toLowerCase() !== request.collateralTokenAddress.toLowerCase()) return fail('repay_question_mismatch', 'The measured owner or market differs from this repayment question.');
  const amount = request.amount, returning = request.returnCollateral === true;
  if (returning && amount.mode !== 'all') return fail('repay_amount_invalid', 'The collateral comes back with a full repayment only.');
  if (returning && s.position.collateral === 0n) return fail('nothing_to_return', `No ${s.collateral.symbol} is deposited in this Morpho market at the reading block, so there is nothing to take back.`);
  // Taking the collateral back repays first while any debt is left; with none, it only withdraws.
  const repaying = !returning || s.position.borrowShares > 0n;
  // The collateral comes back out of Morpho Blue, and cannot while its transfers are paused or its issuer has
  // blocked Morpho Blue or this wallet: the review said only "The repayment reverted", and nothing of the
  // repayment that still works (audit LM-2, 2026-11-14). A plain repayment moves only USDC and goes ahead.
  const hold = morphoCollateralHoldOfV1(s.collateralTransfers);
  if (returning && hold) {
    return fail('repay_collateral_held', morphoCollateralHoldWordsV1({ symbol: s.collateral.symbol, hold, action: 'take_back', blockNumber: s.block.number,
      debtOpen: s.position.borrowShares > 0n }));
  }
  const encodedMaximum = !repaying ? 0n : amount.mode === 'assets' ? amount.assets : request.maximumAssets;
  if (repaying) {
    const totals = { ...s.storedTotals, ...s.accruedTotals };
    const projected = morphoRepayProjectionV1({ totals, position: s.position, amount, maximumAssets: request.maximumAssets });
    // The debt as the contract rounds it against the borrower, for the words only.
    const debt = toAssetsUpV1(s.position.borrowShares, totals.totalBorrowAssets, totals.totalBorrowShares);
    // Repay all repays every share, and the wallet pays what they are worth when the transaction lands. A
    // bound with no room above the debt read let a ready review revert onchain once the debt had grown past
    // it (audit LM-4, 2026-11-14: about 51 atoms in thirty seconds on a debt of 1,025 USDC). So the bound must
    // leave room for the interest until it lands, as on Aave since LA-1, and the page's own bound is named.
    const advised = amount.mode === 'all' ? repayAllBoundAtomicV1(debt) : undefined;
    if (!projected.ok) return fail(projected.refusal, projected.refusal === 'nothing_to_repay'
      ? 'No debt shares were recorded in this market at the reading block.'
      : projected.refusal === 'repay_maximum_exceeded' && amount.mode === 'all'
        ? repayMaximumBelowDebtWordsV1({ debt, maximum: request.maximumAssets, wallet: s.walletLoanAssets, minimum: advised, venue: 'morpho' })
        : projected.refusal === 'repay_exceeds_debt' && amount.mode === 'assets'
          ? repayExactOverDebtWordsV1({ assets: amount.assets, debt, block: s.block.number })
          : projected.refusal === 'repay_rounds_to_zero' && amount.mode === 'assets'
            ? repayExactRoundsToZeroWordsV1({ assets: amount.assets })
            : 'The exact repayment and maximum USDC budget could not be established.');
    if (amount.mode === 'all' && request.maximumAssets < repayAllMinimumAtomicV1(debt)) {
      return fail('repay_maximum_exceeded', repayMaximumBelowDebtWordsV1({ debt, maximum: request.maximumAssets, wallet: s.walletLoanAssets, minimum: advised, venue: 'morpho' }));
    }
    if (s.walletLoanAssets < encodedMaximum) return fail('repay_usdc_insufficient', repayWalletBelowMaximumWordsV1({ debt, maximum: encodedMaximum, wallet: s.walletLoanAssets,
      ...(advised === undefined ? {} : { minimum: advised }) }));
  }
  if (sequential && repaying && typeof s.loanAllowanceToMorphoAssets !== 'bigint') {
    return fail('repay_allowance_unread', 'This wallet’s USDC allowance to Morpho Blue could not be read, and a repayment in steps needs it.');
  }
  const planned = morphoDirectRepayPlanV1({ walletAddress: s.walletAddress, marketId: s.marketId, marketParams: s.params, amount,
    borrowShares: s.position.borrowShares, maximumAssets: encodedMaximum, repaying,
    ...(returning ? { returnCollateralAssets: s.position.collateral } : {}),
    ...(sequential ? { delivery: 'sequential' as const, allowanceAssets: s.loanAllowanceToMorphoAssets ?? 0n } : {}) });
  if (!planned.ok) return fail(planned.refusal, planned.detail);
  // The wallet's own calls carry no deadline: the review's own window bounds them.
  const calls: ExecutionCallV1[] = [...planned.plan.calls];
  const plan = { calls, steps: planned.plan.steps.map(row => ({ index: row.index, to: row.to, reading: row.reading })) };
  const probes = buildMorphoRepayProbesV1({ marketId: s.marketId, walletAddress: s.walletAddress,
    loanTokenAddress: s.loan.address, collateralTokenAddress: s.collateral.address });
  if (!probes.ok) return fail(probes.refusal, probes.detail);
  const callsHash = hashApprovedCallsV1(plan.calls);
  const simulationRequest: SimulationProviderRequestV1 = {
    chainId: 8453, walletAddress: s.walletAddress,
    blueprintHash: stableHashV1('morpho-repay-request/v1', { wallet: s.walletAddress, marketId: s.marketId,
      mode: amount.mode, assets: amount.mode === 'assets' ? amount.assets.toString() : null, maximumAssets: request.maximumAssets.toString(),
      ...(returning ? { returnCollateral: true } : {}) }),
    callsHash, calls: plan.calls, observations: probes.observations,
  };
  const answer = await runSimulationChainV1({ chain: deps.chain ?? buildSimulationChainV1(deps.env ?? process.env),
    request: simulationRequest, nowIso: now().toISOString(), label: 'Repayment simulation', logContext: { marketId: s.marketId, callsHash } });
  if (!answer.ok) return fail(answer.errorCode, 'The exact repayment could not be simulated. No executable review is available.');
  if (answer.response.status !== 'success') return fail('repay_simulation_reverted', 'The repayment reverted in simulation. No executable review is available.');
  const changes = answer.response.assetChanges;
  if (!changes || changes.status !== 'available') return fail('repay_effects_unread', 'The simulation did not establish all wallet asset movements.');
  let debit = 0n, collateralIn = 0n;
  for (const change of changes.changes) {
    if (!/^(0|[1-9][0-9]{0,77})$/.test(change.amountAtomic)) return fail('repay_effects_unread', 'A wallet asset movement could not be read exactly.');
    const atoms = BigInt(change.amountAtomic);
    if (atoms === 0n) continue;
    // The collateral coming back is the one other movement, from Morpho Blue itself, and only when asked for.
    if (returning && change.token.toLowerCase() === s.collateral.address.toLowerCase() && change.direction === 'in' &&
        change.counterparty?.toLowerCase() === MORPHO_BLUE_BASE_V1 && change.kind === 'erc20_transfer') { collateralIn += atoms; continue; }
    if (change.token.toLowerCase() !== ADDRESSES.usdc.toLowerCase()) return fail('repay_unrequested_asset_change', 'An asset other than USDC moved in this repayment.');
    // The wallet pays Morpho Blue itself, exactly what is repaid; nothing comes back.
    if (change.counterparty?.toLowerCase() !== MORPHO_BLUE_BASE_V1 || change.kind !== 'erc20_transfer' || change.direction !== 'out') {
      return fail('repay_transfer_counterparty_mismatch', 'USDC moved other than from this wallet to Morpho Blue.');
    }
    debit += atoms;
  }
  if (repaying ? debit <= 0n || debit > encodedMaximum || (amount.mode === 'assets' && debit !== amount.assets) : debit !== 0n) {
    return fail('repay_maximum_mismatch', 'The measured USDC paid does not match the repayment or its cap.');
  }
  if (collateralIn !== (returning ? s.position.collateral : 0n)) return fail('repay_effects_mismatch', 'The collateral that came back is not the whole recorded collateral.');
  const measured = verifyMorphoRepayPoststateV1({ request: simulationRequest, response: answer.response,
    expected: { marketId: s.marketId, loanTokenAddress: s.loan.address, collateralTokenAddress: s.collateral.address,
      amount, maximumAssets: encodedMaximum, position: s.position, blockNumber: Number(s.block.number),
      ...(returning ? { returnCollateralAssets: s.position.collateral } : {}) } });
  if (!measured.ok) return fail(measured.refusal, measured.detail);
  if (measured.repaidAssets !== debit) return fail('repay_effects_mismatch', 'USDC movements and the independently measured debt reduction disagree.');
  const facts: LendingFactsV1 = { operation: 'repay', venue: 'morpho', collateralTokenAddress: s.collateral.address,
    collateralSymbol: s.collateral.symbol, collateralDecimals: s.collateral.decimals, marketId: s.marketId,
    amountMode: amount.mode, requestedAssets: amount.mode === 'assets' ? amount.assets.toString() : null,
    maximumDebitAssets: encodedMaximum.toString(), collateralSupplyAssets: '0',
    debtBeforeAssets: measured.before.debtAssets.toString(), debtAfterAssets: measured.after.debtAssets.toString(),
    collateralBeforeAssets: measured.before.position.collateral.toString(), collateralAfterAssets: measured.after.position.collateral.toString(),
    debtBeforeShares: measured.before.position.borrowShares.toString(), debtAfterShares: measured.after.position.borrowShares.toString(),
    ...(returning ? { collateralReturnAssets: s.position.collateral.toString() } : {}),
    blockNumber: answer.response.blockNumber,
    warnings: [
      ...(!returning ? ['Collateral stays deposited. This repayment does not withdraw it.']
        : repaying ? [`This repays all USDC debt in this Morpho market, then returns your ${s.collateral.symbol} collateral to this wallet.`]
          : [`No USDC debt is open in this Morpho market. This returns your ${s.collateral.symbol} collateral to this wallet, and no USDC moves.`]),
      ...(returning ? ['The collateral comes back by the wallet’s own call to Morpho Blue, so no authorization is granted; Morpho lets it go only once no debt is left.'] : []),
      ...(returning && s.collateral.symbol === 'WETH' ? ['A loan opened with native ETH holds WETH as its collateral, so it comes back as WETH.'] : []),
      ...(repaying && amount.mode === 'all' ? [sequential
        ? 'Morpho Blue takes what the debt is worth when the repayment lands, never more than your cap, which leaves room above the debt for the interest until then.'
        : 'Morpho Blue takes what the debt is worth when the transaction lands, never more than your cap, which leaves room above the debt for the interest until then; the allowance is cleared in the same batch.'] : []),
      MORPHO_DIRECT_CALLS_WARNING_V1,
      ...(hold ? [morphoCollateralHoldWordsV1({ symbol: s.collateral.symbol, hold, action: 'repay', blockNumber: s.block.number })] : []),
      ...(sequential ? [morphoStepsWarningV1(calls.length, 'repay', returning)] : [])] };
  const signingTermsHash = stableHashV1('still-repay-signing-terms/v1', {
    wallet: s.walletAddress,
    callsHash,
    facts: lendingSigningTermsFactsV1(facts),
  });
  const expiry = now().getTime() + 30_000;
  if (expiry <= now().getTime()) return fail('repay_expired', 'The prepared repayment expired during measurement. Read it again.');
  return { state: 'ready', facts, calls: plan.calls, callsHash, signingTermsHash, expiresAt: new Date(expiry).toISOString(),
    ...(sequential ? { atomicRequired: false as const, delivery: 'sequential' as const } : { atomicRequired: true as const }), steps: plan.steps,
    measured: { provider: answer.providerId, blockNumber: answer.response.blockNumber, loanDeltaAssets: (-debit).toString() } };
}
