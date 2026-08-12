import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';

import { O1_BASE_ROUTER_PROXY, validateO1Swap } from './o1Guard.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const POOL = '0x2222222222222222222222222222222222222222';
const EXCHANGE = '0x3333333333333333333333333333333333333333';
const OTHER = '0x4444444444444444444444444444444444444444';
const AMOUNT_IN = 100_000_000n;
const MINIMUM_OUT = 37_810_000_000_000_000n;
const NOW = new Date('2026-08-12T12:00:00.000Z');
const EXPIRES = '2026-08-12T12:10:00.000Z';

const ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'swaps',
        type: 'tuple[]',
        components: [
          { name: 'dexType', type: 'uint8' },
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'pool', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'exchange', type: 'address' },
          { name: 'extraData', type: 'bytes' },
        ],
      },
      { name: 'settlementToken', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

function calls(
  overrides: {
    approval?: bigint;
    tokenOut?: string;
    settlementToken?: string;
    minimum?: bigint;
  } = {},
) {
  return [
    {
      to: USDC,
      value: '0',
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [O1_BASE_ROUTER_PROXY, overrides.approval ?? AMOUNT_IN],
      }),
    },
    {
      to: O1_BASE_ROUTER_PROXY,
      value: '0',
      data: encodeFunctionData({
        abi: ABI,
        functionName: 'swap',
        args: [
          [
            {
              dexType: 1,
              tokenIn: USDC,
              tokenOut: (overrides.tokenOut ?? WETH) as `0x${string}`,
              pool: POOL,
              fee: 500,
              tickSpacing: 10,
              exchange: EXCHANGE,
              extraData: '0x',
            },
          ],
          (overrides.settlementToken ?? WETH) as `0x${string}`,
          AMOUNT_IN,
          overrides.minimum ?? MINIMUM_OUT,
        ],
      }),
    },
  ];
}

function run(batch = calls(), overrides: Partial<{ expiresAt: string }> = {}) {
  return validateO1Swap({
    chain: 8453,
    calls: batch,
    now: NOW,
    context: {
      inputTokenAddress: USDC,
      outputTokenAddress: WETH,
      amountInAtomic: AMOUNT_IN.toString(),
      minimumOutputAtomic: MINIMUM_OUT.toString(),
      swapper: WALLET,
      routerAddress: O1_BASE_ROUTER_PROXY,
      expiresAt: overrides.expiresAt ?? EXPIRES,
    },
  });
}

describe('o1 Safety Kernel guard', () => {
  test('accepts exact approval plus the reviewed route', () => {
    const result = run();
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.semantics.spendAmountRaw, AMOUNT_IN.toString());
    assert.equal(result.semantics.minimumOutputRaw, MINIMUM_OUT.toString());
    assert.deepEqual(result.semantics.recipients, [WALLET]);
  });

  test('rejects an unlimited approval', () => {
    const result = run(calls({ approval: (1n << 256n) - 1n }));
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'o1_approval_not_exact');
  });

  test('rejects output substitution and a weaker minimum', () => {
    const substituted = run(calls({ tokenOut: OTHER }));
    assert.equal(substituted.success, false);
    if (!substituted.success) assert.equal(substituted.code, 'o1_route_asset_mismatch');

    const weak = run(calls({ minimum: MINIMUM_OUT - 1n }));
    assert.equal(weak.success, false);
    if (!weak.success) assert.equal(weak.code, 'o1_swap_bounds_invalid');

    const foreignSettlement = run(calls({ settlementToken: OTHER }));
    assert.equal(foreignSettlement.success, false);
    if (!foreignSettlement.success) assert.equal(foreignSettlement.code, 'o1_swap_bounds_invalid');
  });

  test('rejects expired calls and any extra target', () => {
    const expired = run(calls(), { expiresAt: NOW.toISOString() });
    assert.equal(expired.success, false);
    if (!expired.success) assert.equal(expired.code, 'o1_quote_expired');

    const extra = run([...calls(), { to: OTHER, value: '0', data: '0x' }]);
    assert.equal(extra.success, false);
    if (!extra.success) assert.equal(extra.code, 'o1_batch_size_invalid');
  });
});
