import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { InMemoryReopenGameRepositoryV1 } from '@mioagent/route-storage';

import {
  ReopenCallAgentInputV1Schema,
  ReopenRoundAgentOutputV1Schema,
  reopenAgentPicksV1,
  reopenMineForAgentV1,
  reopenRoundForAgentV1,
} from '../src/reopenAgent.js';
import { reopenGameForV1, reopenSharedStateV1, type ReopenGameDepsV1 } from '../src/reopenGameService.js';
import { etInstantV1, weekendMarketV1, type WeekendMarketRunV1, type WeekendMarketStockInputV1 } from '../src/weekendMarket.js';

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

/** A weekend whose close is on `close` (a Friday, or a Thursday before a
 * holiday Friday), with Base at `sunday` by the lock and the feed reopening
 * at `reopen` on `sundayDate`. */
function weekend(close: string, sundayDate: string) {
  const stock = (symbol: string, n: number, sunday: number, reopen: number): WeekendMarketStockInputV1 => {
    const closePrint = iso(close, '12:59');
    return {
      tokenAddress: `0xb2${String(n).padStart(38, '0')}`,
      symbol,
      name: `${symbol} Inc.`,
      runs: [
        ...hourly(close, '11:05', 2, 100.05, 100, closePrint),
        ...hourly(sundayDate, '10:05', 7, sunday, 100, closePrint),
        ...hourly(sundayDate, '20:03', 2, reopen, reopen, iso(sundayDate, '20:00')),
      ],
    };
  };
  return [
    stock('NVDA', 1, 101, 102),
    stock('TSLA', 2, 99, 101),
    stock('AAPL', 3, 100.5, 99),
    stock('AMZN', 4, 99.5, 99),
    stock('MSTR', 5, 104, 106),
  ];
}

function depsV1(stocks: WeekendMarketStockInputV1[]) {
  const repository = new InMemoryReopenGameRepositoryV1();
  const deps: ReopenGameDepsV1 = {
    repository,
    stocks: async (_since, until) =>
      stocks.map((row) => ({ ...row, runs: row.runs.filter((run) => Date.parse(run.at) <= until.getTime()) })),
    weekend: async (now) => weekendMarketV1({ now, stocks }),
    basename: async (wallet) => (wallet.endsWith('1') ? 'first.base.eth' : null),
  };
  return { deps, repository };
}

const WALLET = '0x1111111111111111111111111111111111111111';

describe('Call the reopen, for an assistant', () => {
  test('a named answer becomes a pick, and nothing else does', () => {
    assert.deepEqual(reopenAgentPicksV1({ NVDA: 'above', TSLA: 'below' }), { NVDA: 'up', TSLA: 'down' });
    assert.equal(reopenAgentPicksV1({}), null, 'naming nothing changes nothing');
    assert.equal(ReopenCallAgentInputV1Schema.safeParse({ META: 'above' }).success, false, 'only the five');
    assert.equal(ReopenCallAgentInputV1Schema.safeParse({ NVDA: 'up' }).success, false, 'above or below');
  });

  test('an open round: the closes, the lock, and Base on the weekend as a place, not a forecast', async () => {
    const { deps, repository } = depsV1(weekend('2026-10-09', '2026-10-11'));
    // Late on Sunday: six hours of quotes behind the price on Base.
    const now = et('2026-10-11', '16:30');
    const shared = await reopenSharedStateV1(now, deps);
    const answer = reopenRoundForAgentV1(await reopenGameForV1({ shared, player: null, now, repository }));
    assert.equal(ReopenRoundAgentOutputV1Schema.safeParse(answer).success, true);
    assert.equal('me' in answer, false, 'the public answer carries nobody');
    assert.equal(answer.closeDay, 'Friday');
    assert.equal(answer.playUrl, 'https://miorail.xyz/stocks/weekend');
    assert.match(answer.miorailSummary, /^Round #1 is open: will each stock reopen above or below Friday's close\? NVDA closed at \$100\.00, /);
    assert.match(answer.miorailSummary, /Picks close Sun 17:00 ET \(2026-10-11T21:00:00\.000Z\)/);
    assert.match(answer.miorailSummary, /On Base right now, against Friday's close: NVDA \+1\.00%, TSLA -1\.00%/);
    assert.match(answer.miorailSummary, /not a forecast of the reopen, and not Base's call, which is fixed only at the lock/);
    assert.match(answer.miorailSummary, /hidden until the lock/);
    assert.match(answer.miorailSummary, /Nothing is won but the record\.$/);
  });

  test('a settled round: each reopen, Base’s calls and score, the leaderboard, the next round', async () => {
    const { deps, repository } = depsV1(weekend('2026-10-09', '2026-10-11'));
    await reopenSharedStateV1(et('2026-10-10', '12:00'), deps);
    const player = await repository.walletPlayer({ wallet: WALLET, now: et('2026-10-10', '12:00') });
    await repository.savePicks({
      roundId: '2026-10-09',
      playerId: player,
      picks: { NVDA: 'up', TSLA: 'down' },
      now: et('2026-10-11', '12:00'),
    });
    const now = et('2026-10-11', '21:30');
    const shared = await reopenSharedStateV1(now, deps);
    const answer = reopenRoundForAgentV1(await reopenGameForV1({ shared, player: null, now, repository }));
    assert.match(
      answer.miorailSummary,
      /^Round #1 is settled, against Friday's close: NVDA reopened above at \$102\.00; Base had called above; TSLA reopened above at \$101\.00; Base had called below;/,
    );
    assert.match(answer.miorailSummary, /Base got 3 of 5; the players' majority got 1 of 5; 1 person played\./);
    assert.match(answer.miorailSummary, /Round #2 opens Fri 20:00 ET \(/);
    assert.match(answer.miorailSummary, /Leaderboard after 1 round and 1 player: #1 first\.base\.eth 1\/5\./);

    const mine = reopenMineForAgentV1(
      await reopenGameForV1({ shared, player: { playerId: player, signed: true }, now, repository }),
    );
    assert.match(mine.miorailSummary, /^This wallet's picks in round #1: NVDA above and TSLA below\. It called 1 of 5 in that round\./);
    assert.match(mine.miorailSummary, /On the leaderboard it is #1 of 1\./);
    assert.deepEqual(mine.me?.picks, { NVDA: 'up', TSLA: 'down' });
  });

  test('before a holiday Friday the close is Thursday’s, and the answer says so', async () => {
    // Christmas Eve 2026: a 13:00 close on Thursday, the reopen on Sunday.
    const { deps, repository } = depsV1(weekend('2026-12-24', '2026-12-27'));
    const now = et('2026-12-26', '12:00');
    const shared = await reopenSharedStateV1(now, deps);
    assert.equal(shared.round?.roundId, '2026-12-24');
    const answer = reopenRoundForAgentV1(await reopenGameForV1({ shared, player: null, now, repository }));
    assert.equal(answer.closeDay, 'Thursday');
    assert.match(answer.miorailSummary, /above or below Thursday's close\?/);
  });
});
