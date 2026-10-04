import type { StockChartResponseV1 } from '@mioagent/rwa-market-reality/stock-chart';

import { stockPriceLabelV1 } from './stockQuotesView';

// ---------------------------------------------------------------------------
// The week on the stock card, drawn from the server's hourly points.
//
// Time runs along x, so a missed ladder pass is a gap rather than a line drawn
// through a price nobody measured, and the weekend bands sit where the
// weekend was. The line has no colour of its own: a rise is not good news and
// a fall is not bad news, so the chart claims neither (see the 24h change).
// ---------------------------------------------------------------------------

/** Fewer points than this draw a shape that says nothing: no chart. */
export const STOCK_CHART_MIN_POINTS_V1 = 12;
/** A longer silence is drawn as a gap. The ladder runs at least every two
 * hours, so four hours without a point is a missed pass, not a quiet market. */
export const STOCK_CHART_GAP_MS_V1 = 4 * 3_600_000;

export interface StockChartViewV1 {
  /** An SVG path in a 100 × 40 box, y down. */
  path: string;
  /** When only Base traded, as x ranges in the same box. */
  baseOnly: { x: number; width: number }[];
  low: string;
  high: string;
  /** For a screen reader: what the line shows, in words. */
  label: string;
  caption: string;
}

const WIDTH_V1 = 100;
const HEIGHT_V1 = 40;
/** Room above and below the line, so the high and the low are not clipped. */
const PAD_V1 = 4;

export function stockChartViewV1(chart: StockChartResponseV1 | null, name: string): StockChartViewV1 | null {
  if (!chart || chart.points.length < STOCK_CHART_MIN_POINTS_V1) return null;
  const from = Date.parse(chart.from);
  const to = Date.parse(chart.asOf);
  const span = to - from;
  if (!Number.isFinite(span) || span <= 0) return null;

  const mids = chart.points.map((point) => point.mid);
  const low = Math.min(...mids);
  const high = Math.max(...mids);
  // A flat week is drawn flat, in the middle, not stretched into a zigzag.
  const range = high - low || high * 0.01 || 1;
  const middle = (high + low) / 2;
  const x = (at: number) => Math.max(0, Math.min(WIDTH_V1, ((at - from) / span) * WIDTH_V1));
  const y = (mid: number) =>
    HEIGHT_V1 / 2 - ((mid - middle) / range) * (HEIGHT_V1 - 2 * PAD_V1);

  let path = '';
  let previous: number | null = null;
  for (const point of chart.points) {
    const at = Date.parse(point.at);
    const move = previous === null || at - previous > STOCK_CHART_GAP_MS_V1 ? 'M' : 'L';
    path += `${move}${x(at).toFixed(2)},${y(point.mid).toFixed(2)}`;
    previous = at;
  }

  const baseOnly = chart.baseOnly
    .map((band) => {
      const start = x(Date.parse(band.from));
      return { x: Number(start.toFixed(2)), width: Number((x(Date.parse(band.to)) - start).toFixed(2)) };
    })
    .filter((band) => band.width > 0);

  const first = stockPriceLabelV1(mids[0]!);
  const last = stockPriceLabelV1(mids[mids.length - 1]!);
  return {
    path,
    baseOnly,
    low: stockPriceLabelV1(low),
    high: stockPriceLabelV1(high),
    label:
      `${name} on Base over 7 days, hourly: from ${first} to ${last}, ` +
      `low ${stockPriceLabelV1(low)}, high ${stockPriceLabelV1(high)}.`,
    caption:
      baseOnly.length > 0
        ? '7 days on Base, hourly. Shaded: Wall Street was closed and the stock traded only on Base.'
        : '7 days on Base, hourly.',
  };
}
