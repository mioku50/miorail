import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalUsdcForBaseChain } from './baseGuards.js';
import { KYBERSWAP_BASE_ROUTER, validateKyberSwap } from './kyberGuard.js';

const WALLET = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';

function context() {
  return {
    amountDecimal: '1.25',
    inputToken: 'USDC' as const,
    outputToken: 'ETH' as const,
    swapper: WALLET,
    recipient: WALLET,
    routerAddress: KYBERSWAP_BASE_ROUTER,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function approveData(spender: string, amount: bigint) {
  return `0x095ea7b3${spender.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}

test('T56 KyberSwap guard accepts exact USDC approval plus pinned router call', () => {
  const result = validateKyberSwap({
    chain: 8453,
    context: context(),
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(KYBERSWAP_BASE_ROUTER, 1_250_000n) },
      { to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' },
    ],
  });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.semantics.spendAmountUsdc, 1.25);
});

test('T56 KyberSwap guard accepts a swap-only call when no approval is required', () => {
  const result = validateKyberSwap({
    chain: 8453,
    context: context(),
    calls: [{ to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' }],
  });
  assert.equal(result.success, true);
});

test('T56 KyberSwap guard blocks router mismatch, unlimited approvals, foreign targets, and native value', () => {
  const cases = [
    [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(KYBERSWAP_BASE_ROUTER, (1n << 256n) - 1n) },
      { to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' },
    ],
    [{ to: '0x1111111111111111111111111111111111111111', value: '0', data: '0x12345678' }],
    [{ to: KYBERSWAP_BASE_ROUTER, value: '1', data: '0x12345678' }],
  ];
  for (const calls of cases) assert.equal(validateKyberSwap({ chain: 8453, context: context(), calls }).success, false);

  const wrongRouterContext = { ...context(), routerAddress: '0x2222222222222222222222222222222222222222' };
  assert.equal(
    validateKyberSwap({
      chain: 8453,
      context: wrongRouterContext,
      calls: [{ to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' }],
    }).success,
    false,
  );
});

test('T56 KyberSwap guard requires wallet-bound sender and recipient', () => {
  const mismatched = { ...context(), recipient: '0x2222222222222222222222222222222222222222' };
  assert.equal(
    validateKyberSwap({
      chain: 8453,
      context: mismatched,
      calls: [{ to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' }],
    }).success,
    false,
  );
});

test('T56 KyberSwap guard rejects an expired route', () => {
  const expired = { ...context(), expiresAt: new Date(Date.now() - 1_000).toISOString() };
  assert.equal(
    validateKyberSwap({
      chain: 8453,
      context: expired,
      calls: [{ to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' }],
    }).success,
    false,
  );
});
