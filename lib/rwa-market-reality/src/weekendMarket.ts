import { z } from 'zod';

import { REVIEWED_US_EQUITIES_CALENDAR_2026_V1, type ReviewedReferenceCalendarV1 } from './referenceSession.js';

// ---------------------------------------------------------------------------
// The weekend market.
//
// Wall Street goes quiet on Friday evening and the reference feeds with it:
// the Chainlink feeds for Coinbase's tokenized stocks publish through the
// overnight session and stop only across the weekend. The last print lands by
// 20:00 ET on Friday, and the next one comes at 20:00 ET on Sunday, when the
// overnight session opens. The tokens on Base keep trading the whole time.
//
// Measured 2026-09-25 over four weekends of the public ladder:
//   * the price on Base moves. The median weekend range was 0.66% for the
//     large caps and 1.42% for the thin names;
//   * the market is open. Pools saw ~70k token movements per weekend day,
//     against 100–130k on a weekday;
//   * it is NOT a forecast. The Sunday price on Base pointed the way the
//     reopen went in 19 of 30 cases, 10 of 10 on one weekend and 0 of 4 on
//     another. This card says where the market trades, never where Monday opens;
//   * ~1% of quotes are junk (more than 10% away from the reference). One NVDAc
//     range came out at 10^46 bps before they were dropped. A single run
//     therefore never names a price here: a price is the median of six hours.
//
// Pure: runs in, a response out. The server reads the runs, the card renders
// the response, and both surfaces see one computation.
// ---------------------------------------------------------------------------

export const WEEKEND_MARKET_SCHEMA_VERSION_V1 = 'weekend-market/v1' as const;

/** A price is the median of this window, never one run. */
export const WEEKEND_MEDIAN_WINDOW_HOURS_V1 = 6;
/** Fewer runs than this in the window and no price is named. */
export const WEEKEND_MIN_SAMPLES_V1 = 3;
/** A run further than this from its own reference is a broken quote. */
export const WEEKEND_JUNK_RATIO_V1 = 0.1;
/** Below this, a reopen gap has no direction worth comparing with. */
export const WEEKEND_MEANINGFUL_GAP_BPS_V1 = 20;

/** One public-ladder run for one stock: the mid of the best buy and sell at
 * the smallest size, and the feed value that stood beside it. */
export interface WeekendMarketRunV1 {
  at: string;
  mid: number;
  reference: number;
  referenceUpdatedAt: string;
}

export interface WeekendMarketStockInputV1 {
  tokenAddress: string;
  /** The company's ticker, e.g. NVDA. */
  symbol: string;
  name: string;
  runs: readonly WeekendMarketRunV1[];
}

const IsoV1 = z.string().datetime({ offset: true });
const DecimalV1 = z.string().regex(/^\d+(?:\.\d+)?$/);

export const WeekendMarketWindowV1Schema = z
  .object({
    /** The last regular session's close: the price every move is measured from. */
    closeAt: IsoV1,
    /** When the feed goes quiet: 20:00 ET that evening. */
    darkStartAt: IsoV1,
    /** 20:00 ET on the evening before the next session. The feed's own first
     * print is what says it happened. */
    expectedReopenAt: IsoV1,
    /** The result stays on the board until the next session closes. */
    nextSessionCloseAt: IsoV1,
  })
  .strict();
export type WeekendMarketWindowV1 = z.infer<typeof WeekendMarketWindowV1Schema>;

export const WeekendMarketStockV1Schema = z
  .object({
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    symbol: z.string().min(1).max(40),
    name: z.string().min(1).max(200),
    /** The feed value at the close, USD per share. */
    close: DecimalV1.nullable(),
    /** The median price on Base over the last six hours of the quiet period,
     * or the six hours before the reopen once it came. */
    base: z
      .object({
        value: DecimalV1,
        moveBps: z.number().int(),
        samples: z.number().int().positive(),
        from: IsoV1,
        to: IsoV1,
      })
      .strict()
      .nullable(),
    /** The feed's first print after the quiet period. */
    reopen: z
      .object({
        value: DecimalV1,
        at: IsoV1,
        gapBps: z.number().int(),
        /** Null when the gap is too small to have a direction. */
        sameDirection: z.boolean().nullable(),
      })
      .strict()
      .nullable(),
    unavailable: z.enum(['no_close_reference', 'too_few_measurements']).nullable(),
  })
  .strict();
export type WeekendMarketStockV1 = z.infer<typeof WeekendMarketStockV1Schema>;

export const WeekendMarketResponseV1Schema = z
  .object({
    schemaVersion: z.literal(WEEKEND_MARKET_SCHEMA_VERSION_V1),
    state: z.enum(['none', 'in_progress', 'reopened']),
    generatedAt: IsoV1,
    window: WeekendMarketWindowV1Schema.nullable(),
    stocks: z.array(WeekendMarketStockV1Schema),
    /** Once reopened: for how many stocks the Base price pointed the way the
     * reopen went, out of those whose gap had a direction. */
    called: z
      .object({ sameDirection: z.number().int().nonnegative(), meaningful: z.number().int().nonnegative() })
      .strict()
      .nullable(),
  })
  .strict();
export type WeekendMarketResponseV1 = z.infer<typeof WeekendMarketResponseV1Schema>;

// --- Eastern time, without a timezone library --------------------------------

function etPartsV1(instant: Date): { localDate: string; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    localDate: `${value('year')}-${value('month')}-${value('day')}`,
    minuteOfDay: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

/** The instant a New York wall clock shows `minuteOfDay` on `localDate`.
 * Tries both of the offsets New York uses and keeps the one that reads back. */
export function etInstantV1(localDate: string, minuteOfDay: number): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(Date.UTC(year!, month! - 1, day!, 0, minuteOfDay) + offsetHours * 3_600_000);
    const back = etPartsV1(candidate);
    if (back.localDate === localDate && back.minuteOfDay === minuteOfDay) return candidate;
  }
  // Only reachable inside a DST switch hour, which no session boundary sits in.
  return new Date(Date.UTC(year!, month! - 1, day!, 0, minuteOfDay) + 5 * 3_600_000);
}

function shiftDateV1(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function sessionOnV1(localDate: string, calendar: ReviewedReferenceCalendarV1): { close: number } | null {
  if (localDate < calendar.validFrom || localDate > calendar.validThrough) return null;
  const weekday = new Date(`${localDate}T12:00:00.000Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || calendar.closedDates.includes(localDate)) return null;
  return { close: calendar.earlyCloseMinutes[localDate] ?? calendar.regularCloseMinute };
}

/**
 * The quiet period `now` belongs to, or null.
 *
 * Null on a weeknight: the overnight session opens at 20:00 ET the same
 * evening, so the feed never goes quiet. Null outside the reviewed calendar
 * too, because this module never guesses a holiday. A holiday Monday moves
 * the reopen to Monday 20:00 ET, which is what happened on Labor Day 2026.
 */
export function weekendWindowV1(
  now: Date,
  calendar: ReviewedReferenceCalendarV1 = REVIEWED_US_EQUITIES_CALENDAR_2026_V1,
): WeekendMarketWindowV1 | null {
  const local = etPartsV1(now);
  let closedDate: string | null = null;
  let closeMinute = 0;
  for (let offset = 0; offset <= 10 && !closedDate; offset += 1) {
    const date = shiftDateV1(local.localDate, -offset);
    const session = sessionOnV1(date, calendar);
    if (!session || (offset === 0 && local.minuteOfDay < session.close)) continue;
    closedDate = date;
    closeMinute = session.close;
  }
  if (!closedDate) return null;
  let nextDate: string | null = null;
  let nextClose = 0;
  for (let offset = 1; offset <= 10 && !nextDate; offset += 1) {
    const date = shiftDateV1(closedDate, offset);
    const session = sessionOnV1(date, calendar);
    if (!session) continue;
    nextDate = date;
    nextClose = session.close;
  }
  if (!nextDate) return null;
  const darkStart = etInstantV1(closedDate, 20 * 60);
  const expectedReopen = etInstantV1(shiftDateV1(nextDate, -1), 20 * 60);
  if (expectedReopen.getTime() <= darkStart.getTime()) return null;
  return {
    closeAt: etInstantV1(closedDate, closeMinute).toISOString(),
    darkStartAt: darkStart.toISOString(),
    expectedReopenAt: expectedReopen.toISOString(),
    nextSessionCloseAt: etInstantV1(nextDate, nextClose).toISOString(),
  };
}

function medianV1(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function bpsV1(value: number, basis: number): number {
  return Math.round((value / basis - 1) * 10_000);
}

function priceV1(value: number): string {
  return value.toFixed(2);
}

function stockRowV1(stock: WeekendMarketStockInputV1, window: WeekendMarketWindowV1, now: Date): WeekendMarketStockV1 {
  const nowMs = now.getTime();
  const closeAtMs = Date.parse(window.closeAt);
  const darkStartMs = Date.parse(window.darkStartAt);
  const runs = stock.runs
    .map((run) => ({ ...run, atMs: Date.parse(run.at), referenceAtMs: Date.parse(run.referenceUpdatedAt) }))
    .filter(
      (run) =>
        Number.isFinite(run.atMs) &&
        Number.isFinite(run.referenceAtMs) &&
        run.atMs <= nowMs &&
        Number.isFinite(run.mid) &&
        run.mid > 0 &&
        Number.isFinite(run.reference) &&
        run.reference > 0 &&
        Math.abs(run.mid / run.reference - 1) <= WEEKEND_JUNK_RATIO_V1,
    );

  // The close: the latest value the feed had published by the bell.
  const atClose = runs
    .filter((run) => run.referenceAtMs <= closeAtMs)
    .sort((a, b) => b.referenceAtMs - a.referenceAtMs || b.atMs - a.atMs)[0];
  // The reopen: the first value it published after going quiet.
  const reopened = runs
    .filter((run) => run.referenceAtMs > darkStartMs)
    .sort((a, b) => a.referenceAtMs - b.referenceAtMs)[0];

  const end = reopened ? reopened.referenceAtMs : nowMs;
  const start = Math.max(darkStartMs, end - WEEKEND_MEDIAN_WINDOW_HOURS_V1 * 3_600_000);
  const quiet = runs.filter((run) => run.atMs >= start && run.atMs < end);

  const base = { tokenAddress: stock.tokenAddress.toLowerCase(), symbol: stock.symbol, name: stock.name };
  if (!atClose) return { ...base, close: null, base: null, reopen: null, unavailable: 'no_close_reference' };
  const close = atClose.reference;
  const median = quiet.length >= WEEKEND_MIN_SAMPLES_V1 ? medianV1(quiet.map((run) => run.mid)) : null;
  const baseReading =
    median === null
      ? null
      : {
          value: priceV1(median),
          moveBps: bpsV1(median, close),
          samples: quiet.length,
          from: new Date(start).toISOString(),
          to: new Date(end).toISOString(),
        };
  const reopen = reopened
    ? (() => {
        const gapBps = bpsV1(reopened.reference, close);
        const sameDirection =
          Math.abs(gapBps) < WEEKEND_MEANINGFUL_GAP_BPS_V1 || !baseReading || baseReading.moveBps === 0
            ? null
            : Math.sign(baseReading.moveBps) === Math.sign(gapBps);
        return { value: priceV1(reopened.reference), at: new Date(reopened.referenceAtMs).toISOString(), gapBps, sameDirection };
      })()
    : null;
  return {
    ...base,
    close: priceV1(close),
    base: baseReading,
    reopen,
    unavailable: baseReading ? null : 'too_few_measurements',
  };
}

/**
 * The weekend as one answer.
 *
 * `none` outside a quiet period and after the next session closes, so the
 * card never shows last weekend on a Wednesday. `in_progress` from 20:00 ET
 * Friday until a feed prints again. `reopened` after that, until the next
 * session's close.
 */
export function weekendMarketV1(input: {
  now: Date;
  stocks: readonly WeekendMarketStockInputV1[];
  calendar?: ReviewedReferenceCalendarV1;
}): WeekendMarketResponseV1 {
  const generatedAt = input.now.toISOString();
  const window = weekendWindowV1(input.now, input.calendar);
  const nowMs = input.now.getTime();
  if (!window || nowMs < Date.parse(window.darkStartAt) || nowMs >= Date.parse(window.nextSessionCloseAt)) {
    return { schemaVersion: WEEKEND_MARKET_SCHEMA_VERSION_V1, state: 'none', generatedAt, window: null, stocks: [], called: null };
  }
  const rows = input.stocks.map((stock) => stockRowV1(stock, window, input.now));
  const state = rows.some((row) => row.reopen !== null) ? 'reopened' : 'in_progress';
  // Biggest moves first: in progress by the move on Base, reopened by the gap.
  const weight = (row: WeekendMarketStockV1) =>
    state === 'reopened' ? Math.abs(row.reopen?.gapBps ?? -1) : Math.abs(row.base?.moveBps ?? -1);
  rows.sort((a, b) => weight(b) - weight(a) || a.symbol.localeCompare(b.symbol));
  const meaningful = rows.filter((row) => row.reopen?.sameDirection !== null && row.reopen?.sameDirection !== undefined);
  return {
    schemaVersion: WEEKEND_MARKET_SCHEMA_VERSION_V1,
    state,
    generatedAt,
    window,
    stocks: rows,
    called:
      state === 'reopened'
        ? { sameDirection: meaningful.filter((row) => row.reopen!.sameDirection === true).length, meaningful: meaningful.length }
        : null,
  };
}
