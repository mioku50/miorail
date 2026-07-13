import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalUsdcForBaseChain } from './baseGuards.js';
import {
  BASE_UNISWAP_UNIVERSAL_ROUTER_2,
  PERMIT2_ADDRESS,
  validateUniswapSwap,
} from './uniswapGuard.js';

const WALLET = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';

function context() {
  return {
    amountDecimal: '1.25',
    inputToken: 'USDC' as const,
    outputToken: 'ETH' as const,
    swapper: WALLET,
    routerVersion: '2.0' as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function approveData(spender: string, amount: bigint) {
  return `0x095ea7b3${spender.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}

test('T47 Uniswap guard accepts exact USDC approval plus pinned router call', () => {
  const result = validateUniswapSwap({
    chain: 8453,
    context: context(),
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(PERMIT2_ADDRESS, 1_250_000n) },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x12345678' },
    ],
  });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.semantics.spendAmountUsdc, 1.25);
});

test('T47 Uniswap guard blocks unlimited approvals, foreign targets and native value', () => {
  const cases = [
    [{ to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(PERMIT2_ADDRESS, (1n << 256n) - 1n) }, { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x12345678' }],
    [{ to: '0x1111111111111111111111111111111111111111', value: '0', data: '0x12345678' }],
    [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '1', data: '0x12345678' }],
  ];
  for (const calls of cases) assert.equal(validateUniswapSwap({ chain: 8453, context: context(), calls }).success, false);
});
