import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { StillLoopCandidateV1, StillLoopRepositoryV1 } from '../src/stillLoops.js';

// One contract for both repositories: the memory one must behave as Postgres does.

const WALLET = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export function loopCandidateV1(n: number, patch: Partial<StillLoopCandidateV1> = {}): StillLoopCandidateV1 {
  return {
    executionId: id(n), walletAddress: WALLET, brand: 'apple', collateral: 'AAPLc', productId: 'itunes-germany', productName: 'iTunes Germany',
    packageLabel: '25 EUR', priceRoundedAtomic: '27000000', venue: 'aave-v4', via: 'claude', team: false,
    confirmedAt: new Date(Date.UTC(2026, 10, 20, 12, n)).toISOString(), ...patch,
  };
}

export function stillLoopsContractV1(label: string, make: () => Promise<StillLoopRepositoryV1>): void {
  describe(`${label}: Loops`, () => {
    test('are numbered in the order confirmed, once, with no gap however often a pass writes them', async () => {
      const repo = await make();
      const later = loopCandidateV1(2), earlier = loopCandidateV1(1);
      const written = await repo.record([later, earlier]);
      assert.deepEqual(written.map((row) => [row.executionId, row.loopNo]), [[later.executionId, 2], [earlier.executionId, 1]]);
      for (let pass = 0; pass < 3; pass += 1) await repo.record([earlier, later, loopCandidateV1(3)]);
      assert.equal((await repo.byExecution(id(3)))?.loopNo, 3);
      assert.equal((await repo.record([loopCandidateV1(4)]))[0]?.loopNo, 4, 'no number was spent on a row already written');
      const stored = await repo.byExecution(id(1));
      assert.deepEqual(stored, { ...earlier, loopNo: 1, deliveredAt: null, undelivered: null, onWall: false, wallLabel: null, walledAt: null });
      assert.equal(await repo.byExecution(id(99)), null);
    });

    test('keep Bitrefill’s first word on the card, and go on the wall only by their own wallet, complete and not the team’s', async () => {
      const repo = await make();
      await repo.record([loopCandidateV1(1), loopCandidateV1(2, { team: true }), loopCandidateV1(3, { via: 'web' })]);
      const at = new Date('2026-11-20T13:00:00.000Z');
      assert.equal(await repo.putOnWall({ executionId: id(1), walletAddress: WALLET, label: null, at }), null, 'not before the card arrived');
      assert.equal((await repo.markDelivery({ executionId: id(1), outcome: 'complete', at }))?.deliveredAt, at.toISOString());
      const later = await repo.markDelivery({ executionId: id(1), outcome: 'denied', at: new Date('2026-11-20T14:00:00.000Z') });
      assert.deepEqual([later?.deliveredAt, later?.undelivered], [at.toISOString(), null], 'the first answer stands');
      assert.equal((await repo.markDelivery({ executionId: id(3), outcome: 'blocked', at }))?.undelivered, 'blocked');
      assert.equal(await repo.markDelivery({ executionId: id(42), outcome: 'complete', at }), null);
      await repo.markDelivery({ executionId: id(2), outcome: 'complete', at });
      assert.equal(await repo.putOnWall({ executionId: id(1), walletAddress: OTHER, label: null, at }), null, 'only its own wallet');
      assert.equal(await repo.putOnWall({ executionId: id(2), walletAddress: WALLET, label: null, at }), null, 'never a team Loop');
      assert.equal(await repo.putOnWall({ executionId: id(3), walletAddress: WALLET, label: null, at }), null, 'never one whose card did not arrive');
      await assert.rejects(repo.putOnWall({ executionId: id(1), walletAddress: WALLET, label: 'Alice <b>', at }), /still_loop_label_invalid/);
      const walled = await repo.putOnWall({ executionId: id(1), walletAddress: WALLET, label: 'alice.base.eth', at });
      assert.deepEqual([walled?.onWall, walled?.wallLabel, walled?.walledAt], [true, 'alice.base.eth', at.toISOString()]);
      const again = await repo.putOnWall({ executionId: id(1), walletAddress: WALLET, label: null, at: new Date('2026-11-21T00:00:00.000Z') });
      assert.deepEqual([again?.wallLabel, again?.walledAt], ['alice.base.eth', at.toISOString()], 'once on the wall, it stays as it went');
      assert.deepEqual((await repo.wall({ limit: 10 })).map((row) => row.loopNo), [1]);
      assert.deepEqual(await repo.wall({ limit: 0 }), []);
    });

    test('one wallet reads its own Loops, the newest first, and no other wallet’s', async () => {
      const repo = await make();
      await repo.record([loopCandidateV1(1), loopCandidateV1(2, { walletAddress: OTHER }), loopCandidateV1(3)]);
      assert.deepEqual((await repo.byWallet({ walletAddress: WALLET.toUpperCase().replace('0X', '0x'), limit: 10 })).map((row) => row.loopNo), [3, 1]);
      assert.deepEqual((await repo.byWallet({ walletAddress: OTHER, limit: 10 })).map((row) => row.loopNo), [2]);
      assert.deepEqual((await repo.byWallet({ walletAddress: WALLET, limit: 1 })).map((row) => row.loopNo), [3]);
      assert.deepEqual(await repo.byWallet({ walletAddress: `0x${'c'.repeat(40)}`, limit: 10 }), []);
    });

    test('count only complete Loops outside the team, this week apart', async () => {
      const repo = await make();
      await repo.record([
        loopCandidateV1(1, { confirmedAt: '2026-11-10T12:00:00.000Z' }),
        loopCandidateV1(2, { brand: 'amazon', collateral: 'AMZNc', productId: 'amazon-uk', via: 'web' }),
        loopCandidateV1(3, { team: true }),
        loopCandidateV1(4),
      ]);
      const at = new Date('2026-11-20T13:00:00.000Z');
      for (const n of [1, 2, 3]) await repo.markDelivery({ executionId: id(n), outcome: 'complete', at });
      assert.deepEqual(await repo.counts({ weekSince: new Date('2026-11-16T00:00:00.000Z') }),
        { total: 2, week: 1, byBrand: { apple: 1, amazon: 1, google: 0, meta: 0, microsoft: 0 }, viaAssistant: 1 });
    });

    test('refuse what cannot be a Loop before anything is written', async () => {
      const repo = await make();
      for (const bad of [{ walletAddress: 'not-a-wallet' }, { brand: 'nvidia' }, { collateral: 'MSFTc' }, { priceRoundedAtomic: '27500000' },
        { via: 'gemini' }, { productId: 'Itunes Germany' }, { productName: ' ' }, { executionId: 'x' }]) {
        await assert.rejects(repo.record([loopCandidateV1(1, bad as Partial<StillLoopCandidateV1>)]), /still_loop_invalid/, JSON.stringify(bad));
      }
      assert.equal(await repo.byExecution(id(1)), null);
    });
  });
}
