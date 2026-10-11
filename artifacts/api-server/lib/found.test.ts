import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { InMemoryAerodromeRewardAlertRepositoryV1 } from '@mioagent/route-storage';

import type { AerodromeRewardsReadV1 } from './aerodromeRewards.js';
import {
  foundNextV1,
  foundReplyV1,
  foundRewardNoticeV1,
  foundRuntimeV1,
  readFoundTotalV1,
  refreshFoundAlertsV1,
  runFoundReadV1,
  type FoundTotalReadV1,
} from './found.js';
import type { UniswapFeesReadV1 } from './uniswapFees.js';

const WALLET = '0x4e2e3d4c5b6a79880716253443526170e8f9a0b1';
const WETH = '0x4200000000000000000000000000000000000006';
const original = { ...foundRuntimeV1 };
afterEach(() => Object.assign(foundRuntimeV1, original));

const aerodrome = (totalUsdcAtomic: string, claims = 1): AerodromeRewardsReadV1 => ({ ok: true, rewards: {
  blockNumber: '37123456', poolsRead: 39_243, clPositionsHeld: 0, positionsFound: claims, managedSkipped: 0, claims,
  aero: claims ? { token: '0x940181a94a35a4569e4529a3cdfb74e38fd98631', symbol: 'AERO', decimals: 18, amountAtomic: '8120000000000000000', usdcAtomic: totalUsdcAtomic } : null,
  fees: [], totalUsdcAtomic: claims ? totalUsdcAtomic : '0', unpriced: 0,
} });
const uniswap = (totalUsdcAtomic: string, positions = 1): UniswapFeesReadV1 => ({ ok: true, fees: {
  blockNumber: '37123460', positionsHeld: 2, positionsOpen: 2, v4PositionsHeld: 0, unreadable: 0,
  positions: Array.from({ length: positions }, (_, index) => ({ tokenId: String(11 + index), token0: WETH, token1: WETH, fee: 500,
    amount0: '1000000000000000', amount1: '0', usdcAtomic: totalUsdcAtomic })),
  fees: positions ? [{ token: WETH, symbol: 'WETH', decimals: 18, amountAtomic: '1000000000000000', usdcAtomic: totalUsdcAtomic }] : [],
  totalUsdcAtomic: positions ? totalUsdcAtomic : '0', unpriced: 0,
} });
const failedAerodrome: AerodromeRewardsReadV1 = { ok: false, errorCode: 'aerodrome_read_deadline', poolsRead: 1, poolsTotal: 2 };
const failedUniswap: UniswapFeesReadV1 = { ok: false, errorCode: 'uniswap_read_unavailable', positionsHeld: 0 };

test('"What can I claim?" totals both readings and keeps each one’s own lines', () => {
  const both = foundReplyV1(aerodrome('7750000'), uniswap('2500000'), false);
  assert.equal(both.errorCode, null);
  const lines = both.reply.split('\n');
  assert.equal(lines[0], 'You can claim about $10.25 now.');
  assert.ok(lines.includes('Found on Aerodrome: about $7.75 you can claim now.'));
  assert.ok(lines.includes('Found on Uniswap: about $2.50 you can collect now from 1 position.'));
  assert.doesNotMatch(both.reply, /Say /, 'the buttons carry the next steps');
  assert.equal(foundReplyV1(aerodrome('0', 0), uniswap('0', 0), false).reply.split('\n')[0], 'Nothing to claim on Aerodrome or Uniswap right now.');
  assert.equal(foundReplyV1(aerodrome('0', 0), uniswap('0', 0), true).reply.split('\n')[0], 'Сейчас забирать нечего ни на Aerodrome, ни на Uniswap.');
});

test('one side unread: what was read stands, and nothing is called "nothing"', () => {
  const half = foundReplyV1(failedAerodrome, uniswap('2500000'), false);
  assert.equal(half.errorCode, null);
  assert.equal(half.reply.split('\n')[0], 'You can claim about $2.50 now, in what could be read.');
  assert.match(half.reply, /Could not read all of Aerodrome just now/);
  const empty = foundReplyV1(failedAerodrome, uniswap('0', 0), false);
  assert.equal(empty.reply.split('\n')[0], 'Not everything could be read, so this is not “nothing to claim”.');
  const neither = foundReplyV1(failedAerodrome, failedUniswap, false);
  assert.equal(neither.errorCode, 'aerodrome_read_deadline');
});

test('the buttons: each claim where something was found and it can be prepared, then one alert', () => {
  const released = { russian: false, aerodromeClaimReleased: true, uniswapCollectReleased: true };
  assert.deepEqual(foundNextV1(aerodrome('7750000'), uniswap('2500000'), released), [
    { prompt: 'Claim my Aerodrome fees', kind: 'claim' },
    { prompt: 'Collect my Uniswap fees', kind: 'claim' },
    { prompt: 'Notify me when my rewards reach $5', kind: 'alert' },
  ]);
  assert.deepEqual(foundNextV1(aerodrome('0', 0), uniswap('2500000'), { ...released, uniswapCollectReleased: false }).map((next) => next.prompt),
    ['Notify me when my rewards reach $5']);
  assert.deepEqual(foundNextV1(failedAerodrome, failedUniswap, released), []);
  assert.deepEqual(foundNextV1(aerodrome('1', 1), uniswap('0', 0), { ...released, russian: true }).map((next) => next.prompt),
    ['Забери мои комиссии Aerodrome', 'Сообщи, когда мои награды дойдут до $5']);
});

test('the console reading asks only the protocols named, for the signed-in wallet', async () => {
  const asked: string[] = [];
  foundRuntimeV1.readAerodrome = async (wallet) => { asked.push(`aerodrome:${wallet}`); return aerodrome('7750000'); };
  foundRuntimeV1.readUniswap = async (wallet) => { asked.push(`uniswap:${wallet}`); return uniswap('2500000'); };
  const both = await runFoundReadV1({ walletAddress: WALLET.toUpperCase().replace('0X', '0x'), message: 'What can I claim?',
    protocols: ['aerodrome', 'uniswap'], aerodromeClaimReleased: true, uniswapCollectReleased: true });
  assert.equal(both.status, 'answered');
  assert.deepEqual(both.trace.map((row) => row.tool), ['aerodrome_rewards_read', 'uniswap_fees_read']);
  assert.equal(both.next?.length, 3);
  assert.deepEqual(asked.sort(), [`aerodrome:${WALLET}`, `uniswap:${WALLET}`]);
  asked.length = 0;
  const one = await runFoundReadV1({ walletAddress: WALLET, message: 'Check my Uniswap fees', protocols: ['uniswap'],
    aerodromeClaimReleased: true, uniswapCollectReleased: true });
  assert.deepEqual(asked, [`uniswap:${WALLET}`]);
  assert.match(one.reply ?? '', /^Found on Uniswap: about \$2\.50/);
  assert.deepEqual(one.next?.map((next) => next.kind), ['claim', 'alert']);
  foundRuntimeV1.readUniswap = async () => failedUniswap;
  const failed = await runFoundReadV1({ walletAddress: WALLET, message: 'Check my Uniswap fees', protocols: ['uniswap'],
    aerodromeClaimReleased: true, uniswapCollectReleased: true });
  assert.deepEqual([failed.status, failed.errorCode, failed.next], ['failed', 'uniswap_read_unavailable', []]);
});

test('the alert reads both and keeps their sum; either one failing is a failure tried again', async () => {
  foundRuntimeV1.readAerodrome = async () => aerodrome('7750000');
  foundRuntimeV1.readUniswap = async () => uniswap('2500000');
  assert.deepEqual(await readFoundTotalV1(WALLET), { ok: true, blockNumber: '37123456', totalUsdcAtomic: '10250000' });
  foundRuntimeV1.readUniswap = async () => failedUniswap;
  assert.deepEqual(await readFoundTotalV1(WALLET), { ok: false, errorCode: 'uniswap_read_unavailable' });
});

test('the push fits Base App, names both, and leads to Wallet MCP', () => {
  const notice = foundRewardNoticeV1({ usdCents: 1_238 });
  assert.equal(notice.title, 'Rewards to claim: $12.38');
  assert.ok(notice.title.length <= 30 && notice.message.length <= 200, JSON.stringify(notice));
  assert.equal(notice.targetPath, '/extensions');
  assert.match(notice.message, /Aerodrome and Uniswap/);
  assert.match(notice.message, /“What can I claim\?”/);
  assert.ok(foundRewardNoticeV1({ usdCents: 99_999_999 }).title.length <= 30);
  assert.ok(foundRewardNoticeV1({ usdCents: 99_999_999 }).message.length <= 200);
});

test('the reading pass reads the wallets due, keeps each reading, and a dry pass keeps none', async () => {
  const alerts = new InMemoryAerodromeRewardAlertRepositoryV1();
  const now = new Date('2026-10-11T12:00:00.000Z');
  const other = '0x1111111111111111111111111111111111111111';
  const third = '0x3333333333333333333333333333333333333333';
  for (const wallet of [WALLET, other, third]) await alerts.subscribe({ walletAddress: wallet, thresholdUsdCents: 500, at: now });
  const readings: Record<string, FoundTotalReadV1> = {
    [WALLET]: { ok: true, blockNumber: '42', totalUsdcAtomic: '6789999' },
    [other]: { ok: false, errorCode: 'aerodrome_read_deadline' },
  };
  const read = async (wallet: string) => {
    if (wallet === third) throw new Error('rpc down');
    return readings[wallet]!;
  };
  assert.deepEqual(await refreshFoundAlertsV1({ alerts, now, dry: true, read, limit: 5 }), { due: 3, read: 1, failed: 2 });
  assert.equal((await alerts.get(WALLET))!.readAt, null, 'a dry pass keeps nothing');
  // Two a pass, never-read first in address order: both of these fail, and a
  // read that throws is kept as a failure like one that answered with one.
  assert.deepEqual(await refreshFoundAlertsV1({ alerts, now, read, limit: 2 }), { due: 2, read: 0, failed: 2 });
  assert.equal((await alerts.get(other))!.readError, 'aerodrome_read_deadline');
  assert.equal((await alerts.get(third))!.readError, 'found_read_unavailable');
  assert.deepEqual(await refreshFoundAlertsV1({ alerts, now, read, limit: 2 }), { due: 1, read: 1, failed: 0 });
  const kept = (await alerts.get(WALLET))!;
  assert.deepEqual([kept.readUsdCents, kept.readBlock, kept.readError], [678, '42', null]);
  // A failure is tried again after half an hour; a good reading after six.
  const soon = new Date(now.getTime() + 31 * 60_000);
  assert.deepEqual(await refreshFoundAlertsV1({ alerts, now: soon, read, limit: 5 }), { due: 2, read: 0, failed: 2 });
});
