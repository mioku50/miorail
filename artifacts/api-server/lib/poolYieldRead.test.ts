import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolYieldReadingV1 } from '@mioagent/route-storage';

import { readPoolYieldV1 } from './poolYieldRead.js';

const NOW = new Date('2026-10-04T15:20:00.000Z');
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DEEP = '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9';
const SHALLOW = '0x20e5fad2661ee9eb0c04824524030af31943b62d';

function reading(patch: Partial<PoolYieldReadingV1> = {}): PoolYieldReadingV1 {
  return {
    chainId: 8453,
    poolAddress: DEEP,
    tokenAddress: NVDA,
    gaugeAddress: '0x30d1e5af5ce39863e6f69a1f73ffb0e1ac9771a8',
    blockNumber: 52168748,
    blockAt: '2026-10-04T15:14:03.000Z',
    readAt: '2026-10-04T15:14:05.000Z',
    token0Address: USDC,
    token1Address: NVDA,
    decimals0: 6,
    decimals1: 8,
    balance0Atomic: '1595248000000',
    balance1Atomic: '374000000000',
    sqrtPriceX96: '51666644440429115138812345925',
    liquidity: '222002453296139',
    stakedLiquidity: '216049702351400',
    feePips: 500,
    unstakedFeePips: 100000,
    rewardRate: '46982049643163578',
    periodFinish: 1791417600,
    aeroUsd: 0.86524193,
    aeroUsdUpdatedAt: '2026-10-04T14:50:57.000Z',
    swaps: null,
    ...patch,
  };
}

test('the pool of the newest reading is the one said, over eight days of its readings', async () => {
  const asked: { token: string; since: string }[] = [];
  const answer = await readPoolYieldV1(NOW, NVDA.toUpperCase().replace('0X', '0x'), {
    readings: async (token, since) => {
      asked.push({ token, since });
      // The deepest pool moved: an older reading of another pool must not
      // be mixed into the newest pool's figure.
      return [reading({ poolAddress: SHALLOW, blockNumber: 52100000, blockAt: '2026-10-03T00:00:00.000Z', readAt: '2026-10-03T00:00:02.000Z' }), reading()];
    },
  });
  assert.deepEqual(asked, [{ token: NVDA, since: '2026-09-26T15:20:00.000Z' }]);
  assert.equal(answer.schemaVersion, 'pool-yield-response/v1');
  assert.equal(answer.yield?.poolAddress, DEEP);
  assert.ok(answer.yield!.aero!.aprPercent! > 50);
});

test('nothing measured is null, never a zero yield', async () => {
  const answer = await readPoolYieldV1(NOW, NVDA, { readings: async () => [] });
  assert.deepEqual(answer, { schemaVersion: 'pool-yield-response/v1', tokenAddress: NVDA, yield: null });
});
