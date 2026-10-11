import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, parseAbi } from 'viem';
import { validateBaseCalls } from './baseGuards.js';
import { UNISWAP_V3_POSITION_MANAGER_BASE_V1, validateUniswapCollectCallsV1 } from './uniswapCollectGuard.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const MAX = (1n << 128n) - 1n;
const ABI = parseAbi(['function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256,uint256)']);
const collect = (tokenId: bigint, over: { recipient?: string; amount0Max?: bigint; to?: string } = {}) => ({
  to: over.to ?? UNISWAP_V3_POSITION_MANAGER_BASE_V1, value: '0',
  data: encodeFunctionData({ abi: ABI, functionName: 'collect', args: [{
    tokenId, recipient: (over.recipient ?? WALLET) as `0x${string}`, amount0Max: over.amount0Max ?? MAX, amount1Max: MAX,
  }] }),
});

test('only a full collect to the wallet itself, at the pinned manager, passes; the generic transport refuses it', () => {
  assert.doesNotThrow(() => validateUniswapCollectCallsV1(WALLET, [collect(41n), collect(42n)]));
  assert.throws(() => validateBaseCalls('8453', [collect(41n)]));
  assert.throws(() => validateUniswapCollectCallsV1(WALLET, [collect(41n, { recipient: OTHER })]), /calldata_refused/);
  assert.throws(() => validateUniswapCollectCallsV1(WALLET, [collect(41n, { amount0Max: 1n })]), /calldata_refused/);
  assert.throws(() => validateUniswapCollectCallsV1(WALLET, [collect(41n, { to: OTHER })]), /collect_invalid/);
  assert.throws(() => validateUniswapCollectCallsV1(WALLET, [collect(0n)]), /calldata_refused/);
  assert.throws(() => validateUniswapCollectCallsV1(WALLET, [collect(41n), collect(41n)]), /duplicate/);
  assert.throws(() => validateUniswapCollectCallsV1(WALLET, [{ ...collect(41n), value: '1' }]), /collect_invalid/);
  assert.throws(() => validateUniswapCollectCallsV1(WALLET, [{ ...collect(41n), data: '0x095ea7b3' }]), /calldata_refused/);
  assert.throws(() => validateUniswapCollectCallsV1(WALLET, []), /collect_invalid/);
  assert.throws(() => validateUniswapCollectCallsV1(WALLET, Array.from({ length: 21 }, (_, i) => collect(BigInt(i + 1)))), /collect_invalid/);
});

test('ERC-8021 attribution trails the calldata; a malformed one is refused', () => {
  const suffix = '62635f74657374070080218021802180218021802180218021';
  assert.doesNotThrow(() => validateUniswapCollectCallsV1(WALLET, [{ ...collect(41n), data: collect(41n).data + suffix }]));
  assert.throws(() => validateUniswapCollectCallsV1(WALLET, [{ ...collect(41n), data: collect(41n).data + suffix.replace('0700', 'ff00') }]), /suffix_invalid/);
});
