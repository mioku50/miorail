import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { B20BatchCallV1, B20ReaderV1 } from '@mioagent/b20-control';

import {
  AERO_USD_FEED_BASE_V1,
  CL_SWAP_TOPIC_V1,
  readPoolYieldStateV1,
  sumPoolSwapsV1,
} from '../src/poolYield.js';

const POOL = '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const GAUGE = '0x30d1e5af5ce39863e6f69a1f73ffb0e1ac9771a8';
describe('the swaps a pool logged', () => {
  const log = (amount0: bigint, amount1: bigint, patch: Record<string, unknown> = {}) => ({
    address: POOL,
    topics: [CL_SWAP_TOPIC_V1, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`],
    data: `0x${BigInt.asUintN(256, amount0).toString(16).padStart(64, '0')}${BigInt.asUintN(256, amount1).toString(16).padStart(64, '0')}${'0'.repeat(64 * 3)}`,
    ...patch,
  });

  test('only what went in is summed, on each side', () => {
    const sum = sumPoolSwapsV1(POOL, [log(1_000_000n, -5_000n), log(-2_000_000n, 9_000n)]);
    assert.deepEqual(sum, { count: 2, amount0In: 1_000_000n, amount1In: 9_000n });
  });

  test('a log that is not this pool’s swap, or is cut short, voids the total', () => {
    assert.equal(sumPoolSwapsV1(POOL, [log(1n, -1n, { address: USDC })]), null);
    assert.equal(sumPoolSwapsV1(POOL, [log(1n, -1n, { topics: [`0x${'1'.repeat(64)}`] })]), null);
    assert.equal(sumPoolSwapsV1(POOL, [{ address: POOL, topics: [CL_SWAP_TOPIC_V1], data: '0x12' }]), null);
    assert.deepEqual(sumPoolSwapsV1(POOL, []), { count: 0, amount0In: 0n, amount1In: 0n });
  });
});

describe('reading a pool and its gauge at one block', () => {
  const word = (value: bigint | string) =>
    typeof value === 'string' ? `0x${value.replace('0x', '').padStart(64, '0')}` : `0x${value.toString(16).padStart(64, '0')}`;
  const SELECTOR = (signature: string) =>
    ({
      'token0()': '0x0dfe1681',
      'token1()': '0xd21220a7',
      'gauge()': '0xa6f19c84',
      'fee()': '0xddca3f43',
      'unstakedFee()': '0xb64cc67b',
      'liquidity()': '0x1a686502',
      'stakedLiquidity()': '0x3ab04b20',
      'slot0()': '0x3850c7bd',
      'rewardRate()': '0x7b0a47ee',
      'periodFinish()': '0xebe2b12b',
      'decimals()': '0x313ce567',
      'latestRoundData()': '0xfeaf968c',
    })[signature]!;

  function readerWith(answers: Record<string, string>): B20ReaderV1 & { asked: string[] } {
    const asked: string[] = [];
    const answer = (input: B20BatchCallV1) => {
      const key = `${input.to.toLowerCase()}:${input.data.slice(0, 10)}`;
      asked.push(key);
      const value = answers[key];
      return value === undefined ? { ok: false, reason: 'reverted' } : { ok: true, value, raw: value };
    };
    return {
      call: async (input: B20BatchCallV1) => answer(input),
      callMany: async (inputs: readonly B20BatchCallV1[]) => inputs.map(answer),
      asked,
    } as unknown as B20ReaderV1 & { asked: string[] };
  }

  const ANSWERS: Record<string, string> = {
    [`${POOL}:${SELECTOR('token0()')}`]: word(USDC),
    [`${POOL}:${SELECTOR('token1()')}`]: word(NVDA),
    [`${POOL}:${SELECTOR('gauge()')}`]: word(GAUGE),
    [`${POOL}:${SELECTOR('fee()')}`]: word(500n),
    [`${POOL}:${SELECTOR('unstakedFee()')}`]: word(100_000n),
    [`${POOL}:${SELECTOR('liquidity()')}`]: word(222_002_453_296_139n),
    [`${POOL}:${SELECTOR('stakedLiquidity()')}`]: word(216_049_702_351_400n),
    [`${POOL}:${SELECTOR('slot0()')}`]: `${word(51_666_644_440_429_115_138_812_345_925n)}${'0'.repeat(64 * 5)}`,
    [`${POOL}:${SELECTOR('rewardRate()')}`]: word(46_982_049_643_163_578n),
    [`${POOL}:${SELECTOR('periodFinish()')}`]: word(1_791_417_600n),
    [`${AERO_USD_FEED_BASE_V1}:${SELECTOR('latestRoundData()')}`]: `${word(1n)}${word(86_524_193n).slice(2)}${word(1n).slice(2)}${word(1_791_125_457n).slice(2)}${word(1n).slice(2)}`,
    [`${USDC}:${SELECTOR('decimals()')}`]: word(6n),
    [`${NVDA}:${SELECTOR('decimals()')}`]: word(8n),
    [`${USDC}:0x70a08231`]: word(1_595_248_000_000n),
    [`${NVDA}:0x70a08231`]: word(374_000_000_000n),
  };

  test('every fact at one block, the AERO price with its own time', async () => {
    const reader = readerWith(ANSWERS);
    const read = await readPoolYieldStateV1({ reader, poolAddress: POOL.toUpperCase().replace('0X', '0x'), blockTag: '0x31c0a2c' });
    assert.equal(read.ok, true);
    const state = (read as { ok: true; state: Record<string, unknown> }).state;
    assert.equal(state.gaugeAddress, GAUGE);
    assert.equal(state.sqrtPriceX96, '51666644440429115138812345925');
    assert.equal(state.rewardRate, '46982049643163578');
    assert.equal(state.aeroUsd, 0.86524193);
    assert.equal(state.aeroUsdUpdatedAt, '2026-10-04T14:50:57.000Z');
    assert.equal(state.balance0Atomic, '1595248000000');
    assert.equal(state.decimals1, 8);
  });

  test('a pool that did not answer every read is not a reading', async () => {
    const answers = { ...ANSWERS };
    delete answers[`${POOL}:${SELECTOR('stakedLiquidity()')}`];
    const read = await readPoolYieldStateV1({ reader: readerWith(answers), poolAddress: POOL, blockTag: '0x1' });
    assert.equal(read.ok, false);
  });

  test('a feed that did not answer leaves the price unread, and no gauge pays nothing', async () => {
    const answers = { ...ANSWERS, [`${POOL}:${SELECTOR('gauge()')}`]: word(0n) };
    delete answers[`${AERO_USD_FEED_BASE_V1}:${SELECTOR('latestRoundData()')}`];
    const read = await readPoolYieldStateV1({ reader: readerWith(answers), poolAddress: POOL, blockTag: '0x1' });
    assert.equal(read.ok, true);
    const state = (read as { ok: true; state: Record<string, unknown> }).state;
    assert.equal(state.gaugeAddress, null);
    assert.equal(state.rewardRate, '0');
    assert.equal(state.aeroUsd, null);
    assert.equal(state.aeroUsdUpdatedAt, null);
  });
});
