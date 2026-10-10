import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { PoolYieldReadingV1 } from '@mioagent/route-storage';

import { PoolYieldV1Schema, poolYieldV1 } from '../src/poolYield.js';

const POOL = '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const GAUGE = '0x30d1e5af5ce39863e6f69a1f73ffb0e1ac9771a8';
const NOW = new Date('2026-10-04T15:20:00.000Z');

/** The NVDAc/USDC pool as read on 2026-10-04 at block 52168748. */
/** The stock's market price on Base beside the fixture pool: the same as its own. */
const MARKET = 235.14;

function reading(patch: Partial<PoolYieldReadingV1> = {}): PoolYieldReadingV1 {
  return {
    chainId: 8453,
    poolAddress: POOL,
    tokenAddress: NVDA,
    gaugeAddress: GAUGE,
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

describe('what an Aerodrome pool pays, per dollar in it', () => {
  test('the NVDAc pool: its own price, its money, and a week of AERO at this rate', () => {
    const view = poolYieldV1({ readings: [reading()], now: NOW, marketPriceUsd: MARKET })!;
    PoolYieldV1Schema.parse(view);
    // The pool's price for NVDAc in USDC, from its sqrt price.
    assert.ok(Math.abs(view.stockPriceUsd - 235.14) < 0.05, `price ${view.stockPriceUsd}`);
    // $1,595,248 of USDC and 3,740 NVDAc at that price.
    assert.ok(Math.abs(view.poolUsd - (1_595_248 + 3_740 * view.stockPriceUsd)) < 1);
    assert.equal(view.stakedSharePercent, 97.31);
    // 0.04698 AERO a second for a week, at Chainlink's $0.865.
    assert.ok(Math.abs(view.aero!.perWeek - 28_414.7) < 1, `perWeek ${view.aero!.perWeek}`);
    assert.ok(Math.abs(view.aero!.perWeekUsd - 24_585) < 5);
    // Per staked dollar over a year: the week's AERO over 97.31% of the pool.
    const expected = ((Number(46_982_049_643_163_578n) / 1e18) * 31_536_000 * 0.86524193) / (view.poolUsd * 0.9731) * 100;
    assert.ok(Math.abs(view.aero!.aprPercent! - expected) < 0.01);
    assert.ok(view.aero!.aprPercent! > 50 && view.aero!.aprPercent! < 56);
    assert.equal(view.aero!.periodEndsAt, '2026-10-08T00:00:00.000Z');
    // No swaps were read, so no fee figure is made up.
    assert.equal(view.fees, null);
  });

  test('no AERO is said for a period that has ended, a pool with no gauge, or an unread price', () => {
    assert.equal(poolYieldV1({ readings: [reading({ periodFinish: 1791100000 })], now: NOW })!.aero, null);
    assert.equal(poolYieldV1({ readings: [reading({ gaugeAddress: null, rewardRate: '0' })], now: NOW })!.aero, null);
    assert.equal(
      poolYieldV1({ readings: [reading({ aeroUsd: null, aeroUsdUpdatedAt: null })], now: NOW })!.aero,
      null,
    );
  });

  test('with almost nothing staked in range, the AERO is said but not a rate', () => {
    const view = poolYieldV1({ readings: [reading({ stakedLiquidity: '1000000000000' })], now: NOW })!;
    assert.equal(view.stakedSharePercent, 0.45);
    assert.ok(view.aero!.perWeek > 28_000);
    assert.equal(view.aero!.aprPercent, null);
  });

  test('fees: what was paid in on each side, times the fee, over the days the logs covered', () => {
    // Two readings, one day of swaps each: $1,000,000 of USDC and 1,000 NVDAc
    // paid in over the two days.
    const first = reading({
      blockNumber: 52125548,
      blockAt: '2026-10-03T15:14:03.000Z',
      readAt: '2026-10-03T15:14:05.000Z',
      swaps: { fromBlock: 52082348, fromAt: '2026-10-02T15:14:03.000Z', count: 400, amount0InAtomic: '500000000000', amount1InAtomic: '50000000000' },
    });
    const second = reading({
      swaps: { fromBlock: 52125548, fromAt: '2026-10-03T15:14:03.000Z', count: 600, amount0InAtomic: '500000000000', amount1InAtomic: '50000000000' },
    });
    const view = poolYieldV1({ readings: [second, first], now: NOW, marketPriceUsd: MARKET })!;
    assert.equal(view.fees!.days, 2);
    assert.equal(view.fees!.swaps, 1_000);
    // 0.05% of $1,000,000 and of 1,000 NVDAc at the pool's price.
    const expectedFees = 500 + 0.5 * view.stockPriceUsd;
    assert.ok(Math.abs(view.fees!.feesUsd - expectedFees) < 0.01, `fees ${view.fees!.feesUsd}`);
    // A dollar not staked keeps 90% of its share: the pool takes 10%.
    const expectedApr = ((expectedFees / 2) * 365 * 0.9) / view.poolUsd * 100;
    assert.ok(Math.abs(view.fees!.aprPercent - expectedApr) < 0.0001);
    assert.equal(view.fees!.unstakedFeePercent, 10);
  });

  test('under a day of swaps is no fee figure, and swaps older than the week do not count', () => {
    const short = reading({
      swaps: { fromBlock: 52158748, fromAt: '2026-10-04T09:40:43.000Z', count: 256, amount0InAtomic: '122214067233', amount1InAtomic: '17000000000' },
    });
    assert.equal(poolYieldV1({ readings: [short], now: NOW, marketPriceUsd: MARKET })!.fees, null);
    const old = reading({
      blockNumber: 51000000,
      blockAt: '2026-09-20T00:00:00.000Z',
      readAt: '2026-09-20T00:00:02.000Z',
      swaps: { fromBlock: 50900000, fromAt: '2026-09-17T00:00:00.000Z', count: 9, amount0InAtomic: '1', amount1InAtomic: '1' },
    });
    assert.equal(poolYieldV1({ readings: [old, reading()], now: NOW, marketPriceUsd: MARKET })!.fees, null);
  });

  test('a pool that is not paired with USDC is not priced in this version', () => {
    const weth = '0x4200000000000000000000000000000000000006';
    assert.equal(poolYieldV1({ readings: [reading({ token0Address: weth })], now: NOW }), null);
    assert.equal(poolYieldV1({ readings: [], now: NOW, marketPriceUsd: MARKET }), null);
  });
});


describe('the same figure for an assistant', () => {
  test('two alternatives by name, and a sentence written by no model', async () => {
    const { poolYieldAgentV1 } = await import('../src/poolYield.js');
    const view = poolYieldV1({ readings: [reading()], now: NOW, marketPriceUsd: MARKET })!;
    const agent = poolYieldAgentV1(view);
    assert.equal(agent.poolAddress, POOL);
    assert.ok(agent.staked!.aprPercent! > 50);
    assert.equal(agent.notStaked, null);
    assert.match(agent.summary, /^The deepest Aerodrome pool for this token \(0x853f5f1b92b16714fe6cda67caad0856b83c7ab9\) holds about \$2\.47M\./);
    assert.match(agent.summary, /A position staked in its gauge earns AERO instead of its fees: about 5\d% a year per dollar/);
    assert.match(agent.summary, /until 2026-10-08T00:00:00\.000Z\./);
    assert.doesNotMatch(agent.summary, /not staked earns fees/);
    assert.match(agent.summary, /never a promise/);
  });
});

test('a rate needs the market price beside the pool and at least $1,000 in it', () => {
  const swaps = { fromBlock: 52082348, fromAt: '2026-10-02T15:14:03.000Z', count: 400, amount0InAtomic: '500000000000', amount1InAtomic: '50000000000' };
  const first = reading({ blockNumber: 52125548, blockAt: '2026-10-03T15:14:03.000Z', readAt: '2026-10-03T15:14:05.000Z', swaps });
  const second = reading({ swaps: { ...swaps, fromBlock: 52125548, fromAt: '2026-10-03T15:14:03.000Z' } });

  // No market price beside it: the pool's own price values it, and nothing is
  // called a rate. The week's AERO stays an amount.
  const unpriced = poolYieldV1({ readings: [second, first], now: NOW })!;
  assert.equal(unpriced.fees, null);
  assert.equal(unpriced.aero!.aprPercent, null);
  assert.ok(unpriced.aero!.perWeek > 28_000);

  // A pool's own price far from the market's (BILIc: $157,235 against
  // $15.49) does not value it: the market price does.
  const valued = poolYieldV1({ readings: [second, first], now: NOW, marketPriceUsd: 15.49 })!;
  assert.equal(valued.stockPriceUsd, 15.49);
  assert.ok(Math.abs(valued.poolUsd - (1_595_248 + 3_740 * 15.49)) < 1);
  assert.ok(valued.fees !== null && valued.aero!.aprPercent !== null);

  // CAKEc's pool: about $174, which printed "about 24208% a year in AERO".
  const tiny = poolYieldV1({
    readings: [reading({ balance0Atomic: '120000000', balance1Atomic: '500000', swaps: second.swaps })],
    now: NOW,
    marketPriceUsd: 108.45,
  })!;
  assert.ok(tiny.poolUsd < 1_000);
  assert.equal(tiny.aero!.aprPercent, null);
  assert.equal(tiny.fees, null);
});
