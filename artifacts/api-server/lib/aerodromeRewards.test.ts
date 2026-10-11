import assert from 'node:assert/strict';
import test from 'node:test';

import { AERODROME_AERO_V1, type AerodromeClaimPlanV1 } from './aerodromeClaimReader.js';
import {
  aerodromeRewardsNextV1,
  aerodromeRewardTotalsV1,
  aerodromeRewardsReplyV1,
  usdcAtomicToCentsV1,
  valueAerodromeRewardsV1,
} from './aerodromeRewards.js';
import { CANONICAL_BASE_USDC_V1 } from './stockGift.js';

const WETH = '0x4200000000000000000000000000000000000006';
const MEME = '0x7777777777777777777777777777777777777777';
const POOL = '0x2222222222222222222222222222222222222222';

function item(kind: AerodromeClaimPlanV1['calls'][number]['kind'], over: Partial<AerodromeClaimPlanV1['calls'][number]> = {}) {
  return {
    kind, pool: POOL, tokenId: '0', token0: WETH, token1: CANONICAL_BASE_USDC_V1,
    amount0: '0', amount1: '0', aero: '0',
    call: { index: 0, callType: 'other' as const, to: POOL as `0x${string}`, valueWei: '0', data: '0x' as `0x${string}`,
      asset: null, amountAtomic: null, recipient: null, spender: null },
    ...over,
  };
}

function plan(calls: AerodromeClaimPlanV1['calls'], over: Partial<AerodromeClaimPlanV1> = {}): AerodromeClaimPlanV1 {
  return {
    blockNumber: '37123456', poolsTotal: 39_243, poolsRead: 39_243, poolsUnread: 0, poolsReadDirect: 0,
    clPositionsTotal: 1, clPositionsRead: 1, positionsFound: calls.length, managedSkipped: 0, calls, errorCode: null, ...over,
  };
}

// A position with fees AND a stake: the plan carries the same amounts on both
// of its items, as the reader writes them.
const staked = { amount0: '1000000000000000', amount1: '1530000', aero: '8120000000000000000' };
const CALLS = [
  item('basic_fees', staked),
  item('basic_aero', staked),
  item('cl_fees', { token0: MEME, token1: WETH, amount0: '5000000000000000000000', amount1: '200000000000000' }),
];

test('each item claims only its own part: fees once per token, AERO once', () => {
  const totals = aerodromeRewardTotalsV1(plan(CALLS));
  assert.equal(totals.aeroAtomic, 8_120_000_000_000_000_000n);
  assert.deepEqual([...totals.fees], [
    [WETH, 1_200_000_000_000_000n],
    [CANONICAL_BASE_USDC_V1, 1_530_000n],
    [MEME, 5_000_000_000_000_000_000_000n],
  ]);
});

test('amounts are valued by a sell quote; USDC is itself; an unpriced one is named, not zero', async () => {
  const asked: string[] = [];
  const rewards = await valueAerodromeRewardsV1(plan(CALLS), {
    tokenMeta: async (token) => (token === WETH ? { symbol: 'WETH', decimals: 18 } : { symbol: 'MEME', decimals: 18 }),
    value: async (asset, amountAtomic) => {
      asked.push(`${asset.symbol}:${amountAtomic}`);
      if (asset.address === AERODROME_AERO_V1) return '7750000';
      if (asset.address === WETH) return '3100000';
      return null;
    },
  });
  assert.deepEqual(asked.sort(), ['AERO:8120000000000000000', 'MEME:5000000000000000000000', 'WETH:1200000000000000']);
  assert.equal(rewards.aero?.usdcAtomic, '7750000');
  assert.deepEqual(rewards.fees.map((fee) => [fee.symbol, fee.usdcAtomic]), [['WETH', '3100000'], ['USDC', '1530000'], ['MEME', null]]);
  assert.equal(rewards.totalUsdcAtomic, '12380000');
  assert.equal(rewards.unpriced, 1);
  assert.equal(usdcAtomicToCentsV1(rewards.totalUsdcAtomic), 1_238);

  const { reply, errorCode } = aerodromeRewardsReplyV1({ ok: true, rewards }, false);
  assert.equal(errorCode, null);
  assert.deepEqual(reply.split('\n'), [
    'Found on Aerodrome: about $12.38 you can claim now, not counting what could not be priced.',
    '• 8.12 AERO (about $7.75) from staked positions',
    '• Pool fees: 0.0012 WETH (about $3.10), 1.53 USDC (about $1.53), 5,000 MEME (no router priced it)',
    'Read every pool (39,243) and the 1 position NFT this wallet holds, at block 37,123,456.',
    'Values are what a sell would fetch in USDC now.',
    'Say “Claim my Aerodrome fees” to collect it, or “Notify me when my Aerodrome rewards reach $5” to hear when it builds up.',
  ]);
  const russian = aerodromeRewardsReplyV1({ ok: true, rewards }, true).reply;
  assert.match(russian, /^Найдено на Aerodrome: можно забрать около \$12\.38/);
  assert.match(russian, /«Забери мои комиссии Aerodrome»/);
});

test('less than a cent is "under $0.01", and amounts nobody priced are not "$0.00"', async () => {
  const tiny = await valueAerodromeRewardsV1(plan([item('cl_fees', { token0: CANONICAL_BASE_USDC_V1, token1: MEME, amount0: '112200', amount1: '19549308011258976323710' })]), {
    tokenMeta: async () => ({ symbol: 'RWACu', decimals: 18 }),
    value: async () => '3',
  });
  const english = aerodromeRewardsReplyV1({ ok: true, rewards: tiny }, false).reply.split('\n');
  assert.equal(english[0], 'Found on Aerodrome: about $0.11 you can claim now.');
  assert.equal(english[1], '• Pool fees: 0.1122 USDC (about $0.11), 19,549.308 RWACu (under $0.01)');
  assert.match(aerodromeRewardsReplyV1({ ok: true, rewards: tiny }, true).reply, /19,549\.308 RWACu \(меньше \$0\.01\)/);
  const unpriced = await valueAerodromeRewardsV1(plan([item('cl_fees', { token0: MEME, token1: MEME, amount0: '5', amount1: '0' })]), {
    tokenMeta: async () => ({ symbol: 'MEME', decimals: 18 }),
    value: async () => null,
  });
  assert.equal(aerodromeRewardsReplyV1({ ok: true, rewards: unpriced }, false).reply.split('\n')[0], 'Found on Aerodrome: rewards no router could price right now.');
});
test('nothing to claim is said only after every pool was read', async () => {
  const rewards = await valueAerodromeRewardsV1(plan([], { clPositionsTotal: 0, positionsFound: 2, managedSkipped: 1 }), {
    tokenMeta: async () => assert.fail('nothing to price'),
    value: async () => assert.fail('nothing to price'),
  });
  const { reply, errorCode } = aerodromeRewardsReplyV1({ ok: true, rewards }, false);
  assert.equal(errorCode, null);
  assert.deepEqual(reply.split('\n'), [
    'Nothing to claim on Aerodrome for this wallet right now: no fees and no AERO.',
    'Read every pool (39,243), at block 37,123,456.',
    '1 position sits in a vault or a locker: their rewards are claimed there, not here.',
    'Say “Notify me when my Aerodrome rewards reach $5” to hear when there is.',
  ]);

  const unread = aerodromeRewardsReplyV1({ ok: false, errorCode: 'aerodrome_incomplete_coverage', poolsRead: 38_000, poolsTotal: 39_243 }, false);
  assert.equal(unread.errorCode, 'aerodrome_incomplete_coverage');
  assert.equal(unread.reply, 'Could not read all of Aerodrome just now (38,000 of 39,243 pools), so this is not “nothing to claim”. Try again in a minute.');
  assert.match(aerodromeRewardsReplyV1({ ok: false, errorCode: 'aerodrome_positions_limit', poolsRead: 0, poolsTotal: 0 }, false).reply, /more Aerodrome positions than Miorail reads at once \(200\)/);
  assert.match(aerodromeRewardsReplyV1({ ok: false, errorCode: 'aerodrome_target_mismatch', poolsRead: 1, poolsTotal: 1 }, true).reply, /не может проверить \(aerodrome_target_mismatch\)/);
});

test('a reading offers the claim and the alert as buttons, in the language it was asked in', async () => {
  const rewards = await valueAerodromeRewardsV1(plan(CALLS), {
    tokenMeta: async () => ({ symbol: 'MEME', decimals: 18 }),
    value: async () => '1000000',
  });
  assert.deepEqual(aerodromeRewardsNextV1({ ok: true, rewards }, { russian: false, claimReleased: true }), [
    { prompt: 'Claim my Aerodrome fees', kind: 'claim' },
    { prompt: 'Notify me when my Aerodrome rewards reach $5', kind: 'alert' },
  ]);
  assert.deepEqual(aerodromeRewardsNextV1({ ok: true, rewards }, { russian: true, claimReleased: true }).map((next) => next.prompt), [
    'Забери мои комиссии Aerodrome',
    'Сообщи, когда награды Aerodrome дойдут до $5',
  ]);
  // No claim where this deployment could not prepare one.
  assert.deepEqual(aerodromeRewardsNextV1({ ok: true, rewards }, { russian: false, claimReleased: false }).map((next) => next.kind), ['alert']);
  const nothing = await valueAerodromeRewardsV1(plan([]), { tokenMeta: async () => assert.fail(), value: async () => assert.fail() });
  assert.deepEqual(aerodromeRewardsNextV1({ ok: true, rewards: nothing }, { russian: false, claimReleased: true }).map((next) => next.kind), ['alert']);
  // A reading that failed has nothing to act on.
  assert.deepEqual(aerodromeRewardsNextV1({ ok: false, errorCode: 'aerodrome_read_deadline', poolsRead: 1, poolsTotal: 2 }, { russian: false, claimReleased: true }), []);
});
