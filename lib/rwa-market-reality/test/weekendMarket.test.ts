import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  WeekendMarketResponseV1Schema,
  etInstantV1,
  weekendMarketV1,
  weekendWindowV1,
  type WeekendMarketRunV1,
} from '../src/weekendMarket.js';

const et = (localDate: string, clock: string): Date => {
  const [hour, minute] = clock.split(':').map(Number);
  return etInstantV1(localDate, hour! * 60 + minute!);
};
const iso = (localDate: string, clock: string) => et(localDate, clock).toISOString();

const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';

/** A run every hour from `from` to `to` (ET), all at one mid, beside the
 * reference the feed held at that moment. */
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

const FRIDAY_CLOSE_PRINT = iso('2026-09-25', '15:59');
const FRIDAY_LAST_PRINT = iso('2026-09-25', '19:58');

function weekendRuns(extra: WeekendMarketRunV1[] = []): WeekendMarketRunV1[] {
  return [
    // Friday afternoon: the close the weekend is measured from.
    ...hourly({ fromDate: '2026-09-25', fromClock: '14:05', hours: 2, mid: 100.1, reference: 100, referenceUpdatedAt: FRIDAY_CLOSE_PRINT }),
    // After hours the feed still prints; that is not the close.
    ...hourly({ fromDate: '2026-09-25', fromClock: '17:05', hours: 3, mid: 100.4, reference: 100.3, referenceUpdatedAt: FRIDAY_LAST_PRINT }),
    // The quiet period: the feed holds its last print, Base keeps trading.
    ...hourly({ fromDate: '2026-09-26', fromClock: '00:05', hours: 38, mid: 100.8, reference: 100.3, referenceUpdatedAt: FRIDAY_LAST_PRINT }),
    ...hourly({ fromDate: '2026-09-27', fromClock: '14:05', hours: 6, mid: 101, reference: 100.3, referenceUpdatedAt: FRIDAY_LAST_PRINT }),
    ...extra,
  ];
}

describe('the quiet period comes from the reviewed calendar', () => {
  test('a normal weekend: Friday close to the Sunday 20:00 ET reopen', () => {
    assert.deepEqual(weekendWindowV1(et('2026-09-26', '12:00')), {
      closeAt: '2026-09-25T20:00:00.000Z',
      darkStartAt: '2026-09-26T00:00:00.000Z',
      expectedReopenAt: '2026-09-28T00:00:00.000Z',
      nextSessionCloseAt: '2026-09-28T20:00:00.000Z',
    });
  });

  test('a holiday Monday moves the reopen to Monday evening, as on Labor Day 2026', () => {
    const window = weekendWindowV1(et('2026-09-06', '12:00'));
    assert.equal(window?.expectedReopenAt, iso('2026-09-07', '20:00'));
    assert.equal(window?.nextSessionCloseAt, iso('2026-09-08', '16:00'));
  });

  test('a weeknight has no quiet period: the overnight session opens the same evening', () => {
    assert.equal(weekendWindowV1(et('2026-09-22', '22:00')), null);
  });

  test('before 20:00 ET on Friday, and after the next session closes, there is nothing to show', () => {
    const stocks = [{ tokenAddress: NVDA, symbol: 'NVDA', name: 'NVIDIA', runs: weekendRuns() }];
    assert.equal(weekendMarketV1({ now: et('2026-09-25', '18:00'), stocks }).state, 'none');
    assert.equal(weekendMarketV1({ now: et('2026-09-28', '16:30'), stocks }).state, 'none');
  });
});

describe('the weekend on Base', () => {
  test('in progress: the median of six hours on Base against the close at the bell', () => {
    const junk = { at: iso('2026-09-27', '18:30'), mid: 5_000, reference: 100.3, referenceUpdatedAt: FRIDAY_LAST_PRINT };
    const answer = weekendMarketV1({
      now: et('2026-09-27', '19:30'),
      stocks: [{ tokenAddress: NVDA, symbol: 'NVDA', name: 'NVIDIA', runs: weekendRuns([junk]) }],
    });
    assert.equal(answer.state, 'in_progress');
    const [row] = answer.stocks;
    // The close is the print by 16:00, not the after-hours one.
    assert.equal(row?.close, '100.00');
    assert.equal(row?.base?.value, '101.00');
    assert.equal(row?.base?.moveBps, 100);
    // The junk quote is dropped before the median, not averaged in.
    assert.equal(row?.base?.samples, 6);
    assert.equal(row?.reopen, null);
    assert.equal(answer.called, null);
    WeekendMarketResponseV1Schema.parse(answer);
  });

  test('too few runs names no price', () => {
    const answer = weekendMarketV1({
      now: et('2026-09-26', '02:00'),
      stocks: [
        {
          tokenAddress: NVDA,
          symbol: 'NVDA',
          name: 'NVIDIA',
          runs: weekendRuns().filter((run) => Date.parse(run.at) < et('2026-09-26', '01:00').getTime()),
        },
      ],
    });
    assert.equal(answer.stocks[0]?.base, null);
    assert.equal(answer.stocks[0]?.unavailable, 'too_few_measurements');
  });

  test('a stock with no print before the bell has no close to move from', () => {
    const answer = weekendMarketV1({
      now: et('2026-09-27', '19:30'),
      stocks: [
        {
          tokenAddress: NVDA,
          symbol: 'NVDA',
          name: 'NVIDIA',
          runs: weekendRuns().filter((run) => run.referenceUpdatedAt !== FRIDAY_CLOSE_PRINT),
        },
      ],
    });
    assert.equal(answer.stocks[0]?.unavailable, 'no_close_reference');
  });

  test('reopened: the first print after the quiet period, and whether Base pointed its way', () => {
    const reopen = hourly({
      fromDate: '2026-09-27',
      fromClock: '20:05',
      hours: 3,
      mid: 102.1,
      reference: 102,
      referenceUpdatedAt: iso('2026-09-27', '20:00'),
    });
    const answer = weekendMarketV1({
      now: et('2026-09-28', '09:00'),
      stocks: [{ tokenAddress: NVDA, symbol: 'NVDA', name: 'NVIDIA', runs: weekendRuns(reopen) }],
    });
    assert.equal(answer.state, 'reopened');
    const [row] = answer.stocks;
    assert.equal(row?.reopen?.value, '102.00');
    assert.equal(row?.reopen?.gapBps, 200);
    assert.equal(row?.reopen?.at, iso('2026-09-27', '20:00'));
    // What Base said is the six hours BEFORE the reopen, never after it.
    assert.equal(row?.base?.value, '101.00');
    assert.equal(row?.reopen?.sameDirection, true);
    assert.deepEqual(answer.called, { sameDirection: 1, meaningful: 1 });
    WeekendMarketResponseV1Schema.parse(answer);
  });

  test('a gap too small to have a direction is not counted either way', () => {
    const reopen = hourly({
      fromDate: '2026-09-27',
      fromClock: '20:05',
      hours: 2,
      mid: 100.1,
      reference: 100.1,
      referenceUpdatedAt: iso('2026-09-27', '20:00'),
    });
    const answer = weekendMarketV1({
      now: et('2026-09-28', '09:00'),
      stocks: [{ tokenAddress: NVDA, symbol: 'NVDA', name: 'NVIDIA', runs: weekendRuns(reopen) }],
    });
    assert.equal(answer.stocks[0]?.reopen?.gapBps, 10);
    assert.equal(answer.stocks[0]?.reopen?.sameDirection, null);
    assert.deepEqual(answer.called, { sameDirection: 0, meaningful: 0 });
  });

  test('the biggest move comes first', () => {
    const flat = weekendRuns().map((run) => ({ ...run, mid: run.mid > 100.5 ? 100.3 : run.mid }));
    const answer = weekendMarketV1({
      now: et('2026-09-27', '19:30'),
      stocks: [
        { tokenAddress: '0xb200000000000000000000578f3ae29d9e6e0101', symbol: 'AAPL', name: 'Apple', runs: flat },
        { tokenAddress: NVDA, symbol: 'NVDA', name: 'NVIDIA', runs: weekendRuns() },
      ],
    });
    assert.deepEqual(answer.stocks.map((row) => row.symbol), ['NVDA', 'AAPL']);
  });
});
