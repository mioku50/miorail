import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { b20BlockAtOrBeforeV1, type B20BlockHeaderV1, type B20ReaderV1 } from '../src/index.js';

/** A chain of two-second blocks that switches to half-second blocks at 6,000,
 * the way Cobalt shortens Base's, so a search that trusted arithmetic would
 * land thousands of blocks away. */
function chainV1(head = 10_000) {
  const timestamp = (n: number) => (n <= 6_000 ? 1_000_000 + n * 2 : 1_000_000 + 12_000 + (n - 6_000) * 0.5);
  const asked: string[] = [];
  const reader = {
    async readBlockHeader(tag: string) {
      asked.push(tag);
      const n = tag === 'latest' ? head : Number.parseInt(tag, 16);
      if (n > head) return { ok: true as const, value: null, raw: 'null' };
      const value: B20BlockHeaderV1 = { blockNumber: n, blockHash: `0x${n.toString(16).padStart(64, '0')}` as never, timestamp: Math.floor(timestamp(n)) };
      return { ok: true as const, value, raw: value.blockHash };
    },
  } as unknown as B20ReaderV1;
  return { reader, asked, timestamp };
}

describe('the block at an instant', () => {
  test('the last block at or before it, on both sides of a change in block time', async () => {
    const { reader, timestamp } = chainV1();
    for (const n of [1, 2, 777, 5_999, 6_000, 6_001, 8_888, 9_999]) {
      for (const offset of [0, 1]) {
        const at = (Math.floor(timestamp(n)) + offset) * 1000;
        const found = await b20BlockAtOrBeforeV1(reader, at);
        assert.ok(found.ok, `block ${n}`);
        assert.ok(found.value.timestamp <= at / 1000, `block ${n}: at or before`);
        const next = await reader.readBlockHeader!(`0x${(found.value.blockNumber + 1).toString(16)}`);
        if (next.ok && next.value) assert.ok(next.value.timestamp > at / 1000, `block ${n}: the next one is after`);
      }
    }
  });

  test('from a good guess it asks for a handful of headers', async () => {
    const { reader, asked, timestamp } = chainV1();
    await b20BlockAtOrBeforeV1(reader, Math.floor(timestamp(3_210)) * 1000);
    assert.ok(asked.length <= 12, `${asked.length} headers`);
  });

  test('after the head is the head; before the first block is nothing', async () => {
    const { reader } = chainV1();
    const late = await b20BlockAtOrBeforeV1(reader, 9_000_000_000_000);
    assert.equal(late.ok && late.value.blockNumber, 10_000);
    const early = await b20BlockAtOrBeforeV1(reader, 1_000);
    assert.deepEqual(early.ok ? null : early.reason, 'empty_result');
  });

  test('a reader without headers says so rather than guessing', async () => {
    const found = await b20BlockAtOrBeforeV1({} as B20ReaderV1, Date.now());
    assert.equal(found.ok ? null : found.reason, 'not_configured');
  });
});
