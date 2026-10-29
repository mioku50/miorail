import { decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { stableHashV1 } from '@mioagent/route-domain';
import { SimulationObservationRequestV1Schema, SimulationObservationsV1Schema, type SimulationProviderRequestV1 } from '@mioagent/paid-intelligence';
import { aaveSpokeAbi, aaveOracleAbi, aaveHubAbi, erc20Abi, multicall3Abi } from '@mioagent/still-engine/abi';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';
import type { WalletSnapshot } from '@mioagent/still-engine/read';
import { stillAaveCapacityV1, validAaveReserveBindingsV1, type AaveV4UserPositionV1, type StillAaveCapacityV1, type StillAaveStandingV1 } from './stillAaveStanding.js';
import { matchesAaveV4DeploymentV1, type AaveV4ReserveBindingV1 } from './aaveV4BorrowPlan.js';

export const aaveV4PoststateAggregateAbiV1 = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)',
]);
const extraSpokeAbi = parseAbi(['function getUserLastRiskPremium(address user) view returns (uint256)']);
const extraHubAbi = parseAbi([
  'function getAssetDrawnIndex(uint256 assetId) view returns (uint256)',
  'function previewAddByAssets(uint256 assetId,uint256 assets) view returns (uint256)',
]);
const allowanceAbi = parseAbi(['function allowance(address owner,address spender) view returns (uint256)']);
const ZERO = BigInt(0), RAY = BigInt(10) ** BigInt(27), BPS = BigInt(10_000), WAD = BigInt(10) ** BigInt(18);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ceil = (a: bigint, d: bigint) => (a + d - BigInt(1)) / d;
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const registryParams = [{ type: 'uint256' }, { type: 'bool' }] as const;

export interface AaveV4PoststateRefusedV1 {
  ok: false;
  refusal: 'aave_poststate_inputs_invalid' | 'aave_poststate_observations_unread' | 'aave_poststate_binding_mismatch' | 'aave_poststate_reserve_mismatch' | 'aave_poststate_position_mismatch' | 'aave_poststate_funding_mismatch' | 'aave_poststate_debt_mismatch' | 'aave_poststate_policy_refused';
  detail: string;
}
const refuse = (refusal: AaveV4PoststateRefusedV1['refusal'], detail: string): AaveV4PoststateRefusedV1 => ({ ok: false, refusal, detail });
type Observation = NonNullable<SimulationProviderRequestV1['observations']>;
interface Getter { id: string; to: Address; data: Hex; abi?: Abi; functionName?: string }
type Position = Omit<AaveV4UserPositionV1, 'reserveId'>;
interface Reserve {
  info: { underlying: Address; hub: Address; assetId: number; decimals: number; collateralRisk: number; flags: number; dynamicConfigKey: number };
  config: { collateralRisk: number; paused: boolean; frozen: boolean; borrowable: boolean; receiveSharesEnabled: boolean };
  position: Position;
  supplied: bigint;
  debt: bigint;
  usingAsCollateral: boolean;
  borrowing: boolean;
  hubConfig: { addCap: number; drawCap: number; riskPremiumThreshold: number; active: boolean; halted: boolean };
  factorBps?: bigint;
  price?: bigint;
  registry?: { multiplier: bigint; paused: boolean };
}
export interface AaveV4MeasuredPhaseV1 {
  blockNumber: bigint;
  blockTimestamp: bigint;
  reserveCount: bigint;
  oracle: Address;
  walletUsdcAssets: bigint;
  debtAssets: bigint;
  selectedSuppliedAssets: bigint;
  walletCollateralAssets: bigint;
  healthFactorWad: bigint | null;
  usdcLiquidityAssets: bigint;
  usdcSpokeOwedAssets: bigint;
  walletStocks: Map<string, bigint>;
  reserves: Map<number, Reserve>;
  drawnIndex: bigint;
  riskPremium: bigint;
  allowance: bigint;
  projectedSupplyShares: bigint | null;
  account: { riskPremium: bigint; avgCollateralFactor: bigint; healthFactor: bigint; totalCollateralValue: bigint; totalDebtValueRay: bigint; activeCollateralCount: bigint; borrowCount: bigint } | null;
}

function getters(standing: StillAaveStandingV1, operation: 'borrow' | 'repay'): Getter[] {
  const rows: Getter[] = [];
  const encode = encodeFunctionData as (v: { abi: Abi; functionName: string; args: readonly unknown[] }) => Hex;
  const add = (id: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[]) => rows.push({ id, to, abi, functionName, data: encode({ abi, functionName, args }) });
  const user = standing.walletAddress;
  add('block', ADDRESSES.multicall3, multicall3Abi, 'getBlockNumber', []);
  add('timestamp', ADDRESSES.multicall3, multicall3Abi, 'getCurrentBlockTimestamp', []);
  add('count', ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getReserveCount', []);
  add('oracle', ADDRESSES.aaveSpoke, aaveSpokeAbi, 'ORACLE', []);
  add('risk_premium', ADDRESSES.aaveSpoke, extraSpokeAbi, 'getUserLastRiskPremium', [user]);
  add('drawn_index', ADDRESSES.aaveHub, extraHubAbi, 'getAssetDrawnIndex', [BigInt(standing.loanReserve.hubAssetId)]);
  if (operation === 'borrow') {
    add('loan_liquidity', ADDRESSES.aaveHub, aaveHubAbi, 'getAssetLiquidity', [BigInt(standing.loanReserve.hubAssetId)]);
    add('loan_owed', ADDRESSES.aaveHub, aaveHubAbi, 'getSpokeTotalOwed', [BigInt(standing.loanReserve.hubAssetId), ADDRESSES.aaveSpoke]);
  }
  add('usdc_wallet', ADDRESSES.usdc, erc20Abi, 'balanceOf', [user]);
  if (operation === 'borrow') add('account', ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserAccountData', [user]);
  for (const stock of STOCKS) add(`wallet_${stock.id}`, stock.token, erc20Abi, 'balanceOf', [user]);
  const approvalToken = operation === 'repay' ? ADDRESSES.usdc : standing.selectedStock!.token;
  add('allowance', approvalToken, allowanceAbi, 'allowance', [user, ADDRESSES.aaveSpoke]);
  if (operation === 'borrow' && standing.collateralSupplyAssets > ZERO) add('supply_shares', ADDRESSES.aaveHub, extraHubAbi, 'previewAddByAssets', [BigInt(standing.collateralReserve!.hubAssetId), standing.collateralSupplyAssets]);
  for (const r of standing.reserves) {
    const id = BigInt(r.reserveId), prefix = `reserve_${r.reserveId}`;
    add(`${prefix}_info`, ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getReserve', [id]);
    add(`${prefix}_config`, ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getReserveConfig', [id]);
    if (operation === 'borrow') add(`${prefix}_hub`, ADDRESSES.aaveHub, aaveHubAbi, 'getSpokeConfig', [BigInt(r.hubAssetId), ADDRESSES.aaveSpoke]);
    add(`${prefix}_position`, ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserPosition', [id, user]);
    add(`${prefix}_supplied`, ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserSuppliedAssets', [id, user]);
    add(`${prefix}_debt`, ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserTotalDebt', [id, user]);
    add(`${prefix}_status`, ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserReserveStatus', [id, user]);
    if (operation === 'borrow') {
      const snapshot = standing.snapshot.aave!.reserves.find(v => v.info.reserveId === r.reserveId)!;
      const active = r.reserveId === standing.loanReserve.reserveId || r.reserveId === standing.collateralReserve!.reserveId || (snapshot.status.ok && snapshot.status.value.usingAsCollateral);
      if (!active) continue;
      add(`${prefix}_factor`, ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getDynamicReserveConfig', [id, r.dynamicConfigKey]);
      add(`${prefix}_price`, ADDRESSES.aaveOracle, aaveOracleAbi, 'getReservePrice', [id]);
      const stock = STOCKS.find(s => same(s.token, r.underlying));
      if (stock) rows.push({ id: `${prefix}_registry`, to: ADDRESSES.coinbaseStockRegistry,
        data: `0xd4197e82${stock.token.slice(2).toLowerCase().padStart(64, '0')}` });
    }
  }
  return rows;
}

function chunks(rows: readonly Getter[]): Getter[][] {
  const result: Getter[][] = [];
  for (const row of rows) {
    let group = result[result.length - 1];
    if (!group || group.length >= 14) { group = []; result.push(group); }
    group.push(row);
  }
  return result;
}

/** One bounded aggregate per group observes the entire cross-collateral
 * account without widening the transport's max-eight-probes-per-phase guard. */
export function buildAaveV4PoststateProbesV1(standing: StillAaveStandingV1, operation: 'borrow' | 'repay'):
  | { ok: true; observations: Observation }
  | AaveV4PoststateRefusedV1 {
  if (!validAaveReserveBindingsV1(standing) || !matchesAaveV4DeploymentV1(standing.deployment) ||
      !/^0x[0-9a-f]{40}$/i.test(standing.walletAddress) || standing.collateralSupplyAssets < ZERO || standing.operation !== operation || (operation !== 'borrow' && operation !== 'repay') ||
      (operation === 'borrow' && (!standing.selectedStock || !standing.collateralReserve))) return refuse('aave_poststate_inputs_invalid', 'The complete registered Spoke, operation and owner were not established.');
  const groups = chunks(getters(standing, operation));
  if (groups.length > 8) return refuse('aave_poststate_inputs_invalid', 'The reviewed account exceeds the bounded observation contract.');
  const probes = groups.map((group, i) => ({ id: `aave_${i}`, to: ADDRESSES.multicall3.toLowerCase(), data: encodeFunctionData({
    abi: aaveV4PoststateAggregateAbiV1, functionName: 'aggregate3', args: [group.map(g => ({ target: g.to, allowFailure: false, callData: g.data }))],
  }) }));
  const parsed = SimulationObservationRequestV1Schema.safeParse({ before: probes, after: probes.map(p => ({ ...p })) });
  if (!parsed.success) return refuse('aave_poststate_inputs_invalid', 'The exact account getters do not fit the bounded observation transport.');
  return { ok: true, observations: parsed.data };
}

function decodePhase(groups: readonly Getter[][], rows: readonly Hex[], standing: StillAaveStandingV1): AaveV4MeasuredPhaseV1 | null {
  try {
    const values = new Map<string, unknown>();
    const decode = decodeFunctionResult as (v: { abi: Abi; functionName: string; data: Hex }) => unknown;
    const encode = encodeFunctionResult as (v: { abi: Abi; functionName: string; result: unknown }) => Hex;
    for (const [index, group] of groups.entries()) {
      const data = rows[index]!;
      const decoded = decodeFunctionResult({ abi: aaveV4PoststateAggregateAbiV1, functionName: 'aggregate3', data });
      if (decoded.length !== group.length || encodeFunctionResult({ abi: aaveV4PoststateAggregateAbiV1, functionName: 'aggregate3', result: decoded }).toLowerCase() !== data.toLowerCase()) return null;
      for (const [n, entry] of decoded.entries()) {
        if (!entry.success) return null;
        const getter = group[n]!;
        if (!getter.abi || !getter.functionName) {
          const v = decodeAbiParameters(registryParams, entry.returnData);
          if (encodeAbiParameters(registryParams, v).toLowerCase() !== entry.returnData.toLowerCase()) return null;
          values.set(getter.id, { multiplier: v[0], paused: v[1] });
        } else {
          const result = decode({ abi: getter.abi, functionName: getter.functionName, data: entry.returnData });
          if (encode({ abi: getter.abi, functionName: getter.functionName, result }).toLowerCase() !== entry.returnData.toLowerCase()) return null;
          values.set(getter.id, result);
        }
      }
    }
    const take = <T>(id: string): T => {
      if (!values.has(id)) throw new Error('aave_getter_missing');
      return values.get(id) as T;
    };
    const reserves = new Map<number, Reserve>();
    for (const r of standing.reserves) {
      const p = `reserve_${r.reserveId}`, status = take<readonly [boolean, boolean]>(`${p}_status`);
      const factor = values.get(`${p}_factor`) as { collateralFactor: number } | undefined;
      reserves.set(r.reserveId, { info: take(`${p}_info`), config: take(`${p}_config`), position: take(`${p}_position`),
        supplied: take(`${p}_supplied`), debt: take(`${p}_debt`), usingAsCollateral: status[0], borrowing: status[1],
        hubConfig: values.get(`${p}_hub`) as Reserve['hubConfig'],
        factorBps: factor ? BigInt(factor.collateralFactor) : undefined,
        price: values.get(`${p}_price`) as bigint | undefined, registry: values.get(`${p}_registry`) as Reserve['registry'] });
    }
    const account = values.has('account') ? take<AaveV4MeasuredPhaseV1['account']>('account') : null;
    return { blockNumber: take('block'), blockTimestamp: take('timestamp'), reserveCount: take('count'), oracle: take('oracle'), walletUsdcAssets: take('usdc_wallet'),
      debtAssets: reserves.get(standing.loanReserve.reserveId)!.debt, selectedSuppliedAssets: standing.collateralReserve ? reserves.get(standing.collateralReserve.reserveId)!.supplied : ZERO,
      walletCollateralAssets: standing.selectedStock ? take<bigint>(`wallet_${standing.selectedStock.id}`) : ZERO, healthFactorWad: account?.healthFactor ?? null,
      usdcLiquidityAssets: values.has('loan_liquidity') ? take('loan_liquidity') : ZERO, usdcSpokeOwedAssets: values.has('loan_owed') ? take('loan_owed') : ZERO,
      walletStocks: new Map(STOCKS.map(s => [s.id, take<bigint>(`wallet_${s.id}`)])), reserves,
      drawnIndex: take('drawn_index'), riskPremium: take('risk_premium'), allowance: take('allowance'),
      projectedSupplyShares: values.has('supply_shares') ? take('supply_shares') : null, account };
  } catch { return null; }
}

function bindingMatches(binding: AaveV4ReserveBindingV1, value: Reserve): boolean {
  return same(binding.underlying, value.info.underlying) && same(binding.hub, value.info.hub) && binding.hubAssetId === value.info.assetId &&
    binding.decimals === value.info.decimals && binding.dynamicConfigKey === value.info.dynamicConfigKey;
}
function premiumRay(position: Position, index: bigint): bigint {
  const premium = position.premiumShares * index - position.premiumOffsetRay;
  if (premium < ZERO) throw new Error('aave_premium_negative');
  return premium;
}
function debt(position: Position, index: bigint): bigint {
  return ceil(position.drawnShares * index, RAY) + ceil(premiumRay(position, index), RAY);
}

function capacityAfter(standing: StillAaveStandingV1, phase: AaveV4MeasuredPhaseV1): StillAaveCapacityV1 {
  const original = standing.snapshot.aave!;
  const snapshot: WalletSnapshot = { ...standing.snapshot, block: { number: phase.blockNumber, timestamp: phase.blockTimestamp },
    aave: { ...original, usdcDebt: { ok: true, value: phase.reserves.get(standing.loanReserve.reserveId)!.debt },
      usdcLiquidity: { ok: true, value: phase.usdcLiquidityAssets }, usdcSpokeOwed: { ok: true, value: phase.usdcSpokeOwedAssets },
      reserves: original.reserves.map(r => {
        const v = phase.reserves.get(r.info.reserveId)!;
        return { ...r, supplied: { ok: true, value: v.supplied }, status: { ok: true, value: { usingAsCollateral: v.usingAsCollateral, borrowing: v.borrowing } },
          config: { ok: true, value: v.config }, spokeConfig: { ok: true, value: { addCap: BigInt(v.hubConfig.addCap), drawCap: BigInt(v.hubConfig.drawCap), active: v.hubConfig.active, halted: v.hubConfig.halted } },
          ...(v.factorBps === undefined ? {} : { factorBps: { ok: true as const, value: v.factorBps }, userFactorBps: { ok: true as const, value: v.factorBps } }),
          ...(v.price === undefined ? {} : { price: { ok: true as const, value: v.price } }) };
      }) },
    coinbase: new Map(standing.snapshot.coinbase),
  };
  for (const r of standing.reserves) {
    const stock = STOCKS.find(s => same(s.token, r.underlying)), value = phase.reserves.get(r.reserveId)!;
    if (stock && value.registry) snapshot.coinbase.set(stock.id, { ok: true, value: value.registry });
  }
  return stillAaveCapacityV1({ universe: standing.universe, snapshot, calendar: standing.calendar,
    now: new Date(Math.max(Date.parse(standing.readAt), Number(phase.blockTimestamp) * 1000)), selectedStockId: standing.selectedStock!.id, additionalCollateralAssets: ZERO });
}

export type AaveV4PoststateV1 = { ok: true; before: AaveV4MeasuredPhaseV1; after: AaveV4MeasuredPhaseV1; capacity: StillAaveCapacityV1 | null; usdcMovedAssets: bigint } | AaveV4PoststateRefusedV1;

/** Independent same-state proof, separate from the execution receipt. */
export function verifyAaveV4PoststateV1(input: {
  request: Pick<SimulationProviderRequestV1, 'walletAddress' | 'callsHash' | 'observations'> & { chainId: number };
  response: { blockNumber: number; observations?: unknown };
  expected: { standing: StillAaveStandingV1; operation: 'borrow' | 'repay'; borrowAssets?: bigint; maximumRepayAssets?: bigint; fullRepay?: boolean };
}): AaveV4PoststateV1 {
  const { request, response, expected } = input, standing = expected.standing;
  const built = buildAaveV4PoststateProbesV1(standing, expected.operation);
  if (!built.ok) return built;
  if (request.chainId !== 8453 || !same(request.walletAddress, standing.walletAddress) || !/^0x[a-fA-F0-9]{64}$/.test(request.callsHash) ||
      !Number.isSafeInteger(response.blockNumber) || response.blockNumber < standing.blockNumber) return refuse('aave_poststate_inputs_invalid', 'The simulation was not bound to this wallet, Base chain and current reading.');
  const requested = SimulationObservationRequestV1Schema.safeParse(request.observations), observed = SimulationObservationsV1Schema.safeParse(response.observations);
  if (!requested.success || !observed.success) return refuse('aave_poststate_observations_unread', 'The complete account before and after state was not read.');
  const normalized = (phase: 'before' | 'after') => requested.data[phase].map(v => ({ ...v, to: v.to.toLowerCase(), data: v.data.toLowerCase() }));
  if (json(normalized('before')) !== json(built.observations.before) || json(normalized('after')) !== json(built.observations.after)) return refuse('aave_poststate_binding_mismatch', 'The requested account getters changed identity or order.');
  const requestHash = stableHashV1('simulation-observations/v1', { chainId: 8453, walletAddress: request.walletAddress.toLowerCase(), callsHash: request.callsHash,
    before: normalized('before'), after: normalized('after') });
  const wanted = (['before', 'after'] as const).flatMap(phase => built.observations[phase].map(probe => ({ ...probe, phase })));
  if (observed.data.requestHash !== requestHash || observed.data.results.length !== wanted.length) return refuse('aave_poststate_binding_mismatch', 'The observations were not bound to the exact approved calls.');
  const phaseRows: { before: Hex[]; after: Hex[] } = { before: [], after: [] };
  for (const [i, row] of observed.data.results.entries()) {
    const target = wanted[i]!;
    if (row.phase !== target.phase || row.id !== target.id || !same(row.to, target.to) || !same(row.data, target.data)) return refuse('aave_poststate_binding_mismatch', 'A getter result changed its identity, phase or order.');
    phaseRows[row.phase].push(row.returnData as Hex);
  }
  const groups = chunks(getters(standing, expected.operation));
  const before = decodePhase(groups, phaseRows.before, standing), after = decodePhase(groups, phaseRows.after, standing);
  if (!before || !after) return refuse('aave_poststate_observations_unread', 'A getter was not a complete canonical ABI answer.');
  if (before.blockNumber !== BigInt(response.blockNumber) || after.blockNumber !== before.blockNumber || before.blockTimestamp !== after.blockTimestamp ||
      before.blockTimestamp < standing.blockTimestamp || before.reserveCount !== BigInt(standing.reserves.length) || after.reserveCount !== before.reserveCount ||
      !same(before.oracle, ADDRESSES.aaveOracle) || !same(after.oracle, before.oracle) || before.drawnIndex <= ZERO || before.drawnIndex !== after.drawnIndex ||
      before.riskPremium >= (BigInt(1) << BigInt(24)) || after.riskPremium >= (BigInt(1) << BigInt(24))) return refuse('aave_poststate_reserve_mismatch', 'The same simulation block, exact whole Spoke or debt index was not established.');
  const loanId = standing.loanReserve.reserveId, selectedId = standing.collateralReserve?.reserveId;
  for (const binding of standing.reserves) {
    const pre = before.reserves.get(binding.reserveId)!, post = after.reserves.get(binding.reserveId)!;
    const readPosition = standing.positions.find(p => p.reserveId === binding.reserveId)!;
    const position = readPosition;
    if (!bindingMatches(binding, pre) || json(pre.info) !== json(post.info) || json(pre.config) !== json(post.config) || json(pre.hubConfig) !== json(post.hubConfig)) return refuse('aave_poststate_reserve_mismatch', 'A reserve identity, configuration or latest dynamic key changed.');
    if ((['drawnShares', 'premiumShares', 'premiumOffsetRay', 'suppliedShares', 'dynamicConfigKey'] as const).some(key => pre.position[key] !== position[key])) return refuse('aave_poststate_position_mismatch', 'The owner’s recorded shares changed before this simulation.');
    if (binding.reserveId !== loanId && (expected.operation === 'borrow'
      ? pre.debt !== ZERO || post.debt !== ZERO || pre.position.drawnShares !== ZERO || post.position.drawnShares !== ZERO
      : pre.debt !== post.debt || pre.position.drawnShares !== post.position.drawnShares)) return refuse('aave_poststate_debt_mismatch', 'Another borrowed asset changed or was not part of this USDC-only borrowing allowance.');
    const selectedSupply = expected.operation === 'borrow' && binding.reserveId === selectedId ? standing.collateralSupplyAssets : ZERO;
    if (selectedSupply > ZERO) {
      if (before.projectedSupplyShares === null || before.projectedSupplyShares <= ZERO || post.position.suppliedShares - pre.position.suppliedShares !== before.projectedSupplyShares || post.supplied < pre.supplied || post.supplied - pre.supplied > selectedSupply) return refuse('aave_poststate_position_mismatch', 'The exact selected stock supply and its shares were not established.');
    } else if (post.position.suppliedShares !== pre.position.suppliedShares || post.supplied !== pre.supplied) return refuse('aave_poststate_position_mismatch', 'A collateral or supply position changed outside the selected pledge.');
    if (expected.operation === 'borrow') {
      const shouldUse = binding.reserveId === selectedId || pre.usingAsCollateral;
      if (post.usingAsCollateral !== shouldUse || (post.usingAsCollateral && post.position.dynamicConfigKey !== binding.dynamicConfigKey)) return refuse('aave_poststate_position_mismatch', 'Collateral enablement or the refreshed factor key was not established.');
      if (!post.usingAsCollateral && post.position.dynamicConfigKey !== pre.position.dynamicConfigKey) return refuse('aave_poststate_position_mismatch', 'An unrelated reserve configuration changed.');
      if (pre.price !== undefined && (pre.price <= ZERO || post.price !== pre.price || pre.factorBps !== post.factorBps || json(pre.registry) !== json(post.registry))) return refuse('aave_poststate_policy_refused', 'A reviewed collateral price, factor or issuer registry changed within this simulated action.');
    } else if (post.usingAsCollateral !== pre.usingAsCollateral || post.position.dynamicConfigKey !== pre.position.dynamicConfigKey) return refuse('aave_poststate_position_mismatch', 'Repayment changed collateral configuration.');
    if (binding.reserveId !== loanId && (post.position.premiumShares !== pre.position.premiumShares || post.position.premiumOffsetRay !== pre.position.premiumOffsetRay || post.borrowing !== pre.borrowing)) return refuse('aave_poststate_position_mismatch', 'Another debt or premium position changed.');
  }
  for (const stock of STOCKS) {
    const amount = expected.operation === 'borrow' && stock.id === standing.selectedStock?.id ? standing.collateralSupplyAssets : ZERO;
    const pre = before.walletStocks.get(stock.id)!, post = after.walletStocks.get(stock.id)!;
    if (pre < amount || pre - post !== amount) return refuse('aave_poststate_funding_mismatch', 'The wallet stock debit did not equal only the explicitly selected pledge.');
  }
  const preLoan = before.reserves.get(loanId)!, postLoan = after.reserves.get(loanId)!;
  const idx = before.drawnIndex;
  try {
    if (debt(preLoan.position, idx) !== preLoan.debt || debt(postLoan.position, idx) !== postLoan.debt) return refuse('aave_poststate_debt_mismatch', 'The read debt did not match the verified deployed share and premium arithmetic.');
    if (expected.operation === 'borrow') {
      const amount = expected.borrowAssets;
      if (amount === undefined || amount <= ZERO || after.walletUsdcAssets - before.walletUsdcAssets !== amount || postLoan.position.drawnShares - preLoan.position.drawnShares !== ceil(amount * RAY, idx) ||
          premiumRay(postLoan.position, idx) !== premiumRay(preLoan.position, idx) || postLoan.debt <= preLoan.debt || !postLoan.borrowing || !after.account || after.account.healthFactor <= WAD || after.account.borrowCount !== BigInt(1) || after.account.riskPremium !== after.riskPremium ||
          postLoan.position.premiumShares !== ceil(postLoan.position.drawnShares * after.riskPremium, BPS)) return refuse('aave_poststate_debt_mismatch', 'The exact USDC arrival, debt-share increase and refreshed premium were not established.');
      if (standing.collateralSupplyAssets > ZERO && after.allowance !== ZERO || standing.collateralSupplyAssets === ZERO && before.allowance !== after.allowance) return refuse('aave_poststate_funding_mismatch', 'The collateral allowance did not finish at its canonical bound.');
      const capacity = capacityAfter(standing, after);
      if (postLoan.debt > capacity.limitAssets) return refuse('aave_poststate_policy_refused', 'The measured total debt exceeds Still’s current whole-account allowance.');
      return { ok: true, before, after, capacity, usdcMovedAssets: amount };
    }
    const maximum = expected.maximumRepayAssets;
    if (maximum === undefined || maximum <= ZERO || before.walletUsdcAssets < maximum || after.allowance !== ZERO || before.riskPremium !== after.riskPremium) return refuse('aave_poststate_funding_mismatch', 'The confirmed maximum USDC budget and allowance cleanup were not established.');
    const drawnDebt = ceil(preLoan.position.drawnShares * idx, RAY), premium = premiumRay(preLoan.position, idx), premiumDebt = ceil(premium, RAY);
    const full = maximum >= drawnDebt + premiumDebt;
    const restoredPremiumRay = full || maximum >= premiumDebt ? premium : maximum * RAY;
    const drawnRestored = full ? drawnDebt : maximum >= premiumDebt ? maximum - premiumDebt : ZERO;
    const burnt = drawnRestored * RAY / idx, debit = drawnRestored + ceil(restoredPremiumRay, RAY);
    if (debit <= ZERO || debit > maximum || before.walletUsdcAssets - after.walletUsdcAssets !== debit || postLoan.position.drawnShares !== preLoan.position.drawnShares - burnt ||
        premiumRay(postLoan.position, idx) !== premium - restoredPremiumRay || postLoan.position.premiumShares !== ceil(postLoan.position.drawnShares * after.riskPremium, BPS) || postLoan.debt >= preLoan.debt ||
        postLoan.borrowing !== (postLoan.position.drawnShares !== ZERO)) return refuse('aave_poststate_debt_mismatch', 'The exact bounded repayment did not reduce only this USDC principal/premium debt.');
    if (expected.fullRepay && (postLoan.position.drawnShares !== ZERO || premiumRay(postLoan.position, idx) !== ZERO || postLoan.debt !== ZERO)) return refuse('aave_poststate_debt_mismatch', 'Full repayment did not establish zero remaining principal and premium debt.');
    return { ok: true, before, after, capacity: null, usdcMovedAssets: debit };
  } catch { return refuse('aave_poststate_observations_unread', 'The read account did not satisfy the bounded deployed accounting contract.'); }
}
