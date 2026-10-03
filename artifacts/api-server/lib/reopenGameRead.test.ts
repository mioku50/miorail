import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { InMemoryReopenGameRepositoryV1 } from '@mioagent/route-storage';
import {
  etInstantV1,
  weekendMarketV1,
  type WeekendMarketRunV1,
  type WeekendMarketStockInputV1,
} from '@mioagent/rwa-market-reality/weekend-market';

import { advanceReopenRoundV1, reopenGameForV1, reopenSharedStateV1, type ReopenGameDepsV1 } from './reopenGameRead.js';

const et = (localDate: string, clock: string): Date => {
  const [hour, minute] = clock.split(':').map(Number);
  return etInstantV1(localDate, hour! * 60 + minute!);
};
const iso = (localDate: string, clock: string) => et(localDate, clock).toISOString();

function hourly(fromDate: string, fromClock: string, hours: number, mid: number, reference: number, referenceUpdatedAt: string): WeekendMarketRunV1[] {
  const start = et(fromDate, fromClock).getTime();
  return Array.from({ length: hours }, (_, index) => ({
    at: new Date(start + index * 3_600_000).toISOString(),
    mid,
    reference,
    referenceUpdatedAt,
  }));
}

/** The weekend of 2026-10-09: closes at 100, Base at `sunday` by the lock, the
 * feed reopening at `reopen`. */
function stock(symbol: string, n: number, sunday: number, reopen: number): WeekendMarketStockInputV1 {
  const closePrint = iso('2026-10-09', '15:59');
  return {
    tokenAddress: `0xb2${String(n).padStart(38, '0')}`,
    symbol,
    name: `${symbol} Inc.`,
    runs: [
      ...hourly('2026-10-09', '14:05', 2, 100.05, 100, closePrint),
      ...hourly('2026-10-11', '10:05', 7, sunday, 100, closePrint),
      ...hourly('2026-10-11', '20:03', 2, reopen, reopen, iso('2026-10-11', '20:00')),
    ],
  };
}
const STOCKS = [
  stock('NVDA', 1, 101, 102),
  stock('TSLA', 2, 99, 101),
  stock('AAPL', 3, 100.5, 99),
  stock('AMZN', 4, 99.5, 99),
  stock('MSTR', 5, 104, 106),
];

function depsV1(repository = new InMemoryReopenGameRepositoryV1()) {
  const reads: string[] = [];
  const deps: ReopenGameDepsV1 = {
    repository,
    stocks: async (since, until) => {
      reads.push(`${since.toISOString()}..${until.toISOString()}`);
      return STOCKS.map((row) => ({ ...row, runs: row.runs.filter((run) => Date.parse(run.at) <= until.getTime()) }));
    },
    weekend: async (now) => weekendMarketV1({ now, stocks: STOCKS }),
  };
  return { deps, reads, repository };
}

describe('the round is brought up to date by whoever asks', () => {
  test('between weekends nothing opens, and the next round is number one', async () => {
    const { deps, reads } = depsV1();
    const shared = await reopenSharedStateV1(et('2026-10-07', '12:00'), deps);
    assert.equal(shared.round, null);
    assert.equal(shared.next?.number, 1);
    assert.equal(shared.next?.locksAt, iso('2026-10-11', '17:00'));
    assert.deepEqual(reads, [], 'no runs are read when nothing is due');
  });

  test('the first ask of the weekend opens the round; the crowd stays hidden while picks are open', async () => {
    const { deps, repository } = depsV1();
    const shared = await reopenSharedStateV1(et('2026-10-10', '12:00'), deps);
    assert.equal(shared.round?.number, 1);
    assert.equal(shared.round?.state, 'open');
    assert.deepEqual(shared.round?.stocks.map((row) => [row.symbol, row.close]), [
      ['NVDA', '100.00'],
      ['TSLA', '100.00'],
      ['AAPL', '100.00'],
      ['AMZN', '100.00'],
      ['MSTR', '100.00'],
    ]);
    assert.equal(shared.round?.players, null);
    assert.ok(shared.round?.stocks.every((row) => row.crowd === null && row.baseCall === null));
    assert.equal(shared.next?.number, 2);
    assert.equal((await repository.rounds(5)).length, 1);
  });

  test('Base calls after the lock, and only once the grace has passed', async () => {
    const { deps } = depsV1();
    await advanceReopenRoundV1(et('2026-10-10', '12:00'), deps);
    const atLock = await advanceReopenRoundV1(et('2026-10-11', '17:02'), deps);
    assert.equal(atLock.row?.calls, null, 'a quote from 16:59 may still be landing');
    const called = await advanceReopenRoundV1(et('2026-10-11', '17:11'), deps);
    assert.deepEqual(
      (called.row?.calls as { symbol: string; call: string | null }[]).map((row) => [row.symbol, row.call]),
      [
        ['NVDA', 'up'],
        ['TSLA', 'down'],
        ['AAPL', 'up'],
        ['AMZN', 'down'],
        ['MSTR', 'up'],
      ],
    );
  });

  test('a whole weekend: picks, the lock, the reopen, the score', async () => {
    const { deps, repository } = depsV1();
    await advanceReopenRoundV1(et('2026-10-10', '12:00'), deps);
    const me = await repository.walletPlayer({ wallet: '0x1111111111111111111111111111111111111111', now: et('2026-10-10', '12:00') });
    const device = await repository.createDevicePlayer({ tokenHash: 'c'.repeat(64), now: et('2026-10-10', '12:00') });
    await repository.savePicks({ roundId: '2026-10-09', playerId: me, picks: { NVDA: 'up', TSLA: 'up', AAPL: 'down', AMZN: 'down', MSTR: 'down' }, now: et('2026-10-11', '16:59') });
    await repository.savePicks({ roundId: '2026-10-09', playerId: device, picks: { NVDA: 'up', TSLA: 'down' }, now: et('2026-10-11', '09:00') });

    const locked = await reopenSharedStateV1(et('2026-10-11', '18:00'), deps);
    assert.equal(locked.round?.state, 'locked');
    assert.equal(locked.round?.players, 2);
    assert.deepEqual(locked.round?.stocks[0]?.crowd, { up: 2, down: 0 });

    const settled = await reopenSharedStateV1(et('2026-10-11', '21:30'), deps);
    assert.equal(settled.round?.state, 'settled');
    assert.deepEqual(
      settled.round?.stocks.map((row) => [row.symbol, row.result?.outcome]),
      [
        ['NVDA', 'up'],
        ['TSLA', 'up'],
        ['AAPL', 'down'],
        ['AMZN', 'down'],
        ['MSTR', 'up'],
      ],
    );
    assert.deepEqual(settled.round?.score?.base, { correct: 3, of: 5, cells: '🟩🟥🟥🟩🟩' });
    assert.deepEqual(settled.baseRecord, { rounds: 1, correct: 3, of: 5 });

    const mine = await reopenGameForV1({ shared: settled, player: { playerId: me, signed: true }, now: et('2026-10-11', '21:30'), repository });
    assert.deepEqual(mine.me?.score, { correct: 4, of: 5, cells: '🟩🟩🟩🟩🟥' });
    assert.deepEqual(mine.me?.record, { played: 1, streak: 1, correct: 4, of: 5, beatBase: 1 });
    assert.equal(mine.me?.signed, true);

    // On Tuesday the round still shows, settled, until the next one opens.
    const tuesday = await reopenSharedStateV1(et('2026-10-13', '12:00'), deps);
    assert.equal(tuesday.round?.roundId, '2026-10-09');
    assert.equal(tuesday.round?.state, 'settled');
    assert.equal(tuesday.next?.number, 2);
  });

  test('a round nobody looked at on Sunday settles the same on Tuesday', async () => {
    const { deps } = depsV1();
    await advanceReopenRoundV1(et('2026-10-10', '12:00'), deps);
    const late = await reopenSharedStateV1(et('2026-10-13', '12:00'), deps);
    assert.equal(late.round?.state, 'settled');
    assert.deepEqual(late.round?.score?.base, { correct: 3, of: 5, cells: '🟩🟥🟥🟩🟩' });
  });

  test('a reader with no picks has no game of their own', async () => {
    const { deps, repository } = depsV1();
    const shared = await reopenSharedStateV1(et('2026-10-10', '12:00'), deps);
    const nobody = await reopenGameForV1({ shared, player: null, now: et('2026-10-10', '12:00'), repository });
    assert.equal(nobody.me, null);
    const fresh = await reopenGameForV1({ shared, player: { playerId: `w:0x${'2'.repeat(40)}`, signed: true }, now: et('2026-10-10', '12:00'), repository });
    assert.deepEqual(fresh.me?.picks, {});
    assert.equal(fresh.me?.record.played, 0);
  });
});
