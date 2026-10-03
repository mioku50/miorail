import { client } from '@mioagent/db';
import { readPublicLadderPricesV1, type PublicLadderPriceRowV1 } from '@mioagent/route-storage';
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
}

/** Where a token's icon is served from, on our own origin. */
export function stockIconPathV1(tokenAddress: string): string {
  return `/api/public/stocks/icons/${tokenAddress.toLowerCase()}.png`;
}

export async function readStockQuotesV1(now: Date, deps: StockQuotesReadDepsV1): Promise<StockQuotesResponseV1> {
  const [prices, meta] = await Promise.all([
    deps.prices(new Date(now.getTime() - 26 * 3_600_000), now),
    deps.meta(),
  ]);
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
  return stockQuotesV1({ now, prices, stocks });
}

/** The shared read, over the production database. */
export function databaseStockPricesV1(since: Date, until: Date): Promise<PublicLadderPriceRowV1[]> {
  return readPublicLadderPricesV1(client, { since, until });
}
