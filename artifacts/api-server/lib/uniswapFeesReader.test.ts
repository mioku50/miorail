import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData } from 'viem';

import {
  UNISWAP_POSITIONS_LIMIT_V1,
  UNISWAP_V3_POSITIONS_ABI_V1,
  UNISWAP_V3_POSITION_MANAGER_V1,
  UNISWAP_V4_POSITION_MANAGER_V1,
  readUniswapFeesPlanV1,
  revertedV1,
  uniswapCollectCallV1,
  type UniswapFeesReadDepsV1,
  type UniswapViewCallV1,
} from './uniswapFeesReader.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MAX = (1n << 128n) - 1n;

/** positions(): nonce, operator, token0, token1, fee, tickLower, tickUpper,
 * liquidity, feeGrowth0, feeGrowth1, owed0, owed1. */
function position(liquidity: bigint, owed0 = 0n, owed1 = 0n) {
  return [0n, '0x0000000000000000000000000000000000000000', WETH, USDC, 500, -100, 100, liquidity, 0n, 0n, owed0, owed1];
}

function deps(input: {
  held: number;
  v4?: number;
  positions: Record<string, unknown[]>;
  collect: Record<string, [bigint, bigint] | null>;
}): UniswapFeesReadDepsV1 & { asked: UniswapViewCallV1[][]; dry: string[][] } {
  const ids = Object.keys(input.positions);
  const asked: UniswapViewCallV1[][] = [];
  const dry: string[][] = [];
  return {
    asked, dry,
    blockNumber: 1_234n,
    readMany: async (calls) => {
      asked.push([...calls]);
      return calls.map((call) => {
        if (call.name === 'balanceOf') return BigInt(call.address === UNISWAP_V4_POSITION_MANAGER_V1 ? input.v4 ?? 0 : input.held);
        if (call.name === 'tokenOfOwnerByIndex') return BigInt(ids[Number(call.args[1])]!);
        return input.positions[String(call.args[0])];
      });
    },
    dryCollect: async (wallet, tokenIds) => {
      assert.equal(wallet, WALLET);
      dry.push(tokenIds.map(String));
      return tokenIds.map((id) => input.collect[String(id)] ?? null);
    },
  };
}

test('every position is read; closed ones are not dry-run; a revert is counted, never zero', async () => {
  const reader = deps({
    held: 4, v4: 2,
    positions: { 11: position(5n), 12: position(0n), 13: position(0n, 7n, 0n), 14: position(9n) },
    collect: { 11: [3n, 4n], 13: [7n, 0n], 14: null },
  });
  const plan = await readUniswapFeesPlanV1(reader, WALLET.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(reader.dry, [['11', '13', '14']], 'a closed position with nothing owed pays nothing and is not asked');
  assert.deepEqual(
    { held: plan.positionsHeld, open: plan.positionsOpen, v4: plan.v4PositionsHeld, unreadable: plan.unreadable, block: plan.blockNumber, error: plan.errorCode },
    { held: 4, open: 3, v4: 2, unreadable: 1, block: '1234', error: null },
  );
  assert.deepEqual(plan.positions, [
    { tokenId: '11', token0: WETH, token1: USDC, fee: 500, amount0: '3', amount1: '4' },
    { tokenId: '13', token0: WETH, token1: USDC, fee: 500, amount0: '7', amount1: '0' },
  ]);
  // Both managers are asked about this wallet only.
  assert.deepEqual(reader.asked[0]!.map((call) => [call.address, call.name, call.args[0]]), [
    [UNISWAP_V3_POSITION_MANAGER_V1, 'balanceOf', WALLET],
    [UNISWAP_V4_POSITION_MANAGER_V1, 'balanceOf', WALLET],
  ]);
});

test('an empty wallet reads nothing more, and one past the limit is told, not cut', async () => {
  const empty = deps({ held: 0, positions: {}, collect: {} });
  assert.deepEqual((await readUniswapFeesPlanV1(empty, WALLET)).positions, []);
  assert.equal(empty.asked.length, 1);
  const huge = deps({ held: UNISWAP_POSITIONS_LIMIT_V1 + 1, positions: {}, collect: {} });
  const plan = await readUniswapFeesPlanV1(huge, WALLET);
  assert.equal(plan.errorCode, 'uniswap_positions_limit');
  assert.equal(plan.positionsHeld, UNISWAP_POSITIONS_LIMIT_V1 + 1);
  assert.equal(huge.asked.length, 1, 'no position is enumerated past the limit');
});

test('an answer of the wrong shape fails the reading instead of becoming a number', async () => {
  const bad = deps({ held: 1, positions: { 11: [1n, 2n] }, collect: {} });
  await assert.rejects(readUniswapFeesPlanV1(bad, WALLET), /uniswap_read_invalid/);
  const negative = deps({ held: 1, positions: { 11: position(1n) }, collect: { 11: [-1n, 0n] } });
  await assert.rejects(readUniswapFeesPlanV1(negative, WALLET), /uniswap_read_invalid/);
});

test('a collect call pays everything owed to the wallet itself, at the pinned manager', () => {
  const call = uniswapCollectCallV1('41', WALLET.toUpperCase().replace('0X', '0x'), 3);
  assert.equal(call.to, UNISWAP_V3_POSITION_MANAGER_V1);
  assert.equal(call.valueWei, '0');
  assert.equal(call.index, 3);
  const decoded = decodeFunctionData({ abi: UNISWAP_V3_POSITIONS_ABI_V1, data: call.data });
  assert.equal(decoded.functionName, 'collect');
  assert.deepEqual(decoded.args, [{ tokenId: 41n, recipient: WALLET, amount0Max: MAX, amount1Max: MAX }]);
});

test('a revert is told apart from a request that failed', () => {
  assert.equal(revertedV1({ name: 'CallExecutionError', cause: { code: 3, message: 'execution reverted' } }), true);
  assert.equal(revertedV1({ message: 'x', details: 'execution reverted: Not approved' }), true);
  assert.equal(revertedV1({ name: 'HttpRequestError', message: 'HTTP request failed. Status: 429' }), false);
  assert.equal(revertedV1({ name: 'TimeoutError', message: 'The request took too long' }), false);
  assert.equal(revertedV1(null), false);
});
