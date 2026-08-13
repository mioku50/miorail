import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';
import {
  BALANCER_PERMIT2_BASE_V1,
  BALANCER_V3_ROUTER_BASE_V1,
  validateBalancerSwap,
  type BalancerSwapContext,
} from './balancerGuard.js';

const NOW = new Date('2026-08-13T10:00:00.000Z');
const DEADLINE = BigInt(Math.floor(NOW.getTime() / 1000) + 180);
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const POOL = '0x7b4c560f33a71a9f7a500af3c4c65b46fbbafdb7';
const WALLET = '0x1111111111111111111111111111111111111111';
const AMOUNT = 100000000n;
const MINIMUM = 52600000000000000n;
const permitAbi = [{
  type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [
    { name: 'token', type: 'address' }, { name: 'spender', type: 'address' },
    { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' },
  ], outputs: [],
}] as const;
const swapAbi = [{
  type: 'function', name: 'swapSingleTokenExactIn', stateMutability: 'payable',
  inputs: [
    { name: 'pool', type: 'address' }, { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' }, { name: 'exactAmountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    { name: 'wethIsEth', type: 'bool' }, { name: 'userData', type: 'bytes' },
  ], outputs: [{ name: '', type: 'uint256' }],
}] as const;

function context(overrides: Partial<BalancerSwapContext> = {}): BalancerSwapContext {
  return {
    protocolVersion: 3,
    inputTokenAddress: USDC,
    outputTokenAddress: WETH,
    amountInAtomic: AMOUNT.toString(),
    minimumOutputAtomic: MINIMUM.toString(),
    walletAddress: WALLET,
    routerAddress: BALANCER_V3_ROUTER_BASE_V1,
    sourceKeys: [`balancer:v3:${POOL}:${USDC}:${WETH}:pool`],
    ...overrides,
  };
}
function calls(overrides: { pool?: `0x${string}`; minimum?: bigint; approval?: bigint } = {}) {
  return [
    {
      to: USDC, value: '0',
      data: encodeFunctionData({
        abi: erc20Abi, functionName: 'approve',
        args: [BALANCER_PERMIT2_BASE_V1, overrides.approval ?? AMOUNT],
      }),
    },
    {
      to: BALANCER_PERMIT2_BASE_V1, value: '0',
      data: encodeFunctionData({
        abi: permitAbi, functionName: 'approve',
        args: [USDC, BALANCER_V3_ROUTER_BASE_V1, AMOUNT, Number(DEADLINE)],
      }),
    },
    {
      to: BALANCER_V3_ROUTER_BASE_V1, value: '0',
      data: encodeFunctionData({
        abi: swapAbi, functionName: 'swapSingleTokenExactIn',
        args: [overrides.pool ?? POOL, USDC, WETH, AMOUNT, overrides.minimum ?? MINIMUM, DEADLINE, false, '0x'],
      }),
    },
  ];
}

test('Balancer guard accepts only the exact reviewed V3 batch', () => {
  assert.equal(validateBalancerSwap({ chain: 8453, calls: calls(), context: context(), now: NOW }).success, true);
});

test('Balancer guard blocks unlimited approval, pool substitution, and a weaker minimum', () => {
  assert.equal(validateBalancerSwap({
    chain: 8453, calls: calls({ approval: (1n << 256n) - 1n }), context: context(), now: NOW,
  }).success, false);
  assert.equal(validateBalancerSwap({
    chain: 8453,
    calls: calls({ pool: '0x2222222222222222222222222222222222222222' }),
    context: context(),
    now: NOW,
  }).success, false);
  assert.equal(validateBalancerSwap({
    chain: 8453, calls: calls({ minimum: MINIMUM - 1n }), context: context(), now: NOW,
  }).success, false);
});
