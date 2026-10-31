// What-if questions, answered by the engine that answers the Mirror.
//
// A scenario edits the chain reading a report was computed from (a price, a debt, a deposit) and
// computes the report again with computeMirror. Every figure in a scenario therefore comes from
// the same arithmetic as the page: Still's shares, the weekend and earnings rules, Aave's caps,
// Morpho's shares and interest. Nothing here estimates. An edit the reading cannot carry, because
// a value it needs was not read, is refused and says which edit.

import {
  MORPHO_VIRTUAL_ASSETS_V1,
  MORPHO_VIRTUAL_SHARES_V1,
  morphoAccruedTotalsV1,
  mulDivUpV1,
  toAssetsUpV1,
  toSharesDownV1,
} from '@mioagent/rwa-issuer/morphoBorrowMath';
import { BPS, WAD, mulDiv } from './math.js';
import { computeMirror, type MirrorInput } from './mirror.js';
import { safetyFromHealthFactor } from './policy.js';
import type { AaveReserveSnapshot, MorphoSnapshot, WalletSnapshot } from './read.js';
import { CRYPTO, STOCKS, type AssetId, type CryptoId } from './registry.js';
import type { MirrorReport } from './report.js';
import type { Outcome } from './rpc.js';

/** A loan a scenario can change: the Aave V4 spoke, or one Morpho market by its collateral. */
export type ScenarioVenueV1 = 'aave-v4' | `morpho:${CryptoId}`;

export type ScenarioEditV1 =
  /** A price moves by `changeBps`: −3000 is a 30% fall, 2000 a 20% rise. */
  | { kind: 'price'; asset: AssetId; changeBps: number }
  /** A price goes to a dollar figure, in cents per whole token. */
  | { kind: 'price_to'; asset: AssetId; cents: bigint }
  /** More USDC borrowed on a loan, in USDC base units. */
  | { kind: 'borrow'; venue: ScenarioVenueV1; usdcAtomic: bigint }
  /** USDC paid back, in base units, or the whole debt. */
  | { kind: 'repay'; venue: ScenarioVenueV1; usdcAtomic: bigint | 'all' }
  /** Collateral pledged: tokens already in the wallet, or tokens the wallet does not hold yet. */
  | { kind: 'deposit'; asset: AssetId; raw: bigint; source: 'wallet' | 'new' };

export type ScenarioRefusalV1 =
  /** A value the edit needs was not read at this block. */
  | 'unread'
  /** The edit is outside what one question may ask: a fall of 100% or more, a zero amount. */
  | 'out_of_range'
  /** A repayment where nothing is owed. */
  | 'no_debt'
  /** A borrow on a market where nothing is pledged: Get money pledges and borrows in one step. */
  | 'no_collateral'
  /** More than the venue has to lend. */
  | 'exceeds_liquidity'
  /** A deposit from the wallet of more than the wallet holds. */
  | 'exceeds_wallet';

export type ScenarioOutcomeV1 =
  | { ok: true; before: MirrorReport; after: MirrorReport; edits: readonly ScenarioEditV1[] }
  | { ok: false; reason: ScenarioRefusalV1; edit: ScenarioEditV1 };

class Refused extends Error {
  constructor(readonly reason: ScenarioRefusalV1, readonly edit: ScenarioEditV1) {
    super(reason);
  }
}

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const unread = <T>(): Outcome<T> => ({ ok: false, reason: 'reverted' });

function readOr<T>(outcome: Outcome<T> | undefined, edit: ScenarioEditV1): T {
  if (!outcome?.ok) throw new Refused('unread', edit);
  return outcome.value;
}

function stockReserve(snapshot: WalletSnapshot, asset: AssetId, edit: ScenarioEditV1): AaveReserveSnapshot {
  const reserve = snapshot.aave?.reserves.find((r) => r.info.role.kind === 'stock' && r.info.role.asset.id === asset);
  if (!reserve) throw new Refused('unread', edit);
  return reserve;
}

function morphoMarket(snapshot: WalletSnapshot, asset: CryptoId, edit: ScenarioEditV1): MorphoSnapshot {
  const market = snapshot.morpho.get(asset);
  if (!market) throw new Refused('unread', edit);
  return market;
}

const isStock = (asset: AssetId): boolean => STOCKS.some((s) => s.id === asset);

function applyPrice(snapshot: WalletSnapshot, edit: Extract<ScenarioEditV1, { kind: 'price' }>): void {
  if (!Number.isInteger(edit.changeBps) || edit.changeBps <= -10_000 || edit.changeBps > 100_000) {
    throw new Refused('out_of_range', edit);
  }
  const scale = (price: bigint) => mulDiv(price, BPS + BigInt(edit.changeBps), BPS, 'down');
  if (isStock(edit.asset)) {
    const reserve = stockReserve(snapshot, edit.asset, edit);
    reserve.price = ok(scale(readOr(reserve.price, edit)));
    return;
  }
  const market = morphoMarket(snapshot, edit.asset as CryptoId, edit);
  market.price = ok(scale(readOr(market.price, edit)));
}

function applyPriceTo(input: MirrorInput, snapshot: WalletSnapshot, edit: Extract<ScenarioEditV1, { kind: 'price_to' }>): void {
  if (edit.cents <= 0n) throw new Refused('out_of_range', edit);
  if (isStock(edit.asset)) {
    if (!input.universe.aave.ok) throw new Refused('unread', edit);
    const reserve = stockReserve(snapshot, edit.asset, edit);
    readOr(reserve.price, edit);
    // The Aave oracle quotes a whole token in its own decimals.
    reserve.price = ok(edit.cents * 10n ** BigInt(Math.max(0, input.universe.aave.oracleDecimals - 2)));
    return;
  }
  const asset = CRYPTO.find((c) => c.id === edit.asset)!;
  const market = morphoMarket(snapshot, asset.id, edit);
  readOr(market.price, edit);
  // Morpho prices one raw unit of collateral in raw USDC, scaled by 1e36.
  market.price = ok((edit.cents * 10n ** 4n * 10n ** 36n) / 10n ** BigInt(asset.decimals));
}

function applyAaveDebt(snapshot: WalletSnapshot, edit: Extract<ScenarioEditV1, { kind: 'borrow' | 'repay' }>): void {
  const aave = snapshot.aave;
  if (!aave) throw new Refused('unread', edit);
  const debt = readOr(aave.usdcDebt, edit);
  let change: bigint;
  if (edit.kind === 'borrow') {
    const pledged = aave.reserves.some((r) => r.info.role.kind === 'stock' && r.supplied.ok && r.supplied.value > 0n);
    if (!pledged) throw new Refused('no_collateral', edit);
    change = edit.usdcAtomic;
    if (aave.usdcLiquidity.ok && change > aave.usdcLiquidity.value) throw new Refused('exceeds_liquidity', edit);
  } else {
    if (debt === 0n) throw new Refused('no_debt', edit);
    const paid = edit.usdcAtomic === 'all' || edit.usdcAtomic > debt ? debt : edit.usdcAtomic;
    change = -paid;
  }
  aave.usdcDebt = ok(debt + change);
  if (aave.usdcSpokeOwed.ok) aave.usdcSpokeOwed = ok(aave.usdcSpokeOwed.value + change > 0n ? aave.usdcSpokeOwed.value + change : 0n);
  if (aave.usdcLiquidity.ok) aave.usdcLiquidity = ok(aave.usdcLiquidity.value - change);
}

function applyMorphoDebt(snapshot: WalletSnapshot, asset: CryptoId, edit: Extract<ScenarioEditV1, { kind: 'borrow' | 'repay' }>): void {
  const market = morphoMarket(snapshot, asset, edit);
  const position = readOr(market.position, edit);
  // Interest since the market's last write is added first, as the contract does on any call.
  const totals = morphoAccruedTotalsV1(readOr(market.market, edit), readOr(market.borrowRatePerSecond, edit), snapshot.block.timestamp);
  let assets: bigint;
  let shares: bigint;
  if (edit.kind === 'borrow') {
    if (position.collateral === 0n) throw new Refused('no_collateral', edit);
    assets = edit.usdcAtomic;
    if (assets > totals.totalSupplyAssets - totals.totalBorrowAssets) throw new Refused('exceeds_liquidity', edit);
    shares = mulDivUpV1(assets, totals.totalBorrowShares + MORPHO_VIRTUAL_SHARES_V1, totals.totalBorrowAssets + MORPHO_VIRTUAL_ASSETS_V1);
  } else {
    if (position.borrowShares === 0n) throw new Refused('no_debt', edit);
    const owed = toAssetsUpV1(position.borrowShares, totals.totalBorrowAssets, totals.totalBorrowShares);
    if (edit.usdcAtomic === 'all' || edit.usdcAtomic >= owed) {
      shares = position.borrowShares;
      assets = owed;
    } else {
      shares = toSharesDownV1(edit.usdcAtomic, totals.totalBorrowAssets, totals.totalBorrowShares);
      assets = edit.usdcAtomic;
    }
    shares = -shares;
    assets = -assets;
  }
  const borrowAssets = totals.totalBorrowAssets + assets;
  market.market = ok({
    ...totals,
    totalBorrowAssets: borrowAssets > 0n ? borrowAssets : 0n,
    totalBorrowShares: totals.totalBorrowShares + shares,
    lastUpdate: snapshot.block.timestamp,
  });
  market.position = ok({ ...position, borrowShares: position.borrowShares + shares });
}

function applyDeposit(snapshot: WalletSnapshot, edit: Extract<ScenarioEditV1, { kind: 'deposit' }>): void {
  if (edit.raw <= 0n) throw new Refused('out_of_range', edit);
  if (isStock(edit.asset)) {
    const reserve = stockReserve(snapshot, edit.asset, edit);
    const supplied = readOr(reserve.supplied, edit);
    if (edit.source === 'wallet') {
      const key = reserve.info.underlying.toLowerCase();
      const held = readOr(snapshot.balances.get(key), edit);
      if (held < edit.raw) throw new Refused('exceeds_wallet', edit);
      snapshot.balances.set(key, ok(held - edit.raw));
    }
    reserve.supplied = ok(supplied + edit.raw);
    if (reserve.spokeAdded.ok) reserve.spokeAdded = ok(reserve.spokeAdded.value + edit.raw);
    reserve.status = ok({ usingAsCollateral: true, borrowing: reserve.status.ok ? reserve.status.value.borrowing : false });
    // A new supply is held under the reserve's current factor.
    if (!reserve.userFactorBps.ok || supplied === 0n) reserve.userFactorBps = reserve.factorBps;
    return;
  }
  const asset = CRYPTO.find((c) => c.id === edit.asset)!;
  const market = morphoMarket(snapshot, asset.id, edit);
  const position = readOr(market.position, edit);
  if (edit.source === 'wallet') {
    const key = asset.token.toLowerCase();
    const tokens = readOr(snapshot.balances.get(key), edit);
    const native = asset.includesNativeEth ? readOr(snapshot.nativeEth, edit) : 0n;
    if (tokens + native < edit.raw) throw new Refused('exceeds_wallet', edit);
    // Wrapped tokens go first; native ETH makes up the rest, as Get money wraps it.
    const fromTokens = tokens < edit.raw ? tokens : edit.raw;
    snapshot.balances.set(key, ok(tokens - fromTokens));
    if (edit.raw > fromTokens) snapshot.nativeEth = ok(native - (edit.raw - fromTokens));
  }
  market.position = ok({ ...position, collateral: position.collateral + edit.raw });
}

function apply(input: MirrorInput, snapshot: WalletSnapshot, edit: ScenarioEditV1): void {
  if (edit.kind === 'price') return applyPrice(snapshot, edit);
  if (edit.kind === 'price_to') return applyPriceTo(input, snapshot, edit);
  if (edit.kind === 'deposit') return applyDeposit(snapshot, edit);
  if (edit.kind === 'borrow' && edit.usdcAtomic <= 0n) throw new Refused('out_of_range', edit);
  if (edit.kind === 'repay' && edit.usdcAtomic !== 'all' && edit.usdcAtomic <= 0n) throw new Refused('out_of_range', edit);
  if (edit.venue === 'aave-v4') return applyAaveDebt(snapshot, edit);
  return applyMorphoDebt(snapshot, edit.venue.slice('morpho:'.length) as CryptoId, edit);
}

/** The same reading with the protocol's own health factor set aside, so the engine computes it. */
function withComputedHealth(input: MirrorInput, snapshot: WalletSnapshot): MirrorInput {
  return { ...input, snapshot: { ...snapshot, aave: snapshot.aave ? { ...snapshot.aave, account: unread() } : null } };
}

/**
 * The report the edits would give, beside the report as read.
 *
 * Aave states its own health factor, and the page shows that one. A scenario cannot ask the
 * protocol, so the engine computes the health factor before and after from the same weighted
 * collateral and the scenario moves the protocol's figure by that ratio: the change is the
 * engine's, the starting point is the one the person already sees.
 */
export function scenarioV1(input: MirrorInput, edits: readonly ScenarioEditV1[]): ScenarioOutcomeV1 {
  const snapshot = structuredClone(input.snapshot);
  try {
    for (const edit of edits) apply(input, snapshot, edit);
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason, edit: error.edit };
    throw error;
  }
  const before = computeMirror(input);
  const after = computeMirror(withComputedHealth(input, snapshot));
  const protocol = before.venues.find((v) => v.venue === 'aave-v4')?.safety;
  const afterAave = after.venues.find((v) => v.venue === 'aave-v4');
  if (protocol?.source === 'protocol' && afterAave?.safety) {
    const computedBefore = computeMirror(withComputedHealth(input, input.snapshot)).venues.find((v) => v.venue === 'aave-v4')?.safety;
    if (computedBefore && BigInt(computedBefore.healthFactor) > 0n) {
      const healthFactor = mulDiv(BigInt(protocol.healthFactor), BigInt(afterAave.safety.healthFactor), BigInt(computedBefore.healthFactor), 'down');
      const { marginBps, state } = safetyFromHealthFactor(healthFactor);
      afterAave.safety = { healthFactor: healthFactor.toString(), marginBps: Number(marginBps), state, source: 'computed' };
    }
  }
  return { ok: true, before, after, edits };
}

/**
 * A health factor as people read it: 1.47, two decimals, rounded down so it never flatters. A
 * billionth of slack comes first, so a wei lost to division cannot turn 1.05 into 1.04.
 */
export function healthFactorTextV1(healthFactorWad: string | bigint): string {
  const hundredths = mulDiv(BigInt(healthFactorWad) + 10n ** 9n, 100n, WAD, 'down');
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}
