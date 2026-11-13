import { hashApprovedCallsV1, stableHashV1 } from '@mioagent/route-domain';
import type { SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';
import { aaveV4BorrowPlanV1, aaveV4RepayPlanV1, classifyAaveV4DeploymentReadV1, matchesAaveV4DeploymentV1, type AaveV4DeploymentStatusV1 } from './aaveV4BorrowPlan.js';
import { inspectAaveV4DeploymentAtV1, readAaveStandingV1, readAaveV4DeploymentAtV1, readSpokeAllowanceAtV1 } from './stillAaveStanding.js';
import { buildAaveV4PoststateProbesV1, verifyAaveV4PoststateV1 } from './aaveV4BorrowPoststate.js';
import { buildSimulationChainV1, runSimulationChainV1, type SimulationChainV1 } from './swapSimulation.js';
import type { LendingQuestionV1 } from './lendingDraft.js';
import { lendingSigningTermsFactsV1, type LendingRunV1, type LendingFactsV1 } from './lendingReview.js';
import { repayAllBoundAtomicV1, repayAllMinimumAtomicV1 } from '@mioagent/still-engine/repay';
import { repayMaximumBelowDebtWordsV1, repayWalletBelowMaximumWordsV1 } from './repayWords.js';
import { aaveLendingStressV1, collateralTransfersPausedWordsV1, otherCollateralPausedWordsV1 } from './lendingStress.js';

export interface AaveLendingDepsV1 {
  read?: typeof readAaveStandingV1;
  deploymentAt?: typeof readAaveV4DeploymentAtV1;
  inspectDeploymentAt?: typeof inspectAaveV4DeploymentAtV1;
  allowance?: typeof readSpokeAllowanceAtV1;
  chain?: SimulationChainV1;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}
const fail = (refusal: string, detail: string): LendingRunV1 => ({ state: 'refused', refusal, detail });

/** Said on a review that goes in steps, before anything is signed. */
function stepsWarningV1(count: number, operation: 'borrow' | 'repay', returning = false): string {
  const steps = count === 1 ? 'one transaction' : `${count} steps, one transaction each`;
  return operation === 'borrow'
    ? `Your wallet sends this as ${steps}, and pays each network fee. Still reviews each next step again before your wallet asks for it. Stopping between steps takes no loan: an allowance or a deposit already sent stays in place.`
    : `Your wallet sends this as ${steps}, and pays each network fee. Stopping after the allowance repays nothing. Whatever the repayment leaves of the allowance stays with the Aave Spoke, which takes funds only for calls your own wallet makes.${
      returning ? ' Stopping after the repayment leaves the stock deposited, to take back later.' : ''}`;
}
const NO_DEBT_HEALTH_SENTINEL = 1n << 128n;

function deploymentFailureV1(status: Exclude<AaveV4DeploymentStatusV1, 'matched'>): LendingRunV1 {
  switch (status) {
    case 'implementation_mismatch':
      return fail('aave_deployment_changed', 'The Aave Spoke EIP-1967 implementation address at the simulation block does not match the reviewed implementation.');
    case 'code_hash_mismatch':
      return fail('aave_deployment_code_mismatch', 'The Aave Spoke proxy or implementation bytecode hash at the simulation block does not match the reviewed deployment.');
    case 'slot_unreadable':
      return fail('aave_deployment_slot_unreadable', 'The Aave Spoke EIP-1967 implementation slot could not be read at the simulation block.');
    case 'block_unavailable':
      return fail('aave_deployment_block_unavailable', 'The simulation block is not yet available on the bytecode verification RPC. Try the review again.');
    case 'rpc_unavailable':
      return fail('aave_deployment_rpc_unavailable', 'Still could not reach a Base RPC to verify the Aave Spoke bytecode at the simulation block.');
  }
}

/** The direct V4 Spoke acts for msg.sender. No position-manager grant, V3
 * method, unregistered stock, recipient from a model or native ETH is used.
 * A ready result requires the exact same-state debt and collateral proof.
 * `delivery: 'sequential'` plans the same action as one transaction per call,
 * for a wallet that cannot send a batch; it is simulated and checked alike. */
export async function runAaveLendingV1(input: { walletAddress: string; question: LendingQuestionV1; delivery?: 'atomic' | 'sequential'; atLeastBlock?: bigint }, deps: AaveLendingDepsV1 = {}): Promise<LendingRunV1> {
  const now = deps.now ?? (() => new Date()), q = input.question, sequential = input.delivery === 'sequential';
  const returning = q.operation === 'repay' && q.returnCollateral === true;
  const supply = q.operation === 'borrow' ? BigInt(q.collateralSupplyAssets) : 0n;
  const read = await (deps.read ?? readAaveStandingV1)({ tokenAddress: q.collateralTokenAddress,
    walletAddress: input.walletAddress, operation: q.operation, collateralSupplyAssets: supply,
    ...(input.atLeastBlock !== undefined ? { atLeastBlock: input.atLeastBlock } : {}) });
  if (read.state === 'refused') return fail(read.refusal, read.detail);
  const s = read.standing;
  if (!s.selectedStock || !s.collateralReserve) return fail('aave_reserve_mismatch', 'This review did not establish the exact registered stock reserve.');
  if (s.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase() || s.operation !== q.operation ||
    s.selectedStock.token.toLowerCase() !== q.collateralTokenAddress.toLowerCase() ||
    !STOCKS.some(stock => stock.token.toLowerCase() === q.collateralTokenAddress.toLowerCase()) || s.collateralSupplyAssets !== supply) {
    return fail('aave_question_mismatch', 'The measured owner, operation or stock differs from this exact question.');
  }
  const ask = q.operation === 'borrow' ? BigInt(q.borrowAssets) : q.amountMode === 'assets' ? BigInt(q.repayAssets!) : BigInt(q.maximumAssets);
  if ((ask <= 0n && !returning) || ask < 0n || ask >= (1n << 128n)) return fail('aave_amount_invalid', 'Choose an exact positive USDC amount.');
  if (q.operation === 'borrow' && (!s.capacity || ask > s.capacity.availableAssets)) return fail('aave_over_still_limit', 'The requested loan exceeds the measured Still allowance for this exact collateral choice.');
  // Aave takes the smaller of the debt and the bound when a repayment lands. A bound with no room above the
  // debt read leaves the interest since owing, so Repay all is asked with room (audit LEND-2, 2026-11-10).
  // What is refused is a bound the debt has nearly reached: the debt and the room until landing (audit LA-1,
  // 2026-11-14). The page's own bound is what the refusal names, as the page does.
  const repayAll = q.operation === 'repay' && q.amountMode === 'all' && s.debtAssets > 0n;
  const repayAllMinimum = repayAll ? repayAllMinimumAtomicV1(s.debtAssets) : null;
  const repayAllAdvised = repayAll ? repayAllBoundAtomicV1(s.debtAssets) : null;
  if (q.operation === 'repay') {
    if (returning && s.existingSuppliedAssets === 0n) return fail('nothing_to_return', `No ${s.selectedStock.id} is deposited in this Aave Spoke at the reading block, so there is nothing to take back.`);
    if (returning && s.snapshot.aave?.reserves.some(r => r.info.role.kind !== 'usdc' && (!r.status.ok || r.status.value.borrowing))) {
      return fail('aave_other_debt_open', 'Another asset is borrowed in this Aave account, so a stock is not taken back here. Only a USDC loan is repaid and closed by Still.');
    }
    if (s.debtAssets === 0n && !returning) return fail('nothing_to_repay', 'No USDC debt was recorded in this Aave Spoke at the reading block.');
    if (repayAllMinimum !== null && repayAllAdvised !== null && ask < repayAllMinimum) {
      return fail('repay_maximum_exceeded', repayMaximumBelowDebtWordsV1({ debt: s.debtAssets, maximum: ask, wallet: s.walletUsdcAssets, minimum: repayAllAdvised }));
    }
    if (q.amountMode === 'assets' && ask > s.debtAssets) return fail('repay_exceeds_debt', 'The exact partial repayment exceeds the recorded debt. Choose full repayment with an explicit maximum instead.');
    if (ask > BigInt(q.maximumAssets)) return fail('repay_maximum_exceeded', 'The chosen repayment exceeds the explicit USDC budget.');
  }
  // In steps, an allowance already exactly in place is not asked for again, read at the same block.
  // Taking a stock back repays first while any debt is left; with none, it only withdraws.
  const back = returning ? { stockId: s.selectedStock.id, collateralReserve: s.collateralReserve, assets: s.existingSuppliedAssets, repay: s.debtAssets > 0n } : undefined;
  const repayAssets = back && !back.repay ? 0n : ask;
  // Said here in numbers; the plan below refuses the same thing in a sentence.
  if (q.operation === 'repay' && repayAssets > s.walletUsdcAssets) {
    return fail('aave_funding_insufficient', repayWalletBelowMaximumWordsV1({ debt: s.debtAssets, maximum: repayAssets, wallet: s.walletUsdcAssets,
      ...(repayAllAdvised === null ? {} : { minimum: repayAllAdvised }) }));
  }
  let allowanceAssets = 0n;
  if (sequential && ((q.operation === 'repay' && repayAssets > 0n) || supply > 0n)) {
    const read = await (deps.allowance ?? readSpokeAllowanceAtV1)({ token: q.operation === 'borrow' ? s.selectedStock.token : ADDRESSES.usdc,
      walletAddress: s.walletAddress, blockNumber: s.blockNumber });
    if (read === null) return fail('aave_allowance_unread', 'The wallet’s current allowance to the Aave Spoke could not be read, so the steps could not be planned.');
    allowanceAssets = read;
  }
  const delivery = sequential ? { delivery: 'sequential' as const, allowanceAssets } : {};
  const planned = q.operation === 'borrow'
    ? aaveV4BorrowPlanV1({ walletAddress: s.walletAddress, stockId: s.selectedStock.id,
        collateralReserve: s.collateralReserve, loanReserve: s.loanReserve, collateralSupplyAssets: supply,
        borrowAssets: ask, walletCollateralAssets: s.walletCollateralAssets, existingSuppliedAssets: s.existingSuppliedAssets,
        collateralAlreadyEnabled: s.collateralAlreadyEnabled, deployment: s.deployment, ...delivery })
    : aaveV4RepayPlanV1({ walletAddress: s.walletAddress, loanReserve: s.loanReserve,
        maximumRepayAssets: repayAssets, walletUsdcAssets: s.walletUsdcAssets, deployment: s.deployment, ...delivery, ...(back ? { returnCollateral: back } : {}) });
  if (!planned.ok) return fail(planned.refusal, planned.detail);
  const plan = planned.plan;
  const probes = buildAaveV4PoststateProbesV1(s, q.operation);
  if (!probes.ok) return fail(probes.refusal, probes.detail);
  const callsHash = hashApprovedCallsV1(plan.calls);
  const request: SimulationProviderRequestV1 = { chainId: 8453, walletAddress: s.walletAddress,
    blueprintHash: stableHashV1('aave-v4-lending-question/v1', { wallet: s.walletAddress, question: q }), callsHash,
    calls: plan.calls, observations: probes.observations };
  const answer = await runSimulationChainV1({ chain: deps.chain ?? buildSimulationChainV1(deps.env ?? process.env), request,
    nowIso: now().toISOString(), label: 'Aave V4 lending simulation', logContext: { callsHash } });
  if (!answer.ok) return fail(answer.errorCode, 'The exact Aave action and position could not be simulated. No executable review is available.');
  if (answer.response.status !== 'success') return fail('aave_simulation_reverted', 'The Aave action reverted in simulation. No executable review is available.');
  const inspection = deps.inspectDeploymentAt
    ? await deps.inspectDeploymentAt(answer.response.blockNumber)
    : deps.deploymentAt
      ? await deps.deploymentAt(answer.response.blockNumber).then(deployment => ({
          status: classifyAaveV4DeploymentReadV1(answer.response.blockNumber, deployment),
          deployment,
        }))
      : await inspectAaveV4DeploymentAtV1(answer.response.blockNumber);
  if (inspection.status !== 'matched' || !inspection.deployment || !matchesAaveV4DeploymentV1(inspection.deployment) || inspection.deployment.blockNumber !== answer.response.blockNumber) {
    return deploymentFailureV1(inspection.status === 'matched' ? 'block_unavailable' : inspection.status);
  }
  const changes = answer.response.assetChanges;
  if (!changes || changes.status !== 'available') return fail('aave_effects_unread', 'The simulation did not establish all wallet asset movements.');
  let usdcNet = 0n, stockOut = 0n, grossUsdcOut = 0n, stockIn = 0n;
  for (const c of changes.changes) {
    if (!/^(0|[1-9][0-9]{0,77})$/.test(c.amountAtomic)) return fail('aave_effects_unread', 'A wallet movement could not be read exactly.');
    const amount = BigInt(c.amountAtomic); if (amount === 0n) continue;
    if (c.counterparty?.toLowerCase() !== ADDRESSES.aaveHub.toLowerCase() || c.kind !== 'erc20_transfer') return fail('aave_transfer_counterparty_mismatch', 'A wallet movement did not reach or come from the registered Aave Hub.');
    if (c.token.toLowerCase() === ADDRESSES.usdc.toLowerCase()) { usdcNet += c.direction === 'in' ? amount : -amount; if (c.direction === 'out') grossUsdcOut += amount; }
    else if (q.operation === 'borrow' && c.token.toLowerCase() === s.selectedStock.token.toLowerCase() && c.direction === 'out') stockOut += amount;
    else if (back && c.token.toLowerCase() === s.selectedStock.token.toLowerCase() && c.direction === 'in') stockIn += amount;
    else return fail('aave_unrequested_asset_change', 'An asset moved outside the exact collateral and USDC action you chose.');
  }
  // With no debt left, taking the stock back moves no USDC at all.
  const usdcMismatch = back && !back.repay ? usdcNet !== 0n || grossUsdcOut !== 0n : usdcNet >= 0n || -usdcNet > ask || grossUsdcOut !== -usdcNet;
  if (q.operation === 'borrow' ? usdcNet !== ask || stockOut !== supply || grossUsdcOut !== 0n : usdcMismatch || stockOut !== 0n || stockIn !== (back?.assets ?? 0n)) return fail('aave_effects_mismatch', 'The wallet movements do not match the selected Aave action.');
  const measured = verifyAaveV4PoststateV1({ request, response: answer.response, expected: { standing: s, operation: q.operation,
    ...(q.operation === 'borrow' ? { borrowAssets: ask } : { maximumRepayAssets: repayAssets, fullRepay: q.amountMode === 'all',
      ...(back ? { returnCollateralAssets: back.assets } : {}), ...(sequential ? { sequential: true } : {}) }) } });
  if (!measured.ok) return fail(measured.refusal, measured.detail);
  const beforeLoan = measured.before.reserves.get(s.loanReserve.reserveId), afterLoan = measured.after.reserves.get(s.loanReserve.reserveId);
  const beforeStock = measured.before.reserves.get(s.collateralReserve.reserveId), afterStock = measured.after.reserves.get(s.collateralReserve.reserveId);
  if (!beforeLoan || !afterLoan || !beforeStock || !afterStock || measured.usdcMovedAssets !== (usdcNet > 0n ? usdcNet : -usdcNet)) return fail('aave_position_unread', 'The USDC movement and resulting Aave position do not agree.');
  if (q.operation === 'borrow' && (!measured.capacity || afterLoan.debt > measured.capacity.limitAssets)) return fail('aave_over_still_limit', 'The simulated total debt exceeds Still’s allowance at the measured prices and financial window.');
  if (q.operation === 'repay' && q.amountMode === 'assets' && -usdcNet !== ask) return fail('repay_amount_changed', 'The simulated repayment differs from the exact USDC amount requested.');
  const healthBeforeWad = beforeLoan.debt > 0n && measured.before.healthFactorWad !== null && measured.before.healthFactorWad < NO_DEBT_HEALTH_SENTINEL ? measured.before.healthFactorWad.toString() : null;
  const healthAfterWad = afterLoan.debt > 0n && measured.after.healthFactorWad !== null && measured.after.healthFactorWad < NO_DEBT_HEALTH_SENTINEL ? measured.after.healthFactorWad.toString() : null;
  // A new loan against a stock that cannot move: it could not be taken back, and a liquidator could still
  // take the deposit inside the Spoke (2026-11-13). Repaying and taking back are never stopped here.
  if (q.operation === 'borrow' && measured.after.selectedTransfersPaused === true) {
    return fail('collateral_transfers_paused', collateralTransfersPausedWordsV1({ symbol: s.selectedStock.id, venue: 'aave-v4', blockNumber: answer.response.blockNumber }));
  }
  // Nor against an account whose limit counts another stock that cannot move (audit LA-2, 2026-11-14).
  const otherPaused = [...new Set([...measured.before.otherPausedCollateral, ...measured.after.otherPausedCollateral])];
  if (q.operation === 'borrow' && otherPaused.length > 0) {
    return fail('collateral_transfers_paused', otherCollateralPausedWordsV1({ symbols: otherPaused, chosen: s.selectedStock.id, blockNumber: answer.response.blockNumber }));
  }
  const stress = q.operation === 'borrow' ? aaveLendingStressV1({
    healthAfterWad: healthAfterWad === null ? null : BigInt(healthAfterWad),
    activeCollateralCount: measured.after.account?.activeCollateralCount ?? null,
    selectedIsCollateral: afterStock.usingAsCollateral && afterStock.supplied > 0n,
    price: afterStock.price ?? null,
    oracleDecimals: s.universe.aave.ok ? s.universe.aave.oracleDecimals : -1,
    receiveSharesEnabled: afterStock.config.receiveSharesEnabled, frozen: afterStock.config.frozen,
    transfersPaused: measured.after.selectedTransfersPaused,
  }) : null;
  const facts: LendingFactsV1 = { operation: q.operation, venue: 'aave-v4', collateralTokenAddress: s.selectedStock.token.toLowerCase(),
    collateralSymbol: s.selectedStock.id, collateralDecimals: s.selectedStock.decimals, marketId: ADDRESSES.aaveSpoke.toLowerCase(),
    amountMode: q.operation === 'borrow' ? 'assets' : q.amountMode, requestedAssets: q.operation === 'borrow' || q.amountMode === 'assets' ? ask.toString() : null,
    maximumDebitAssets: q.operation === 'repay' ? repayAssets.toString() : '0', collateralSupplyAssets: supply.toString(),
    debtBeforeAssets: beforeLoan.debt.toString(), debtAfterAssets: afterLoan.debt.toString(),
    collateralBeforeAssets: beforeStock.supplied.toString(), collateralAfterAssets: afterStock.supplied.toString(),
    collateralBeforeShares: beforeStock.position.suppliedShares.toString(), collateralAfterShares: afterStock.position.suppliedShares.toString(),
    healthBeforeWad, healthAfterWad,
    ...(measured.capacity ? { policyLimitAssets: measured.capacity.limitAssets.toString(), protocolLimitAssets: measured.capacity.protocolLimitAssets.toString(), termsVersion: s.termsVersion } : {}),
    debtBeforeShares: beforeLoan.position.drawnShares.toString(), debtAfterShares: afterLoan.position.drawnShares.toString(),
    ...(back ? { collateralReturnAssets: back.assets.toString() } : {}),
    ...(stress ? { stress } : {}),
    blockNumber: answer.response.blockNumber, warnings: q.operation === 'borrow' ? [
      ...(!s.collateralAlreadyEnabled ? ['This also enables your selected stock deposit as collateral in this Spoke.'] : []),
      'This creates USDC debt in the reviewed Aave V4 equities Spoke. Its existing collateral and USDC debt are measured together.',
      `Still’s ${s.termsVersion} allowance was checked at the simulation block. Prices, rates and financial windows can change before your wallet submits.`,
      'Aave enforces its own health rules onchain. Your collateral can be liquidated. A server review is not an onchain price or Still-limit guarantee.',
      ...(sequential ? [stepsWarningV1(plan.calls.length, 'borrow')] : []),
    ] : back && !back.repay ? [`No USDC debt is open in the Aave V4 equities Spoke. This returns your ${s.selectedStock.id} deposit to this wallet, and no USDC moves.`,
      ...(sequential ? [stepsWarningV1(plan.calls.length, 'repay', true)] : [])]
      : [back ? `This repays all USDC debt of the Aave V4 equities Spoke, then returns your ${s.selectedStock.id} deposit to this wallet.`
          : 'This repays the USDC debt of the Aave V4 equities Spoke. Collateral remains deposited.',
      ...(back ? [sequential ? 'The stock is taken back in the last step, after Still has checked again that no debt is left.'
        : 'The stock leaves in the same batch, after the repayment. Aave checks that the account stays healthy, not that the debt is zero, so Still reads the result from Base: a loan with any debt left is not called closed.'] : []),
      sequential ? 'The Spoke takes at most your explicit USDC maximum and requests no position-manager grant.'
        : 'The Spoke takes at most your explicit USDC maximum, clears the temporary allowance in the same atomic batch and requests no position-manager grant.',
      ...(sequential ? [stepsWarningV1(plan.calls.length, 'repay', Boolean(back))] : [])] };
  // The way it is sent is part of what is signed: steps are never armed as a batch, nor a batch as steps.
  const signingTermsHash = stableHashV1('aave-v4-lending-signing-terms/v1', {
    wallet: s.walletAddress,
    callsHash,
    facts: lendingSigningTermsFactsV1(facts),
    ...(sequential ? { delivery: 'sequential' } : {}),
  });
  return { state: 'ready', facts, calls: plan.calls, callsHash, signingTermsHash, expiresAt: new Date(now().getTime() + 30_000).toISOString(),
    ...(sequential ? { atomicRequired: false as const, delivery: 'sequential' as const } : { atomicRequired: true as const }),
    steps: plan.steps.map(step => ({ index: step.index, to: step.to, reading: step.reading })),
    measured: { provider: 'base_same_state', blockNumber: answer.response.blockNumber, loanDeltaAssets: usdcNet.toString() } };
}
