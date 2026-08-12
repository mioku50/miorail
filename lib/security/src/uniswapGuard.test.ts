import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalUsdcForBaseChain } from './baseGuards.js';
import type { SwapGuardAssetV1 } from './swapAsset.js';
import {
  BASE_UNISWAP_UNIVERSAL_ROUTER_2,
  PERMIT2_ADDRESS,
  validateUniswapSwap,
} from './uniswapGuard.js';

const WALLET = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

// Each side is an asset, not a name. The three canonical ones are spelled out
// here so the tests below assert against the same addresses the guard derives
// its pins from.
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

function nativeContextU() {
  return {
    ...context(),
    amountDecimal: '1',
    inputAsset: ETH_ASSET as SwapGuardAssetV1,
    outputAsset: USDC_ASSET as SwapGuardAssetV1,
  };
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
  const wethContext = {
    ...context(),
    amountDecimal: '1',
    inputAsset: WETH_ASSET as SwapGuardAssetV1,
    outputAsset: USDC_ASSET as SwapGuardAssetV1,
  };
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
    context: {
      ...context(),
      amountDecimal: '1',
      inputAsset: ETH_ASSET as SwapGuardAssetV1,
      outputAsset: WETH_ASSET as SwapGuardAssetV1,
    },
    calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: ONE_ETH_U.toString(), data: '0x3593564c' }],
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Any token, not three names.
//
// The guard used to accept a side only if it was called 'USDC', 'ETH' or
// 'WETH'. That was never a safety check — it was a check on a NAME, and it
// capped the product at three assets. A side is now an address and a decimals,
// and every pin the guard had is derived from it. What these hold down is that
// widening the SET did not loosen any of the RULES.
// ---------------------------------------------------------------------------

const MIO = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const MIO_ASSET = { kind: 'erc20', address: MIO, decimals: 18 } as const;

function permit2ApproveData(token: string, spender: string, amount: bigint, expiry: bigint) {
  return (
    `0x87517c45${token.slice(2).padStart(64, '0')}${spender.slice(2).padStart(64, '0')}` +
    `${amount.toString(16).padStart(64, '0')}${expiry.toString(16).padStart(64, '0')}`
  );
}

test('an arbitrary ERC-20 input is approved by ITS address, and only its address', () => {
  const mioContext = {
    ...context(),
    amountDecimal: '10000',
    inputAsset: MIO_ASSET as SwapGuardAssetV1,
    outputAsset: ETH_ASSET as SwapGuardAssetV1,
  };
  const amount = 10_000n * ONE_ETH_U;
  const allowed = validateUniswapSwap({
    chain: 8453,
    context: mioContext,
    calls: [
      { to: MIO, value: '0', data: approveData(PERMIT2_ADDRESS, amount) },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' },
    ],
  });
  assert.equal(allowed.success, true);
  // Eighteen decimals came from the asset, not from a symbol lookup.
  if (allowed.success) assert.equal(allowed.semantics.spendAmountRaw, amount.toString());
  // Ten thousand of something is not ten thousand dollars.
  if (allowed.success) assert.equal(allowed.semantics.spendAmountUsdc, 0);

  // Approving a DIFFERENT token in the same batch is still a spend nobody
  // asked for, even when that token is the safest one on the chain.
  const wrongToken = validateUniswapSwap({
    chain: 8453,
    context: mioContext,
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(PERMIT2_ADDRESS, amount) },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' },
    ],
  });
  assert.equal(wrongToken.success, false);
});

test('a Permit2 approval must name the input token, whatever that token is', () => {
  const mioContext = {
    ...context(),
    amountDecimal: '1',
    inputAsset: MIO_ASSET as SwapGuardAssetV1,
    outputAsset: ETH_ASSET as SwapGuardAssetV1,
  };
  const expiry = BigInt(Math.floor(Date.parse(mioContext.expiresAt) / 1000));
  const withMio = validateUniswapSwap({
    chain: 8453,
    context: mioContext,
    calls: [
      { to: MIO, value: '0', data: approveData(PERMIT2_ADDRESS, ONE_ETH_U) },
      {
        to: PERMIT2_ADDRESS,
        value: '0',
        data: permit2ApproveData(MIO, BASE_UNISWAP_UNIVERSAL_ROUTER_2, ONE_ETH_U, expiry),
      },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' },
    ],
  });
  assert.equal(withMio.success, true);

  const withUsdc = validateUniswapSwap({
    chain: 8453,
    context: mioContext,
    calls: [
      { to: MIO, value: '0', data: approveData(PERMIT2_ADDRESS, ONE_ETH_U) },
      {
        to: PERMIT2_ADDRESS,
        value: '0',
        data: permit2ApproveData(
          canonicalUsdcForBaseChain(8453).toLowerCase(),
          BASE_UNISWAP_UNIVERSAL_ROUTER_2,
          ONE_ETH_U,
          expiry,
        ),
      },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' },
    ],
  });
  assert.equal(withUsdc.success, false);
});

test("the amount is parsed at the token's own decimals, not at eighteen either", () => {
  // Eight decimals — a real shape on Base (wrapped BTC), and the case where
  // assuming ETH's eighteen would overstate the approval by 1e10.
  const eightDecimals = {
    ...context(),
    amountDecimal: '2.5',
    inputAsset: { kind: 'erc20', address: MIO, decimals: 8 } as SwapGuardAssetV1,
    outputAsset: ETH_ASSET as SwapGuardAssetV1,
  };
  const result = validateUniswapSwap({
    chain: 8453,
    context: eightDecimals,
    calls: [
      { to: MIO, value: '0', data: approveData(PERMIT2_ADDRESS, 250_000_000n) },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' },
    ],
  });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.semantics.spendAmountRaw, '250000000');
});

test('a token claiming the router or Permit2 address is refused before any calldata is read', () => {
  // Otherwise the loop would read the router call as an approval — or the
  // approval as the router call — and the pins would check each other.
  for (const address of [BASE_UNISWAP_UNIVERSAL_ROUTER_2, PERMIT2_ADDRESS]) {
    const result = validateUniswapSwap({
      chain: 8453,
      context: {
        ...context(),
        amountDecimal: '1',
        inputAsset: { kind: 'erc20', address, decimals: 18 } as SwapGuardAssetV1,
        outputAsset: ETH_ASSET as SwapGuardAssetV1,
      },
      calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' }],
    });
    assert.equal(result.success, false, address);
    if (!result.success) assert.equal(result.code, 'uniswap_context_invalid');
  }
});

test('an unusable asset is a refusal, never a default', () => {
  const broken: SwapGuardAssetV1[] = [
    { kind: 'erc20', address: '0x0000000000000000000000000000000000000000', decimals: 18 },
    { kind: 'erc20', address: 'MIO', decimals: 18 },
    { kind: 'erc20', address: MIO, decimals: 1.5 },
    { kind: 'erc20', address: MIO, decimals: 255 },
    { kind: 'erc20', address: MIO, decimals: -1 },
  ];
  for (const inputAsset of broken) {
    const result = validateUniswapSwap({
      chain: 8453,
      context: { ...context(), amountDecimal: '1', inputAsset, outputAsset: ETH_ASSET as SwapGuardAssetV1 },
      calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' }],
    });
    assert.equal(result.success, false, JSON.stringify(inputAsset));
    if (!result.success) assert.equal(result.code, 'uniswap_context_invalid');
  }
});

test('the same token on both sides is refused, whatever its case', () => {
  const result = validateUniswapSwap({
    chain: 8453,
    context: {
      ...context(),
      amountDecimal: '1',
      inputAsset: MIO_ASSET as SwapGuardAssetV1,
      outputAsset: { kind: 'erc20', address: MIO.toUpperCase().replace('0X', '0x'), decimals: 18 } as SwapGuardAssetV1,
    },
    calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' }],
  });
  assert.equal(result.success, false);
});

test('a non-USDC input is reported as NOT a dollar figure', () => {
  // 0 dollars is the most dangerous value a budget cap can read, so the guard
  // says outright that the number is not money.
  const mio = validateUniswapSwap({
    chain: 8453,
    context: {
      ...context(),
      amountDecimal: '1',
      inputAsset: MIO_ASSET as SwapGuardAssetV1,
      outputAsset: ETH_ASSET as SwapGuardAssetV1,
    },
    calls: [
      { to: MIO, value: '0', data: approveData(PERMIT2_ADDRESS, ONE_ETH_U) },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x3593564c' },
    ],
  });
  assert.equal(mio.success, true);
  if (mio.success) assert.equal(mio.semantics.spendAmountIsUsd, false);

  const usdc = validateUniswapSwap({
    chain: 8453,
    context: context(),
    calls: [
      { to: canonicalUsdcForBaseChain(8453), value: '0', data: approveData(PERMIT2_ADDRESS, 1_250_000n) },
      { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x12345678' },
    ],
  });
  assert.equal(usdc.success, true);
  if (usdc.success) assert.equal(usdc.semantics.spendAmountIsUsd, true);
});
