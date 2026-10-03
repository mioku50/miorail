import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ReopenGameRepositoryV1, ReopenRoundOpeningV1 } from '../src/index.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const DEVICE = 'a'.repeat(64);
const OTHER_DEVICE = 'b'.repeat(64);

const opening = (roundId: string, weekOffsetDays = 0): ReopenRoundOpeningV1 => {
  const shift = (iso: string) => new Date(Date.parse(iso) + weekOffsetDays * 86_400_000).toISOString();
  return {
    roundId,
    closeAt: shift('2026-10-09T20:00:00.000Z'),
    opensAt: shift('2026-10-10T00:00:00.000Z'),
    locksAt: shift('2026-10-11T21:00:00.000Z'),
    expectedReopenAt: shift('2026-10-12T00:00:00.000Z'),
    nextSessionCloseAt: shift('2026-10-12T20:00:00.000Z'),
    stocks: [{ symbol: 'NVDA', close: '100.00' }],
  };
};
const BEFORE_LOCK = new Date('2026-10-10T12:00:00.000Z');
const AFTER_LOCK = new Date('2026-10-11T21:00:00.000Z');
const AFTER_REOPEN = new Date('2026-10-12T00:10:00.000Z');

export function reopenGameContract(name: string, factory: () => Promise<ReopenGameRepositoryV1>): void {
  describe(`${name}: Call the reopen storage`, () => {
    test('a round opens once and rounds are numbered in the order they opened', async () => {
      const repo = await factory();
      const first = await repo.openRound({ opening: opening('2026-10-09'), now: BEFORE_LOCK });
      const again = await repo.openRound({ opening: { ...opening('2026-10-09'), stocks: [] }, now: AFTER_LOCK });
      assert.equal(first.number, 1);
      assert.deepEqual(again, first, 'the second opening changes nothing');
      const second = await repo.openRound({ opening: opening('2026-10-16', 7), now: BEFORE_LOCK });
      assert.equal(second.number, 2);
      assert.deepEqual((await repo.rounds(5)).map((row) => row.roundId), ['2026-10-16', '2026-10-09']);
      assert.deepEqual(first.stocks, [{ symbol: 'NVDA', close: '100.00' }]);
    });

    test('a round out of order is refused', async () => {
      const repo = await factory();
      await assert.rejects(
        repo.openRound({ opening: { ...opening('2026-10-09'), locksAt: '2026-10-09T00:00:00.000Z' }, now: BEFORE_LOCK }),
      );
    });

    test('each stage is written once, and never ahead of its moment', async () => {
      const repo = await factory();
      await repo.openRound({ opening: opening('2026-10-09'), now: BEFORE_LOCK });
      const early = await repo.fixCalls({ roundId: '2026-10-09', calls: [{ call: 'up' }], at: BEFORE_LOCK });
      assert.equal(early?.calls, null, 'no call before the lock');
      const noCalls = await repo.settle({ roundId: '2026-10-09', results: [{}], at: AFTER_REOPEN });
      assert.equal(noCalls?.results, null, 'no result before the calls');
      const called = await repo.fixCalls({ roundId: '2026-10-09', calls: [{ call: 'up' }], at: AFTER_LOCK });
      assert.deepEqual(called?.calls, [{ call: 'up' }]);
      assert.equal(called?.calledAt, AFTER_LOCK.toISOString());
      const recalled = await repo.fixCalls({ roundId: '2026-10-09', calls: [{ call: 'down' }], at: AFTER_REOPEN });
      assert.deepEqual(recalled?.calls, [{ call: 'up' }], 'a call is never rewritten');
      assert.equal((await repo.settle({ roundId: '2026-10-09', results: [{}], at: AFTER_LOCK }))?.results, null);
      const settled = await repo.settle({ roundId: '2026-10-09', results: [{ outcome: 'up' }], at: AFTER_REOPEN });
      assert.deepEqual(settled?.results, [{ outcome: 'up' }]);
      assert.equal(await repo.fixCalls({ roundId: '2026-10-02', calls: [], at: AFTER_LOCK }), null);
    });

    test('a pick lands only before its round locks, and replaces the last one', async () => {
      const repo = await factory();
      await repo.openRound({ opening: opening('2026-10-09'), now: BEFORE_LOCK });
      const player = await repo.walletPlayer({ wallet: WALLET, now: BEFORE_LOCK });
      assert.equal(player, `w:${WALLET}`);
      assert.equal(await repo.walletPlayer({ wallet: WALLET, now: AFTER_LOCK }), player, 'one player per wallet');
      assert.equal(await repo.savePicks({ roundId: '2026-10-09', playerId: player, picks: { NVDA: 'up' }, now: BEFORE_LOCK }), 'saved');
      assert.equal(
        await repo.savePicks({ roundId: '2026-10-09', playerId: player, picks: { NVDA: 'down', TSLA: 'up' }, now: new Date(AFTER_LOCK.getTime() - 1) }),
        'saved',
      );
      assert.equal(await repo.savePicks({ roundId: '2026-10-09', playerId: player, picks: { NVDA: 'up' }, now: AFTER_LOCK }), 'locked');
      assert.equal(await repo.savePicks({ roundId: '2026-10-02', playerId: player, picks: { NVDA: 'up' }, now: BEFORE_LOCK }), 'unknown_round');
      const mine = await repo.picksOf(player);
      assert.deepEqual(mine.map((row) => [row.roundId, row.picks]), [['2026-10-09', { NVDA: 'down', TSLA: 'up' }]]);
      await assert.rejects(repo.savePicks({ roundId: '2026-10-09', playerId: player, picks: { NVDA: 'sideways' as 'up' }, now: BEFORE_LOCK }));
    });

    test('the crowd counts players and their sides per stock', async () => {
      const repo = await factory();
      await repo.openRound({ opening: opening('2026-10-09'), now: BEFORE_LOCK });
      const wallet = await repo.walletPlayer({ wallet: WALLET, now: BEFORE_LOCK });
      const device = await repo.createDevicePlayer({ tokenHash: DEVICE, now: BEFORE_LOCK });
      const silent = await repo.createDevicePlayer({ tokenHash: OTHER_DEVICE, now: BEFORE_LOCK });
      await repo.savePicks({ roundId: '2026-10-09', playerId: wallet, picks: { NVDA: 'up', TSLA: 'down' }, now: BEFORE_LOCK });
      await repo.savePicks({ roundId: '2026-10-09', playerId: device, picks: { NVDA: 'up' }, now: BEFORE_LOCK });
      await repo.savePicks({ roundId: '2026-10-09', playerId: silent, picks: {}, now: BEFORE_LOCK });
      const crowd = await repo.crowd('2026-10-09');
      assert.equal(crowd.players, 2, 'an empty pick is not a player');
      assert.deepEqual(crowd.split, { NVDA: { up: 2, down: 0 }, TSLA: { up: 0, down: 1 } });
    });

    test('a device plays without a wallet, and signing in moves its picks over', async () => {
      const repo = await factory();
      await repo.openRound({ opening: opening('2026-10-09'), now: BEFORE_LOCK });
      await repo.openRound({ opening: opening('2026-10-16', 7), now: BEFORE_LOCK });
      const device = await repo.createDevicePlayer({ tokenHash: DEVICE, now: BEFORE_LOCK });
      await assert.rejects(repo.createDevicePlayer({ tokenHash: DEVICE, now: BEFORE_LOCK }));
      assert.equal(await repo.devicePlayer(DEVICE), device);
      assert.equal(await repo.devicePlayer('not-a-hash'), null);
      await repo.savePicks({ roundId: '2026-10-09', playerId: device, picks: { NVDA: 'up' }, now: BEFORE_LOCK });
      const sixteenth = new Date(BEFORE_LOCK.getTime() + 7 * 86_400_000);
      await repo.savePicks({ roundId: '2026-10-16', playerId: device, picks: { NVDA: 'down' }, now: sixteenth });
      // The merge needs the wallet's player to exist first.
      assert.equal(await repo.mergeDevice({ tokenHash: DEVICE, wallet: WALLET, now: AFTER_LOCK }), null);
      const wallet = await repo.walletPlayer({ wallet: WALLET, now: AFTER_LOCK });
      await repo.savePicks({ roundId: '2026-10-16', playerId: wallet, picks: { TSLA: 'up' }, now: sixteenth });
      assert.deepEqual(await repo.mergeDevice({ tokenHash: DEVICE, wallet: WALLET, now: AFTER_LOCK }), { moved: 1, dropped: 1 });
      assert.deepEqual(
        (await repo.picksOf(wallet)).map((row) => [row.roundId, row.picks]),
        [
          ['2026-10-09', { NVDA: 'up' }],
          // The wallet had its own picks that round; those stand.
          ['2026-10-16', { TSLA: 'up' }],
        ],
      );
      assert.deepEqual(await repo.picksOf(device), []);
      assert.equal(await repo.devicePlayer(DEVICE), null, 'a merged device no longer plays');
      assert.equal(await repo.mergeDevice({ tokenHash: DEVICE, wallet: WALLET, now: AFTER_LOCK }), null);
      assert.equal((await repo.crowd('2026-10-16')).players, 1, 'nobody is counted twice');
    });
  });
}
