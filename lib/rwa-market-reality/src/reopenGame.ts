import { z } from 'zod';

import { REVIEWED_US_EQUITIES_CALENDAR_2026_V1, type ReviewedReferenceCalendarV1 } from './referenceSession.js';
import {
  etInstantV1,
  etLocalDateV1,
  nextWeekendStartV1,
  weekendMarketV1,
  weekendWindowV1,
  type WeekendMarketStockInputV1,
  type WeekendMarketWindowV1,
} from './weekendMarket.js';

// ---------------------------------------------------------------------------
// Call the reopen: one round per weekend.
//
// From 20:00 ET on Friday until 20:00 ET on Sunday, Wall Street and its
// reference feeds are dark while Coinbase's stock tokens keep trading on Base.
// A round asks one question about five stocks: will each reopen above or below
// Friday's close? Players answer, and so does Base.
//
// THE RULES, AND WHY EACH ONE
//
//  * Picks close at 17:00 ET on Sunday, three hours before the reopen. US equity
//    index futures open at 18:00 ET on Sunday and point the way, and 24/5
//    brokers trade from 20:00; a round that locked later would be won by
//    whoever picked last.
//  * Base calls at the same instant: up if the price on Base (the weekend
//    card's six-hour median) is above Friday's close, down if below. Same
//    moment, same information. Base's record is built from rounds actually
//    played, never from the 19 of 30 measured before the game existed.
//  * Friday's close is the reference feed's value at the 16:00 ET bell and
//    the reopen is the first value the feed published after going quiet, as
//    Miorail's sampler recorded it: the two numbers the weekend card shows.
//  * Equal to the cent has no direction, and a stock with no reopen print is
//    void: it counts for nobody, Base included.
//  * No prizes. The tokens are not offered to US persons, and a contest whose
//    prize is a security is a legal question. A round is played for the record.
//
// Pure: stored runs in, a round out. The server freezes each stage in the
// database as it passes, and every stage computes the same answer whenever it
// is computed, because it reads only runs measured before its own moment.
// ---------------------------------------------------------------------------

export const REOPEN_GAME_SCHEMA_VERSION_V1 = 'call-the-reopen/v1' as const;

/**
 * The five stocks every round asks about, in the order a round lists them.
 *
 * Fixed rather than chosen each week, so a player calls the same names every
 * weekend. Each has a Chainlink reference and trades on Base through the
 * weekend; Strategy moves with bitcoin, which never closes.
 */
export const REOPEN_LINEUP_V1 = ['NVDA', 'TSLA', 'AAPL', 'AMZN', 'MSTR'] as const;

/** Picks close at 17:00 ET on the Sunday inside the weekend. */
export const REOPEN_LOCK_MINUTE_ET_V1 = 17 * 60;

/**
 * Base's call is fixed this long after the lock. A sampler pass takes about
 * five minutes, so a quote measured at 16:59 can be written at 17:03; fixing
 * the call before it lands would make the call depend on when it was fixed.
 */
export const REOPEN_CALL_GRACE_MS_V1 = 10 * 60_000;

/** Without a reopen print for every stock, a round settles this long after the
 * expected reopen with what came; the rest are void. */
export const REOPEN_SETTLE_GRACE_MS_V1 = 6 * 3_600_000;

/** A reopen print earlier than this before the expected reopen is not the
 * reopen. The feeds are dark all weekend; a print in the middle of it would be
 * something else, and a round is settled on the session, not on an anomaly. */
const REOPEN_EARLY_PRINT_MS_V1 = 15 * 60_000;

const IsoV1 = z.string().datetime({ offset: true });
const CentsV1 = z.string().regex(/^\d+\.\d{2}$/);
const DirectionV1 = z.enum(['up', 'down']);
export type ReopenDirectionV1 = z.infer<typeof DirectionV1>;

export const ReopenRoundIdV1Schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// --- The schedule -------------------------------------------------------------

export interface ReopenScheduleV1 {
  /** The New York date of the close before the quiet period: one round each. */
  roundId: string;
  closeAt: string;
  opensAt: string;
  locksAt: string;
  expectedReopenAt: string;
  /** The weekend card's own horizon. A result is computed inside it. */
  nextSessionCloseAt: string;
}

function shiftDateV1(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/**
 * The round a quiet period holds, or null when it holds none.
 *
 * A quiet period without a Sunday in it, such as one holiday in the middle of a
 * week, has no round: futures and brokers trade straight through it.
 */
export function reopenScheduleOfWindowV1(window: WeekendMarketWindowV1): ReopenScheduleV1 | null {
  const opensMs = Date.parse(window.darkStartAt);
  const reopenMs = Date.parse(window.expectedReopenAt);
  const firstDay = etLocalDateV1(new Date(opensMs));
  let sunday: string | null = null;
  for (let offset = 0; offset <= 4 && sunday === null; offset += 1) {
    const date = shiftDateV1(firstDay, offset);
    if (new Date(`${date}T12:00:00.000Z`).getUTCDay() === 0) sunday = date;
  }
  if (sunday === null) return null;
  const locksMs = etInstantV1(sunday, REOPEN_LOCK_MINUTE_ET_V1).getTime();
  if (!(locksMs > opensMs && locksMs < reopenMs)) return null;
  return {
    roundId: etLocalDateV1(new Date(Date.parse(window.closeAt))),
    closeAt: window.closeAt,
    opensAt: window.darkStartAt,
    locksAt: new Date(locksMs).toISOString(),
    expectedReopenAt: window.expectedReopenAt,
    nextSessionCloseAt: window.nextSessionCloseAt,
  };
}

/**
 * The round `now` is inside, from its opening until the next session closes,
 * and the next round to open. Both null past the reviewed calendar: the end of
 * our calendar is not a weekend.
 */
export function reopenSchedulesV1(
  now: Date,
  calendar: ReviewedReferenceCalendarV1 = REVIEWED_US_EQUITIES_CALENDAR_2026_V1,
): { current: ReopenScheduleV1 | null; next: ReopenScheduleV1 | null } {
  const nowMs = now.getTime();
  const window = weekendWindowV1(now, calendar);
  const current =
    window && nowMs >= Date.parse(window.darkStartAt) && nowMs < Date.parse(window.nextSessionCloseAt)
      ? reopenScheduleOfWindowV1(window)
      : null;
  let next: ReopenScheduleV1 | null = null;
  let from = now;
  for (let tries = 0; tries < 6 && next === null; tries += 1) {
    const start = nextWeekendStartV1(from, calendar);
    if (!start) break;
    const startMs = Date.parse(start);
    const following = weekendWindowV1(new Date(startMs + 60_000), calendar);
    const schedule = following ? reopenScheduleOfWindowV1(following) : null;
    if (schedule && schedule.roundId !== current?.roundId) next = schedule;
    from = new Date(startMs + 60_000);
  }
  return { current, next };
}

// --- The three frozen stages ------------------------------------------------

export const ReopenStockV1Schema = z
  .object({
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    symbol: z.string().min(1).max(40),
    name: z.string().min(1).max(200),
    /** The feed's value at Friday's bell, to the cent: the line every call is about. */
    close: CentsV1,
  })
  .strict();
export type ReopenStockV1 = z.infer<typeof ReopenStockV1Schema>;

export const ReopenCallV1Schema = z
  .object({
    symbol: z.string().min(1).max(40),
    /** Base's six-hour median at the lock; null with too few quotes to name one. */
    base: CentsV1.nullable(),
    call: DirectionV1.nullable(),
  })
  .strict();
export type ReopenCallV1 = z.infer<typeof ReopenCallV1Schema>;

export const ReopenResultV1Schema = z
  .object({
    symbol: z.string().min(1).max(40),
    reopen: CentsV1.nullable(),
    at: IsoV1.nullable(),
    outcome: z.enum(['up', 'down', 'void']),
  })
  .strict();
export type ReopenResultV1 = z.infer<typeof ReopenResultV1Schema>;

function centsV1(value: string): number {
  const [whole, fraction = '00'] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
}

/** Up or down from the close, to the cent. Equal is no direction. */
export function reopenDirectionV1(value: string, close: string): ReopenDirectionV1 | null {
  const a = centsV1(value);
  const b = centsV1(close);
  return a > b ? 'up' : a < b ? 'down' : null;
}

/**
 * The stocks a round asks about, frozen when it opens.
 *
 * The caller passes ONE issuer's tokens: a symbol is not an identifier, and
 * another issuer's NVDA would be a different question. A lineup stock the
 * feed had no close for is left out of the round, not asked with a guess.
 */
export function reopenLineupV1(input: {
  schedule: ReopenScheduleV1;
  stocks: readonly WeekendMarketStockInputV1[];
  calendar?: ReviewedReferenceCalendarV1;
}): ReopenStockV1[] {
  const board = weekendMarketV1({
    now: new Date(Date.parse(input.schedule.opensAt)),
    stocks: input.stocks,
    ...(input.calendar ? { calendar: input.calendar } : {}),
  });
  return REOPEN_LINEUP_V1.flatMap((symbol) => {
    const row = board.stocks
      .filter((stock) => stock.symbol === symbol && stock.close !== null)
      .sort((a, b) => a.tokenAddress.localeCompare(b.tokenAddress))[0];
    return row && row.close ? [{ tokenAddress: row.tokenAddress, symbol, name: row.name, close: row.close }] : [];
  });
}

/** Base's call, from the prices measured before the lock and nothing after. */
export function reopenBaseCallsV1(input: {
  schedule: ReopenScheduleV1;
  lineup: readonly ReopenStockV1[];
  stocks: readonly WeekendMarketStockInputV1[];
  calendar?: ReviewedReferenceCalendarV1;
}): ReopenCallV1[] {
  const board = weekendMarketV1({
    now: new Date(Date.parse(input.schedule.locksAt)),
    stocks: input.stocks,
    ...(input.calendar ? { calendar: input.calendar } : {}),
  });
  return input.lineup.map((stock) => {
    const base = board.stocks.find((row) => row.tokenAddress === stock.tokenAddress)?.base?.value ?? null;
    return { symbol: stock.symbol, base, call: base === null ? null : reopenDirectionV1(base, stock.close) };
  });
}

/**
 * Where each stock reopened, and whether that settles the round yet.
 *
 * Computed inside the weekend card's horizon whenever it is asked, so a round
 * nobody looked at until Tuesday settles exactly as it would have on Sunday.
 */
export function reopenResultsV1(input: {
  schedule: ReopenScheduleV1;
  lineup: readonly ReopenStockV1[];
  stocks: readonly WeekendMarketStockInputV1[];
  now: Date;
  calendar?: ReviewedReferenceCalendarV1;
}): { complete: boolean; results: ReopenResultV1[] } {
  const nowMs = input.now.getTime();
  const expectedMs = Date.parse(input.schedule.expectedReopenAt);
  const at = Math.min(nowMs, Date.parse(input.schedule.nextSessionCloseAt) - 1);
  const board = weekendMarketV1({
    now: new Date(at),
    stocks: input.stocks,
    ...(input.calendar ? { calendar: input.calendar } : {}),
  });
  const results = input.lineup.map((stock): ReopenResultV1 => {
    const reopen = board.stocks.find((row) => row.tokenAddress === stock.tokenAddress)?.reopen ?? null;
    if (!reopen || Date.parse(reopen.at) < expectedMs - REOPEN_EARLY_PRINT_MS_V1) {
      return { symbol: stock.symbol, reopen: null, at: null, outcome: 'void' };
    }
    return {
      symbol: stock.symbol,
      reopen: reopen.value,
      at: reopen.at,
      outcome: reopenDirectionV1(reopen.value, stock.close) ?? 'void',
    };
  });
  const everyone = results.every((result) => result.reopen !== null);
  const late = nowMs >= expectedMs + REOPEN_SETTLE_GRACE_MS_V1;
  return { complete: nowMs >= expectedMs && (everyone || late), results };
}

// --- Scores -------------------------------------------------------------------

export type ReopenPicksV1 = Readonly<Partial<Record<string, ReopenDirectionV1>>>;

export const ReopenPicksV1Schema = z
  .record(z.string().regex(/^[A-Z0-9.]{1,12}$/), DirectionV1)
  .refine((picks) => Object.keys(picks).length <= REOPEN_LINEUP_V1.length, 'at most one pick per stock');

export const ReopenScoreV1Schema = z
  .object({
    correct: z.number().int().nonnegative(),
    /** Stocks that settled with a direction. A void one counts for nobody. */
    of: z.number().int().nonnegative(),
    /** One square per stock in round order: right, wrong, or no call. */
    cells: z.string().max(40),
  })
  .strict();
export type ReopenScoreV1 = z.infer<typeof ReopenScoreV1Schema>;

export function reopenScoreV1(picks: ReopenPicksV1, results: readonly ReopenResultV1[]): ReopenScoreV1 {
  let correct = 0;
  let of = 0;
  const cells = results.map((result) => {
    if (result.outcome === 'void') return '⬜';
    of += 1;
    const pick = picks[result.symbol];
    if (!pick) return '⬜';
    if (pick === result.outcome) {
      correct += 1;
      return '🟩';
    }
    return '🟥';
  });
  return { correct, of, cells: cells.join('') };
}

export function reopenBasePicksV1(calls: readonly ReopenCallV1[]): ReopenPicksV1 {
  return Object.fromEntries(calls.flatMap((row) => (row.call ? [[row.symbol, row.call]] : [])));
}

/** The crowd's side per stock: the majority, or none on a tie. */
export function reopenCrowdPicksV1(counts: Readonly<Record<string, { up: number; down: number }>>): ReopenPicksV1 {
  return Object.fromEntries(
    Object.entries(counts).flatMap(([symbol, count]): [string, ReopenDirectionV1][] =>
      count.up > count.down ? [[symbol, 'up']] : count.down > count.up ? [[symbol, 'down']] : [],
    ),
  );
}

/** The share line: "Call the reopen #3 🟩🟩🟥🟩⬜ 3/4 · Base 2/4". */
export function reopenShareLineV1(input: { number: number; mine: ReopenScoreV1; base: ReopenScoreV1 }): string {
  return `Call the reopen #${input.number} ${input.mine.cells} ${input.mine.correct}/${input.mine.of} · Base ${input.base.correct}/${input.base.of}`;
}

// --- A player's record ----------------------------------------------------------

export interface ReopenPlayedRoundV1 {
  roundId: string;
  number: number;
  /** Past its lock: a round still open neither extends nor breaks a streak. */
  locked: boolean;
  results: readonly ReopenResultV1[] | null;
  calls: readonly ReopenCallV1[] | null;
  picks: ReopenPicksV1 | null;
}

export const ReopenRecordV1Schema = z
  .object({
    /** Rounds with at least one pick, once they locked. */
    played: z.number().int().nonnegative(),
    /** Weekends in a row, back from the latest locked round. */
    streak: z.number().int().nonnegative(),
    correct: z.number().int().nonnegative(),
    of: z.number().int().nonnegative(),
    /** Settled rounds where the player was right more often than Base. */
    beatBase: z.number().int().nonnegative(),
  })
  .strict();
export type ReopenRecordV1 = z.infer<typeof ReopenRecordV1Schema>;

export function reopenRecordV1(rounds: readonly ReopenPlayedRoundV1[]): ReopenRecordV1 {
  const locked = [...rounds].filter((round) => round.locked).sort((a, b) => b.number - a.number);
  const playedOne = (round: ReopenPlayedRoundV1) => round.picks !== null && Object.keys(round.picks).length > 0;
  let streak = 0;
  for (const round of locked) {
    if (!playedOne(round)) break;
    streak += 1;
  }
  let correct = 0;
  let of = 0;
  let beatBase = 0;
  for (const round of locked) {
    if (!playedOne(round) || !round.results) continue;
    const mine = reopenScoreV1(round.picks!, round.results);
    correct += mine.correct;
    of += mine.of;
    const base = reopenScoreV1(reopenBasePicksV1(round.calls ?? []), round.results);
    if (mine.correct > base.correct) beatBase += 1;
  }
  return { played: locked.filter(playedOne).length, streak, correct, of, beatBase };
}

// --- The wire -----------------------------------------------------------------

export const ReopenGameStockV1Schema = ReopenStockV1Schema.extend({
  /** The weekend card's price on Base right now, while the weekend lasts. */
  baseNow: z.object({ value: CentsV1, moveBps: z.number().int() }).strict().nullable(),
  /** Fixed at the lock; null before it, or with no price to call from. */
  baseCall: ReopenCallV1Schema.omit({ symbol: true }).nullable(),
  /** How the players split, once picks closed. Never shown while they can
   * still change: a crowd on screen is a crowd being copied. */
  crowd: z.object({ up: z.number().int().nonnegative(), down: z.number().int().nonnegative() }).strict().nullable(),
  result: ReopenResultV1Schema.omit({ symbol: true }).nullable(),
}).strict();
export type ReopenGameStockV1 = z.infer<typeof ReopenGameStockV1Schema>;

export const ReopenGameResponseV1Schema = z
  .object({
    schemaVersion: z.literal(REOPEN_GAME_SCHEMA_VERSION_V1),
    generatedAt: IsoV1,
    round: z
      .object({
        roundId: ReopenRoundIdV1Schema,
        number: z.number().int().positive(),
        state: z.enum(['open', 'locked', 'settled']),
        opensAt: IsoV1,
        locksAt: IsoV1,
        expectedReopenAt: IsoV1,
        stocks: z.array(ReopenGameStockV1Schema).max(REOPEN_LINEUP_V1.length),
        /** Players with a pick, once picks closed. */
        players: z.number().int().nonnegative().nullable(),
        /** Once settled. */
        score: z
          .object({ base: ReopenScoreV1Schema, crowd: ReopenScoreV1Schema.nullable() })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    next: z
      .object({ number: z.number().int().positive(), opensAt: IsoV1, locksAt: IsoV1, expectedReopenAt: IsoV1 })
      .strict()
      .nullable(),
    /** Base's record over every settled round. */
    baseRecord: z
      .object({
        rounds: z.number().int().nonnegative(),
        correct: z.number().int().nonnegative(),
        of: z.number().int().nonnegative(),
      })
      .strict(),
    /** The reader's own game: absent for somebody who never picked. */
    me: z
      .object({
        picks: z.record(z.string(), DirectionV1),
        pickedAt: IsoV1.nullable(),
        score: ReopenScoreV1Schema.nullable(),
        record: ReopenRecordV1Schema,
        /** Whether the picks are kept with a wallet or only on this device. */
        signed: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ReopenGameResponseV1 = z.infer<typeof ReopenGameResponseV1Schema>;

export const ReopenPickRequestV1Schema = z
  .object({
    roundId: ReopenRoundIdV1Schema,
    picks: ReopenPicksV1Schema,
  })
  .strict();
export type ReopenPickRequestV1 = z.infer<typeof ReopenPickRequestV1Schema>;

/** A pick's answer: the game as it now stands, and the device's new token
 * when this pick was its first. Kept by the device; only its hash is stored. */
export const ReopenPickResponseV1Schema = z
  .object({
    game: ReopenGameResponseV1Schema,
    device: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable(),
  })
  .strict();
export type ReopenPickResponseV1 = z.infer<typeof ReopenPickResponseV1Schema>;
