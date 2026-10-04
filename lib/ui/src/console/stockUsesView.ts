import type { RepresentationUseAccessV1 } from '@mioagent/rwa-issuer/useAccess';
import { venueAnnouncementReadingsV1 } from '@mioagent/rwa-issuer/venueAnnouncements';
import type { PoolYieldV1 } from '@mioagent/rwa-market-reality/pool-yield';

import { pairedTokenLabelV1 } from './marketRealityView';

// ---------------------------------------------------------------------------
// "What else you can do with NVDAc": the few uses a holder can act on, lifted
// from Use & access onto the stock's own card.
//
// Use & access answers every question about an exact address — transfers,
// bridges, every pool, every lending market, the ones a stranger deployed. A
// holder asks a smaller one: where else does this token work, and what does
// it pay. So this block keeps only what a venue itself stands behind:
//
//   * the deepest pool on a NAMED venue, with the venue's own page;
//   * a Morpho market MORPHO lists, never one anybody could deploy — what can
//     be borrowed there now and at what rate, and what lending into it earns;
//   * an announced venue that does not list the token yet, said as exactly
//     that, so a reader who saw the announcement does not think we missed it.
//
// Every caveat stays in Use & access, under "How we know". The rates are the
// venue's own figures and move; the card says so in one line.
// ---------------------------------------------------------------------------

export interface StockUseRowV1 {
  id: 'pool' | 'yield' | 'borrow' | 'earn' | 'announced';
  label: string;
  text: string;
  href: string | null;
}

export interface StockUsesViewV1 {
  title: string;
  rows: StockUseRowV1[];
  note: string;
}

/** A Morpho market's own page. Opened 2026-10-03 against a real market (it
 * redirects to the market, "USDC | NVDAc 62.5%") and a made-up id (404). */
export function morphoMarketUrlV1(marketId: string): string | null {
  return /^0x[0-9a-f]{64}$/i.test(marketId) ? `https://app.morpho.org/base/market/${marketId.toLowerCase()}` : null;
}

/** `$2.14M`, `$537.9K`, `$153`: a size, rounded for reading. */
export function compactUsdV1(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** 408 basis points → `4.08%`. */
function rateV1(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function decimalV1(atomic: string, decimals: number): number {
  if (!/^[0-9]+$/.test(atomic)) return Number.NaN;
  return Number(atomic) / 10 ** decimals;
}

/** `53%`, `4.6%`, `0.42%`: a yearly rate at the precision a reader uses. */
function percentV1(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 10) return `${Math.round(value)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  if (value >= 0.01) return `${value.toFixed(2)}%`;
  return 'under 0.01%';
}

/**
 * What the pool pays, as two alternatives and never their sum: a position
 * staked in the gauge earns AERO and gives its fees to voters, and one that
 * is not staked earns the fees and no AERO. Said only for the pool the row
 * above names, so the two lines never describe two pools.
 */
function poolYieldRowV1(yieldView: PoolYieldV1): StockUseRowV1 | null {
  const parts: string[] = [];
  if (yieldView.aero) {
    parts.push(
      yieldView.aero.aprPercent !== null
        ? `Staked: about ${percentV1(yieldView.aero.aprPercent)} a year in AERO (this week's rate)`
        : `Staked: a share of ${Math.round(yieldView.aero.perWeek).toLocaleString('en-US')} AERO this week`,
    );
  }
  if (yieldView.fees) {
    const days = yieldView.fees.days >= 2 ? `${Math.round(yieldView.fees.days)} days` : `${yieldView.fees.days} days`;
    parts.push(`Not staked: about ${percentV1(yieldView.fees.aprPercent)} a year in fees (last ${days})`);
  }
  if (parts.length === 0) return null;
  const tail = [
    // A rate is an average over the pool's money; an amount is not a rate.
    (yieldView.aero?.aprPercent ?? null) !== null || yieldView.fees ? 'per dollar in the pool, on average' : null,
    // Staking trades the fees for the AERO, so with a gauge it is either.
    yieldView.aero ? 'a position earns one or the other' : null,
  ].filter((part): part is string => part !== null);
  return {
    id: 'yield',
    label: 'Pays',
    text: `${parts.join(' · ')}${tail.length > 0 ? ` · ${tail.join('; ')}` : ''}`,
    href: null,
  };
}

function ageV1(at: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

export function stockUsesViewV1(input: {
  use: RepresentationUseAccessV1 | null;
  tokenSymbol: string;
  /** The stock's price on Base, for the pool's size in dollars. */
  priceUsd: number | null;
  /** What the stock's deepest Aerodrome pool pays, when measured. */
  poolYield?: PoolYieldV1 | null;
  now: Date;
}): StockUsesViewV1 | null {
  const { use, tokenSymbol } = input;
  if (!use) return null;
  const rows: StockUseRowV1[] = [];

  // The deepest pool a named venue runs, with that venue's own page.
  const pool = use.pools?.state === 'measured'
    ? use.pools.rows.find((row) => row.venueName !== null && row.venuePageUrl !== null)
    : undefined;
  if (pool) {
    const paired = pairedTokenLabelV1(pool);
    const held = decimalV1(pool.tokenBalanceAtomic, pool.tokenDecimals);
    const other =
      pool.pairedBalanceAtomic !== null && pool.pairedDecimals !== null
        ? decimalV1(pool.pairedBalanceAtomic, pool.pairedDecimals)
        : Number.NaN;
    // A dollar size only when both halves are dollars we can stand behind:
    // the stock at its price on Base, the other side only when it is USDC.
    const size =
      input.priceUsd !== null && paired === 'USDC' && Number.isFinite(held) && Number.isFinite(other)
        ? held * input.priceUsd + other
        : null;
    rows.push({
      id: 'pool',
      label: 'Pool',
      text: `${pool.venueName} · ${tokenSymbol}/${paired ?? 'another token'}${size !== null ? ` · about ${compactUsdV1(size)} in it` : ''}`,
      href: pool.venuePageUrl,
    });
    const paid = input.poolYield && input.poolYield.poolAddress === pool.poolAddress ? poolYieldRowV1(input.poolYield) : null;
    if (paid) rows.push(paid);
  }

  // A Morpho market Morpho itself lists, where this token is the collateral.
  const morpho = use.defi.venues.find((venue) => venue.venueId === 'morpho' && venue.state === 'listed');
  const market = (morpho?.markets ?? [])
    .filter((row) => row.curated === true && row.role === 'collateral')
    .sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1))[0];
  if (market) {
    const href = morphoMarketUrlV1(market.marketId);
    const loan = market.loanAssetSymbol ?? 'the loan asset';
    const parts = [
      market.liquidityUsd !== null ? `up to ${compactUsdV1(market.liquidityUsd)} now` : null,
      market.borrowApyBps != null ? `${rateV1(market.borrowApyBps)} a year` : null,
      market.lltvBps !== null ? `up to ${rateV1(market.lltvBps).replace(/\.?0+%$/, '%')} of its value` : null,
    ].filter((part): part is string => part !== null);
    rows.push({
      id: 'borrow',
      label: 'Borrow',
      text: `${loan} against ${tokenSymbol} on Morpho${parts.length ? ` · ${parts.join(' · ')}` : ''}`,
      href,
    });
    if (market.supplyApyBps != null) {
      rows.push({
        id: 'earn',
        label: 'Earn',
        text: `Lend ${loan} in that Morpho market · ${rateV1(market.supplyApyBps)} a year${
          market.supplyUsd !== null ? ` · ${compactUsdV1(market.supplyUsd)} lent so far` : ''
        }`,
        href,
      });
    }
  }

  // Announced and not live: said as exactly that, never as a use.
  for (const reading of venueAnnouncementReadingsV1({ issuerId: 'coinbase', venues: use.defi.venues })) {
    if (reading.measured !== 'not_listed') continue;
    const day = new Date(`${reading.announcement.announcedAt}T00:00:00Z`).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
    });
    rows.push({
      id: 'announced',
      label: reading.announcement.venueName.replace(/ v\d+$/, ''),
      text: `${reading.announcement.announcedBy} announced it as collateral on ${day} — not live yet`,
      href: null,
    });
  }

  if (rows.length === 0) return null;
  return {
    title: `What else you can do with ${tokenSymbol}`,
    rows,
    note: `The venues' own figures, read ${ageV1(use.observedAt, input.now)}. Rates move. Nothing here is advice.`,
  };
}
