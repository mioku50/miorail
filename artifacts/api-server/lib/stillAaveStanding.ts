import { keccak256, type Address } from 'viem';
import { createEarningsCalendar, createProviders, earningsWindow, stillShareBps, weekendWindow, type CalendarRead, type StockAsset } from '@mioagent/still-engine';
import { readWallet, type Universe, type WalletSnapshot } from '@mioagent/still-engine/read';
import { ADDRESSES, STOCKS, type StockId } from '@mioagent/still-engine/registry';
import { aaveSpokeAbi, aaveHubAbi, aaveOracleAbi } from '@mioagent/still-engine/abi';
import { Batch } from '@mioagent/still-engine/rpc';
import { TERMS } from '@mioagent/still-engine/policy';
import { stillRpcUrlsV1 } from './stillMirror.js';
import { AAVE_V4_DEPLOYMENT_PIN_V1, matchesAaveV4DeploymentV1, type AaveV4DeploymentReadV1, type AaveV4ReserveBindingV1 } from './aaveV4BorrowPlan.js';

const ZERO = BigInt(0), BPS = BigInt(10_000), USDC = BigInt(1_000_000), CENT = BigInt(10_000);
const UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const unsigned = (a: bigint) => typeof a === 'bigint' && a >= ZERO && a <= UINT256;

export interface AaveV4UserPositionV1 {
  reserveId: number;
  drawnShares: bigint;
  premiumShares: bigint;
  premiumOffsetRay: bigint;
  suppliedShares: bigint;
  dynamicConfigKey: number;
}
export interface StillAaveSnapshotV1 {
  universe: Universe;
  snapshot: WalletSnapshot;
  deployment: AaveV4DeploymentReadV1;
  /** Fresh reserve identities and latest dynamic keys at snapshot.block. */
  reserves: AaveV4ReserveBindingV1[];
  positions: AaveV4UserPositionV1[];
}
export interface StillAaveCapacityV1 {
  limitAssets: bigint;
  protocolLimitAssets: bigint;
  debtAssets: bigint;
  liquidityAssets: bigint;
  availableAssets: bigint;
  /** Each contributing stock names its actual financial-policy haircut. */
  shareBpsByStock: Partial<Record<StockId, number>>;
}
export interface StillAaveStandingV1 extends StillAaveSnapshotV1 {
  walletAddress: Address;
  readAt: string;
  blockNumber: number;
  blockTimestamp: bigint;
  operation: 'borrow' | 'repay';
  selectedStock: StockAsset | null;
  collateralReserve: AaveV4ReserveBindingV1 | null;
  loanReserve: AaveV4ReserveBindingV1;
  collateralSupplyAssets: bigint;
  existingSuppliedAssets: bigint;
  walletCollateralAssets: bigint;
  walletUsdcAssets: bigint;
  collateralAlreadyEnabled: boolean;
  debtAssets: bigint;
  capacity: StillAaveCapacityV1 | null;
  calendar: CalendarRead;
  termsVersion: string;
}
export type StillAaveReadingV1 =
  | { state: 'read'; standing: StillAaveStandingV1 }
  | { state: 'refused'; refusal: 'aave_inputs_invalid' | 'aave_unread' | 'aave_deployment_changed' | 'aave_reserve_mismatch' | 'aave_position_unread' | 'aave_funding_insufficient' | 'aave_borrow_closed' | 'aave_capacity_unread'; detail: string };

export interface StillAaveReaderDepsV1 {
  now?: () => Date;
  snapshot?: (wallet: Address) => Promise<StillAaveSnapshotV1>;
  calendar?: () => Promise<CalendarRead>;
}
const refuse = (refusal: Extract<StillAaveReadingV1, { state: 'refused' }>['refusal'], detail: string): StillAaveReadingV1 => ({ state: 'refused', refusal, detail });
let providers: ReturnType<typeof createProviders> | null = null;
const calendarSource = createEarningsCalendar();

async function freshSnapshot(wallet: Address): Promise<StillAaveSnapshotV1> {
  providers ??= createProviders(stillRpcUrlsV1(), 'miorail-still-aave/1');
  for (const provider of providers) {
    try {
      const at = await provider.client.getBlockNumber();
      const [chainId, slot, proxyCode] = await Promise.all([
        provider.client.getChainId(),
        provider.client.getStorageAt({ address: ADDRESSES.aaveSpoke, slot: AAVE_V4_DEPLOYMENT_PIN_V1.implementationSlot, blockNumber: at }),
        provider.client.getBytecode({ address: ADDRESSES.aaveSpoke, blockNumber: at }),
      ]);
      if (!slot || !/^0x0{24}[a-fA-F0-9]{40}$/.test(slot) || !proxyCode || proxyCode === '0x') throw new Error('aave_deployment_unread');
      const implementationAddress = `0x${slot.slice(-40)}` as Address;
      const implementationCode = await provider.client.getBytecode({ address: implementationAddress, blockNumber: at });
      if (!implementationCode || implementationCode === '0x' || at <= ZERO || at > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('aave_deployment_unread');
      const deployment: AaveV4DeploymentReadV1 = { chainId, blockNumber: Number(at), implementationAddress,
        implementationCodeHash: keccak256(implementationCode), proxyCodeHash: keccak256(proxyCode) };
      if (!matchesAaveV4DeploymentV1(deployment)) throw new Error('aave_deployment_changed');
      const first = new Batch();
      const oracle = first.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'ORACLE', []);
      const count = first.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getReserveCount', []);
      const decimals = first.add(ADDRESSES.aaveOracle, aaveOracleAbi, 'decimals', []);
      const noCap = first.add(ADDRESSES.aaveHub, aaveHubAbi, 'MAX_ALLOWED_SPOKE_CAP', []);
      await first.run([provider], at);
      const n = need(count.outcome);
      if (n < BigInt(2) || n > BigInt(8) || !same(need(oracle.outcome), ADDRESSES.aaveOracle)) throw new Error('aave_universe_unread');
      const second = new Batch();
      const slots = Array.from({ length: Number(n) }, (_, reserveId) => ({ reserveId,
        reserve: second.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getReserve', [BigInt(reserveId)]),
        source: second.add(ADDRESSES.aaveOracle, aaveOracleAbi, 'getReserveSource', [BigInt(reserveId)]),
        position: second.add(ADDRESSES.aaveSpoke, aaveSpokeAbi, 'getUserPosition', [BigInt(reserveId), wallet]),
      }));
      await second.run([provider], at);
      const infos = slots.map(({ reserveId, reserve, source }) => {
        const r = need(reserve.outcome), stock = STOCKS.find(s => same(s.token, r.underlying));
        const role = stock ? { kind: 'stock' as const, asset: stock } : same(r.underlying, ADDRESSES.usdc) ? { kind: 'usdc' as const } : { kind: 'other' as const };
        return { reserveId, underlying: r.underlying, hubAssetId: r.assetId, decimals: r.decimals, dynamicConfigKey: r.dynamicConfigKey,
          priceSource: need(source.outcome), role };
      });
      const usdc = infos.filter(r => r.role.kind === 'usdc');
      if (usdc.length !== 1) throw new Error('aave_universe_unread');
      const universe: Universe = { loadedAt: new Date(), provider: provider.label, morpho: [], aave: { ok: true,
        oracleDecimals: need(decimals.outcome), noCap: BigInt(need(noCap.outcome)), reserves: infos, usdc: usdc[0]! } };
      const snapshot = await readWallet([provider], universe, wallet, at);
      const reserves = slots.map(({ reserveId, reserve }) => {
        const r = need(reserve.outcome);
        return { reserveId, underlying: r.underlying, hub: r.hub, hubAssetId: r.assetId, decimals: r.decimals, dynamicConfigKey: r.dynamicConfigKey };
      });
      const positions = slots.map(({ reserveId, position }) => ({ reserveId, ...need(position.outcome) }));
      return { universe, snapshot, deployment, reserves, positions };
    } catch { /* Fall back only at a new explicitly pinned block. */ }
  }
  throw new Error('aave_deployment_unread');
}

/** Whole reviewed Spoke only; another reserve/loan cannot be quietly omitted. */
export function validAaveReserveBindingsV1(read: StillAaveSnapshotV1): boolean {
  if (!read.universe.aave.ok || !read.snapshot.aave || read.reserves.length < 2 || read.reserves.length > 8 || read.reserves.length !== read.universe.aave.reserves.length || read.reserves.length !== read.snapshot.aave.reserves.length || read.positions.length !== read.reserves.length) return false;
  if (new Set(read.reserves.map(r => r.reserveId)).size !== read.reserves.length || new Set(read.reserves.map(r => r.underlying.toLowerCase())).size !== read.reserves.length || new Set(read.reserves.map(r => r.hubAssetId)).size !== read.reserves.length) return false;
  return read.reserves.every((r, index) => {
    const info = read.universe.aave.ok ? read.universe.aave.reserves.find(v => v.reserveId === r.reserveId) : undefined;
    const snap = read.snapshot.aave?.reserves.find(v => v.info.reserveId === r.reserveId);
    const stock = STOCKS.find(s => same(s.token, r.underlying));
    const position = read.positions[index];
    return r.reserveId === index && !!info && !!snap && position?.reserveId === r.reserveId &&
      [position.drawnShares, position.premiumShares, position.suppliedShares].every(v => unsigned(v) && v < (BigInt(1) << BigInt(120))) &&
      position.premiumOffsetRay >= -(BigInt(1) << BigInt(199)) && position.premiumOffsetRay < (BigInt(1) << BigInt(199)) &&
      Number.isSafeInteger(position.dynamicConfigKey) && position.dynamicConfigKey >= 0 && position.dynamicConfigKey <= 4294967295 &&
      Number.isInteger(r.dynamicConfigKey) && r.dynamicConfigKey >= 0 && r.dynamicConfigKey <= 4294967295 &&
      same(r.hub, ADDRESSES.aaveHub) && same(r.underlying, info.underlying) && same(r.underlying, snap.info.underlying) && r.hubAssetId === info.hubAssetId &&
      (stock ? r.decimals === stock.decimals && info.role.kind === 'stock' && info.role.asset.id === stock.id : same(r.underlying, ADDRESSES.usdc) && r.decimals === 6 && info.role.kind === 'usdc');
  });
}

/** Rechecks deployed proxy/runtime at the exact simulation or receipt block. */
export async function readAaveV4DeploymentAtV1(blockNumber: number): Promise<AaveV4DeploymentReadV1 | null> {
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) return null;
  providers ??= createProviders(stillRpcUrlsV1(), 'miorail-still-aave/1');
  for (const provider of providers) {
    try {
      const at = BigInt(blockNumber);
      const [chainId, slot, proxyCode] = await Promise.all([
        provider.client.getChainId(),
        provider.client.getStorageAt({ address: ADDRESSES.aaveSpoke, slot: AAVE_V4_DEPLOYMENT_PIN_V1.implementationSlot, blockNumber: at }),
        provider.client.getBytecode({ address: ADDRESSES.aaveSpoke, blockNumber: at }),
      ]);
      if (!slot || !/^0x0{24}[a-fA-F0-9]{40}$/.test(slot) || !proxyCode || proxyCode === '0x') continue;
      const implementationAddress = `0x${slot.slice(-40)}` as Address;
      const implementationCode = await provider.client.getBytecode({ address: implementationAddress, blockNumber: at });
      if (!implementationCode || implementationCode === '0x') continue;
      return { chainId, blockNumber, implementationAddress, implementationCodeHash: keccak256(implementationCode), proxyCodeHash: keccak256(proxyCode) };
    } catch { /* Only a pinned successful read is an answer. */ }
  }
  return null;
}

export async function readAaveStandingV1(input: {
  tokenAddress?: string;
  walletAddress: string;
  collateralSupplyAssets?: bigint;
  operation: 'borrow' | 'repay';
  deps?: StillAaveReaderDepsV1;
}): Promise<StillAaveReadingV1> {
  const stock = input.tokenAddress ? STOCKS.find(s => same(s.token, input.tokenAddress!)) : undefined;
  if (input.tokenAddress && !stock && !(input.operation === 'repay' && same(input.tokenAddress, ADDRESSES.usdc))) return refuse('aave_inputs_invalid', 'The collateral must be an exact registered stock address.');
  return readStillAaveStandingV1({ walletAddress: input.walletAddress, stockId: stock?.id, operation: input.operation, collateralSupplyAssets: input.collateralSupplyAssets, deps: input.deps });
}

function need<T>(value: { ok: true; value: T } | { ok: false } | undefined): T {
  if (!value?.ok) throw new Error('aave_required_read_missing');
  return value.value;
}
function stockShare(stock: StockId, calendar: CalendarRead, blockAt: Date, now: Date): bigint {
  const dates = calendar.ok ? calendar.calendar.dates.get(stock) : undefined;
  const at = (when: Date) => stillShareBps('stock', weekendWindow(when).active, dates === undefined || earningsWindow(when, dates)?.active === true);
  const blockShare = at(blockAt), nowShare = at(now);
  return blockShare < nowShare ? blockShare : nowShare;
}

/** Aave and Still account for every currently enabled pledged reserve.
 * Wallet tokens only enter when the person explicitly selected this deposit. */
export function stillAaveCapacityV1(input: {
  snapshot: WalletSnapshot;
  universe: Universe;
  calendar: CalendarRead;
  now: Date;
  selectedStockId: StockId;
  additionalCollateralAssets: bigint;
}): StillAaveCapacityV1 {
  const { snapshot, universe, calendar, now } = input;
  if (!universe.aave.ok || !snapshot.aave || !unsigned(input.additionalCollateralAssets)) throw new Error('aave_capacity_unread');
  const aave = snapshot.aave;
  const usdc = aave.reserves.find(r => r.info.role.kind === 'usdc');
  if (!usdc) throw new Error('aave_usdc_missing');
  const usdcPrice = need(usdc.price), debt = need(aave.usdcDebt), liquidity = need(aave.usdcLiquidity), owed = need(aave.usdcSpokeOwed), config = need(usdc.config), spoke = need(usdc.spokeConfig);
  if (usdcPrice <= ZERO || !unsigned(debt) || !unsigned(liquidity) || !unsigned(owed)) throw new Error('aave_capacity_unread');
  const drawRoom = spoke.drawCap === universe.aave.noCap ? liquidity : (spoke.drawCap * USDC > owed ? spoke.drawCap * USDC - owed : ZERO);
  const lendable = config.paused || config.frozen || !config.borrowable || !spoke.active || spoke.halted ? ZERO : (liquidity < drawRoom ? liquidity : drawRoom);
  let limitAssets = ZERO, protocolLimitAssets = ZERO;
  const shareBpsByStock: Partial<Record<StockId, number>> = {};
  const blockAt = new Date(Number(snapshot.block.timestamp) * 1000);
  for (const reserve of aave.reserves) {
    if (reserve.info.role.kind !== 'stock') continue;
    const stock = reserve.info.role.asset, supplied = need(reserve.supplied), status = need(reserve.status);
    const selected = stock.id === input.selectedStockId;
    const additional = selected ? input.additionalCollateralAssets : ZERO;
    const pledged = (status.usingAsCollateral || selected ? supplied : ZERO) + additional;
    if (pledged === ZERO) continue;
    const price = need(reserve.price), latestFactor = need(reserve.factorBps), registry = need(snapshot.coinbase.get(stock.id));
    const userFactor = status.usingAsCollateral ? need(reserve.userFactorBps) : latestFactor;
    const flags = need(reserve.config), caps = need(reserve.spokeConfig);
    // A borrow refreshes all enabled collateral configs. Taking the smaller
    // of the recorded and newest factor also covers the refresh conservatively.
    const factor = latestFactor < userFactor ? latestFactor : userFactor;
    if (price <= ZERO || factor < ZERO || factor > BPS || registry.multiplier <= ZERO || registry.paused || flags.paused || flags.frozen || !caps.active || caps.halted) throw new Error('aave_collateral_unavailable');
    const share = stockShare(stock.id, calendar, blockAt, now);
    shareBpsByStock[stock.id] = Number(share);
    const denominator = (BigInt(10) ** BigInt(stock.decimals)) * BPS * usdcPrice;
    const protocol = pledged * price * factor * USDC / denominator;
    protocolLimitAssets += protocol;
    limitAssets += pledged * price * factor * USDC * share / (denominator * BPS);
  }
  const headroom = limitAssets > debt ? limitAssets - debt : ZERO;
  const atomic = headroom < lendable ? headroom : lendable;
  return { limitAssets, protocolLimitAssets, debtAssets: debt, liquidityAssets: lendable, availableAssets: atomic / CENT * CENT, shareBpsByStock };
}

export async function readStillAaveStandingV1(input: {
  walletAddress: string;
  operation: 'borrow' | 'repay';
  stockId?: StockId;
  collateralSupplyAssets?: bigint;
  deps?: StillAaveReaderDepsV1;
}): Promise<StillAaveReadingV1> {
  const wallet = input.walletAddress.toLowerCase(), supply = input.collateralSupplyAssets ?? ZERO;
  const selectedStock = input.stockId ? STOCKS.find(s => s.id === input.stockId) ?? null : null;
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || /^0x0{40}$/.test(wallet) || !unsigned(supply) ||
      (input.operation !== 'borrow' && input.operation !== 'repay') || (input.operation === 'borrow' && !selectedStock) || (input.operation === 'repay' && supply !== ZERO)) return refuse('aave_inputs_invalid', 'The exact registered operation, wallet and selected pledge are required.');
  const now = input.deps?.now?.() ?? new Date();
  let read: StillAaveSnapshotV1;
  try { read = await (input.deps?.snapshot ?? freshSnapshot)(wallet as Address); }
  catch { return refuse('aave_unread', 'Still could not establish this Aave account at one Base block.'); }
  if (!matchesAaveV4DeploymentV1(read.deployment) || read.deployment.blockNumber !== Number(read.snapshot.block.number)) return refuse('aave_deployment_changed', 'The Aave deployment could not be bound to this read block.');
  if (!validAaveReserveBindingsV1(read)) return refuse('aave_reserve_mismatch', 'Every reserve on the reviewed Spoke must match its registered stock or USDC identity.');
  const aave = read.snapshot.aave!;
  const loanReserve = read.reserves.find(r => same(r.underlying, ADDRESSES.usdc))!;
  const collateralReserve = selectedStock ? read.reserves.find(r => same(r.underlying, selectedStock.token)) ?? null : null;
  const selected = collateralReserve ? aave.reserves.find(r => r.info.reserveId === collateralReserve.reserveId) : null;
  let debt: bigint, walletUsdc: bigint, walletCollateral = ZERO, supplied = ZERO, enabled = false;
  try {
    debt = need(aave.usdcDebt); walletUsdc = need(read.snapshot.balances.get(ADDRESSES.usdc.toLowerCase()));
    if (!unsigned(debt) || !unsigned(walletUsdc)) throw new Error('aave_position_unread');
    if (input.operation === 'borrow' && (need(aave.account).borrowCount > BigInt(1) || aave.reserves.some(r => r.info.role.kind !== 'usdc' && need(r.status).borrowing))) throw new Error('aave_position_unread');
    if (selectedStock) {
      if (!selected || !collateralReserve) throw new Error('aave_stock_missing');
      walletCollateral = need(read.snapshot.balances.get(selectedStock.token.toLowerCase())); supplied = need(selected.supplied); enabled = need(selected.status).usingAsCollateral;
      if (!unsigned(walletCollateral) || !unsigned(supplied)) throw new Error('aave_position_unread');
    }
  } catch { return refuse('aave_position_unread', 'The required debt and wallet balances could not be established.'); }
  if (supply > walletCollateral) return refuse('aave_funding_insufficient', 'The explicit stock pledge exceeds this wallet’s measured balance.');
  const calendar = await (input.deps?.calendar ? input.deps.calendar() : calendarSource.current()).catch(() => ({ ok: false as const }));
  let capacity: StillAaveCapacityV1 | null = null;
  if (input.operation === 'borrow') {
    try {
      const flags = need(selected!.config), caps = need(selected!.spokeConfig), added = need(selected!.spokeAdded);
      if (flags.paused || flags.frozen || !caps.active || caps.halted) throw new Error('aave_borrow_closed');
      if (!read.universe.aave.ok || (supply > ZERO && caps.addCap !== read.universe.aave.noCap && added + supply > caps.addCap * BigInt(10) ** BigInt(selectedStock!.decimals))) return refuse('aave_borrow_closed', 'The exact pledge exceeds the registered collateral supply cap.');
      capacity = stillAaveCapacityV1({ ...read, calendar, now, selectedStockId: selectedStock!.id, additionalCollateralAssets: supply });
    } catch { return refuse('aave_capacity_unread', 'Still could not establish a current borrowing allowance for the whole reviewed Aave account.'); }
  }
  return { state: 'read', standing: { ...read, walletAddress: wallet as Address, readAt: now.toISOString(), blockNumber: Number(read.snapshot.block.number), blockTimestamp: read.snapshot.block.timestamp,
    operation: input.operation, selectedStock, collateralReserve, loanReserve, collateralSupplyAssets: supply, existingSuppliedAssets: supplied,
    walletCollateralAssets: walletCollateral, walletUsdcAssets: walletUsdc, collateralAlreadyEnabled: enabled, debtAssets: debt, capacity, calendar, termsVersion: TERMS.version } };
}
