import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalUsdcForBaseChain } from './baseGuards.js';
import { KYBERSWAP_BASE_ROUTER, validateKyberSwap } from './kyberGuard.js';
import { encodeKyberSwapV1, kyberSwapRecipientV1, KYBERSWAP_NATIVE_TOKEN_V1 as ETH, readKyberSwapV1 } from './kyberRouterCalldata.js';
import { KYBERSWAP_ROUTE_BUILD_2026_11_14 } from './fixtures/kyberswapRouteBuild20261114.js';

// ---------------------------------------------------------------------------
// The KyberSwap router call is read, not trusted by its address (audit SW-1,
// 2026-11-14). The router draws desc.srcToken from the caller, pays
// desc.dstReceiver, takes fees for desc.feeReceivers and enforces
// desc.minReturnAmount (MetaAggregationRouterV2, Sourcify full match).
// ---------------------------------------------------------------------------

const recorded = KYBERSWAP_ROUTE_BUILD_2026_11_14;
const BURN = '0x000000000000000000000000000000000000dead';
const WALLET = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
const ATTACKER = '0x000000000000000000000000000000000000beef';
const USDC = canonicalUsdcForBaseChain(8453).toLowerCase();
const NVDA = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const expected = { wallet: WALLET, inputToken: USDC, outputToken: NVDA, amountInAtomic: 2_000_000n };
const call = (patch: Partial<Parameters<typeof encodeKyberSwapV1>[0]> = {}) =>
  encodeKyberSwapV1({ srcToken: USDC, dstToken: NVDA, dstReceiver: WALLET, amount: 2_000_000n, minReturnAmount: 990n, ...patch });

test('live route/build answers read exactly, as KyberSwap encodes them', () => {
  assert.equal(recorded.usdcToWeth.routerAddress, KYBERSWAP_BASE_ROUTER);
  const usdc = readKyberSwapV1(recorded.usdcToWeth.data, { wallet: BURN, inputToken: recorded.usdcToWeth.tokenIn, outputToken: recorded.usdcToWeth.tokenOut, amountInAtomic: BigInt(recorded.usdcToWeth.amountIn) });
  assert.deepEqual(usdc, { ok: true, function: 'swap', minReturnAtomic: 1051846297156668n, dstReceiver: BURN });
  // Native ETH in, as the router names it.
  const eth = readKyberSwapV1(recorded.ethToUsdc.data, { wallet: BURN, inputToken: null, outputToken: recorded.ethToUsdc.tokenOut, amountInAtomic: BigInt(recorded.ethToUsdc.amountIn) });
  assert.deepEqual(eth, { ok: true, function: 'swap', minReturnAtomic: 1883018n, dstReceiver: BURN });
  assert.equal(kyberSwapRecipientV1(recorded.usdcToWeth.data), BURN);
  // The same live call, for any other wallet, pays someone else.
  const other = readKyberSwapV1(recorded.usdcToWeth.data, { wallet: WALLET, inputToken: recorded.usdcToWeth.tokenIn, outputToken: recorded.usdcToWeth.tokenOut, amountInAtomic: 2_000_000n });
  assert.deepEqual(other.ok ? null : other.code, 'kyberswap_pays_another_address');
});

test('another receiver, another token drawn or bought, another amount: refused', () => {
  const cases: Array<[Partial<Parameters<typeof encodeKyberSwapV1>[0]>, string]> = [
    [{ dstReceiver: ATTACKER }, 'kyberswap_pays_another_address'],
    // The router draws srcToken from the caller: another token the wallet approved to it.
    [{ srcToken: '0x4200000000000000000000000000000000000006' }, 'kyberswap_pulls_another_token'],
    [{ srcToken: ETH }, 'kyberswap_pulls_another_token'],
    [{ dstToken: USDC }, 'kyberswap_pays_another_token'],
    [{ amount: 2_000_001n, srcAmounts: [2_000_001n] }, 'kyberswap_input_amount_mismatch'],
    [{ minReturnAmount: 0n }, 'kyberswap_minimum_missing'],
    [{ feeReceivers: [ATTACKER], feeAmounts: [1n] }, 'kyberswap_fee_not_allowed'],
    [{ permit: `0x${'11'.repeat(224)}` }, 'kyberswap_permit_not_allowed'],
    [{ flags: 0x201n }, 'kyberswap_partial_fill_not_allowed'],
    [{ flags: 0x202n }, 'kyberswap_extra_eth_not_allowed'],
    [{ srcAmounts: [1_500_000n, 600_000n], srcReceivers: [ATTACKER, ATTACKER] }, 'kyberswap_source_split_invalid'],
    [{ targetData: '0x' }, 'kyberswap_router_call_undecodable'],
  ];
  for (const [patch, code] of cases) {
    const reading = readKyberSwapV1(call(patch), expected);
    assert.deepEqual(reading.ok ? null : reading.code, code, JSON.stringify(patch, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  }
  assert.equal(readKyberSwapV1(call(), expected).ok, true);
  // Flags the router does not read (KyberSwap sets 0x200) change nothing it enforces.
  assert.equal(readKyberSwapV1(call({ flags: 0x220n }), expected).ok, true);
});

test('bytes the arguments do not explain are refused; one attribution suffix is not', () => {
  const clean = call();
  assert.deepEqual(readKyberSwapV1(`${clean}ab`, expected).ok, false);
  const code = Buffer.from('bc_still').toString('hex');
  assert.equal(readKyberSwapV1(`${clean}${code}${(code.length / 2).toString(16).padStart(2, '0')}00${'8021'.repeat(8)}`, expected).ok, true);
  assert.equal(readKyberSwapV1('0x12345678', expected).ok, false);
});

test('the guard holds the router call to the reviewed minimum, and says what it read', () => {
  const context = { amountDecimal: '2', inputAsset: { kind: 'erc20', address: USDC, decimals: 6 } as const, outputAsset: { kind: 'erc20', address: NVDA, decimals: 18 } as const,
    swapper: WALLET, recipient: WALLET, routerAddress: KYBERSWAP_BASE_ROUTER, expiresAt: new Date(Date.now() + 60_000).toISOString(), minimumOutputAtomic: '990' };
  const approve = `0x095ea7b3${KYBERSWAP_BASE_ROUTER.slice(2).padStart(64, '0')}${(2_000_000n).toString(16).padStart(64, '0')}`;
  const run = (data: string) => validateKyberSwap({ chain: 8453, context, calls: [{ to: USDC, value: '0', data: approve }, { to: KYBERSWAP_BASE_ROUTER, value: '0', data }] });
  const allowed = run(call());
  assert.equal(allowed.success, true);
  if (allowed.success) {
    assert.equal(allowed.semantics.guaranteedOutputRaw, '990');
    assert.match(allowed.checks.join(' '), /Router calldata decoded/);
  }
  const below = run(call({ minReturnAmount: 989n }));
  assert.deepEqual(below.success ? null : below.code, 'kyberswap_minimum_below_review');
  const attacker = run(call({ dstReceiver: ATTACKER }));
  assert.deepEqual(attacker.success ? null : attacker.code, 'kyberswap_pays_another_address');
});
