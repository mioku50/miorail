import { hashApprovedCallsV1, stableHashV1 } from '@mioagent/route-domain';
import type { SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';
import { aaveV4BorrowPlanV1, aaveV4RepayPlanV1, matchesAaveV4DeploymentV1 } from './aaveV4BorrowPlan.js';
import { readAaveStandingV1, readAaveV4DeploymentAtV1 } from './stillAaveStanding.js';
import { buildAaveV4PoststateProbesV1, verifyAaveV4PoststateV1 } from './aaveV4BorrowPoststate.js';
import { buildSimulationChainV1, runSimulationChainV1, type SimulationChainV1 } from './swapSimulation.js';
import type { LendingQuestionV1 } from './lendingDraft.js';
import type { LendingRunV1, LendingFactsV1 } from './lendingReview.js';

export interface AaveLendingDepsV1 {
  read?: typeof readAaveStandingV1;
  deploymentAt?: typeof readAaveV4DeploymentAtV1;
  chain?: SimulationChainV1;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}
const fail = (refusal: string, detail: string): LendingRunV1 => ({ state: 'refused', refusal, detail });

/** The direct V4 Spoke acts for msg.sender. No position-manager grant, V3
 * method, unregistered stock, recipient from a model or native ETH is used.
 * A ready result requires the exact same-state debt and collateral proof. */
export async function runAaveLendingV1(input: { walletAddress: string; question: LendingQuestionV1 }, deps: AaveLendingDepsV1 = {}): Promise<LendingRunV1> {
  const now = deps.now ?? (() => new Date()), q = input.question;
  const supply = q.operation === 'borrow' ? BigInt(q.collateralSupplyAssets) : 0n;
  const read = await (deps.read ?? readAaveStandingV1)({ tokenAddress: q.collateralTokenAddress,
    walletAddress: input.walletAddress, operation: q.operation, collateralSupplyAssets: supply });
  if (read.state === 'refused') return fail(read.refusal, read.detail);
  const s = read.standing;
  if (!s.selectedStock || !s.collateralReserve) return fail('aave_reserve_mismatch', 'This review did not establish the exact registered stock reserve.');
  if (s.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase() || s.operation !== q.operation ||
    s.selectedStock.token.toLowerCase() !== q.collateralTokenAddress.toLowerCase() ||
    !STOCKS.some(stock => stock.token.toLowerCase() === q.collateralTokenAddress.toLowerCase()) || s.collateralSupplyAssets !== supply) {
    return fail('aave_question_mismatch', 'The measured owner, operation or stock differs from this exact question.');
  }
  const ask = q.operation === 'borrow' ? BigInt(q.borrowAssets) : q.amountMode === 'assets' ? BigInt(q.repayAssets!) : BigInt(q.maximumAssets);
  if (ask <= 0n || ask >= (1n << 128n)) return fail('aave_amount_invalid', 'Choose an exact positive USDC amount.');
  if (q.operation === 'borrow' && (!s.capacity || ask > s.capacity.availableAssets)) return fail('aave_over_still_limit', 'The requested loan exceeds the measured Still allowance for this exact collateral choice.');
  if (q.operation === 'repay') {
    if (s.debtAssets === 0n) return fail('nothing_to_repay', 'No USDC debt was recorded in this Aave Spoke at the reading block.');
    if (q.amountMode === 'all' && s.debtAssets > ask) return fail('repay_maximum_exceeded', 'The recorded debt exceeds your explicit maximum USDC budget.');
    if (q.amountMode === 'assets' && ask > s.debtAssets) return fail('repay_exceeds_debt', 'The exact partial repayment exceeds the recorded debt. Choose full repayment with an explicit maximum instead.');
    if (ask > BigInt(q.maximumAssets)) return fail('repay_maximum_exceeded', 'The chosen repayment exceeds the explicit USDC budget.');
  }
  const planned = q.operation === 'borrow'
    ? aaveV4BorrowPlanV1({ walletAddress: s.walletAddress, stockId: s.selectedStock.id,
        collateralReserve: s.collateralReserve, loanReserve: s.loanReserve, collateralSupplyAssets: supply,
        borrowAssets: ask, walletCollateralAssets: s.walletCollateralAssets, existingSuppliedAssets: s.existingSuppliedAssets,
        collateralAlreadyEnabled: s.collateralAlreadyEnabled, deployment: s.deployment })
    : aaveV4RepayPlanV1({ walletAddress: s.walletAddress, loanReserve: s.loanReserve,
        maximumRepayAssets: ask, walletUsdcAssets: s.walletUsdcAssets, deployment: s.deployment });
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
  const deployment = await (deps.deploymentAt ?? readAaveV4DeploymentAtV1)(answer.response.blockNumber);
  if (!deployment || !matchesAaveV4DeploymentV1(deployment) || deployment.blockNumber !== answer.response.blockNumber) return fail('aave_deployment_changed', 'The reviewed implementation was not established at the simulation block.');
  const changes = answer.response.assetChanges;
  if (!changes || changes.status !== 'available') return fail('aave_effects_unread', 'The simulation did not establish all wallet asset movements.');
  let usdcNet = 0n, stockOut = 0n, grossUsdcOut = 0n;
  for (const c of changes.changes) {
    if (!/^(0|[1-9][0-9]{0,77})$/.test(c.amountAtomic)) return fail('aave_effects_unread', 'A wallet movement could not be read exactly.');
    const amount = BigInt(c.amountAtomic); if (amount === 0n) continue;
    if (c.counterparty?.toLowerCase() !== ADDRESSES.aaveHub.toLowerCase() || c.kind !== 'erc20_transfer') return fail('aave_transfer_counterparty_mismatch', 'A wallet movement did not reach or come from the registered Aave Hub.');
    if (c.token.toLowerCase() === ADDRESSES.usdc.toLowerCase()) { usdcNet += c.direction === 'in' ? amount : -amount; if (c.direction === 'out') grossUsdcOut += amount; }
    else if (q.operation === 'borrow' && c.token.toLowerCase() === s.selectedStock.token.toLowerCase() && c.direction === 'out') stockOut += amount;
    else return fail('aave_unrequested_asset_change', 'An asset moved outside the exact collateral and USDC action you chose.');
  }
  if (q.operation === 'borrow' ? usdcNet !== ask || stockOut !== supply || grossUsdcOut !== 0n : usdcNet >= 0n || -usdcNet > ask || grossUsdcOut !== -usdcNet || stockOut !== 0n) return fail('aave_effects_mismatch', 'The wallet movements do not match the selected Aave action.');
  const measured = verifyAaveV4PoststateV1({ request, response: answer.response, expected: { standing: s, operation: q.operation,
    ...(q.operation === 'borrow' ? { borrowAssets: ask } : { maximumRepayAssets: ask, fullRepay: q.amountMode === 'all' }) } });
  if (!measured.ok) return fail(measured.refusal, measured.detail);
  const beforeLoan = measured.before.reserves.get(s.loanReserve.reserveId), afterLoan = measured.after.reserves.get(s.loanReserve.reserveId);
  const beforeStock = measured.before.reserves.get(s.collateralReserve.reserveId), afterStock = measured.after.reserves.get(s.collateralReserve.reserveId);
  if (!beforeLoan || !afterLoan || !beforeStock || !afterStock || measured.usdcMovedAssets !== (usdcNet > 0n ? usdcNet : -usdcNet)) return fail('aave_position_unread', 'The USDC movement and resulting Aave position do not agree.');
  if (q.operation === 'borrow' && (!measured.capacity || afterLoan.debt > measured.capacity.limitAssets)) return fail('aave_over_still_limit', 'The simulated total debt exceeds Still’s allowance at the measured prices and financial window.');
  if (q.operation === 'repay' && q.amountMode === 'assets' && -usdcNet !== ask) return fail('repay_amount_changed', 'The simulated repayment differs from the exact USDC amount requested.');
  const facts: LendingFactsV1 = { operation: q.operation, venue: 'aave-v4', collateralTokenAddress: s.selectedStock.token.toLowerCase(),
    collateralSymbol: s.selectedStock.id, collateralDecimals: s.selectedStock.decimals, marketId: ADDRESSES.aaveSpoke.toLowerCase(),
    amountMode: q.operation === 'borrow' ? 'assets' : q.amountMode, requestedAssets: q.operation === 'borrow' || q.amountMode === 'assets' ? ask.toString() : null,
    maximumDebitAssets: q.operation === 'repay' ? ask.toString() : '0', collateralSupplyAssets: supply.toString(),
    debtBeforeAssets: beforeLoan.debt.toString(), debtAfterAssets: afterLoan.debt.toString(),
    collateralBeforeAssets: beforeStock.supplied.toString(), collateralAfterAssets: afterStock.supplied.toString(),
    collateralBeforeShares: beforeStock.position.suppliedShares.toString(), collateralAfterShares: afterStock.position.suppliedShares.toString(),
    healthBeforeWad: measured.before.healthFactorWad?.toString() ?? null, healthAfterWad: measured.after.healthFactorWad?.toString() ?? null,
    ...(measured.capacity ? { policyLimitAssets: measured.capacity.limitAssets.toString(), protocolLimitAssets: measured.capacity.protocolLimitAssets.toString(), termsVersion: s.termsVersion } : {}),
    debtBeforeShares: beforeLoan.position.drawnShares.toString(), debtAfterShares: afterLoan.position.drawnShares.toString(),
    blockNumber: answer.response.blockNumber, warnings: q.operation === 'borrow' ? [
      ...(!s.collateralAlreadyEnabled ? ['This also enables your selected stock deposit as collateral in this Spoke.'] : []),
      'This creates USDC debt in the reviewed Aave V4 equities Spoke. Its existing collateral and USDC debt are measured together.',
      `Still’s ${s.termsVersion} allowance was checked at the simulation block. Prices, rates and financial windows can change before your wallet submits.`,
      'Aave enforces its own health rules onchain. Your collateral can be liquidated. A server review is not an onchain price or Still-limit guarantee.',
    ] : ['This repays the USDC debt of the Aave V4 equities Spoke. Collateral remains deposited.',
      'The Spoke takes at most your explicit USDC maximum, clears the temporary allowance in the same atomic batch and requests no position-manager grant.'] };
  const { blockNumber: _blockNumber, ...economicFacts } = facts;
  const signingTermsHash = stableHashV1('aave-v4-lending-signing-terms/v1', { wallet: s.walletAddress, callsHash, facts: economicFacts });
  return { state: 'ready', facts, calls: plan.calls, callsHash, signingTermsHash, expiresAt: new Date(now().getTime() + 30_000).toISOString(),
    atomicRequired: true, steps: plan.steps.map(step => ({ index: step.index, to: step.to, reading: step.reading })),
    measured: { provider: 'base_same_state', blockNumber: answer.response.blockNumber, loanDeltaAssets: usdcNet.toString() } };
}
