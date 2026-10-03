import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  REOPEN_CALL_GRACE_MS_V1,
  REOPEN_LINEUP_V1,
  ReopenGameResponseV1Schema,
  ReopenPickRequestV1Schema,
  reopenBaseCallsV1,
  reopenBasePicksV1,
  reopenCrowdPicksV1,
  reopenDirectionV1,
  reopenLineupV1,
  reopenRecordV1,
  reopenResultsV1,
  reopenScheduleOfWindowV1,
  reopenSchedulesV1,
  reopenScoreV1,
  reopenShareLineV1,
  type ReopenResultV1,
} from '../src/reopenGame.js';
import { etInstantV1, weekendWindowV1, type WeekendMarketRunV1, type WeekendMarketStockInputV1 } from '../src/weekendMarket.js';

const et = (localDate: string, clock: string): Date => {
  const [hour, minute] = clock.split(':').map(Number);
  return etInstantV1(localDate, hour! * 60 + minute!);
};
const iso = (localDate: string, clock: string) => et(localDate, clock).toISOString();

function hourly(input: {
  fromDate: string;
  fromClock: string;
  hours: number;
  mid: number;
  reference: number;
  referenceUpdatedAt: string;
}): WeekendMarketRunV1[] {
  const start = et(input.fromDate, input.fromClock).getTime();
  return Array.from({ length: input.hours }, (_, index) => ({
    at: new Date(start + index * 3_600_000).toISOString(),
    mid: input.mid,
    reference: input.reference,
    referenceUpdatedAt: input.referenceUpdatedAt,
  }));
}

/**
 * The weekend of 2026-10-09: a close at 100, Base drifting to `sunday` by the
 * lock, and the feed reopening at `reopen` (or never, with null).
 */
function stock(input: {
  symbol: string;
  token: string;
  sunday: number;
  reopen: number | null;
  afterLock?: number;
}): WeekendMarketStockInputV1 {
  const closePrint = iso('2026-10-09', '15:59');
  const lastPrint = iso('2026-10-09', '19:58');
  const runs = [
    ...hourly({ fromDate: '2026-10-09', fromClock: '14:05', hours: 2, mid: 100.05, reference: 100, referenceUpdatedAt: closePrint }),
    ...hourly({ fromDate: '2026-10-09', fromClock: '17:05', hours: 3, mid: 100.2, reference: 100.2, referenceUpdatedAt: lastPrint }),
    ...hourly({ fromDate: '2026-10-11', fromClock: '10:05', hours: 7, mid: input.sunday, reference: 100.2, referenceUpdatedAt: lastPrint }),
    // After the lock Base keeps moving; none of it may reach Base's call.
    ...hourly({ fromDate: '2026-10-11', fromClock: '17:05', hours: 3, mid: input.afterLock ?? input.sunday, reference: 100.2, referenceUpdatedAt: lastPrint }),
    ...(input.reopen === null
      ? []
      : hourly({ fromDate: '2026-10-11', fromClock: '20:03', hours: 2, mid: input.reopen, reference: input.reopen, referenceUpdatedAt: iso('2026-10-11', '20:00') })),
  ];
  return { tokenAddress: input.token, symbol: input.symbol, name: `${input.symbol} Inc.`, runs };
}

const token = (n: number) => `0xb2${String(n).padStart(38, '0')}`;
const WEEKEND = [
  stock({ symbol: 'NVDA', token: token(1), sunday: 101, reopen: 102 }),
  stock({ symbol: 'TSLA', token: token(2), sunday: 99, reopen: 101, afterLock: 98 }),
  stock({ symbol: 'AAPL', token: token(3), sunday: 100.5, reopen: 100 }),
  stock({ symbol: 'AMZN', token: token(4), sunday: 99.5, reopen: 99 }),
  stock({ symbol: 'MSTR', token: token(5), sunday: 104, reopen: null }),
  // Not in the lineup: never asked about, whatever it does.
  stock({ symbol: 'META', token: token(6), sunday: 110, reopen: 111 }),
];

const SCHEDULE = reopenScheduleOfWindowV1(weekendWindowV1(et('2026-10-10', '12:00'))!)!;

describe('a round lives inside one weekend', () => {
  test('it opens Friday 20:00 ET, locks Sunday 17:00 ET and is named by the close', () => {
    assert.deepEqual(SCHEDULE, {
      roundId: '2026-10-09',
      closeAt: iso('2026-10-09', '16:00'),
      opensAt: iso('2026-10-09', '20:00'),
      locksAt: iso('2026-10-11', '17:00'),
      expectedReopenAt: iso('2026-10-11', '20:00'),
      nextSessionCloseAt: iso('2026-10-12', '16:00'),
    });
  });

  test('a holiday Monday still locks on Sunday, before futures open', () => {
    // Labor Day 2026: the reopen moved to Monday 20:00 ET, the lock did not.
    const labor = reopenScheduleOfWindowV1(weekendWindowV1(et('2026-09-06', '12:00'))!)!;
    assert.equal(labor.locksAt, iso('2026-09-06', '17:00'));
    assert.equal(labor.expectedReopenAt, iso('2026-09-07', '20:00'));
  });

  test('Thanksgiving Thursday has no round; the weekend after it does', () => {
    const thursday = weekendWindowV1(et('2026-11-26', '12:00'));
    assert.ok(thursday, 'the feeds do go quiet for Thanksgiving');
    assert.equal(reopenScheduleOfWindowV1(thursday), null);
    const { next } = reopenSchedulesV1(et('2026-11-25', '12:00'));
    assert.equal(next?.roundId, '2026-11-27');
    assert.equal(next?.locksAt, iso('2026-11-29', '17:00'));
  });

  test('during the week there is no current round, only the next one', () => {
    const { current, next } = reopenSchedulesV1(et('2026-10-07', '11:00'));
    assert.equal(current, null);
    assert.equal(next?.roundId, '2026-10-09');
    // Inside the weekend the current round is this one and the next is a week on.
    const weekend = reopenSchedulesV1(et('2026-10-10', '12:00'));
    assert.equal(weekend.current?.roundId, '2026-10-09');
    assert.equal(weekend.next?.roundId, '2026-10-16');
  });

  test('past the reviewed calendar there is no next round', () => {
    assert.equal(reopenSchedulesV1(et('2026-12-30', '12:00')).next, null);
  });
});

describe('three stages, each frozen from what came before it', () => {
  const lineup = reopenLineupV1({ schedule: SCHEDULE, stocks: WEEKEND });

  test('the lineup is the five, in order, at Friday’s close to the cent', () => {
    assert.deepEqual(
      lineup.map((row) => [row.symbol, row.close]),
      REOPEN_LINEUP_V1.map((symbol) => [symbol, '100.00']),
    );
  });

  test('a lineup stock without a close is left out, not asked with a guess', () => {
    const noClose = WEEKEND.map((row) =>
      row.symbol === 'AAPL' ? { ...row, runs: row.runs.filter((run) => run.reference !== 100) } : row,
    );
    assert.deepEqual(
      reopenLineupV1({ schedule: SCHEDULE, stocks: noClose }).map((row) => row.symbol),
      ['NVDA', 'TSLA', 'AMZN', 'MSTR'],
    );
  });

  test('Base calls from the prices before the lock, never after it', () => {
    const calls = reopenBaseCallsV1({ schedule: SCHEDULE, lineup, stocks: WEEKEND });
    assert.deepEqual(
      calls.map((row) => [row.symbol, row.base, row.call]),
      [
        ['NVDA', '101.00', 'up'],
        // TSLA fell further after 17:00; the call is the price at the lock.
        ['TSLA', '99.00', 'down'],
        ['AAPL', '100.50', 'up'],
        ['AMZN', '99.50', 'down'],
        ['MSTR', '104.00', 'up'],
      ],
    );
    assert.ok(REOPEN_CALL_GRACE_MS_V1 >= 5 * 60_000);
  });

  test('a stock with no reopen print is void; the round waits for it, then settles without it', () => {
    const early = reopenResultsV1({ schedule: SCHEDULE, lineup, stocks: WEEKEND, now: et('2026-10-11', '21:00') });
    assert.equal(early.complete, false, 'MSTR has not printed yet');
    const late = reopenResultsV1({ schedule: SCHEDULE, lineup, stocks: WEEKEND, now: et('2026-10-12', '02:30') });
    assert.equal(late.complete, true);
    assert.deepEqual(
      late.results.map((row) => [row.symbol, row.reopen, row.outcome]),
      [
        ['NVDA', '102.00', 'up'],
        ['TSLA', '101.00', 'up'],
        // Reopened exactly at the close: no direction, so nobody is right.
        ['AAPL', '100.00', 'void'],
        ['AMZN', '99.00', 'down'],
        ['MSTR', null, 'void'],
      ],
    );
  });

  test('nothing settles before the reopen, and a round settles the same on Tuesday', () => {
    assert.equal(reopenResultsV1({ schedule: SCHEDULE, lineup, stocks: WEEKEND, now: et('2026-10-11', '19:59') }).complete, false);
    const sunday = reopenResultsV1({ schedule: SCHEDULE, lineup, stocks: WEEKEND, now: et('2026-10-12', '03:00') });
    const tuesday = reopenResultsV1({ schedule: SCHEDULE, lineup, stocks: WEEKEND, now: et('2026-10-13', '09:00') });
    assert.deepEqual(tuesday, sunday);
  });

  test('a print in the middle of the weekend is not the reopen', () => {
    const glitch = WEEKEND.map((row) =>
      row.symbol === 'NVDA'
        ? {
            ...row,
            runs: [
              ...row.runs.filter((run) => Date.parse(run.referenceUpdatedAt) < Date.parse(iso('2026-10-11', '19:00'))),
              { at: iso('2026-10-10', '12:05'), mid: 105, reference: 105, referenceUpdatedAt: iso('2026-10-10', '12:00') },
            ],
          }
        : row,
    );
    const settled = reopenResultsV1({ schedule: SCHEDULE, lineup, stocks: glitch, now: et('2026-10-12', '03:00') });
    assert.equal(settled.results[0]?.outcome, 'void');
  });
});

describe('the score', () => {
  const results: ReopenResultV1[] = [
    { symbol: 'NVDA', reopen: '102.00', at: iso('2026-10-11', '20:00'), outcome: 'up' },
    { symbol: 'TSLA', reopen: '101.00', at: iso('2026-10-11', '20:00'), outcome: 'up' },
    { symbol: 'AAPL', reopen: '100.00', at: iso('2026-10-11', '20:00'), outcome: 'void' },
    { symbol: 'AMZN', reopen: '99.00', at: iso('2026-10-11', '20:00'), outcome: 'down' },
    { symbol: 'MSTR', reopen: null, at: null, outcome: 'void' },
  ];

  test('right, wrong and no pick are three squares; void stocks count for nobody', () => {
    const mine = reopenScoreV1({ NVDA: 'up', TSLA: 'down', AAPL: 'up' }, results);
    assert.deepEqual(mine, { correct: 1, of: 3, cells: '🟩🟥⬜⬜⬜' });
    const base = reopenScoreV1(
      reopenBasePicksV1([
        { symbol: 'NVDA', base: '101.00', call: 'up' },
        { symbol: 'TSLA', base: '99.00', call: 'down' },
        { symbol: 'AAPL', base: '100.50', call: 'up' },
        { symbol: 'AMZN', base: null, call: null },
        { symbol: 'MSTR', base: '104.00', call: 'up' },
      ]),
      results,
    );
    assert.deepEqual(base, { correct: 1, of: 3, cells: '🟩🟥⬜⬜⬜' });
    assert.equal(
      reopenShareLineV1({ number: 3, mine, base }),
      'Call the reopen #3 🟩🟥⬜⬜⬜ 1/3 · Base 1/3',
    );
  });

  test('the crowd’s side is its majority, and a tie is no side', () => {
    assert.deepEqual(reopenCrowdPicksV1({ NVDA: { up: 3, down: 1 }, TSLA: { up: 2, down: 2 }, AMZN: { up: 0, down: 1 } }), {
      NVDA: 'up',
      AMZN: 'down',
    });
  });

  test('to the cent, and equal is no direction', () => {
    assert.equal(reopenDirectionV1('100.01', '100.00'), 'up');
    assert.equal(reopenDirectionV1('99.99', '100.00'), 'down');
    assert.equal(reopenDirectionV1('100.00', '100.00'), null);
  });
});

describe('a player’s record', () => {
  const settled = (number: number, picks: Record<string, 'up' | 'down'> | null) => ({
    roundId: `2026-10-${String(number).padStart(2, '0')}`,
    number,
    locked: true,
    results: [
      { symbol: 'NVDA', reopen: '102.00', at: iso('2026-10-11', '20:00'), outcome: 'up' as const },
      { symbol: 'TSLA', reopen: '99.00', at: iso('2026-10-11', '20:00'), outcome: 'down' as const },
    ],
    calls: [
      { symbol: 'NVDA', base: '101.00', call: 'up' as const },
      { symbol: 'TSLA', base: '101.00', call: 'up' as const },
    ],
    picks,
  });

  test('a streak counts weekends in a row and a skipped one ends it', () => {
    const record = reopenRecordV1([
      settled(1, { NVDA: 'up' }),
      settled(2, null),
      settled(3, { NVDA: 'up', TSLA: 'down' }),
      settled(4, { NVDA: 'down', TSLA: 'down' }),
    ]);
    assert.deepEqual(record, { played: 3, streak: 2, correct: 4, of: 6, beatBase: 1 });
  });

  test('an open round neither extends nor breaks a streak', () => {
    const open = { ...settled(5, null), locked: false, results: null, calls: null };
    assert.equal(reopenRecordV1([settled(4, { NVDA: 'up' }), open]).streak, 1);
    assert.equal(reopenRecordV1([settled(4, { NVDA: 'up' }), { ...open, picks: { NVDA: 'up' } }]).streak, 1);
  });
});

describe('the wire', () => {
  test('a pick names a round and at most one side per stock', () => {
    assert.ok(ReopenPickRequestV1Schema.safeParse({ roundId: '2026-10-09', picks: { NVDA: 'up', TSLA: 'down' } }).success);
    assert.ok(!ReopenPickRequestV1Schema.safeParse({ roundId: '2026-10-09', picks: { NVDA: 'sideways' } }).success);
    assert.ok(!ReopenPickRequestV1Schema.safeParse({ roundId: 'next', picks: {} }).success);
    assert.ok(!ReopenPickRequestV1Schema.safeParse({ roundId: '2026-10-09', picks: {}, wallet: '0x' }).success);
  });

  test('an empty weekend parses: no round, the next one, and Base’s record so far', () => {
    const parsed = ReopenGameResponseV1Schema.parse({
      schemaVersion: 'call-the-reopen/v1',
      generatedAt: iso('2026-10-07', '11:00'),
      round: null,
      next: { number: 1, opensAt: SCHEDULE.opensAt, locksAt: SCHEDULE.locksAt, expectedReopenAt: SCHEDULE.expectedReopenAt },
      baseRecord: { rounds: 0, correct: 0, of: 0 },
      me: null,
    });
    assert.equal(parsed.next?.number, 1);
  });
});
