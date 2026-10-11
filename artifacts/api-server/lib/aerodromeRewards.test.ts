import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryAerodromeRewardAlertRepositoryV1 } from '@mioagent/route-storage';

import { AERODROME_AERO_V1, type AerodromeClaimPlanV1 } from './aerodromeClaimReader.js';
import {
  aerodromeRewardNoticeV1,
  aerodromeRewardTotalsV1,
  aerodromeRewardsReplyV1,
  refreshAerodromeRewardAlertsV1,
  usdcAtomicToCentsV1,
  valueAerodromeRewardsV1,
  type AerodromeRewardsReadV1,
} from './aerodromeRewards.js';
import { CANONICAL_BASE_USDC_V1 } from './stockGift.js';

const WETH = '0x4200000000000000000000000000000000000006';
const MEME = '0x7777777777777777777777777777777777777777';
const POOL = '0x2222222222222222222222222222222222222222';
const WALLET = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';

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

test('the push fits Base App and leads to Wallet MCP', () => {
  const notice = aerodromeRewardNoticeV1({ usdCents: 1_238 });
  assert.equal(notice.title, 'Aerodrome rewards: $12.38');
  assert.ok(notice.title.length <= 30 && notice.message.length <= 200, JSON.stringify(notice));
  assert.equal(notice.targetPath, '/extensions');
  assert.match(notice.message, /“Claim my Aerodrome fees”/);
  assert.ok(aerodromeRewardNoticeV1({ usdCents: 99_999_999 }).title.length <= 30);
});

test('the reading pass reads the wallets due, keeps each reading, and a dry pass keeps none', async () => {
  const alerts = new InMemoryAerodromeRewardAlertRepositoryV1();
  const now = new Date('2026-10-11T12:00:00.000Z');
  const other = '0x1111111111111111111111111111111111111111';
  const third = '0x3333333333333333333333333333333333333333';
  for (const wallet of [WALLET, other, third]) await alerts.subscribe({ walletAddress: wallet, thresholdUsdCents: 500, at: now });
  const readings: Record<string, AerodromeRewardsReadV1> = {
    [WALLET]: { ok: true, rewards: { blockNumber: '42', poolsRead: 1, clPositionsHeld: 0, positionsFound: 1, managedSkipped: 0, claims: 1,
      aero: null, fees: [], totalUsdcAtomic: '6789999', unpriced: 0 } },
    [other]: { ok: false, errorCode: 'aerodrome_read_deadline', poolsRead: 0, poolsTotal: 0 },
  };
  const read = async (wallet: string) => {
    if (wallet === third) throw new Error('rpc down');
    return readings[wallet]!;
  };
  assert.deepEqual(await refreshAerodromeRewardAlertsV1({ alerts, now, dry: true, read, limit: 5 }), { due: 3, read: 1, failed: 2 });
  assert.equal((await alerts.get(WALLET))!.readAt, null, 'a dry pass keeps nothing');
  // Two a pass, never-read first in address order: both of these fail, and a
  // read that throws is kept as a failure like one that answered with one.
  assert.deepEqual(await refreshAerodromeRewardAlertsV1({ alerts, now, read, limit: 2 }), { due: 2, read: 0, failed: 2 });
  assert.equal((await alerts.get(other))!.readError, 'aerodrome_read_deadline');
  assert.equal((await alerts.get(third))!.readError, 'aerodrome_read_unavailable');
  assert.deepEqual(await refreshAerodromeRewardAlertsV1({ alerts, now, read, limit: 2 }), { due: 1, read: 1, failed: 0 });
  const kept = (await alerts.get(WALLET))!;
  assert.deepEqual([kept.readUsdCents, kept.readBlock, kept.readError], [678, '42', null]);
  // A failure is tried again after half an hour; a good reading after six.
  const soon = new Date(now.getTime() + 31 * 60_000);
  assert.deepEqual(await refreshAerodromeRewardAlertsV1({ alerts, now: soon, read, limit: 5 }), { due: 2, read: 0, failed: 2 });
});
