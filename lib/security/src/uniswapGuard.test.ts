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

test('T56 Uniswap guard expiry check honors an injected clock deterministically', () => {
  // Both instants are years in the past relative to real wall time — only the
  // injected clock can make this pass; without it the same expiry still fails
  // (default wall-time behavior unchanged for existing callers).
  const frozenNow = new Date('2020-01-01T12:00:00.000Z');
  const fixedContext = { ...context(), expiresAt: '2020-01-01T12:01:00.000Z' };
  const calls = [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x12345678' }];
  assert.equal(validateUniswapSwap({ chain: 8453, context: fixedContext, calls, now: frozenNow }).success, true);
  const withoutClock = validateUniswapSwap({ chain: 8453, context: fixedContext, calls });
  assert.equal(withoutClock.success, false);
  if (!withoutClock.success) assert.equal(withoutClock.code, 'uniswap_quote_expired');
});

test('T47 Uniswap guard blocks unlimited approvals, foreign targets and native value', () => {
  const cases = [
    [{ to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(PERMIT2_ADDRESS, (1n << 256n) - 1n) }, { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x12345678' }],
    [{ to: '0x1111111111111111111111111111111111111111', value: '0', data: '0x12345678' }],
    [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '1', data: '0x12345678' }],
  ];
  for (const calls of cases) assert.equal(validateUniswapSwap({ chain: 8453, context: context(), calls }).success, false);
});

// ---------------------------------------------------------------------------
// Both directions. Uniswap always quoted and built ETH-in; only this guard and
// the adapter above it insisted on USDC. Widening it lets real native value
// into a batch for the first time, so these pin the value rule rather than the
// happy path: exactly the input amount, on the router call, and nowhere else.
// ---------------------------------------------------------------------------

const ONE_ETH_U = 1_000_000_000_000_000_000n;
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

function nativeContextU() {
  return { ...context(), amountDecimal: '1', inputToken: 'ETH' as const, outputToken: 'USDC' as const };
}

test('a native input attaches exactly its amount to the pinned Universal Router', () => {
  const result = validateUniswapSwap({
    chain: 8453,
    context: nativeContextU(),
    calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: ONE_ETH_U.toString(), data: '0x3593564c' }],
  });
  assert.equal(result.success, true);
  // Eighteen decimals, not USDC's six.
  if (result.success) assert.equal(result.semantics.spendAmountRaw, ONE_ETH_U.toString());
  if (result.success) assert.equal(result.semantics.spendAmountUsdc, 0);
});

test('a native input with the wrong attached value is refused', () => {
  for (const value of ['0', (ONE_ETH_U + 1n).toString()]) {
    const result = validateUniswapSwap({
      chain: 8453,
      context: nativeContextU(),
      calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value, data: '0x3593564c' }],
    });
    assert.equal(result.success, false, `value ${value} must be refused`);
  }
});

test('an ERC-20 input may attach no value at all', () => {
  const result = validateUniswapSwap({
    chain: 8453,
    context: context(),
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(PERMIT2_ADDRESS, 1_250_000n) },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '1', data: '0x3593564c' },
    ],
  });
  assert.equal(result.success, false);
});

test('a native input carrying an approval is refused', () => {
  const result = validateUniswapSwap({
    chain: 8453,
    context: nativeContextU(),
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(PERMIT2_ADDRESS, ONE_ETH_U) },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: ONE_ETH_U.toString(), data: '0x3593564c' },
    ],
  });
  assert.equal(result.success, false);
});

test('a WETH input approves WETH, not USDC', () => {
  const wethContext = { ...context(), amountDecimal: '1', inputToken: 'WETH' as const, outputToken: 'USDC' as const };
  const allowed = validateUniswapSwap({
    chain: 8453,
    context: wethContext,
    calls: [
      { to: WETH_ADDRESS, value: '0', data: approveData(PERMIT2_ADDRESS, ONE_ETH_U) },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' },
    ],
  });
  assert.equal(allowed.success, true);

  const wrongToken = validateUniswapSwap({
    chain: 8453,
    context: wethContext,
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(PERMIT2_ADDRESS, ONE_ETH_U) },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' },
    ],
  });
  assert.equal(wrongToken.success, false);
});

test('ETH to WETH is refused: a wrap is not a routed trade', () => {
  const result = validateUniswapSwap({
    chain: 8453,
    context: { ...context(), amountDecimal: '1', inputToken: 'ETH' as const, outputToken: 'WETH' as const },
    calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: ONE_ETH_U.toString(), data: '0x3593564c' }],
  });
  assert.equal(result.success, false);
});
