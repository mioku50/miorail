import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { stableHashV1 } from '@mioagent/route-domain';
import { EXAMPLE, calendar, snapshot, universe } from '../../../lib/still-engine/test/fixtures.js';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import { aaveSpokeAbi, aaveOracleAbi, aaveHubAbi, erc20Abi, multicall3Abi } from '@mioagent/still-engine/abi';
import { AAVE_V4_DEPLOYMENT_PIN_V1 } from './aaveV4BorrowPlan.js';
import { readStillAaveStandingV1, type StillAaveSnapshotV1, type StillAaveStandingV1 } from './stillAaveStanding.js';
import { aaveV4PoststateAggregateAbiV1, buildAaveV4PoststateProbesV1 } from './aaveV4BorrowPoststate.js';

export const AAVE_TEST_WALLET = '0x1111111111111111111111111111111111111111' as Address;
const RAY = BigInt(10) ** BigInt(27), WAD = BigInt(10) ** BigInt(18), ZERO = BigInt(0);
const clone = <T>(value: T): T => structuredClone(value);
export function aaveReadFixture(): StillAaveSnapshotV1 {
  const u = universe(), s = snapshot({ ...EXAMPLE, wallet: { NVDAc: BigInt(100_000_000) }, pledged: { NVDAc: BigInt(100_000_000) }, aaveDebt: BigInt(10_000_000) });
  s.balances.set(ADDRESSES.usdc.toLowerCase(), { ok: true, value: BigInt(1_000_000_000) });
  if (!u.aave.ok || !s.aave) throw Error('fixture');
  s.aave.account = { ok: true, value: { healthFactor: BigInt(5) * WAD, borrowCount: BigInt(1) } };
  const reserves = u.aave.reserves.map(r => ({ reserveId: r.reserveId, underlying: r.underlying, hub: ADDRESSES.aaveHub,
    hubAssetId: r.hubAssetId, decimals: r.decimals, dynamicConfigKey: r.dynamicConfigKey }));
  const positions = s.aave.reserves.map(r => ({ reserveId: r.info.reserveId, drawnShares: r.info.role.kind === 'usdc' ? BigInt(10_000_000) : ZERO,
    suppliedShares: r.supplied.ok ? r.supplied.value : ZERO, premiumShares: ZERO, premiumOffsetRay: ZERO, dynamicConfigKey: r.info.dynamicConfigKey }));
  return { universe: u, snapshot: s, reserves, positions, deployment: { chainId: 8453, blockNumber: Number(s.block.number),
    implementationAddress: AAVE_V4_DEPLOYMENT_PIN_V1.implementation, implementationCodeHash: AAVE_V4_DEPLOYMENT_PIN_V1.implementationCodeHash, proxyCodeHash: AAVE_V4_DEPLOYMENT_PIN_V1.proxyCodeHash } };
}
/** The same account with its USDC loan repaid: the stock stays deposited, nothing is owed. */
export function aaveRepaidReadFixture(): StillAaveSnapshotV1 {
  const read = aaveReadFixture();
  const usdc = read.snapshot.aave!.reserves.find(r => r.info.role.kind === 'usdc')!;
  read.snapshot.aave!.usdcDebt = { ok: true, value: ZERO };
  if (usdc.status.ok) usdc.status = { ok: true, value: { ...usdc.status.value, borrowing: false } };
  read.positions.find(p => p.reserveId === usdc.info.reserveId)!.drawnShares = ZERO;
  read.snapshot.aave!.account = { ok: true, value: { healthFactor: (BigInt(1) << BigInt(256)) - BigInt(1), borrowCount: ZERO } };
  return read;
}
/** Appends reserves Still does not model, as Aave listed a ninth one on 2026-11-01. */
export function withUnmodeledReserves(read: StillAaveSnapshotV1, count = 1, supplied = BigInt(0), borrowing = false): StillAaveSnapshotV1 {
  if (!read.universe.aave.ok || !read.snapshot.aave) throw Error('fixture');
  for (let i = 0; i < count; i += 1) {
    const reserveId = read.reserves.length;
    const underlying = `0xb2000000000000000000000000000000000000${reserveId.toString(16).padStart(2, '0')}` as `0x${string}`;
    const info = { reserveId, underlying, hubAssetId: reserveId, decimals: 8, dynamicConfigKey: 0, priceSource: null, role: { kind: 'other' as const } };
    read.universe.aave.reserves.push(info);
    read.snapshot.aave.reserves.push({ info, config: { ok: true, value: { paused: false, frozen: false, borrowable: false } },
      factorBps: { ok: true, value: BigInt(5_000) }, userFactorBps: { ok: true, value: BigInt(5_000) }, price: { ok: true, value: BigInt(10_000_000_000) },
      priceUpdatedAt: { ok: false, reason: 'reverted' }, supplied: { ok: true, value: supplied },
      status: { ok: true, value: { usingAsCollateral: supplied > BigInt(0), borrowing } },
      spokeConfig: { ok: true, value: { addCap: BigInt(1_000), drawCap: BigInt(0), active: true, halted: false } }, spokeAdded: { ok: true, value: BigInt(0) } });
    read.reserves.push({ reserveId, underlying, hub: ADDRESSES.aaveHub, hubAssetId: reserveId, decimals: 8, dynamicConfigKey: 0 });
    read.positions.push({ reserveId, drawnShares: borrowing ? BigInt(1) : BigInt(0), suppliedShares: supplied, premiumShares: BigInt(0), premiumOffsetRay: BigInt(0), dynamicConfigKey: 0 });
  }
  return read;
}

export async function aaveStandingFixture(operation: 'borrow' | 'repay' = 'borrow', read = aaveReadFixture(), supply = BigInt(100_000_000)): Promise<StillAaveStandingV1> {
  const r = await readStillAaveStandingV1({ walletAddress: AAVE_TEST_WALLET, operation, stockId: 'NVDAc', collateralSupplyAssets: operation === 'borrow' ? supply : ZERO,
    deps: { now: () => new Date('2026-10-21T15:00:00Z'), snapshot: async () => read, calendar: async () => calendar() } });
  if (r.state !== 'read') throw Error(`${r.refusal}: ${r.detail}`);
  return r.standing;
}

type TestPosition = StillAaveStandingV1['positions'][number];
export interface AavePhaseFixture {
  positions: Map<number, TestPosition>;
  supplied: Map<number, bigint>;
  debts: Map<number, bigint>;
  enabled: Map<number, boolean>;
  wallets: Map<string, bigint>;
  allowance: bigint;
  riskPremium: bigint;
  drawnIndex: bigint;
  healthFactor: bigint;
  changeInfo?: boolean;
  priceChange?: boolean;
}
const extras = parseAbi([
  'function getUserLastRiskPremium(address) view returns (uint256)',
  'function getAssetDrawnIndex(uint256) view returns (uint256)',
  'function previewAddByAssets(uint256,uint256) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
const allAbi = [...aaveSpokeAbi, ...aaveOracleAbi, ...aaveHubAbi, ...erc20Abi, ...multicall3Abi, ...extras] as Abi;
const encode = encodeFunctionResult as (v: { abi: Abi; functionName: string; result: unknown }) => Hex;
const ceil = (n: bigint, d: bigint) => (n + d - BigInt(1)) / d;
/** `returning`: the repayment is followed by taking the selected stock's whole deposit back, as Aave does it:
 * the shares leave, the stock arrives, and a collateral withdrawal refreshes every collateral key and the premium. */
export function aavePoststateFixture(standing: StillAaveStandingV1, operation: 'borrow' | 'repay', amount: bigint, patch?: (phase: AavePhaseFixture, after: boolean) => void, returning = false) {
  const probes = buildAaveV4PoststateProbesV1(standing, operation);
  if (!probes.ok) throw Error(probes.detail);
  const aave = standing.snapshot.aave!;
  const before: AavePhaseFixture = { positions: new Map(standing.positions.map(p => [p.reserveId, clone(p)])), supplied: new Map(aave.reserves.map(r => [r.info.reserveId, r.supplied.ok ? r.supplied.value : ZERO])),
    debts: new Map(aave.reserves.map(r => [r.info.reserveId, r.info.role.kind === 'usdc' ? standing.debtAssets : ZERO])),
    enabled: new Map(aave.reserves.map(r => [r.info.reserveId, r.status.ok && r.status.value.usingAsCollateral])), wallets: new Map([...standing.snapshot.balances].map(([k, v]) => [k, v.ok ? v.value : ZERO])),
    allowance: BigInt(777), riskPremium: ZERO, drawnIndex: RAY, healthFactor: BigInt(5) * WAD };
  patch?.(before, false);
  const after = clone(before), loan = after.positions.get(standing.loanReserve.reserveId)!;
  if (operation === 'borrow') {
    loan.drawnShares += ceil(amount * RAY, after.drawnIndex);
    const stock = standing.selectedStock!, id = standing.collateralReserve!.reserveId;
    after.positions.get(id)!.suppliedShares += standing.collateralSupplyAssets;
    after.supplied.set(id, after.supplied.get(id)! + standing.collateralSupplyAssets);
    after.enabled.set(id, true);
    after.wallets.set(stock.token.toLowerCase(), after.wallets.get(stock.token.toLowerCase())! - standing.collateralSupplyAssets);
    after.wallets.set(ADDRESSES.usdc.toLowerCase(), after.wallets.get(ADDRESSES.usdc.toLowerCase())! + amount);
    loan.premiumShares = ceil(loan.drawnShares * after.riskPremium, BigInt(10_000));
    const old = before.positions.get(standing.loanReserve.reserveId)!;
    const premium = old.premiumShares * after.drawnIndex - old.premiumOffsetRay;
    loan.premiumOffsetRay = loan.premiumShares * after.drawnIndex - premium;
  } else {
    const premium = loan.premiumShares * after.drawnIndex - loan.premiumOffsetRay;
    const principal = ceil(loan.drawnShares * after.drawnIndex, RAY), premiumDebt = ceil(premium, RAY);
    const restoredPremium = amount >= premiumDebt ? premium : amount * RAY;
    const principalAmount = amount >= principal + premiumDebt ? principal : amount >= premiumDebt ? amount - premiumDebt : ZERO;
    const debit = principalAmount + ceil(restoredPremium, RAY);
    loan.drawnShares -= principalAmount * RAY / after.drawnIndex;
    loan.premiumShares = ceil(loan.drawnShares * after.riskPremium, BigInt(10_000));
    loan.premiumOffsetRay = loan.premiumShares * after.drawnIndex - (premium - restoredPremium);
    after.wallets.set(ADDRESSES.usdc.toLowerCase(), after.wallets.get(ADDRESSES.usdc.toLowerCase())! - debit);
  }
  if (returning) {
    const id = standing.collateralReserve!.reserveId, token = standing.selectedStock!.token.toLowerCase(), deposit = after.supplied.get(id)!;
    after.positions.get(id)!.suppliedShares = ZERO; after.supplied.set(id, ZERO);
    after.wallets.set(token, after.wallets.get(token)! + deposit);
    if (before.enabled.get(id)) {
      after.riskPremium = ZERO;
      for (const r of standing.reserves) if (after.enabled.get(r.reserveId)) after.positions.get(r.reserveId)!.dynamicConfigKey = r.dynamicConfigKey;
    }
  }
  const debtOf = (p: TestPosition, m: AavePhaseFixture) => ceil(p.drawnShares * m.drawnIndex, RAY) + ceil(p.premiumShares * m.drawnIndex - p.premiumOffsetRay, RAY);
  after.debts.set(standing.loanReserve.reserveId, debtOf(loan, after));
  // Taking the stock back with no debt left approves and repays nothing.
  after.allowance = (operation === 'repay' && !(returning && amount === ZERO)) || standing.collateralSupplyAssets > ZERO ? ZERO : before.allowance;
  patch?.(after, true);
  const output = (phase: AavePhaseFixture, data: Hex, to: string): Hex => {
    if (data.startsWith('0xd4197e82')) return encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [WAD, false]);
    const decoded = decodeFunctionData({ abi: allAbi, data });
    const args = decoded.args as readonly unknown[] | undefined, name = decoded.functionName;
    const id = Number(args?.[0] ?? 0), info = standing.reserves.find(r => r.reserveId === id), source = aave.reserves.find(r => r.info.reserveId === id);
    let result: unknown;
    switch (name) {
      case 'getBlockNumber': result = standing.snapshot.block.number; break;
      case 'getCurrentBlockTimestamp': result = standing.snapshot.block.timestamp; break;
      case 'getReserveCount': result = BigInt(standing.reserves.length); break;
      case 'ORACLE': result = ADDRESSES.aaveOracle; break;
      case 'getUserLastRiskPremium': result = phase.riskPremium; break;
      case 'getAssetDrawnIndex': result = phase.drawnIndex; break;
      case 'getAssetLiquidity': result = aave.usdcLiquidity.ok ? aave.usdcLiquidity.value : ZERO; break;
      case 'getSpokeTotalOwed': result = aave.usdcSpokeOwed.ok ? aave.usdcSpokeOwed.value : ZERO; break;
      case 'balanceOf': result = phase.wallets.get(to.toLowerCase()) ?? ZERO; break;
      case 'allowance': result = phase.allowance; break;
      case 'previewAddByAssets': result = standing.collateralSupplyAssets; break;
      case 'getUserAccountData': result = { riskPremium: phase.riskPremium, avgCollateralFactor: BigInt(7000), healthFactor: phase.healthFactor,
        totalCollateralValue: BigInt(42_000_000_000), totalDebtValueRay: phase.debts.get(standing.loanReserve.reserveId)! * RAY, activeCollateralCount: BigInt(1), borrowCount: BigInt(1) }; break;
      case 'getReserve': result = { underlying: phase.changeInfo ? ADDRESSES.usdc : info!.underlying as Address, hub: ADDRESSES.aaveHub,
        assetId: info!.hubAssetId, decimals: info!.decimals, collateralRisk: 100, flags: 0, dynamicConfigKey: info!.dynamicConfigKey }; break;
      case 'getReserveConfig': result = { collateralRisk: 100, paused: false, frozen: false, borrowable: source!.info.role.kind === 'usdc', receiveSharesEnabled: false }; break;
      case 'getSpokeConfig': result = { addCap: Number(standing.universe.aave.ok ? standing.universe.aave.noCap : ZERO), drawCap: Number(standing.universe.aave.ok ? standing.universe.aave.noCap : ZERO), riskPremiumThreshold: 0, active: true, halted: false }; break;
      case 'getDynamicReserveConfig': result = { collateralFactor: Number(source!.factorBps.ok ? source!.factorBps.value : ZERO), maxLiquidationBonus: 10500, liquidationFee: 1000 }; break;
      case 'getReservePrice': result = (source!.price.ok ? source!.price.value : ZERO) + (phase.priceChange ? BigInt(1) : ZERO); break;
      case 'getUserPosition': { const { reserveId: _unused, ...p } = phase.positions.get(id)!; result = p; break; }
      case 'getUserSuppliedAssets': result = phase.supplied.get(id); break;
      case 'getUserTotalDebt': result = phase.debts.get(id); break;
      case 'getUserReserveStatus': result = [phase.enabled.get(id), phase.positions.get(id)!.drawnShares > ZERO]; break;
      default: throw Error(`fixture unknown getter ${name}`);
    }
    return encode({ abi: allAbi, functionName: name, result });
  };
  const results = (['before', 'after'] as const).flatMap(phase => probes.observations[phase].map(probe => {
    const calls = decodeFunctionData({ abi: aaveV4PoststateAggregateAbiV1, data: probe.data as Hex }).args[0];
    const model = phase === 'before' ? before : after;
    const returnData = encodeFunctionResult({ abi: aaveV4PoststateAggregateAbiV1, functionName: 'aggregate3', result: calls.map(call => ({ success: true, returnData: output(model, call.callData, call.target) })) });
    return { ...probe, phase, status: 'success' as const, returnData };
  }));
  const callsHash = `0x${'ab'.repeat(32)}`;
  const request = { chainId: 8453 as const, walletAddress: AAVE_TEST_WALLET, callsHash, observations: probes.observations };
  const response = { blockNumber: standing.blockNumber, observations: { requestHash: stableHashV1('simulation-observations/v1', {
    chainId: 8453, walletAddress: AAVE_TEST_WALLET, callsHash, before: probes.observations.before, after: probes.observations.after,
  }), results } };
  return { request, response, before, after };
}
