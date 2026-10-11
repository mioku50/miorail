import assert from 'node:assert/strict';
import test from 'node:test';

import { CANONICAL_BASE_USDC_V1 } from './stockGift.js';
import { uniswapFeesNextV1, uniswapFeesReplyV1, valueUniswapFeesV1, type UniswapFeesReadV1 } from './uniswapFees.js';
import type { UniswapFeesPlanV1 } from './uniswapFeesReader.js';

const WETH = '0x4200000000000000000000000000000000000006';
const MEME = '0x7777777777777777777777777777777777777777';

function plan(over: Partial<UniswapFeesPlanV1> = {}): UniswapFeesPlanV1 {
  return {
    blockNumber: '37123456', positionsHeld: 5, positionsOpen: 3, v4PositionsHeld: 0, unreadable: 0, errorCode: null,
    positions: [
      { tokenId: '11', token0: WETH, token1: CANONICAL_BASE_USDC_V1, fee: 500, amount0: '1000000000000000', amount1: '1530000' },
      { tokenId: '12', token0: WETH, token1: CANONICAL_BASE_USDC_V1, fee: 3000, amount0: '3000000000000000', amount1: '0' },
      { tokenId: '13', token0: MEME, token1: WETH, fee: 10000, amount0: '5000000000000000000000', amount1: '0' },
    ],
    ...over,
  };
}

const deps = {
  tokenMeta: async (token: string) => (token === WETH ? { symbol: 'WETH', decimals: 18 } : { symbol: 'MEME', decimals: 18 }),
  // 0.004 WETH fetches $10.00; MEME is priced by nobody.
  value: async (asset: { address?: string | null }) => (asset.address === WETH ? '10000000' : null),
};

test('fees are summed per token and valued once; each position carries its share', async () => {
  const fees = await valueUniswapFeesV1(plan(), deps);
  assert.deepEqual(fees.fees.map((fee) => [fee.symbol, fee.amountAtomic, fee.usdcAtomic]), [
    ['WETH', '4000000000000000', '10000000'],
    ['USDC', '1530000', '1530000'],
    ['MEME', '5000000000000000000000', null],
  ]);
  assert.equal(fees.totalUsdcAtomic, '11530000');
  assert.equal(fees.unpriced, 1);
  // 0.003 WETH is three quarters of the WETH; 0.001 WETH plus 1.53 USDC is the rest.
  assert.deepEqual(fees.positions.map((position) => [position.tokenId, position.usdcAtomic]), [
    ['12', '7500000'], ['11', '4030000'], ['13', null],
  ]);
});

test('the reply names what was read, what was left out, and what v4 holds', async () => {
  const fees = await valueUniswapFeesV1(plan({ unreadable: 1, v4PositionsHeld: 2 }), deps);
  const lines = uniswapFeesReplyV1({ ok: true, fees }, false).reply.split('\n');
  assert.deepEqual(lines, [
    'Found on Uniswap: about $11.53 you can collect now from 3 positions, not counting what could not be priced.',
    '• Fees: 0.004 WETH (about $10.00), 1.53 USDC (about $1.53), 5,000 MEME (no router priced it)',
    'Read every Uniswap v3 position this wallet holds (5), at block 37,123,456. 2 closed ones pay nothing.',
    '1 position could not be read and is not counted.',
    'This wallet also holds 2 Uniswap v4 positions; Miorail does not read v4 fees yet: see app.uniswap.org.',
    'Values are what a sell would fetch in USDC now. WETH arrives as WETH.',
    'Say “Collect my Uniswap fees” to collect it.',
  ]);
  const russian = uniswapFeesReplyV1({ ok: true, fees }, true).reply;
  assert.match(russian, /^Найдено на Uniswap: можно собрать около \$11\.53 из позиций \(3\)/);
  assert.match(russian, /«Забери мои комиссии Uniswap»/);
  assert.doesNotMatch(uniswapFeesReplyV1({ ok: true, fees }, false, { say: false }).reply, /Say/);
});

test('nothing to collect is said after every position was read; a failed read is never nothing', async () => {
  const none = await valueUniswapFeesV1(plan({ positions: [], positionsHeld: 2, positionsOpen: 0 }), deps);
  assert.deepEqual(uniswapFeesReplyV1({ ok: true, fees: none }, false).reply.split('\n'), [
    'Nothing to collect on Uniswap for this wallet right now.',
    'Read every Uniswap v3 position this wallet holds (2), at block 37,123,456. 2 closed ones pay nothing.',
  ]);
  const limit = uniswapFeesReplyV1({ ok: false, errorCode: 'uniswap_positions_limit', positionsHeld: 1_855 }, false);
  assert.equal(limit.errorCode, 'uniswap_positions_limit');
  assert.match(limit.reply, /holds 1,855 Uniswap v3 positions, more than Miorail reads at once \(100\)/);
  const down = uniswapFeesReplyV1({ ok: false, errorCode: 'uniswap_read_unavailable', positionsHeld: 0 }, true);
  assert.match(down.reply, /это не «собирать нечего»/);
});

test('the buttons: collect where fees were found and the deployment can prepare it, then the alert', async () => {
  const fees = await valueUniswapFeesV1(plan(), deps);
  const read: UniswapFeesReadV1 = { ok: true, fees };
  assert.deepEqual(uniswapFeesNextV1(read, { russian: false, collectReleased: true }), [
    { prompt: 'Collect my Uniswap fees', kind: 'claim' },
    { prompt: 'Notify me when my rewards reach $5', kind: 'alert' },
  ]);
  assert.deepEqual(uniswapFeesNextV1(read, { russian: true, collectReleased: false }), [
    { prompt: 'Сообщи, когда мои награды дойдут до $5', kind: 'alert' },
  ]);
  assert.deepEqual(uniswapFeesNextV1({ ok: false, errorCode: 'uniswap_read_unavailable', positionsHeld: 0 }, { russian: false, collectReleased: true }), []);
});
