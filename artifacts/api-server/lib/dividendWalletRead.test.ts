import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { B20ReaderV1, B20RpcResultV1 } from '@mioagent/b20-control';
import { encodeFunctionResult, type Hex } from 'viem';

import { AGGREGATE3_ABI_V1, MULTICALL3_V1, readAtBlockV1 } from './dividendWalletRead.js';

const A = '0xb2000000000000000000002d0ba3164cc74f58b7';
const B = '0xb2000000000000000000008bc8786b856e61707c';
const CALLS = [
  { to: A, data: '0x313ce567' },
  { to: B, data: '0x313ce567' },
];
const WORD = `0x${'0'.repeat(62)}08` as Hex;

/** A reader whose one call answers with `answer`, recording what it was asked. */
function readerV1(answer: B20RpcResultV1<string>) {
  const asked: Array<{ to: string; blockTag: string }> = [];
  const reader = {
    async call(input: { to: string; data: string; blockTag: string }) {
      asked.push({ to: input.to, blockTag: input.blockTag });
      return answer;
    },
  } as unknown as B20ReaderV1;
  return { reader, asked };
}

function rowsV1(rows: Array<{ success: boolean; returnData: Hex }>): B20RpcResultV1<string> {
  return { ok: true, value: encodeFunctionResult({ abi: AGGREGATE3_ABI_V1, functionName: 'aggregate3', result: rows }), raw: 'x' };
}

describe('reading at one block', () => {
  test('every row is one call to Multicall3, pinned to the block', async () => {
    const { reader, asked } = readerV1(rowsV1([{ success: true, returnData: WORD }, { success: true, returnData: WORD }]));
    const reads = await readAtBlockV1(reader, CALLS, '0x31a0000');
    assert.deepEqual(asked, [{ to: MULTICALL3_V1, blockTag: '0x31a0000' }]);
    assert.deepEqual(reads.map((read) => read.ok && read.value), [WORD, WORD]);
  });

  test('a row that reverts is its own answer, and a row with no code answers empty', async () => {
    const { reader } = readerV1(rowsV1([{ success: false, returnData: '0x' }, { success: true, returnData: '0x' }]));
    const reads = await readAtBlockV1(reader, CALLS, 'latest');
    assert.deepEqual(reads.map((read) => !read.ok && read.reason), ['reverted', 'empty_result']);
  });

  test('a call nobody answered is every row’s reason; a missing Multicall3 is unreadable, never empty tokens', async () => {
    const throttled = await readAtBlockV1(readerV1({ ok: false, reason: 'rate_limited' }).reader, CALLS, 'latest');
    assert.deepEqual(throttled.map((read) => !read.ok && read.reason), ['rate_limited', 'rate_limited']);
    const absent = await readAtBlockV1(readerV1({ ok: false, reason: 'empty_result' }).reader, CALLS, 'latest');
    assert.deepEqual(absent.map((read) => !read.ok && read.reason), ['invalid_response', 'invalid_response']);
  });

  test('an answer with the wrong number of rows, or no rows at all, is unreadable', async () => {
    const short = await readAtBlockV1(readerV1(rowsV1([{ success: true, returnData: WORD }])).reader, CALLS, 'latest');
    assert.deepEqual(short.map((read) => !read.ok && read.reason), ['invalid_response', 'invalid_response']);
    const garbage = await readAtBlockV1(readerV1({ ok: true, value: '0x1234', raw: 'x' }).reader, CALLS, 'latest');
    assert.deepEqual(garbage.map((read) => !read.ok && read.reason), ['invalid_response', 'invalid_response']);
  });

  test('nothing to read asks nothing', async () => {
    const { reader, asked } = readerV1({ ok: false, reason: 'rpc_unavailable' });
    assert.deepEqual(await readAtBlockV1(reader, [], 'latest'), []);
    assert.equal(asked.length, 0);
  });
});
