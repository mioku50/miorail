import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { PoolYieldReadingRepositoryV1, PoolYieldReadingV1 } from '../src/poolYields.js';

// ---------------------------------------------------------------------------
// What the pool-yield store guarantees, on memory and on Postgres alike.
// ---------------------------------------------------------------------------

const POOL = '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9';
const OTHER_POOL = '0x20e5fad2661ee9eb0c04824524030af31943b62d';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/** The NVDAc/USDC pool as read on 2026-10-04 at block 52168748. */
export function yieldReading(patch: Partial<PoolYieldReadingV1> = {}): PoolYieldReadingV1 {
  return {
    chainId: 8453,
    poolAddress: POOL,
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
    swaps: {
      fromBlock: 52158748,
      fromAt: '2026-10-04T09:40:43.000Z',
      count: 256,
      amount0InAtomic: '122214067233',
      amount1InAtomic: '17000000000',
    },
    ...patch,
  };
}

export function poolYieldsContract(name: string, fresh: () => Promise<PoolYieldReadingRepositoryV1>): void {
  describe(`${name}: the pool-yield store`, () => {
    test('a reading round-trips exactly, swaps and AERO price included', async () => {
      const repo = await fresh();
      assert.equal(await repo.record(yieldReading()), 'recorded');
      const [row] = await repo.readingsSince({ chainId: 8453, poolAddress: POOL, since: '2026-10-01T00:00:00.000Z' });
      assert.deepEqual(row, yieldReading());
    });

    test('a second reading at the same block is the same fact', async () => {
      const repo = await fresh();
      assert.equal(await repo.record(yieldReading()), 'recorded');
      assert.equal(await repo.record(yieldReading({ readAt: '2026-10-04T15:20:00.000Z' })), 'duplicate');
      assert.equal((await repo.readingsSince({ chainId: 8453, poolAddress: POOL, since: '2026-10-01T00:00:00.000Z' })).length, 1);
    });

    test('readings come back oldest first, for one pool, from a moment on', async () => {
      const repo = await fresh();
      await repo.record(yieldReading({ blockNumber: 52172348, blockAt: '2026-10-04T17:14:03.000Z', readAt: '2026-10-04T17:14:05.000Z', swaps: null }));
      await repo.record(yieldReading());
      await repo.record(yieldReading({ poolAddress: OTHER_POOL }));
      await repo.record(yieldReading({ blockNumber: 52100000, blockAt: '2026-10-03T00:00:00.000Z', readAt: '2026-10-03T00:00:02.000Z', swaps: null }));
      const rows = await repo.readingsSince({ chainId: 8453, poolAddress: POOL, since: '2026-10-04T00:00:00.000Z' });
      assert.deepEqual(rows.map((row) => row.blockNumber), [52168748, 52172348]);
    });

    test('a stock’s readings come back across its pools, and no other stock’s', async () => {
      const repo = await fresh();
      await repo.record(yieldReading());
      await repo.record(yieldReading({ poolAddress: OTHER_POOL, blockNumber: 52168749 }));
      await repo.record(yieldReading({ poolAddress: OTHER_POOL, blockNumber: 52168750, tokenAddress: USDC }));
      const rows = await repo.readingsForTokenSince({ chainId: 8453, tokenAddress: NVDA.toUpperCase().replace('0X', '0x'), since: '2026-10-01T00:00:00.000Z' });
      assert.deepEqual(rows.map((row) => [row.poolAddress, row.blockNumber]), [[POOL, 52168748], [OTHER_POOL, 52168749]]);
    });

    test('the next swap read starts at the newest reading whose swaps were read', async () => {
      const repo = await fresh();
      assert.equal(await repo.latestWithSwaps({ chainId: 8453, poolAddress: POOL }), null);
      await repo.record(yieldReading());
      // A later pass whose logs were not read does not move the start.
      await repo.record(yieldReading({ blockNumber: 52172348, blockAt: '2026-10-04T17:14:03.000Z', readAt: '2026-10-04T17:14:05.000Z', swaps: null }));
      assert.equal((await repo.latestWithSwaps({ chainId: 8453, poolAddress: POOL }))?.blockNumber, 52168748);
    });

    test('pruning removes what is older than the cut and keeps the rest', async () => {
      const repo = await fresh();
      await repo.record(yieldReading({ blockNumber: 50000000, blockAt: '2026-08-20T00:00:00.000Z', readAt: '2026-08-20T00:00:02.000Z', swaps: null }));
      await repo.record(yieldReading());
      assert.equal(await repo.prune({ before: '2026-09-01T00:00:00.000Z' }), 1);
      assert.deepEqual(
        (await repo.readingsSince({ chainId: 8453, poolAddress: POOL, since: '2026-01-01T00:00:00.000Z' })).map((row) => row.blockNumber),
        [52168748],
      );
    });

    test('a reading that breaks a rule is refused before anything is written', async () => {
      const repo = await fresh();
      await assert.rejects(repo.record(yieldReading({ aeroUsd: 0.86, aeroUsdUpdatedAt: null })), /AERO price must carry its time/);
      await assert.rejects(
        repo.record(yieldReading({ swaps: { ...yieldReading().swaps!, fromBlock: 52168748 } })),
        /swaps cover blocks before the reading/,
      );
      await assert.rejects(repo.record(yieldReading({ balance0Atomic: '-1' })), /balance0Atomic/);
      assert.deepEqual(await repo.readingsSince({ chainId: 8453, poolAddress: POOL, since: '2026-01-01T00:00:00.000Z' }), []);
    });
  });
}
