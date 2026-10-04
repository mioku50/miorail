import { z } from 'zod';

import {
  STOCK_QUOTE_CURRENT_WINDOW_MS_V1,
  STOCK_QUOTE_MEDIAN_RUNS_V1,
} from './stockQuotes.js';
import { weekendWindowV1 } from './weekendMarket.js';

// ---------------------------------------------------------------------------
// A week of one stock's price on Base, for the small chart on its card.
//
// Every point is the price the card itself would have shown at the end of
// that hour: the median of the last three ladder runs inside three hours, the
// rule `stockQuotesV1` uses for the headline. So the chart's last point is the
// card's price, and one stray quote (0.8% of quiet-period quotes sat more than
// 1% from their neighbours) never becomes a spike.
//
// The weekend is marked, because that is the part only Base has: from 20:00
// ET on the last session before a weekend until 20:00 ET on the evening
// before the next one, Wall Street and its overnight session are both shut
// and the token is the only place the stock trades. The windows come from the
// reviewed calendar, so a holiday Friday is marked as Thursday evening onward,
// and nothing is marked past the calendar's end.
// ---------------------------------------------------------------------------

export const STOCK_CHART_DAYS_V1 = 7;
const HOUR_MS = 3_600_000;

export interface StockChartPointV1 {
  /** The end of the hour this point stands for. */
  at: string;
  /** The card's price at that moment, in USD. */
  mid: number;
}

export interface StockChartResponseV1 {
  schemaVersion: 'stock-chart/v1';
  tokenAddress: string;
  asOf: string;
  /** The start of the week shown. */
  from: string;
  points: StockChartPointV1[];
  /** When only Base traded: Wall Street's weekend dark windows in the week. */
  baseOnly: { from: string; to: string }[];
}

const IsoV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}T/);

export const StockChartResponseV1Schema = z
  .object({
    schemaVersion: z.literal('stock-chart/v1'),
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    asOf: IsoV1,
    from: IsoV1,
    points: z
      .array(z.object({ at: IsoV1, mid: z.number().positive().finite() }).strict())
      .max(STOCK_CHART_DAYS_V1 * 24 + 1),
    baseOnly: z.array(z.object({ from: IsoV1, to: IsoV1 }).strict()).max(8),
  })
  .strict();

function medianV1(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Four decimals: a cent is the smallest step the card shows, and a sub-dollar
 * stock still draws a line. */
function roundV1(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** The weekend dark windows that overlap [from, to], clipped to it. */
export function stockChartBaseOnlyV1(from: Date, to: Date): { from: string; to: string }[] {
  const seen = new Map<string, { from: string; to: string }>();
  for (let at = from.getTime(); at <= to.getTime(); at += HOUR_MS) {
    const window = weekendWindowV1(new Date(at));
    if (!window) continue;
    const start = Math.max(Date.parse(window.darkStartAt), from.getTime());
    const end = Math.min(Date.parse(window.expectedReopenAt), to.getTime());
    if (end <= start) continue;
    seen.set(window.darkStartAt, { from: new Date(start).toISOString(), to: new Date(end).toISOString() });
  }
  return [...seen.values()].sort((a, b) => a.from.localeCompare(b.from));
}

export function stockChartV1(input: {
  now: Date;
  tokenAddress: string;
  /** This token's ladder mids; others are ignored. */
  prices: readonly { token: string; at: string; mid: number }[];
}): StockChartResponseV1 {
  const now = input.now.getTime();
  const token = input.tokenAddress.toLowerCase();
  const from = now - STOCK_CHART_DAYS_V1 * 24 * HOUR_MS;
  const runs = input.prices
    .filter((row) => row.token.toLowerCase() === token)
    .map((row) => ({ at: Date.parse(row.at), mid: row.mid }))
    .filter((row) => Number.isFinite(row.at) && row.at <= now && Number.isFinite(row.mid) && row.mid > 0)
    .sort((a, b) => a.at - b.at);

  // One point per hour that had a run of its own, taken at the hour's end
  // (or now, for the hour still running). A run exactly on the hour belongs to
  // the hour it ends, so a boundary never yields two points at one moment.
  const ends = new Set<number>();
  for (const run of runs) if (run.at > from) ends.add(Math.min(Math.ceil(run.at / HOUR_MS) * HOUR_MS, now));
  const points: StockChartPointV1[] = [];
  for (const end of [...ends].sort((a, b) => a - b)) {
    const window = runs
      .filter((run) => run.at <= end && run.at > end - STOCK_QUOTE_CURRENT_WINDOW_MS_V1)
      .slice(-STOCK_QUOTE_MEDIAN_RUNS_V1);
    if (window.length === 0) continue;
    points.push({ at: new Date(end).toISOString(), mid: roundV1(medianV1(window.map((run) => run.mid))) });
  }

  return {
    schemaVersion: 'stock-chart/v1',
    tokenAddress: token,
    asOf: input.now.toISOString(),
    from: new Date(from).toISOString(),
    points,
    baseOnly: stockChartBaseOnlyV1(new Date(from), input.now),
  };
}
