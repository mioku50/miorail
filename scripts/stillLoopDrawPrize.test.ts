import assert from 'node:assert/strict';
import test from 'node:test';

import { loopPrizeTransfersV1, loopPrizesCoveredV1 } from './stillLoopDrawPrize.js';

// Synthetic wallets and transactions: nothing here is anyone's.
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const PRIZE_WALLET = `0x${'9'.repeat(40)}`, STRANGER = `0x${'8'.repeat(40)}`;
const A = `0x${'a'.repeat(40)}`, B = `0x${'b'.repeat(40)}`;
const TX = `0x${'1'.repeat(64)}`, OTHER_TX = `0x${'2'.repeat(64)}`;
const topic = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const transfer = (from: string, to: string, atomic: bigint, token = USDC) =>
  ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: `0x${atomic.toString(16).padStart(64, '0')}` });
const entry = (walletAddress: string, label: string) => ({ label, walletAddress, kind: 'free' as const, loopNo: null, enteredAt: '2026-11-25T10:00:00.000Z' });
const FIVE = 5_000_000n;

test('only USDC from the prize wallet counts (audit LOOP-3)', () => {
  const sent = loopPrizeTransfersV1([
    transfer(PRIZE_WALLET, A, FIVE),
    transfer(STRANGER, B, FIVE),
    transfer(PRIZE_WALLET, B, FIVE, `0x${'7'.repeat(40)}`),
  ], PRIZE_WALLET.toUpperCase().replace('0X', '0x'));
  assert.deepEqual([...sent], [[A, FIVE]]);
});

test('one transfer pays one prize, in this draw or in another', () => {
  const draw = { drawId: '2026-12-03', entries: [entry(A, 'Entry AAAAAA'), entry(B, 'Entry BBBBBB')], payouts: [], prizeAtomic: FIVE.toString() };
  // A won the draw before too, and this same transaction was recorded for it there.
  const before = { drawId: '2026-11-28', entries: [entry(A, 'Loop #1')], payouts: [{ no: 1, tx: TX, at: '2026-12-04T00:00:00.000Z' }], prizeAtomic: FIVE.toString() };
  const sent = new Map([[A, FIVE], [B, FIVE]]);
  assert.deepEqual(loopPrizesCoveredV1({ tx: TX, sent, prize: FIVE, draw, unpaid: [1, 2], draws: [before, draw] }), [2]);
  // Ten to A covers both draws' five.
  assert.deepEqual(loopPrizesCoveredV1({ tx: TX, sent: new Map([[A, 2n * FIVE]]), prize: FIVE, draw, unpaid: [1], draws: [before, draw] }), [1]);
  // Another transaction is not this one.
  assert.deepEqual(loopPrizesCoveredV1({ tx: OTHER_TX, sent, prize: FIVE, draw, unpaid: [1, 2], draws: [before, draw] }), [1, 2]);
  // Less than the prize pays nothing.
  assert.deepEqual(loopPrizesCoveredV1({ tx: OTHER_TX, sent: new Map([[A, FIVE - 1n]]), prize: FIVE, draw, unpaid: [1], draws: [draw] }), []);
});
