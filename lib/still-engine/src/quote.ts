// A Still loan quote with no wallet: what Still would lend against an exact amount of one collateral,
// read at one block with the engine that answers the page, the Agent and a loan review.
//
// The reading is any wallet's, with every figure that belongs to a wallet set to nothing: no tokens,
// no collateral, no debt. The amount asked about is then put in that empty wallet, so the venue's own
// caps count it as they would count a person's tokens, and the loan figures come from pledging it and
// borrowing: the same scenario the Agent answers "what if I pledged…" with. Nothing here estimates. A
// figure the reading cannot carry is null, and the read that failed is named in `failed`.

import { morphoMaxBorrowAssetsV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { BPS, max, min, mulDiv, usdcToCents } from './math.js';
import { computeMirror, type MirrorInput } from './mirror.js';
import type { SafetyState } from './policy.js';
import type { WalletSnapshot } from './read.js';
import { ADDRESSES, assetById, type Asset, type AssetId } from './registry.js';
import type { AssetLimit, AssetLine, MirrorReport, VenueLine } from './report.js';
import type { Outcome } from './rpc.js';
import { scenarioV1, type ScenarioRefusalV1 } from './scenario.js';

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const USDC_DECIMALS = 6n;
const USDC_UNITS_PER_CENT = 10_000n;

/** What closes new borrowing against a collateral, rather than lowering what it counts for. */
export const STILL_QUOTE_CLOSING_LIMITS_V1: readonly AssetLimit[] = [
  'reserve_paused',
  'reserve_frozen',
  'spoke_halted',
  'issuer_paused',
  'not_listed',
];

/** Why new borrowing against this collateral is closed now: a venue or issuer state, or a venue with nothing to lend. */
export type StillQuoteClosedReasonV1 = AssetLimit | 'venue_has_no_liquidity' | 'venue_frozen_by_issuer';

/** What the server read beside the Mirror, at the same block. */
export interface StillLoanQuoteReadsV1 {
  /** What the collateral's own contract says of a new pledge, the reads a borrow review refuses on: for cbBTC or
   * PAXG every transfer paused or Morpho Blue's address frozen, for a stock its B20 transfer pause (audit P2-1,
   * 2026-11-18); null when nothing holds it. Absent for a collateral no issuer can hold this way. */
  collateralHold?: 'paused' | 'venue_frozen' | null;
}

export interface StillLoanQuoteAskV1 {
  asset: AssetId;
  /** The tokens asked about, in the token's base units. */
  raw: bigint;
  /** USDC to borrow, in base units; null asks for the limit alone. */
  borrowAtomic: bigint | null;
}

/** One loan, computed: what it borrows, how far it stands from liquidation, and what it costs a year. */
export interface StillLoanFiguresV1 {
  borrowAtomic: string;
  /** WAD; liquidation can start below 1e18. */
  healthFactor: string;
  /** How far the collateral can fall at once before liquidation can start, in basis points. */
  marginBps: number;
  state: SafetyState;
  /** Per whole token, in cents, rounded up: below it liquidation can start. */
  liquidationPriceCents: string | null;
  liquidationUnreachable: boolean;
  borrowRateBps: number | null;
}

export type StillLoanAtV1 =
  | { outcome: 'computed'; figures: StillLoanFiguresV1 }
  | { outcome: 'refused'; reason: ScenarioRefusalV1 };

export interface StillLoanQuoteV1 {
  asset: Asset;
  venue: { venue: VenueLine['venue']; market: string; label: string };
  reading: MirrorReport['reading'];
  terms: MirrorReport['terms'];
  /** The collateral as the engine reads it, held in an otherwise empty wallet. */
  line: AssetLine | null;
  venueLine: VenueLine | null;
  /** What the venue would take now: all of it, or what its collateral cap leaves room for. Null when unread. */
  pledgeableRaw: bigint | null;
  /** Still's limit against this collateral, before what the venue can lend now. */
  stillLimitCents: string | null;
  /** What could be borrowed now: Still's limit, bounded by the venue's own liquidity and caps. */
  availableNowCents: string | null;
  /** What the protocol itself would lend against the same collateral: the figure Still takes a share of. */
  protocolLimitCents: string | null;
  /** During the closed-market window: the same collateral on weekday terms. */
  weekdayAvailableCents: string | null;
  newLoans: 'open' | 'closed';
  closedBecause: StillQuoteClosedReasonV1[];
  /** A loan of everything available now. Null when nothing is. */
  atStillLimit: StillLoanAtV1 | null;
  /** The loan asked about, when one was. */
  requested: (StillLoanAtV1 & { borrowAtomic: string; withinStillLimit: boolean | null }) | null;
  failed: MirrorReport['coverage']['failed'];
  evidence: MirrorReport['evidence'];
  /**
   * Every read this collateral's answer rests on was taken: its line and its venue with no read of ours failed,
   * the issuer's own pause of a stock read, and the limit, what is available now and what the venue takes all
   * known. A quote that is not complete is not an answer to sell (audit QUOTE-1, 2026-11-18: a reading with no
   * Aave in it said newLoans "open" with every limit null). What a protocol does not publish, such as a stock
   * Aave's calendar lists no date for, leaves it complete: Still's rule for it is fixed.
   */
  complete: boolean;
}

/** The reading with everything that belongs to a wallet set to nothing, whoever it was read for. */
export function marketOnlyInputV1(input: MirrorInput): MirrorInput {
  const snapshot: WalletSnapshot = structuredClone(input.snapshot);
  snapshot.nativeEth = ok(0n);
  for (const key of [...snapshot.balances.keys()]) snapshot.balances.set(key, ok(0n));
  if (snapshot.aave) {
    for (const reserve of snapshot.aave.reserves) {
      reserve.supplied = ok(0n);
      reserve.status = ok({ usingAsCollateral: false, borrowing: false });
      // A new position is held under the reserve's factor of today.
      reserve.userFactorBps = reserve.factorBps;
    }
    snapshot.aave.usdcDebt = ok(0n);
    // The protocol's own figures are about the wallet read; the engine computes them instead.
    snapshot.aave.account = { ok: false, reason: 'reverted' };
    snapshot.aave.riskPremiumBps = ok(0n);
  }
  for (const market of snapshot.morpho.values()) {
    if (market) market.position = ok({ borrowShares: 0n, collateral: 0n });
  }
  return { ...input, snapshot, subject: { address: ZERO_ADDRESS, name: null, input: 'still-loan-quote' } };
}

function withHeldV1(input: MirrorInput, asset: Asset, raw: bigint): MirrorInput {
  const snapshot: WalletSnapshot = structuredClone(input.snapshot);
  // ETH is held as WETH here: the gas money a wallet keeps back belongs to a wallet, not to a quote.
  snapshot.balances.set(asset.token.toLowerCase(), ok(raw));
  return { ...input, snapshot };
}

function venueOfV1(asset: Asset): (line: VenueLine) => boolean {
  return asset.kind === 'stock'
    ? (line) => line.venue === 'aave-v4'
    : (line) => line.venue === 'morpho' && line.market.toLowerCase() === asset.morphoMarket.toLowerCase();
}

function stockReserveV1(snapshot: WalletSnapshot, asset: Asset) {
  return snapshot.aave?.reserves.find((r) => r.info.role.kind === 'stock' && r.info.role.asset.id === asset.id) ?? null;
}

/** What the venue would take now. Morpho Blue has no collateral cap; Aave's spoke does. */
function pledgeableRawV1(input: MirrorInput, asset: Asset, raw: bigint): bigint | null {
  if (asset.kind === 'crypto') return raw;
  if (!input.universe.aave.ok) return null;
  const reserve = stockReserveV1(input.snapshot, asset);
  if (!reserve || !reserve.spokeConfig.ok || !reserve.spokeAdded.ok) return null;
  if (reserve.spokeConfig.value.addCap === input.universe.aave.noCap) return raw;
  const room = max(0n, reserve.spokeConfig.value.addCap * 10n ** BigInt(asset.decimals) - reserve.spokeAdded.value);
  return min(raw, room);
}

/** The protocol's own limit for the same pledge, by the same arithmetic as Still's with no share taken. */
function protocolLimitCentsV1(input: MirrorInput, asset: Asset, pledgeable: bigint | null): string | null {
  if (pledgeable === null) return null;
  if (asset.kind === 'stock') {
    const reserve = stockReserveV1(input.snapshot, asset);
    const usdc = input.snapshot.aave?.reserves.find((r) => r.info.role.kind === 'usdc') ?? null;
    if (!reserve?.price.ok || !reserve.factorBps.ok || !usdc?.price.ok || usdc.price.value === 0n) return null;
    const atomic = mulDiv(
      pledgeable * reserve.price.value * reserve.factorBps.value,
      10n ** USDC_DECIMALS,
      10n ** BigInt(asset.decimals) * BPS * usdc.price.value,
      'down',
    );
    return usdcToCents(atomic, 'down').toString();
  }
  const market = input.snapshot.morpho.get(asset.id);
  if (!market?.price.ok) return null;
  return usdcToCents(morphoMaxBorrowAssetsV1(pledgeable, market.price.value, market.info.params.lltv), 'down').toString();
}

function loanAtV1(held: MirrorInput, asset: Asset, pledge: bigint, borrowAtomic: bigint): StillLoanAtV1 {
  if (pledge <= 0n) return { outcome: 'refused', reason: 'no_collateral' };
  const outcome = scenarioV1(held, [
    { kind: 'deposit', asset: asset.id, raw: pledge, source: 'wallet' },
    { kind: 'borrow', venue: asset.kind === 'stock' ? 'aave-v4' : `morpho:${asset.id}`, usdcAtomic: borrowAtomic },
  ]);
  if (!outcome.ok) return { outcome: 'refused', reason: outcome.reason };
  const venue = outcome.after.venues.find(venueOfV1(asset));
  if (!venue?.safety) return { outcome: 'refused', reason: 'unread' };
  const liquidation = venue.liquidationPrices.find((price) => price.asset === asset.id);
  return {
    outcome: 'computed',
    figures: {
      borrowAtomic: borrowAtomic.toString(),
      healthFactor: venue.safety.healthFactor,
      marginBps: venue.safety.marginBps,
      state: venue.safety.state,
      liquidationPriceCents: liquidation?.priceCents ?? null,
      liquidationUnreachable: liquidation?.unreachable ?? false,
      borrowRateBps: venue.borrowRateBps,
    },
  };
}

export function stillLoanQuoteV1(input: MirrorInput, ask: StillLoanQuoteAskV1, reads: StillLoanQuoteReadsV1 = {}): StillLoanQuoteV1 {
  if (ask.raw <= 0n) throw new RangeError('Still quote: the amount must be above zero');
  if (ask.borrowAtomic !== null && ask.borrowAtomic <= 0n) throw new RangeError('Still quote: a borrow must be above zero');
  const asset = assetById(ask.asset);
  const held = withHeldV1(marketOnlyInputV1(input), asset, ask.raw);
  const report = computeMirror(held);
  const line = report.assets.find((entry) => entry.asset === asset.id) ?? null;
  const venueLine = report.venues.find(venueOfV1(asset)) ?? null;
  const pledgeable = pledgeableRawV1(held, asset, ask.raw);
  const limits = line?.limits ?? [];
  // The collateral's own contract holding a new pledge closes it the way a paused reserve does (audit QUOTE-1).
  const hold: StillQuoteClosedReasonV1[] = reads.collateralHold === 'paused' && !limits.includes('issuer_paused') ? ['issuer_paused']
    : reads.collateralHold === 'venue_frozen' ? ['venue_frozen_by_issuer'] : [];
  const closing: StillQuoteClosedReasonV1[] = [...limits.filter((limit) => STILL_QUOTE_CLOSING_LIMITS_V1.includes(limit)), ...hold];
  const closedBecause: StillQuoteClosedReasonV1[] = closing.length === 0 && venueLine?.liquidityCents === '0'
    ? ['venue_has_no_liquidity']
    : closing;
  const available = hold.length > 0 ? '0' : venueLine?.availableCents ?? null;
  const stillLimit = hold.length > 0 ? '0' : venueLine?.capacityCents ?? null;
  const ours = new Set(report.coverage.failed.filter((failure) => failure.owner === 'us').map((failure) => failure.what));
  // A stock's issuer pause is read from Coinbase's registry; a registry that did not answer left it unread.
  const issuerRead = asset.kind !== 'stock' || held.snapshot.coinbase.get(asset.id)?.ok === true;
  // The rate is part of what the quote sells (the catalog promises it): one that could not be read leaves the quote
  // incomplete, never `complete` with a null rate (audit P2-1, 2026-11-18: Aave's drawn rate is read apart from the
  // venue's failures, so an unread one passed).
  const complete = line !== null && venueLine !== null && venueLine.failed.length === 0 && !line.failed.some((what) => ours.has(what))
    && issuerRead && pledgeable !== null && stillLimit !== null && available !== null && venueLine.borrowRateBps !== null;

  const atStillLimit = available !== null && BigInt(available) > 0n && pledgeable !== null
    ? loanAtV1(held, asset, pledgeable, BigInt(available) * USDC_UNITS_PER_CENT)
    : null;
  const requested = ask.borrowAtomic === null
    ? null
    : {
        ...(pledgeable === null
          ? ({ outcome: 'refused', reason: 'unread' } as const)
          : loanAtV1(held, asset, pledgeable, ask.borrowAtomic)),
        borrowAtomic: ask.borrowAtomic.toString(),
        withinStillLimit: stillLimit === null ? null : ask.borrowAtomic <= BigInt(stillLimit) * USDC_UNITS_PER_CENT,
      };

  return {
    asset,
    venue: venueLine
      ? { venue: venueLine.venue, market: venueLine.market, label: venueLine.label }
      : asset.kind === 'stock'
        ? { venue: 'aave-v4', market: ADDRESSES.aaveSpoke, label: 'Aave V4 · Coinbase Stocks' }
        : { venue: 'morpho', market: asset.morphoMarket, label: `Morpho · ${asset.symbol === 'ETH' ? 'WETH' : asset.symbol}/USDC` },
    reading: report.reading,
    terms: report.terms,
    line,
    venueLine,
    pledgeableRaw: pledgeable,
    stillLimitCents: stillLimit,
    availableNowCents: available,
    protocolLimitCents: closing.length > 0 ? '0' : protocolLimitCentsV1(held, asset, pledgeable),
    weekdayAvailableCents: report.headline.weekdayAvailableCents,
    newLoans: closedBecause.length > 0 ? 'closed' : 'open',
    closedBecause,
    atStillLimit,
    requested,
    failed: report.coverage.failed,
    evidence: report.evidence,
    complete,
  };
}
