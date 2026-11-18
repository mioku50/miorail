import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bytesToHex, hexToBytes, keccak256 } from 'viem';

import {
  LOOP_DRAWS_V1,
  loopDrawCurrentV1,
  loopDrawFirstBlockAtOrAfterV1,
  loopDrawListHashV1,
  loopDrawLockMomentV1,
  loopDrawOpenAtV1,
  loopDrawTargetSecondsV1,
  loopDrawWinnerV1,
  loopDrawWinnersV1,
  type LoopDrawBlockV1,
} from '../src/loopDraws.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('the Loop draws', () => {
  it('are two, back to back: 21 Nov to 28 Nov 18:00 UTC, then to 3 Dec 18:00 UTC, three winners of 5 USDC each', () => {
    assert.deepEqual(LOOP_DRAWS_V1.map((draw) => [draw.drawId, draw.opensAt, draw.closesAt, draw.winners, draw.prizeUsdc]), [
      ['2026-11-28', '2026-11-21T00:00:00.000Z', '2026-11-28T18:00:00.000Z', 3, '5'],
      ['2026-12-03', '2026-11-28T18:00:00.000Z', '2026-12-03T18:00:00.000Z', 3, '5'],
    ]);
    assert.equal(loopDrawOpenAtV1(new Date('2026-11-20T23:59:59.999Z')), null);
    assert.equal(loopDrawCurrentV1(new Date('2026-11-20T23:59:59.999Z'))?.drawId, '2026-11-28', 'before it opens, the first is the next');
    assert.equal(loopDrawOpenAtV1(new Date('2026-11-21T00:00:00.000Z'))?.drawId, '2026-11-28');
    assert.equal(loopDrawOpenAtV1(new Date('2026-11-28T17:59:59.999Z'))?.drawId, '2026-11-28');
    assert.equal(loopDrawOpenAtV1(new Date('2026-11-28T18:00:00.000Z'))?.drawId, '2026-12-03', 'the close of one is the opening of the next');
    assert.equal(loopDrawOpenAtV1(new Date('2026-12-03T18:00:00.000Z')), null);
    assert.equal(loopDrawCurrentV1(new Date('2026-12-04T00:00:00.000Z')), null);
  });

  it('hash the list as its JSON says it, so anybody can hash it again', () => {
    const input = { drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', lockedAt: '2026-11-28T18:00:31.000Z', winners: 3, labels: ['Loop #3', 'Entry K3F9X2'] };
    const expected = keccak256(utf8('{"drawId":"2026-11-28","closesAt":"2026-11-28T18:00:00.000Z","lockedAt":"2026-11-28T18:00:31.000Z","winners":3,"labels":["Loop #3","Entry K3F9X2"]}'));
    assert.equal(loopDrawListHashV1(input), expected);
    // Kept as a number, so a change to the arithmetic cannot pass unnoticed.
    assert.equal(expected, '0x1d4055eb1b8bf1e4e5d5699f8816d7c74906ee7631b97919c265f0a17b16f500');
    assert.notEqual(loopDrawListHashV1({ ...input, labels: ['Entry K3F9X2', 'Loop #3'] }), expected, 'the order is part of the list');
    // Audit, 2026-11-18: the moment the list was fixed sets the picking block, and the winners how many are picked.
    // Both were outside the hash, so a later lockedAt moved the draw to another block with every check passing.
    assert.notEqual(loopDrawListHashV1({ ...input, lockedAt: '2026-11-28T18:10:31.000Z' }), expected, 'the moment it was fixed is part of it');
    assert.notEqual(loopDrawListHashV1({ ...input, winners: 2 }), expected, 'and so is the number of winners');
    assert.equal(loopDrawListHashV1({ ...input, lockedAt: '2026-11-28T21:00:31+03:00' }), expected, 'one moment, however it is written');
    assert.throws(() => loopDrawListHashV1({ ...input, lockedAt: 'soon' }), /loop_draw_locked_at_invalid/);
    assert.throws(() => loopDrawListHashV1({ ...input, winners: 0 }), /loop_draw_winners_invalid/);
  });

  it('pick an entry from the block hash and the draw, from 1 to N', () => {
    const blockHash = `0x${'ab'.repeat(32)}` as const;
    const mixed = BigInt(keccak256(new Uint8Array([...hexToBytes(blockHash), ...utf8('2026-11-28')])));
    for (const count of [1, 2, 3, 7, 100, 12345]) {
      const winner = loopDrawWinnerV1({ blockHash, drawId: '2026-11-28', count });
      assert.equal(winner, Number(mixed % BigInt(count)) + 1);
      assert.ok(winner >= 1 && winner <= count);
    }
    assert.equal(loopDrawWinnerV1({ blockHash, drawId: '2026-11-28', count: 12345 }), 5703);
    assert.notEqual(
      [2, 3, 5, 7, 11].map((count) => loopDrawWinnerV1({ blockHash, drawId: '2026-11-28', count })).join(),
      [2, 3, 5, 7, 11].map((count) => loopDrawWinnerV1({ blockHash, drawId: '2026-12-03', count })).join(),
      'the draw is part of the mix',
    );
    assert.throws(() => loopDrawWinnerV1({ blockHash, drawId: '2026-11-28', count: 0 }), /loop_draw_count_invalid/);
    assert.throws(() => loopDrawWinnerV1({ blockHash: '0x12', drawId: '2026-11-28', count: 3 }), /loop_draw_block_hash_invalid/);
  });

  it('pick more winners one by one from the entries not yet picked, the first as a single draw picks it', () => {
    const blockHash = `0x${'ab'.repeat(32)}` as const;
    const mix = (tag: string) => BigInt(keccak256(new Uint8Array([...hexToBytes(blockHash), ...utf8(tag)])));
    for (const count of [1, 2, 3, 5, 12, 100, 12345]) {
      const winners = loopDrawWinnersV1({ blockHash, drawId: '2026-11-28', count, winners: 3 });
      assert.equal(winners.length, Math.min(3, count));
      assert.equal(new Set(winners).size, winners.length, 'none twice');
      assert.equal(winners[0], loopDrawWinnerV1({ blockHash, drawId: '2026-11-28', count }));
      // By hand: each pick counts along the entries left.
      const left = Array.from({ length: count }, (_, at) => at + 1);
      const byHand = [1, 2, 3].slice(0, Math.min(3, count)).map((k) => left.splice(Number(mix(k === 1 ? '2026-11-28' : `2026-11-28/${k}`) % BigInt(left.length)), 1)[0]);
      assert.deepEqual(winners, byHand);
    }
    assert.deepEqual(loopDrawWinnersV1({ blockHash, drawId: '2026-11-28', count: 12345, winners: 3 }), [5703, 6496, 4273], 'kept as numbers, checked by hand above');
    assert.deepEqual(loopDrawWinnersV1({ blockHash, drawId: '2026-11-28', count: 2, winners: 3 }).sort(), [1, 2], 'fewer entries than winners: every entry wins');
    assert.throws(() => loopDrawWinnersV1({ blockHash, drawId: '2026-11-28', count: 3, winners: 0 }), /loop_draw_winners_invalid/);
    assert.throws(() => loopDrawWinnersV1({ blockHash, drawId: '2026-11-28', count: 3, winners: 21 }), /loop_draw_winners_invalid/);
  });

  it('wait five minutes after the later of the close and the lock, in whole seconds', () => {
    assert.equal(loopDrawLockMomentV1(new Date('2026-11-28T18:00:30.001Z')).toISOString(), '2026-11-28T18:00:31.000Z');
    assert.equal(loopDrawLockMomentV1(new Date('2026-11-28T18:00:30.000Z')).toISOString(), '2026-11-28T18:00:30.000Z');
    const close = Date.parse('2026-11-28T18:00:00.000Z') / 1000;
    assert.equal(loopDrawTargetSecondsV1({ closesAt: '2026-11-28T18:00:00.000Z', lockedAt: '2026-11-28T18:00:31.000Z' }), BigInt(close + 31 + 300));
    assert.equal(loopDrawTargetSecondsV1({ closesAt: '2026-11-28T18:00:00.000Z', lockedAt: '2026-11-28T17:00:00.000Z' }), BigInt(close + 300));
  });
});

describe('the block that picks', () => {
  function chain(timestamps: number[]) {
    let reads = 0;
    const block = (n: number): LoopDrawBlockV1 => ({ number: BigInt(n), hash: bytesToHex(keccak256(utf8(`block ${n}`), 'bytes')), timestamp: BigInt(timestamps[n]!) });
    return {
      head: async () => { reads += 1; return block(timestamps.length - 1); },
      at: async (n: bigint) => { reads += 1; if (n < 0n || n >= BigInt(timestamps.length)) throw new Error('no such block'); return block(Number(n)); },
      reads: () => reads,
      expected: (target: number) => { const i = timestamps.findIndex((t) => t >= target); return i < 0 ? null : i; },
    };
  }

  it('is the first block at or after the target, found in a few reads, and none while the chain has not reached it', async () => {
    const steady = Array.from({ length: 400_000 }, (_, i) => 1_795_000_000 + i * 2);
    let seed = 7;
    const uneven = [1_795_000_000];
    while (uneven.length < 50_000) { seed = (seed * 1103515245 + 12345) % 2 ** 31; uneven.push(uneven.at(-1)! + (seed % 4)); }
    for (const timestamps of [steady, uneven]) {
      const head = timestamps.at(-1)!;
      for (const target of [timestamps[0]! - 100, timestamps[0]!, timestamps[1234]!, timestamps[1234]! + 1, head - 600, head - 1, head]) {
        const c = chain(timestamps);
        const found = await loopDrawFirstBlockAtOrAfterV1({ target: BigInt(target), head: c.head, at: c.at });
        assert.equal(found === null ? null : Number(found.number), c.expected(target), `target ${target}`);
        assert.ok(c.reads() <= 45, `${c.reads()} reads`);
      }
      const c = chain(timestamps);
      assert.equal(await loopDrawFirstBlockAtOrAfterV1({ target: BigInt(head + 1), head: c.head, at: c.at }), null);
    }
  });

  it('refuses a reader that answers with another block', async () => {
    const lying = { head: async () => ({ number: 100n, hash: `0x${'11'.repeat(32)}` as const, timestamp: 1000n }),
      at: async () => ({ number: 5n, hash: `0x${'22'.repeat(32)}` as const, timestamp: 10n }) };
    await assert.rejects(loopDrawFirstBlockAtOrAfterV1({ target: 900n, ...lying }), /loop_draw_block_mismatch/);
  });
});
