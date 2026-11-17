import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { StillLoopDrawEntryV1, StillLoopDrawRepositoryV1 } from '../src/stillLoopDraws.js';

// One contract for both repositories: the memory one must behave as Postgres does.

const WALLET = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;
const HASH = `0x${'1'.repeat(64)}`;
const BLOCK = `0x${'2'.repeat(64)}`;
const TX = `0x${'3'.repeat(64)}`;
const DRAW = { drawId: '2026-11-28', opensAt: '2026-11-21T00:00:00.000Z', closesAt: '2026-11-28T18:00:00.000Z', prizeAtomic: '5000000', winnerCount: 2 };
const LOCKED = new Date('2026-11-28T18:00:31.000Z');

const entry = (label: string, walletAddress: string, kind: 'loop' | 'free', enteredAt: string): StillLoopDrawEntryV1 =>
  ({ label, walletAddress, kind, loopNo: kind === 'loop' ? Number(label.slice(6)) : null, enteredAt });

export function stillLoopDrawsContractV1(label: string, make: () => Promise<StillLoopDrawRepositoryV1>): void {
  describe(`${label}: Loop draws`, () => {
    test('take one free entry per wallet per draw, with a code no other entry in it has', async () => {
      const repo = await make();
      const at = new Date('2026-11-22T09:00:00.000Z');
      const first = await repo.enterFree({ drawId: DRAW.drawId, walletAddress: WALLET, code: 'K3F9X2', at });
      assert.deepEqual(first, { outcome: 'entered', entry: { drawId: DRAW.drawId, walletAddress: WALLET, code: 'K3F9X2', enteredAt: at.toISOString() } });
      const again = await repo.enterFree({ drawId: DRAW.drawId, walletAddress: WALLET, code: 'ZZZZZZ', at: new Date('2026-11-23T09:00:00.000Z') });
      assert.deepEqual(again, { outcome: 'already', entry: { drawId: DRAW.drawId, walletAddress: WALLET, code: 'K3F9X2', enteredAt: at.toISOString() } });
      assert.deepEqual(await repo.enterFree({ drawId: DRAW.drawId, walletAddress: OTHER, code: 'K3F9X2', at }), { outcome: 'code_taken' });
      assert.equal((await repo.enterFree({ drawId: '2026-12-03', walletAddress: WALLET, code: 'K3F9X2', at }))?.outcome, 'entered', 'a draw of its own');
      assert.equal((await repo.enterFree({ drawId: DRAW.drawId, walletAddress: OTHER, code: 'AB12CD', at: new Date('2026-11-28T17:59:59.000Z') }))?.outcome, 'entered');
      assert.deepEqual((await repo.freeEntries({ drawId: DRAW.drawId, before: new Date(DRAW.closesAt) })).map((row) => row.code), ['K3F9X2', 'AB12CD']);
      assert.deepEqual((await repo.freeEntries({ drawId: DRAW.drawId, before: new Date('2026-11-28T17:59:59.000Z') })).map((row) => row.code), ['K3F9X2']);
      assert.equal((await repo.freeEntry({ drawId: DRAW.drawId, walletAddress: OTHER }))?.code, 'AB12CD');
      assert.equal(await repo.freeEntry({ drawId: '2026-12-03', walletAddress: OTHER }), null);
      for (const bad of [{ code: 'k3f9x2' }, { code: 'K3F9XI' }, { code: 'K3F9X' }, { walletAddress: 'nope' }, { drawId: 'next' }]) {
        await assert.rejects(repo.enterFree({ drawId: DRAW.drawId, walletAddress: WALLET, code: 'QQQQQQ', at, ...bad }), /still_loop_draw_invalid/, JSON.stringify(bad));
      }
    });

    test('fix the list once, take no free entry after, and draw once and pay each winner once', async () => {
      const repo = await make();
      await repo.enterFree({ drawId: DRAW.drawId, walletAddress: OTHER, code: 'AB12CD', at: new Date('2026-11-22T09:00:00.000Z') });
      const entries = [entry('Loop #2', WALLET, 'loop', '2026-11-21T10:00:00.000Z'), entry('Entry AB12CD', OTHER, 'free', '2026-11-22T09:00:00.000Z'),
        entry('Entry QW34ER', `0x${'c'.repeat(40)}`, 'free', '2026-11-23T09:00:00.000Z')];
      const locked = await repo.lock({ ...DRAW, entries, entriesHash: HASH, lockedAt: LOCKED });
      assert.deepEqual(locked, { ...DRAW, entries, entryCount: 3, entriesHash: HASH, lockedAt: LOCKED.toISOString(),
        blockNumber: null, blockHash: null, blockTime: null, winnerNos: null, drawnAt: null, payouts: [] });
      const raced = await repo.lock({ ...DRAW, entries: entries.slice(0, 1), entriesHash: `0x${'9'.repeat(64)}`, lockedAt: new Date('2026-11-28T18:01:00.000Z') });
      assert.deepEqual(raced, locked, 'the first list stands');
      assert.deepEqual(await repo.enterFree({ drawId: DRAW.drawId, walletAddress: `0x${'c'.repeat(40)}`, code: 'QQQQQQ', at: LOCKED }), { outcome: 'locked' });
      assert.equal((await repo.enterFree({ drawId: DRAW.drawId, walletAddress: OTHER, code: 'QQQQQQ', at: LOCKED }))?.outcome, 'already');
      assert.equal(await repo.paid({ drawId: DRAW.drawId, no: 1, paidTx: TX, at: LOCKED }), null, 'no prize before a winner');
      const at = new Date('2026-11-28T18:07:00.000Z');
      const block = { number: '123', hash: BLOCK, time: '2026-11-28T18:05:31.000Z' };
      for (const winnerNos of [[4, 1], [2], [2, 2], [2, 1, 3], [0, 1]]) {
        await assert.rejects(repo.drawn({ drawId: DRAW.drawId, block, winnerNos, at }), /still_loop_draw_invalid/, JSON.stringify(winnerNos));
      }
      await assert.rejects(repo.drawn({ drawId: DRAW.drawId, block: null, winnerNos: null, at }), /still_loop_draw_invalid/, 'entries need winners');
      await assert.rejects(repo.drawn({ drawId: DRAW.drawId, block: null, winnerNos: [2, 1], at }), /still_loop_draw_invalid/, 'winners need a block');
      const drawn = await repo.drawn({ drawId: DRAW.drawId, block, winnerNos: [3, 1], at });
      assert.deepEqual([drawn?.blockNumber, drawn?.blockHash, drawn?.blockTime, drawn?.winnerNos, drawn?.drawnAt],
        ['123', BLOCK, '2026-11-28T18:05:31.000Z', [3, 1], at.toISOString()]);
      const redrawn = await repo.drawn({ drawId: DRAW.drawId, block: { number: '124', hash: HASH, time: '2026-11-28T18:05:33.000Z' }, winnerNos: [1, 2], at });
      assert.deepEqual([redrawn?.blockNumber, redrawn?.winnerNos], ['123', [3, 1]], 'the first draw stands');
      await assert.rejects(repo.paid({ drawId: DRAW.drawId, no: 3, paidTx: '0x12', at }), /still_loop_draw_invalid/);
      assert.equal(await repo.paid({ drawId: DRAW.drawId, no: 2, paidTx: TX, at }), null, 'entry 2 did not win');
      assert.deepEqual((await repo.byId(DRAW.drawId))?.payouts, []);
      const paid = await repo.paid({ drawId: DRAW.drawId, no: 3, paidTx: TX, at });
      assert.deepEqual(paid?.payouts, [{ no: 3, tx: TX, at: at.toISOString() }]);
      const again = await repo.paid({ drawId: DRAW.drawId, no: 3, paidTx: HASH, at: new Date('2026-11-29T00:00:00.000Z') });
      assert.deepEqual(again?.payouts, [{ no: 3, tx: TX, at: at.toISOString() }], 'each winner is paid once');
      const both = await repo.paid({ drawId: DRAW.drawId, no: 1, paidTx: TX, at });
      assert.deepEqual(both?.payouts.map((payout) => payout.no), [3, 1], 'one transaction may pay several winners');
      assert.deepEqual((await repo.all()).map((row) => row.drawId), [DRAW.drawId]);
      assert.equal(await repo.byId('2026-12-03'), null);
      assert.equal(await repo.drawn({ drawId: '2026-12-03', block: null, winnerNos: null, at }), null);
    });

    test('draw every entry when fewer entered than may win', async () => {
      const repo = await make();
      const entries = [entry('Entry AB12CD', OTHER, 'free', '2026-11-22T09:00:00.000Z')];
      await repo.lock({ ...DRAW, entries, entriesHash: HASH, lockedAt: LOCKED });
      const block = { number: '123', hash: BLOCK, time: '2026-11-28T18:05:31.000Z' };
      await assert.rejects(repo.drawn({ drawId: DRAW.drawId, block, winnerNos: [1, 1], at: LOCKED }), /still_loop_draw_invalid/);
      assert.deepEqual((await repo.drawn({ drawId: DRAW.drawId, block, winnerNos: [1], at: LOCKED }))?.winnerNos, [1]);
    });

    test('draw a list nobody entered with no block and no winner, and refuse a list that cannot be', async () => {
      const repo = await make();
      const empty = await repo.lock({ ...DRAW, entries: [], entriesHash: HASH, lockedAt: LOCKED });
      assert.equal(empty.entryCount, 0);
      await assert.rejects(repo.drawn({ drawId: DRAW.drawId, block: null, winnerNos: [1], at: LOCKED }), /still_loop_draw_invalid/);
      const drawn = await repo.drawn({ drawId: DRAW.drawId, block: null, winnerNos: null, at: LOCKED });
      assert.deepEqual([drawn?.drawnAt, drawn?.winnerNos, drawn?.blockHash], [LOCKED.toISOString(), null, null]);
      assert.equal(await repo.paid({ drawId: DRAW.drawId, no: 1, paidTx: TX, at: LOCKED }), null, 'nobody to pay');
      for (const bad of [{ lockedAt: new Date('2026-11-28T17:59:59.000Z') }, { entriesHash: '0x12' }, { prizeAtomic: '999999' }, { drawId: 'x' },
        { opensAt: DRAW.closesAt }, { entries: [entry('Loop #1', 'nope', 'loop', DRAW.opensAt)] }, { winnerCount: 0 }, { winnerCount: 21 }]) {
        await assert.rejects(repo.lock({ ...DRAW, entries: [], entriesHash: HASH, lockedAt: LOCKED, drawId: '2026-12-03', ...bad }), /still_loop_draw_invalid/, JSON.stringify(bad));
      }
      assert.equal(await repo.byId('2026-12-03'), null);
    });
  });
}
