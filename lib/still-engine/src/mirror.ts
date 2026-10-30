// The Mirror computation: from one block's reads to what the wallet could borrow through Still.
//
// Pure and deterministic: the same snapshot always gives the same report. Every amount is an
// integer; capacity and availability round down, debts and liquidation prices round up. Lines are
// rounded to cents first and the headline is their exact sum minus the debts, so a summary never
// disagrees with the rows under it.
//
// Morpho's own arithmetic (accrual, debt, the health check, the liquidation price) comes from
// rwa-issuer's morphoBorrowMath, the module Miorail's borrow review checks a borrow with, so an
// offer here and the review of that borrow cannot disagree.

import {
  morphoAccruedTotalsV1,
  morphoHealthV1,
  morphoLiquidationPriceV1,
  morphoMaxBorrowAssetsV1,
  toAssetsUpV1,
  type MorphoMarketStateV1,
} from '@mioagent/rwa-issuer/morphoBorrowMath';
import { BPS, RAY, WAD, divide, max, min, mulDiv, usdcToCents } from './math.js';
import { morphoStillCapacityV1, stillBorrowLimitV1 } from './capacity.js';
import type { CalendarRead } from './calendar.js';
import { TERMS, earningsWindow, safetyFromHealthFactor, stillShareBps, weekendWindow } from './policy.js';
import type { AaveReserveSnapshot, AaveSnapshot, MorphoSnapshot, Universe, WalletSnapshot } from './read.js';
import { ADDRESSES, CRYPTO, STOCKS, type CryptoAsset, type StockAsset } from './registry.js';
import type {
  AssetLine,
  EarningsNote,
  FailedRead,
  Headline,
  LiquidationPrice,
  MirrorReport,
  Safety,
  TokenAmount,
  VenueLine,
} from './report.js';
import type { Outcome } from './rpc.js';

const SECONDS_PER_YEAR = 31_536_000n;
const USDC_DECIMALS = 6;
const PRICE_SCALE_MORPHO = 10n ** 36n;

const amount = (raw: bigint, decimals: number): TokenAmount => ({ raw: raw.toString(), decimals });

/** capacity − loans − venueLimit = available, each part known only when all three are. */
function deductionsOf(capacity: bigint | null, debt: bigint | null, available: bigint | null): VenueLine['deductions'] {
  if (capacity === null || debt === null || available === null) return { loansCents: null, venueLimitCents: null };
  const loans = min(debt, capacity);
  return { loansCents: loans.toString(), venueLimitCents: (capacity - loans - available).toString() };
}
const cents = (value: bigint | null): string | null => (value === null ? null : value.toString());
const iso = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

/** Collects the reads that failed, so the page can name them and the headline turns into a floor. */
class Ledger {
  readonly failures: FailedRead[] = [];
  need<T>(outcome: Outcome<T> | undefined, what: string, local?: string[]): T | undefined {
    if (outcome?.ok) return outcome.value;
    if (!this.failures.some((f) => f.what === what)) this.failures.push({ what, owner: 'us' });
    local?.push(what);
    return undefined;
  }
}

/** A stock's earnings note at the block's time, and the name of the read that failed, if one did. */
type EarningsOf = (asset: StockAsset) => { note: EarningsNote; failed: string | null };

function earningsFrom(calendar: CalendarRead, at: Date): EarningsOf {
  return (asset) => {
    const dates = calendar.ok ? calendar.calendar.dates.get(asset.id) : undefined;
    if (dates === undefined) {
      // Not knowing when a company reports counts as being inside its window.
      const failed = calendar.ok ? `${asset.id} earnings date` : 'Earnings calendar (Aave API)';
      return { note: { source: 'unread', reportDate: null, window: null, lowered: true }, failed };
    }
    const window = earningsWindow(at, dates);
    return {
      note: {
        source: 'calendar',
        reportDate: window?.reportDate ?? null,
        window: window ? { startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString() } : null,
        lowered: window?.active ?? false,
      },
      failed: null,
    };
  };
}

interface Computed {
  lines: AssetLine[];
  venues: VenueLine[];
  /** Every input to some venue's available amount was read. */
  complete: boolean;
}

function stockLine(asset: StockAsset): AssetLine {
  return {
    asset: asset.id,
    kind: 'stock',
    name: asset.name,
    symbol: asset.id,
    token: asset.token,
    isin: asset.isin,
    venue: 'aave-v4',
    wallet: null,
    pledged: null,
    shares: null,
    priceCents: null,
    priceUpdatedAt: null,
    valueCents: null,
    protocolFactorBps: null,
    stillFactorBps: null,
    capacityCents: null,
    earnings: null,
    limits: [],
    failed: [],
  };
}

function computeAave(universe: Universe, snapshot: WalletSnapshot, weekend: boolean, earningsOf: EarningsOf, ledger: Ledger): Computed {
  const lines: AssetLine[] = [];
  let complete = true;
  const aave: AaveSnapshot | null = snapshot.aave;

  // The share Still lends at for this stock now, with its earnings note on the line.
  const shareOf = (asset: StockAsset, line: AssetLine): bigint => {
    const { note, failed } = earningsOf(asset);
    line.earnings = note;
    if (failed !== null) ledger.need(undefined, failed, line.failed);
    return stillShareBps('stock', weekend, note.lowered);
  };

  // Wallet balances are read even when the venue is closed, so a holder sees why nothing counts.
  const walletOf = (asset: StockAsset, line: AssetLine): bigint | undefined =>
    ledger.need(snapshot.balances.get(asset.token.toLowerCase()), `${asset.id} wallet balance`, line.failed);

  if (!universe.aave.ok || !aave) {
    for (const asset of STOCKS) {
      const line = stockLine(asset);
      const wallet = walletOf(asset, line);
      if (wallet === undefined || wallet > 0n) {
        line.wallet = wallet === undefined ? null : amount(wallet, asset.decimals);
        ledger.need(undefined, 'Aave V4 Coinbase Stocks spoke', line.failed);
        shareOf(asset, line);
        lines.push(line);
      }
    }
    complete = false;
    return {
      lines,
      complete,
      venues: [
        {
          venue: 'aave-v4',
          market: ADDRESSES.aaveSpoke,
          label: 'Aave V4 · Coinbase Stocks',
          debtCents: null,
          debtAtomic: null,
          capacityCents: null,
          availableCents: null,
          borrowRateBps: null,
          liquidityCents: null,
          deductions: { loansCents: null, venueLimitCents: null },
          safety: null,
          liquidationPrices: [],
          failed: ['Aave V4 Coinbase Stocks spoke'],
        },
      ],
    };
  }

  const { oracleDecimals, noCap } = universe.aave;
  const venueFailed: string[] = [];
  const usdc = aave.reserves.find((r) => r.info.role.kind === 'usdc');
  const usdcPrice = usdc ? ledger.need(usdc.price, 'USDC price on Aave', venueFailed) : undefined;
  const debt = ledger.need(aave.usdcDebt, 'Aave USDC debt', venueFailed);
  const centsPerPriceUnit = 10n ** BigInt(Math.max(0, oracleDecimals - 2));

  // USDC base units a dollar value buys, value in oracle units (1e8 per dollar).
  const toUsdc = (valueTimesBps: bigint, bpsDivisor: bigint): bigint | undefined =>
    usdcPrice === undefined || usdcPrice === 0n
      ? undefined
      : mulDiv(valueTimesBps, 10n ** BigInt(USDC_DECIMALS), bpsDivisor * usdcPrice, 'down');

  let capacityCents = 0n;
  let capacityComplete = true;
  const capacityKnown = usdcPrice !== undefined && usdcPrice > 0n;
  const collateral: Array<{ reserve: AaveReserveSnapshot; asset: StockAsset; supplied: bigint; price: bigint; userFactor: bigint }> = [];

  for (const reserve of aave.reserves) {
    if (reserve.info.role.kind !== 'stock') continue;
    const asset = reserve.info.role.asset;
    const line = stockLine(asset);
    const wallet = walletOf(asset, line);
    const supplied = ledger.need(reserve.supplied, `${asset.id} supplied on Aave`, line.failed);
    if (wallet === 0n && supplied === 0n) continue; // measured: nothing here
    const share = shareOf(asset, line);
    line.wallet = wallet === undefined ? null : amount(wallet, asset.decimals);
    line.pledged = supplied === undefined ? null : amount(supplied, asset.decimals);

    const registry = snapshot.coinbase.get(asset.id);
    const multiplier = registry?.ok ? registry.value.multiplier : undefined;
    if (multiplier !== undefined && wallet !== undefined && supplied !== undefined) {
      line.shares = amount(mulDiv(wallet + supplied, multiplier, WAD, 'down'), asset.decimals);
    }

    const price = ledger.need(reserve.price, `${asset.id} price on Aave`, line.failed);
    const factor = ledger.need(reserve.factorBps, `${asset.id} collateral factor`, line.failed);
    const config = ledger.need(reserve.config, `${asset.id} reserve status`, line.failed);
    const spoke = ledger.need(reserve.spokeConfig, `${asset.id} Aave cap`, line.failed);
    const added = ledger.need(reserve.spokeAdded, `${asset.id} Aave supplied total`, line.failed);
    const updatedAt = reserve.priceUpdatedAt.ok ? reserve.priceUpdatedAt.value : undefined;

    if (price !== undefined) line.priceCents = divide(price, centsPerPriceUnit, 'down').toString();
    if (updatedAt !== undefined) line.priceUpdatedAt = iso(updatedAt);
    if (price !== undefined && wallet !== undefined && supplied !== undefined) {
      line.valueCents = mulDiv(wallet + supplied, price, 10n ** BigInt(asset.decimals) * centsPerPriceUnit, 'down').toString();
    }
    if (factor !== undefined) {
      line.protocolFactorBps = Number(factor);
      line.stillFactorBps = Number(mulDiv(factor, share, BPS, 'down'));
    }

    if (config?.paused) line.limits.push('reserve_paused');
    if (config?.frozen) line.limits.push('reserve_frozen');
    if (spoke && (!spoke.active || spoke.halted)) line.limits.push('spoke_halted');
    if (registry?.ok && registry.value.paused) line.limits.push('issuer_paused');
    const blocked = line.limits.length > 0;

    // The wallet's tokens count only up to the room left under Aave's collateral cap. Whatever
    // could not be read counts as nothing, so the line is a floor and says which read failed.
    let countableWallet: bigint | undefined;
    if (wallet !== undefined && spoke && added !== undefined) {
      if (spoke.addCap === noCap) countableWallet = wallet;
      else {
        const room = max(0n, spoke.addCap * 10n ** BigInt(asset.decimals) - added);
        countableWallet = min(wallet, room);
        if (countableWallet < wallet) line.limits.push('supply_cap');
      }
    }

    if (blocked) line.capacityCents = '0';
    else if (price !== undefined && factor !== undefined) {
      const counted = (countableWallet ?? 0n) + (supplied ?? 0n);
      const usdcRaw = toUsdc(counted * price * factor * share, 10n ** BigInt(asset.decimals) * BPS * BPS);
      if (usdcRaw !== undefined) {
        const lineCents = usdcToCents(usdcRaw, 'down');
        line.capacityCents = lineCents.toString();
        capacityCents += lineCents;
      }
    }
    if (line.failed.length > 0) capacityComplete = false;

    const using = reserve.status.ok ? reserve.status.value.usingAsCollateral : undefined;
    const userFactor = reserve.userFactorBps.ok ? reserve.userFactorBps.value : undefined;
    if (supplied !== undefined && supplied > 0n && using && price !== undefined && userFactor !== undefined) {
      collateral.push({ reserve, asset, supplied, price, userFactor });
    }
    lines.push(line);
  }

  // What the hub can lend to this spoke now.
  const usdcConfig = usdc ? ledger.need(usdc.config, 'USDC reserve status', venueFailed) : undefined;
  const usdcSpoke = usdc ? ledger.need(usdc.spokeConfig, 'USDC Aave cap', venueFailed) : undefined;
  const liquidity = ledger.need(aave.usdcLiquidity, 'Aave USDC liquidity', venueFailed);
  const owed = ledger.need(aave.usdcSpokeOwed, 'Aave USDC drawn total', venueFailed);
  let lendable: bigint | undefined;
  if (usdcConfig && usdcSpoke && liquidity !== undefined && owed !== undefined) {
    const closed = usdcConfig.paused || usdcConfig.frozen || !usdcConfig.borrowable || !usdcSpoke.active || usdcSpoke.halted;
    const drawRoom = usdcSpoke.drawCap === noCap ? liquidity : max(0n, usdcSpoke.drawCap * 10n ** BigInt(USDC_DECIMALS) - owed);
    lendable = closed ? 0n : min(liquidity, drawRoom);
  }

  const debtCents = debt === undefined ? null : usdcToCents(debt, 'up');
  let availableCents: bigint | null = null;
  if (capacityKnown && debtCents !== null && lendable !== undefined) {
    availableCents = min(max(0n, capacityCents - debtCents), usdcToCents(lendable, 'down'));
  } else complete = false;

  // Safety of what is already borrowed, from the protocol's own health factor when it answers.
  let safety: Safety | null = null;
  const liquidationPrices: LiquidationPrice[] = [];
  if (debt !== undefined && debt > 0n && usdcPrice !== undefined) {
    const debtValue = mulDiv(debt, usdcPrice, 10n ** BigInt(USDC_DECIMALS), 'up');
    const weighted = collateral.map((c) => ({ ...c, weighted: mulDiv(c.supplied * c.price, c.userFactor, 10n ** BigInt(c.asset.decimals) * BPS, 'down') }));
    const account = aave.account.ok ? aave.account.value : undefined;
    let healthFactor: bigint;
    let source: Safety['source'];
    if (account && account.healthFactor > 0n) {
      healthFactor = account.healthFactor;
      source = 'protocol';
    } else {
      const total = weighted.reduce((sum, c) => sum + c.weighted, 0n);
      healthFactor = mulDiv(total, WAD, debtValue, 'down');
      source = 'computed';
    }
    const { marginBps, state } = safetyFromHealthFactor(healthFactor);
    safety = { marginBps: Number(marginBps), state, healthFactor: healthFactor.toString(), source };
    for (const c of weighted) {
      const others = weighted.reduce((sum, o) => (o === c ? sum : sum + o.weighted), 0n);
      if (others >= debtValue) {
        liquidationPrices.push({ asset: c.asset.id, priceCents: null, unreachable: true });
        continue;
      }
      // Price at which this asset alone brings the health factor to 1, in cents, rounded up.
      const priceCents = mulDiv(debtValue - others, 10n ** BigInt(c.asset.decimals) * BPS, c.supplied * c.userFactor * centsPerPriceUnit, 'up');
      liquidationPrices.push({ asset: c.asset.id, priceCents: priceCents.toString(), unreachable: false });
    }
  }

  const rate = aave.usdcDrawnRateRay.ok ? aave.usdcDrawnRateRay.value : undefined;
  // A wallet with nothing on this venue gets no venue line: a row of zeros says nothing.
  const relevant = lines.length > 0 || debtCents !== 0n || venueFailed.length > 0;
  return {
    lines,
    complete: complete && capacityComplete,
    venues: relevant ? [
      {
        venue: 'aave-v4',
        market: ADDRESSES.aaveSpoke,
        label: 'Aave V4 · Coinbase Stocks',
        debtCents: cents(debtCents),
        debtAtomic: debt === undefined ? null : debt.toString(),
        capacityCents: capacityKnown ? capacityCents.toString() : null,
        availableCents: cents(availableCents),
        borrowRateBps: rate === undefined ? null : Number(mulDiv(rate, BPS, RAY, 'up')),
        liquidityCents: lendable === undefined ? null : usdcToCents(lendable, 'down').toString(),
        deductions: deductionsOf(capacityKnown ? capacityCents : null, debtCents, availableCents),
        safety,
        liquidationPrices,
        failed: venueFailed,
      },
    ] : [],
  };
}

function cryptoLine(asset: CryptoAsset): AssetLine {
  return {
    asset: asset.id,
    kind: 'crypto',
    name: asset.name,
    symbol: asset.symbol,
    token: asset.token,
    isin: null,
    venue: 'morpho',
    wallet: null,
    pledged: null,
    shares: null,
    priceCents: null,
    priceUpdatedAt: null,
    valueCents: null,
    protocolFactorBps: null,
    stillFactorBps: null,
    capacityCents: null,
    earnings: null,
    limits: [],
    failed: [],
  };
}

function computeMorpho(asset: CryptoAsset, market: MorphoSnapshot | null, snapshot: WalletSnapshot, ledger: Ledger): Computed {
  const line = cryptoLine(asset);
  const venueFailed: string[] = [];
  const label = `Morpho · ${asset.symbol === 'ETH' ? 'WETH' : asset.symbol}/USDC`;
  const tokenBalance = ledger.need(snapshot.balances.get(asset.token.toLowerCase()), `${asset.symbol === 'ETH' ? 'WETH' : asset.symbol} wallet balance`, line.failed);
  const native = asset.includesNativeEth ? ledger.need(snapshot.nativeEth, 'ETH wallet balance', line.failed) : 0n;
  const wallet = tokenBalance === undefined || native === undefined ? undefined : tokenBalance + native;
  line.wallet = wallet === undefined ? null : amount(wallet, asset.decimals);
  // Gas money stays put: only native ETH above the reserve can be wrapped and pledged.
  const spendableNative = native === undefined ? undefined : max(0n, native - TERMS.ethGasReserveWei);
  const countable = tokenBalance === undefined || spendableNative === undefined ? undefined : tokenBalance + spendableNative;
  if (native !== undefined && native > 0n && spendableNative !== native) line.limits.push('gas_reserve');

  if (!market) {
    if (countable === 0n) return { lines: [], venues: [], complete: true };
    ledger.need(undefined, `${label} market`, line.failed);
    return {
      lines: [line],
      complete: false,
      venues: [
        {
          venue: 'morpho',
          market: asset.morphoMarket,
          label,
          debtCents: null,
          debtAtomic: null,
          capacityCents: null,
          availableCents: null,
          borrowRateBps: null,
          liquidityCents: null,
          deductions: { loansCents: null, venueLimitCents: null },
          safety: null,
          liquidationPrices: [],
          failed: [`${label} market`],
        },
      ],
    };
  }

  const position = ledger.need(market.position, `${label} position`, line.failed);
  const collateral = position?.collateral;
  line.pledged = collateral === undefined ? null : amount(collateral, asset.decimals);
  const borrowShares = position?.borrowShares;
  if (countable === 0n && collateral === 0n && borrowShares === 0n) return { lines: [], venues: [], complete: true };

  const price = ledger.need(market.price, `${asset.symbol} price on Morpho`, line.failed);
  const { lltv } = market.info.params;
  const share = stillShareBps('crypto', false);
  line.protocolFactorBps = Number(mulDiv(lltv, BPS, WAD, 'down'));
  line.stillFactorBps = Number(mulDiv(mulDiv(lltv, BPS, WAD, 'down'), share, BPS, 'down'));
  const unit = 10n ** BigInt(asset.decimals);
  if (price !== undefined) {
    line.priceCents = mulDiv(price, unit, PRICE_SCALE_MORPHO * 10n ** 4n, 'down').toString();
    if (wallet !== undefined && collateral !== undefined) {
      line.valueCents = mulDiv(wallet + collateral, price, PRICE_SCALE_MORPHO * 10n ** 4n, 'down').toString();
    }
  }

  let capacity: bigint | null = null;
  if (price !== undefined && countable !== undefined && collateral !== undefined) {
    // Still's share of what the contract itself would lend against all of it.
    capacity = stillBorrowLimitV1({ protocolLimitAssets: morphoMaxBorrowAssetsV1(countable + collateral, price, lltv), shareBps: share }).limitCents;
    line.capacityCents = capacity.toString();
  }

  // Interest since the market's last update is added before a debt is stated.
  const stored = ledger.need(market.market, `${label} market totals`, venueFailed);
  const rate = ledger.need(market.borrowRatePerSecond, `${label} borrow rate`, venueFailed);
  const accrued = stored && rate !== undefined ? morphoAccruedTotalsV1(stored, rate, snapshot.block.timestamp) : undefined;
  let debt: bigint | undefined;
  if (borrowShares === 0n) debt = 0n;
  else if (borrowShares !== undefined && accrued) debt = toAssetsUpV1(borrowShares, accrued.totalBorrowAssets, accrued.totalBorrowShares);
  const debtCents = debt === undefined ? null : usdcToCents(debt, 'up');
  const liquidity = accrued ? max(0n, accrued.totalSupplyAssets - accrued.totalBorrowAssets) : undefined;

  let available: bigint | null = null;
  if (price !== undefined && countable !== undefined && collateral !== undefined && borrowShares !== undefined && accrued) {
    available = morphoStillCapacityV1({
      market: {
        collateralPrice: price,
        lltvWad: lltv,
        totalSupplyAssets: accrued.totalSupplyAssets,
        totalBorrowAssets: accrued.totalBorrowAssets,
        totalBorrowShares: accrued.totalBorrowShares,
        blockNumber: Number(snapshot.block.number),
      },
      position: { collateral, borrowShares },
      additionalCollateralAssets: countable,
      shareBps: share,
    }).availableCents;
  }

  let safety: Safety | null = null;
  const liquidationPrices: LiquidationPrice[] = [];
  if (debt !== undefined && debt > 0n && collateral !== undefined && borrowShares !== undefined && price !== undefined && accrued) {
    const state: MorphoMarketStateV1 = {
      collateralPrice: price,
      lltvWad: lltv,
      totalSupplyAssets: accrued.totalSupplyAssets,
      totalBorrowAssets: accrued.totalBorrowAssets,
      totalBorrowShares: accrued.totalBorrowShares,
      blockNumber: Number(snapshot.block.number),
    };
    const held = { collateral, borrowShares };
    // morphoHealthV1 owes the same debt as above, so its health factor exists; were it missing,
    // zero would read as the danger it would be.
    const healthFactor = morphoHealthV1({ market: state, position: held }).healthFactorWad ?? 0n;
    const { marginBps, state: safetyState } = safetyFromHealthFactor(healthFactor);
    safety = { marginBps: Number(marginBps), state: safetyState, healthFactor: healthFactor.toString(), source: 'computed' };
    const liquidation = morphoLiquidationPriceV1({ market: state, position: held });
    if (liquidation !== null) {
      // Morpho prices one raw unit in raw USDC × 1e36; cents per whole token, rounded up.
      liquidationPrices.push({ asset: asset.id, priceCents: mulDiv(liquidation, unit, PRICE_SCALE_MORPHO * 10n ** 4n, 'up').toString(), unreachable: false });
    }
  }

  const complete = available !== null && line.failed.length === 0 && venueFailed.length === 0;
  return {
    lines: [line],
    complete,
    venues: [
      {
        venue: 'morpho',
        market: asset.morphoMarket,
        label,
        debtCents: cents(debtCents),
        debtAtomic: debt === undefined ? null : debt.toString(),
        capacityCents: cents(capacity),
        availableCents: cents(available),
        borrowRateBps: rate === undefined ? null : Number(mulDiv(rate * SECONDS_PER_YEAR, BPS, WAD, 'up')),
        liquidityCents: liquidity === undefined ? null : usdcToCents(liquidity, 'down').toString(),
        deductions: deductionsOf(capacity, debtCents, available),
        safety,
        liquidationPrices,
        failed: venueFailed,
      },
    ],
  };
}

function computeAll(universe: Universe, snapshot: WalletSnapshot, weekend: boolean, earningsOf: EarningsOf): Computed & { failures: FailedRead[] } {
  const ledger = new Ledger();
  const parts = [
    computeAave(universe, snapshot, weekend, earningsOf, ledger),
    ...CRYPTO.map((asset) => computeMorpho(asset, snapshot.morpho.get(asset.id) ?? null, snapshot, ledger)),
  ];
  return {
    lines: parts.flatMap((p) => p.lines),
    venues: parts.flatMap((p) => p.venues),
    complete: parts.every((p) => p.complete) && ledger.failures.length === 0,
    failures: ledger.failures,
  };
}

function headlineOf(computed: Computed, weekdayAvailable: bigint | null): Headline {
  const known = computed.venues.filter((v) => v.availableCents !== null);
  const total = known.reduce((sum, v) => sum + BigInt(v.availableCents!), 0n);
  const anything = computed.lines.length > 0;
  let state: Headline['state'];
  if (known.length === 0 && anything) state = 'unknown';
  else if (total >= TERMS.dustBelowCents) state = 'funded';
  else if (total > 0n) state = 'dust';
  else state = computed.complete ? 'none' : 'unknown';

  let reason: Headline['reason'] = null;
  if (state === 'none') {
    const eligible = computed.lines.filter((l) => l.capacityCents !== null && BigInt(l.capacityCents) > 0n);
    if (!anything) reason = 'no_eligible_assets';
    else if (eligible.length > 0) reason = 'limit_in_use';
    else if (computed.lines.some((l) => l.limits.some((x) => x !== 'supply_cap'))) reason = 'paused';
    else reason = 'no_eligible_assets';
  }
  return {
    state,
    availableCents: state === 'unknown' && known.length === 0 ? null : total.toString(),
    complete: computed.complete,
    reason,
    weekdayAvailableCents: weekdayAvailable === null ? null : weekdayAvailable.toString(),
  };
}

export interface MirrorInput {
  universe: Universe;
  snapshot: WalletSnapshot;
  calendar: CalendarRead;
  subject: MirrorReport['subject'];
  assembledAt: Date;
}

export function computeMirror({ universe, snapshot, calendar, subject, assembledAt }: MirrorInput): MirrorReport {
  const blockTime = new Date(Number(snapshot.block.timestamp) * 1000);
  const window = weekendWindow(blockTime);
  const earningsOf = earningsFrom(calendar, blockTime);
  const actual = computeAll(universe, snapshot, window.active, earningsOf);
  let weekdayAvailable: bigint | null = null;
  if (window.active) {
    // Earnings windows hold on weekdays too, so the comparison keeps them.
    const weekday = computeAll(universe, snapshot, false, earningsOf);
    const known = weekday.venues.filter((v) => v.availableCents !== null);
    weekdayAvailable = known.length === 0 ? null : known.reduce((sum, v) => sum + BigInt(v.availableCents!), 0n);
  }

  const evidence: MirrorReport['evidence'] = [
    { label: 'Aave V4 Coinbase Stocks spoke', address: ADDRESSES.aaveSpoke },
    { label: 'Aave V4 Coinbase Stocks hub', address: ADDRESSES.aaveHub },
    { label: 'Aave V4 oracle', address: ADDRESSES.aaveOracle },
    { label: 'Morpho Blue', address: ADDRESSES.morpho },
  ];
  if (universe.aave.ok) {
    for (const reserve of universe.aave.reserves) {
      if (reserve.role.kind === 'stock' && reserve.priceSource && actual.lines.some((l) => l.asset === (reserve.role as { asset: StockAsset }).asset.id)) {
        evidence.push({ label: `${reserve.role.asset.ticker} price feed`, address: reserve.priceSource });
      }
    }
  }

  return {
    kind: 'still.mirror',
    version: 1,
    subject,
    reading: {
      block: snapshot.block.number.toString(),
      blockTime: blockTime.toISOString(),
      assembledAt: assembledAt.toISOString(),
      provider: snapshot.provider,
    },
    terms: {
      version: TERMS.version,
      stockShareBps: Number(TERMS.shareOfProtocolBps),
      cryptoShareBps: Number(TERMS.shareOfProtocolBps),
      weekend: {
        active: window.active,
        startsAt: window.startsAt.toISOString(),
        endsAt: window.endsAt.toISOString(),
        stockShareBps: Number(TERMS.weekendStockShareOfProtocolBps),
      },
      earnings: {
        stockShareBps: Number(TERMS.earningsStockShareOfProtocolBps),
        calendarReadAt: calendar.ok ? calendar.calendar.readAt.toISOString() : null,
      },
    },
    headline: headlineOf(actual, weekdayAvailable),
    assets: actual.lines,
    venues: actual.venues,
    coverage: {
      measured: [
        'Wallet balances of the 7 stock tokens Aave V4 accepts, cbBTC, WETH and ETH',
        'Aave V4 Coinbase Stocks: collateral supplied and USDC owed',
        'Morpho cbBTC/USDC and WETH/USDC: collateral and USDC owed',
        'Earnings report dates of the 7 stocks, from the Aave V4 API calendar',
      ],
      notCounted: [
        'Tokens inside liquidity pools, vaults or other lending markets',
        'Tokenized stocks no lending market on Base accepts yet',
        'Other networks and balances held in the Coinbase app',
      ],
      failed: actual.failures,
    },
    evidence,
  };
}
