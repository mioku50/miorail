import { client } from '@mioagent/db';
import {
  readPublicLadderNoMarketTokensV1,
  readPublicLadderPricesOfTokenV1,
  readPublicLadderPricesV1,
  type PublicLadderPriceRowV1,
} from '@mioagent/route-storage';
import {
  STOCK_CHART_DAYS_V1,
  stockChartV1,
  type StockChartResponseV1,
} from '@mioagent/rwa-market-reality/stock-chart';
import {
  stockQuotesV1,
  type StockQuotesResponseV1,
  type StockQuoteStockV1,
} from '@mioagent/rwa-market-reality/stock-quotes';

import type { CoinbaseStockMetaV1 } from './coinbaseStockMeta.js';

// ---------------------------------------------------------------------------
// The Stocks list's prices: the public ladder's runs over the last 26 hours,
// named by Coinbase's own metadata and bound by the reviewed corpus.
//
// The computation is `stockQuotesV1`; this only fetches. A token is listed when
// the reviewed corpus binds it to Coinbase. Coinbase's metadata names it and
// gives it an icon, and an address Coinbase lists that the corpus does not
// bind is left out rather than guessed at.
// ---------------------------------------------------------------------------

export interface StockQuotesReadDepsV1 {
  prices: (since: Date, until: Date) => Promise<readonly PublicLadderPriceRowV1[]>;
  meta: () => Promise<ReadonlyMap<string, CoinbaseStockMetaV1>>;
  /** The security a Coinbase representation stands for, or null for any other
   * address — another issuer's, or one the corpus does not bind. */
  identify: (tokenAddress: string) => Promise<{ underlyingKey: string } | null>;
  /** Tokens nobody makes a market in on Base yet, from runs since `since`. A failed read names none: the list
   * says "not priced now" rather than calling a market absent on a guess. */
  noMarket?: (since: Date) => Promise<readonly string[]>;
  /** Each multiplier change seen since `since`: a token and when. A failed read names none. */
  ratioChanges?: (since: Date) => Promise<ReadonlyArray<{ tokenAddress: string; observedAt: string }>>;
}

/** How far back the newest run may be for "no market" to stand: the ladder runs hourly. */
export const STOCK_NO_MARKET_WINDOW_MS_V1 = 6 * 3_600_000;

/** Where a token's icon is served from, on our own origin. */
export function stockIconPathV1(tokenAddress: string): string {
  return `/api/public/stocks/icons/${tokenAddress.toLowerCase()}.png`;
}

export async function readStockQuotesV1(now: Date, deps: StockQuotesReadDepsV1): Promise<StockQuotesResponseV1> {
  const [prices, meta, noMarket, ratioChanges] = await Promise.all([
    deps.prices(new Date(now.getTime() - 26 * 3_600_000), now),
    deps.meta(),
    (deps.noMarket?.(new Date(now.getTime() - STOCK_NO_MARKET_WINDOW_MS_V1)) ?? Promise.resolve([])).catch(() => [] as readonly string[]),
    (deps.ratioChanges?.(new Date(now.getTime() - 26 * 3_600_000)) ?? Promise.resolve([]))
      .catch(() => [] as ReadonlyArray<{ tokenAddress: string; observedAt: string }>),
  ]);
  const ratioChangedAt = new Map<string, string[]>();
  for (const change of ratioChanges) {
    const token = change.tokenAddress.toLowerCase();
    ratioChangedAt.set(token, [...(ratioChangedAt.get(token) ?? []), change.observedAt]);
  }
  const tokens = [...new Set([...meta.keys(), ...prices.map((row) => row.token.toLowerCase())])].sort();
  const stocks: StockQuoteStockV1[] = [];
  for (const tokenAddress of tokens) {
    const identity = await deps.identify(tokenAddress);
    if (!identity) continue;
    const row = meta.get(tokenAddress);
    stocks.push({
      tokenAddress,
      underlyingKey: identity.underlyingKey,
      tokenSymbol: row?.symbol ?? null,
      companyName: row?.name ?? null,
      iconPath: row?.iconUrl ? stockIconPathV1(tokenAddress) : null,
    });
  }
  return stockQuotesV1({ now, prices, stocks, noMarket: new Set(noMarket.map((token) => token.toLowerCase())), ratioChangedAt });
}

/** Tokens with no market on Base, over the production database. */
export function databaseStockNoMarketV1(since: Date): Promise<string[]> {
  return readPublicLadderNoMarketTokensV1(client, { since });
}

/** The shared read, over the production database. */
export function databaseStockPricesV1(since: Date, until: Date): Promise<PublicLadderPriceRowV1[]> {
  return readPublicLadderPricesV1(client, { since, until });
}

/**
 * A week of one stock's price on Base, for the chart on its card.
 *
 * Three hours more than the week are read, so the first hour's point takes
 * the card's own three-run median like every other point.
 */
export async function readStockChartV1(
  now: Date,
  tokenAddress: string,
  deps: { prices: (token: string, since: Date, until: Date) => Promise<readonly PublicLadderPriceRowV1[]> },
): Promise<StockChartResponseV1> {
  const token = tokenAddress.toLowerCase();
  const since = new Date(now.getTime() - (STOCK_CHART_DAYS_V1 * 24 + 3) * 3_600_000);
  return stockChartV1({ now, tokenAddress: token, prices: await deps.prices(token, since, now) });
}

/** One stock's prices, over the production database. */
export function databaseStockChartPricesV1(token: string, since: Date, until: Date): Promise<PublicLadderPriceRowV1[]> {
  return readPublicLadderPricesOfTokenV1(client, { token, since, until });
}
