import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalUsdcForBaseChain } from './baseGuards.js';
import { KYBERSWAP_BASE_ROUTER, validateKyberSwap } from './kyberGuard.js';
import type { SwapGuardAssetV1 } from './swapAsset.js';

const WALLET = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

// A side is an asset, not a name.
const USDC_ASSET = {
  kind: 'erc20',
  address: canonicalUsdcForBaseChain(8453).toLowerCase(),
  decimals: 6,
} as const;
const ETH_ASSET = { kind: 'native' } as const;
const WETH_ASSET = { kind: 'erc20', address: WETH_ADDRESS, decimals: 18 } as const;

function context() {
  return {
    amountDecimal: '1.25',
    inputAsset: USDC_ASSET as SwapGuardAssetV1,
    outputAsset: ETH_ASSET as SwapGuardAssetV1,
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

test('T56 KyberSwap guard expiry check honors an injected clock deterministically', () => {
  // Both instants are years in the past relative to real wall time — only the
  // injected clock can make this pass, proving the check never falls back to
  // bare Date.now() when a clock is supplied.
  const frozenNow = new Date('2020-01-01T12:00:00.000Z');
  const fixedContext = { ...context(), expiresAt: '2020-01-01T12:01:00.000Z' };
  const calls = [{ to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' }];
  assert.equal(validateKyberSwap({ chain: 8453, context: fixedContext, calls, now: frozenNow }).success, true);
  // Without the injected clock the same past expiry must still fail (default
  // wall-time behavior unchanged for existing callers).
  const withoutClock = validateKyberSwap({ chain: 8453, context: fixedContext, calls });
  assert.equal(withoutClock.success, false);
  if (!withoutClock.success) assert.equal(withoutClock.code, 'kyberswap_quote_expired');
});

// ---------------------------------------------------------------------------
// Both directions. The USDC-in rule was this repo's, not KyberSwap's, and the
// console ranked three routes for `0.0001 ETH to USDC` before refusing at
// Review. Widening it moves real money in a new shape, so the value rule is
// what these pin: a native input attaches EXACTLY the input amount, to the
// router and nowhere else, and brings no approval with it.
// ---------------------------------------------------------------------------

const ONE_ETH = 1_000_000_000_000_000_000n;

function nativeContext() {
  return {
    ...context(),
    amountDecimal: '1',
    inputAsset: ETH_ASSET as SwapGuardAssetV1,
    outputAsset: USDC_ASSET as SwapGuardAssetV1,
  };
}

test('a native input attaches exactly its amount to the pinned router', () => {
  const result = validateKyberSwap({
    chain: 8453,
    context: nativeContext(),
    calls: [{ to: KYBERSWAP_BASE_ROUTER, value: ONE_ETH.toString(), data: '0x12345678' }],
  });
  assert.equal(result.success, true);
  // Eighteen decimals, not six: parsing an ETH amount as USDC would understate
  // it by twelve orders of magnitude, and every amount check compares to this.
  if (result.success) assert.equal(result.semantics.spendAmountRaw, ONE_ETH.toString());
  // A non-USDC input is not a dollar figure and must not be reported as one.
  if (result.success) assert.equal(result.semantics.spendAmountUsdc, 0);
});

test('a native input that attaches the wrong amount is refused', () => {
  for (const value of ['0', (ONE_ETH + 1n).toString(), (ONE_ETH / 2n).toString()]) {
    const result = validateKyberSwap({
      chain: 8453,
      context: nativeContext(),
      calls: [{ to: KYBERSWAP_BASE_ROUTER, value, data: '0x12345678' }],
    });
    assert.equal(result.success, false, `value ${value} must be refused`);
  }
});

test('value on anything but the router call is refused', () => {
  const result = validateKyberSwap({
    chain: 8453,
    context: nativeContext(),
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: ONE_ETH.toString(), data: approveData(KYBERSWAP_BASE_ROUTER, ONE_ETH) },
      { to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' },
    ],
  });
  assert.equal(result.success, false);
});

test('a native input carrying an approval is refused — there is nothing to approve', () => {
  const result = validateKyberSwap({
    chain: 8453,
    context: nativeContext(),
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(KYBERSWAP_BASE_ROUTER, ONE_ETH) },
      { to: KYBERSWAP_BASE_ROUTER, value: ONE_ETH.toString(), data: '0x12345678' },
    ],
  });
  assert.equal(result.success, false);
});

test('a WETH input approves WETH, and a USDC approval in that batch is refused', () => {
  const weth = WETH_ADDRESS;
  const wethContext = {
    ...context(),
    amountDecimal: '1',
    inputAsset: WETH_ASSET as SwapGuardAssetV1,
    outputAsset: USDC_ASSET as SwapGuardAssetV1,
  };
  const allowed = validateKyberSwap({
    chain: 8453,
    context: wethContext,
    calls: [
      { to: weth, value: '0', data: approveData(KYBERSWAP_BASE_ROUTER, ONE_ETH) },
      { to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' },
    ],
  });
  assert.equal(allowed.success, true);

  const wrongToken = validateKyberSwap({
    chain: 8453,
    context: wethContext,
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(KYBERSWAP_BASE_ROUTER, ONE_ETH) },
      { to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' },
    ],
  });
  assert.equal(wrongToken.success, false);
});

test('ETH to WETH is refused: a wrap is not a routed trade', () => {
  const result = validateKyberSwap({
    chain: 8453,
    context: {
      ...context(),
      amountDecimal: '1',
      inputAsset: ETH_ASSET as SwapGuardAssetV1,
      outputAsset: WETH_ASSET as SwapGuardAssetV1,
    },
    calls: [{ to: KYBERSWAP_BASE_ROUTER, value: ONE_ETH.toString(), data: '0x12345678' }],
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Any token, not three names — the same widening as the Uniswap guard, pinned
// separately because these two have drifted apart before (the USDC-only rule
// lived in four places and was fixed in one of them at a time).
// ---------------------------------------------------------------------------

const KYBER_MIO = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

test('an arbitrary ERC-20 input approves its own address at its own decimals', () => {
  const mioContext = {
    ...context(),
    amountDecimal: '10000',
    inputAsset: { kind: 'erc20', address: KYBER_MIO, decimals: 18 } as SwapGuardAssetV1,
    outputAsset: ETH_ASSET as SwapGuardAssetV1,
  };
  const amount = 10_000n * ONE_ETH;
  const allowed = validateKyberSwap({
    chain: 8453,
    context: mioContext,
    calls: [
      { to: KYBER_MIO, value: '0', data: approveData(KYBERSWAP_BASE_ROUTER, amount) },
      { to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' },
    ],
  });
  assert.equal(allowed.success, true);
  if (allowed.success) assert.equal(allowed.semantics.spendAmountRaw, amount.toString());
  if (allowed.success) assert.equal(allowed.semantics.spendAmountUsdc, 0);

  const wrongToken = validateKyberSwap({
    chain: 8453,
    context: mioContext,
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(KYBERSWAP_BASE_ROUTER, amount) },
      { to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' },
    ],
  });
  assert.equal(wrongToken.success, false);
});

test('a token claiming the pinned router address is refused outright', () => {
  const result = validateKyberSwap({
    chain: 8453,
    context: {
      ...context(),
      amountDecimal: '1',
      inputAsset: { kind: 'erc20', address: KYBERSWAP_BASE_ROUTER, decimals: 18 } as SwapGuardAssetV1,
      outputAsset: ETH_ASSET as SwapGuardAssetV1,
    },
    calls: [{ to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' }],
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.code, 'kyberswap_context_invalid');
});

test('an unusable asset is a refusal, never a default', () => {
  const broken: SwapGuardAssetV1[] = [
    { kind: 'erc20', address: '0x0000000000000000000000000000000000000000', decimals: 18 },
    { kind: 'erc20', address: 'MIO', decimals: 18 },
    { kind: 'erc20', address: KYBER_MIO, decimals: 1.5 },
    { kind: 'erc20', address: KYBER_MIO, decimals: 255 },
  ];
  for (const inputAsset of broken) {
    const result = validateKyberSwap({
      chain: 8453,
      context: { ...context(), amountDecimal: '1', inputAsset, outputAsset: ETH_ASSET as SwapGuardAssetV1 },
      calls: [{ to: KYBERSWAP_BASE_ROUTER, value: '0', data: '0x12345678' }],
    });
    assert.equal(result.success, false, JSON.stringify(inputAsset));
    if (!result.success) assert.equal(result.code, 'kyberswap_context_invalid');
  }
});
