import { z } from 'zod';

// ---------------------------------------------------------------------------
// The Stocks list, as prices.
//
// A reader scanning a list of stocks looks for three things before reading a
// word: which company, what it costs, and which way it went. The list showed
// none of them — a ticker in a box — while the public ladder had been pricing
// 38 of the 59 Coinbase stocks every hour (measured 2026-10-03).
//
// The price is the ladder's own: the middle of the best buy and the best sell
// at $100, the smallest size, where a quote moves the price least. It is a
// price ON BASE, said as one, and never a Wall Street price.
//
// One stray quote must not become a headline. Measured over 1,692 quiet-period
// quotes, 0.8% sat more than 1% away from their neighbours, so a price is the
// median of the last three runs inside a window, never a single run.
//
// A price is also only as good as the market behind it. On 2026-10-10 eight
// stocks showed 1.2 to 70 times the share's own price (CAKEc $7,641 against
// $108, PFEc $143 against $28), because a pool of a few hundred dollars was
// their whole market: the $100 trade priced cleanly and a $1,000 buy-and-sell
// lost 20 to 99%. So each row carries the depth the same runs measured, and a
// thin market's price is not presented as the stock's.
// ---------------------------------------------------------------------------

/** How deep the market behind a price is, from the same runs as the price. */
export type StockQuoteDepthStateV1 = 'normal' | 'thin' | 'unmeasured';

export interface StockQuoteDepthV1 {
  /** normal: a $1,000 buy-and-sell keeps more than 80%. thin: it does not.
   * unmeasured: no run in the window priced both legs at $1,000. */
  state: StockQuoteDepthStateV1;
  /** The median loss of those round trips, in basis points. */
  roundTripLossBps: number | null;
  /** The newest run that measured it. */
  measuredAt: string | null;
}

/** A $1,000 round trip losing this much or more is a thin market: the line
 * the ladder's severe band draws, ten times two legs of the 100 bps policy. */
export const STOCK_THIN_MARKET_LOSS_BPS_V1 = 2_000;

/** One stock on the list. Every number is nullable: no price is never $0. */
export interface StockQuoteRowV1 {
  underlyingKey: string;
  tokenAddress: string;
  /** Coinbase's own token symbol, `NVDAc`. */
  tokenSymbol: string | null;
  /** The company, as Coinbase publishes it: `NVIDIA Corporation`. */
  companyName: string | null;
  /** A same-origin path to Coinbase's icon for this token, or null. */
  iconPath: string | null;
  /** The middle of Miorail's $100 buy and sell quotes on Base, in USD. */
  priceUsd: number | null;
  /** The newest run the price was taken from. */
  priceAt: string | null;
  /** Against the same median about 24 hours earlier, as a fraction. */
  change24h: number | null;
  /** The run the 24-hour comparison was taken against. */
  changeFromAt: string | null;
  /** How much of a real trade the price survives. Absent only in a reply
   * from a server older than the field, which is read as `normal`. */
  depth?: StockQuoteDepthV1;
}

export interface StockQuotesResponseV1 {
  schemaVersion: 'stock-quotes/v1';
  asOf: string;
  rows: StockQuoteRowV1[];
}

const IsoV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}T/);

/** The wire, checked by the client before anything is drawn from it. */
export const StockQuotesResponseV1Schema = z
  .object({
    schemaVersion: z.literal('stock-quotes/v1'),
    asOf: IsoV1,
    rows: z
      .array(
        z
          .object({
            underlyingKey: z.string().min(1).max(200),
            tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
            tokenSymbol: z.string().min(1).max(40).nullable(),
            companyName: z.string().min(1).max(200).nullable(),
            iconPath: z
              .string()
              .regex(/^\/api\/public\/stocks\/icons\/0x[0-9a-f]{40}\.png$/)
              .nullable(),
            priceUsd: z.number().positive().finite().nullable(),
            priceAt: IsoV1.nullable(),
            change24h: z.number().finite().nullable(),
            changeFromAt: IsoV1.nullable(),
            depth: z
              .object({
                state: z.enum(['normal', 'thin', 'unmeasured']),
                roundTripLossBps: z.number().int().min(-1_000_000).max(10_000).nullable(),
                measuredAt: IsoV1.nullable(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

export interface StockQuoteStockV1 {
  tokenAddress: string;
  underlyingKey: string;
  tokenSymbol: string | null;
  companyName: string | null;
  iconPath: string | null;
}

/** How far back a price may come from and still be called current. The
 * ladder runs hourly with a drifting minute; three hours keeps a missed pass
 * from blanking the list without letting a dead market look alive. */
export const STOCK_QUOTE_CURRENT_WINDOW_MS_V1 = 3 * 3_600_000;
/** The comparison point: runs within an hour either side of 24 hours ago. */
export const STOCK_QUOTE_DAY_AGO_SLACK_MS_V1 = 3_600_000;
/** How many runs a median is taken over. */
export const STOCK_QUOTE_MEDIAN_RUNS_V1 = 3;

function medianV1(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The depth the price's own runs measured: the median $1,000 round trip. */
export function stockQuoteDepthV1(
  runs: readonly { at: number; buyAt1k?: number | null; sellAt1k?: number | null }[],
): StockQuoteDepthV1 {
  const measured = runs.filter(
    (run) => run.buyAt1k != null && run.sellAt1k != null && run.buyAt1k > 0 && run.sellAt1k > 0,
  );
  if (measured.length === 0) return { state: 'unmeasured', roundTripLossBps: null, measuredAt: null };
  const loss = Math.round(medianV1(measured.map((run) => (1 - run.sellAt1k! / run.buyAt1k!) * 10_000)));
  return {
    state: loss >= STOCK_THIN_MARKET_LOSS_BPS_V1 ? 'thin' : 'normal',
    roundTripLossBps: loss,
    measuredAt: new Date(Math.max(...measured.map((run) => run.at))).toISOString(),
  };
}

export function stockQuotesV1(input: {
  now: Date;
  prices: readonly { token: string; at: string; mid: number; buyAt1k?: number | null; sellAt1k?: number | null }[];
  stocks: readonly StockQuoteStockV1[];
}): StockQuotesResponseV1 {
  const now = input.now.getTime();
  const byToken = new Map<string, { at: number; mid: number; buyAt1k: number | null; sellAt1k: number | null }[]>();
  for (const row of input.prices) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at > now || !Number.isFinite(row.mid) || row.mid <= 0) continue;
    const token = row.token.toLowerCase();
    byToken.set(token, [
      ...(byToken.get(token) ?? []),
      { at, mid: row.mid, buyAt1k: row.buyAt1k ?? null, sellAt1k: row.sellAt1k ?? null },
    ]);
  }
  const rows = input.stocks.map((stock): StockQuoteRowV1 => {
    const runs = (byToken.get(stock.tokenAddress.toLowerCase()) ?? []).sort((a, b) => a.at - b.at);
    const current = runs
      .filter((run) => run.at > now - STOCK_QUOTE_CURRENT_WINDOW_MS_V1)
      .slice(-STOCK_QUOTE_MEDIAN_RUNS_V1);
    const dayAgo = now - 24 * 3_600_000;
    const earlier = runs
      .filter((run) => Math.abs(run.at - dayAgo) <= STOCK_QUOTE_DAY_AGO_SLACK_MS_V1)
      .sort((a, b) => Math.abs(a.at - dayAgo) - Math.abs(b.at - dayAgo))
      .slice(0, STOCK_QUOTE_MEDIAN_RUNS_V1);
    const price = current.length > 0 ? medianV1(current.map((run) => run.mid)) : null;
    const before = earlier.length > 0 ? medianV1(earlier.map((run) => run.mid)) : null;
    return {
      underlyingKey: stock.underlyingKey,
      tokenAddress: stock.tokenAddress.toLowerCase(),
      tokenSymbol: stock.tokenSymbol,
      companyName: stock.companyName,
      iconPath: stock.iconPath,
      priceUsd: price,
      priceAt: price === null ? null : new Date(current[current.length - 1]!.at).toISOString(),
      change24h: price !== null && before !== null ? price / before - 1 : null,
      changeFromAt: price !== null && before !== null ? new Date(earlier[0]!.at).toISOString() : null,
      depth: stockQuoteDepthV1(current),
    };
  });
  return { schemaVersion: 'stock-quotes/v1', asOf: input.now.toISOString(), rows };
}
