import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, type Hex } from 'viem';
import { canonicalUsdcForBaseChain } from './baseGuards.js';
import { BASE_UNISWAP_UNIVERSAL_ROUTER_2, PERMIT2_ADDRESS, validateUniswapSwap } from './uniswapGuard.js';
import {
  encodeUniswapExecuteV1,
  encodeUniswapV3PathV1,
  readUniswapExecuteV1,
  uniswapExecuteRecipientsV1,
  UNISWAP_BASE_WETH_V1 as WETH,
  UNISWAP_NATIVE_CURRENCY_V1 as NATIVE,
  type UniswapCommandV1,
  type UniswapRouterExpectationV1,
} from './uniswapRouterCalldata.js';
import { UNISWAP_API_TAGS_V1, UNISWAP_EXECUTE_2026_09_23 as REAL } from './fixtures/uniswapExecute20260923.js';

// ---------------------------------------------------------------------------
// The Universal Router call is read, not trusted by its address (audit SW-1,
// 2026-11-14). The audit's own probe, offline on the real guard: an execute()
// paying another address with no minimum, and one with an extra
// PERMIT2_TRANSFER_FROM taking 10 WETH, were both "allowed". These pin that
// they are refused, and that the shapes the Trading API builds still pass.
// ---------------------------------------------------------------------------

const WALLET = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
const ATTACKER = '0x000000000000000000000000000000000000beef';
const MSG_SENDER = '0x0000000000000000000000000000000000000001';
const ROUTER_ITSELF = '0x0000000000000000000000000000000000000002';
const USDC = canonicalUsdcForBaseChain(8453).toLowerCase();
const NVDA = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const DEADLINE = 4_000_000_000n;
const usdcToNvda = { wallet: WALLET, input: { kind: 'erc20', address: USDC }, output: { kind: 'erc20', address: NVDA }, amountInAtomic: 2_000_000n } as const;
const v3 = (patch: Partial<Extract<UniswapCommandV1, { command: 'V3_SWAP_EXACT_IN' }>> = {}): UniswapCommandV1 => ({
  command: 'V3_SWAP_EXACT_IN', recipient: MSG_SENDER, amountIn: 2_000_000n, amountOutMin: 990n, path: encodeUniswapV3PathV1([USDC, NVDA], [500]), payerIsUser: true, ...patch,
});
const read = (commands: UniswapCommandV1[], expected: UniswapRouterExpectationV1 = usdcToNvda) => readUniswapExecuteV1(encodeUniswapExecuteV1(commands, DEADLINE), expected);

test('an exact-input leg that pays the wallet is read, with the minimum the router enforces', () => {
  const reading = read([v3()]);
  assert.equal(reading.ok, true);
  if (reading.ok) assert.deepEqual([reading.guaranteedOutputAtomic, reading.minimumSources, reading.deadline], [990n, 1, DEADLINE]);
  // The wallet's own address works as well as the router's MSG_SENDER marker.
  assert.equal(read([v3({ recipient: WALLET })]).ok, true);
  assert.deepEqual(uniswapExecuteRecipientsV1(encodeUniswapExecuteV1([v3()], DEADLINE), WALLET), [WALLET]);
});

test('the audit probe: output paid to another address with no minimum is refused', () => {
  const reading = read([v3({ recipient: ATTACKER, amountOutMin: 0n })]);
  assert.deepEqual(reading.ok ? null : reading.code, 'uniswap_pays_another_address');
  // And the review is not told the wallet is paid: the recipient read from the bytes is the other address.
  assert.deepEqual(uniswapExecuteRecipientsV1(encodeUniswapExecuteV1([v3({ recipient: ATTACKER })], DEADLINE), WALLET), [ATTACKER]);
});

test('the audit probe: an extra PERMIT2_TRANSFER_FROM drawing another token is refused, and so is every other unread command', () => {
  const pull = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint160' }], [WETH as Hex, ATTACKER as Hex, 10n ** 19n]);
  const reading = read([v3(), { command: 'RAW', type: 0x02, input: pull }]);
  assert.deepEqual(reading.ok ? null : reading.code, 'uniswap_command_not_allowed');
  assert.match(reading.ok ? '' : reading.reason, /PERMIT2_TRANSFER_FROM/);
  for (const type of [0x01, 0x03, 0x09, 0x0a, 0x0d, 0x11, 0x12, 0x13, 0x14, 0x21, 0x07, 0x3f]) {
    const other = read([v3(), { command: 'RAW', type, input: '0x' }]);
    assert.deepEqual(other.ok ? null : other.code, 'uniswap_command_not_allowed', `command 0x${type.toString(16)}`);
  }
  // A command allowed to fail would let a minimum that fails be skipped.
  const allowRevert = read([{ command: 'RAW', type: 0x80, input: encodeUniswapExecuteV1([v3()], DEADLINE) }]);
  assert.deepEqual(allowRevert.ok ? null : allowRevert.code, 'uniswap_command_flag_not_allowed');
});

test('a leg that draws anything but the reviewed input from the wallet is refused', () => {
  const weth = read([v3({ path: encodeUniswapV3PathV1([WETH, NVDA], [500]) })]);
  assert.deepEqual(weth.ok ? null : weth.code, 'uniswap_pulls_another_token');
  const v2 = read([{ command: 'V2_SWAP_EXACT_IN', recipient: MSG_SENDER, amountIn: 2_000_000n, amountOutMin: 990n, path: [WETH, NVDA], payerIsUser: true }]);
  assert.deepEqual(v2.ok ? null : v2.code, 'uniswap_pulls_another_token');
  // More, or less, than the reviewed input.
  for (const amountIn of [2_000_001n, 1_999_999n]) {
    const reading = read([v3({ amountIn })]);
    assert.deepEqual(reading.ok ? null : reading.code, 'uniswap_input_amount_mismatch');
  }
  // Two legs that together draw exactly the input are one swap split across pools.
  const split = read([v3({ amountIn: 1_500_000n, amountOutMin: 700n }), v3({ amountIn: 500_000n, amountOutMin: 290n, path: encodeUniswapV3PathV1([USDC, WETH, NVDA], [500, 3000]) })]);
  assert.equal(split.ok, true);
  if (split.ok) assert.deepEqual([split.guaranteedOutputAtomic, split.minimumSources], [990n, 2]);
});

test('a leg that pays the wallet a token other than the reviewed output is refused', () => {
  const reading = read([v3({ path: encodeUniswapV3PathV1([USDC, WETH], [500]) })]);
  assert.deepEqual(reading.ok ? null : reading.code, 'uniswap_pays_another_token');
});

test('nothing guaranteed is refused: a minimum of zero, or output left in the router', () => {
  const zero = read([v3({ amountOutMin: 0n })]);
  assert.deepEqual(zero.ok ? null : zero.code, 'uniswap_minimum_missing');
  const kept = read([v3({ recipient: ROUTER_ITSELF })]);
  assert.deepEqual(kept.ok ? null : kept.code, 'uniswap_minimum_missing');
});

test('a router that custodies the output pays it on with a sweep to the wallet, and to no one else', () => {
  const custody = [v3({ recipient: ROUTER_ITSELF, amountOutMin: 0n })];
  const swept = read([...custody, { command: 'SWEEP', token: NVDA, recipient: MSG_SENDER, amount: 990n }]);
  assert.equal(swept.ok, true);
  if (swept.ok) assert.equal(swept.guaranteedOutputAtomic, 990n);
  for (const command of ['SWEEP', 'TRANSFER', 'PAY_PORTION'] as const) {
    const reading = read([...custody, { command, token: NVDA, recipient: ATTACKER, amount: 1n }, { command: 'SWEEP', token: NVDA, recipient: MSG_SENDER, amount: 990n }]);
    assert.deepEqual(reading.ok ? null : reading.code, 'uniswap_pays_another_address', command);
  }
  // A sweep with a minimum the router cannot read as uint160 is refused.
  const huge = read([...custody, { command: 'SWEEP', token: NVDA, recipient: MSG_SENDER, amount: 1n << 200n }]);
  assert.deepEqual(huge.ok ? null : huge.code, 'uniswap_command_input_invalid');
});

test('native ETH in: wrapped in the router, never drawn from the wallet; native ETH out: unwrapped to the wallet', () => {
  const ethToUsdc = { wallet: WALLET, input: { kind: 'native' }, output: { kind: 'erc20', address: USDC }, amountInAtomic: 10n ** 15n } as const;
  const wrapped = read([
    { command: 'WRAP_ETH', recipient: ROUTER_ITSELF, amount: 10n ** 15n },
    v3({ amountIn: 10n ** 15n, payerIsUser: false, path: encodeUniswapV3PathV1([WETH, USDC], [500]), amountOutMin: 1_800_000n }),
  ], ethToUsdc);
  assert.equal(wrapped.ok, true);
  // A wallet's WETH drawn through Permit2 in a native swap is not the ETH it sent.
  const drawn = read([v3({ amountIn: 10n ** 15n, payerIsUser: true, path: encodeUniswapV3PathV1([WETH, USDC], [500]) })], ethToUsdc);
  assert.deepEqual(drawn.ok ? null : drawn.code, 'uniswap_pulls_another_token');
  const usdcToEth = { wallet: WALLET, input: { kind: 'erc20', address: USDC }, output: { kind: 'native' }, amountInAtomic: 2_000_000n } as const;
  const unwrapped = read([
    v3({ recipient: ROUTER_ITSELF, amountOutMin: 0n, path: encodeUniswapV3PathV1([USDC, WETH], [500]) }),
    { command: 'UNWRAP_WETH', recipient: MSG_SENDER, amount: 5n * 10n ** 14n },
  ], usdcToEth);
  assert.equal(unwrapped.ok, true);
  if (unwrapped.ok) assert.equal(unwrapped.guaranteedOutputAtomic, 5n * 10n ** 14n);
  const elsewhere = read([
    v3({ recipient: ROUTER_ITSELF, amountOutMin: 0n, path: encodeUniswapV3PathV1([USDC, WETH], [500]) }),
    { command: 'UNWRAP_WETH', recipient: ATTACKER, amount: 5n * 10n ** 14n },
  ], usdcToEth);
  assert.deepEqual(elsewhere.ok ? null : elsewhere.code, 'uniswap_pays_another_address');
});

test('a v4 swap: settled from the wallet in the reviewed input only, taken to the wallet with the swap’s own minimum', () => {
  const swap = { action: 'SWAP_EXACT_IN_SINGLE', currency0: USDC, currency1: NVDA, fee: 500, tickSpacing: 10, hooks: NATIVE, zeroForOne: true, amountIn: 2_000_000n, amountOutMinimum: 990n } as const;
  const settled = read([{ command: 'V4_SWAP', actions: [swap, { action: 'SETTLE_ALL', currency: USDC, amount: 2_000_000n }, { action: 'TAKE_ALL', currency: NVDA, amount: 0n }] }]);
  assert.equal(settled.ok, true);
  if (settled.ok) assert.equal(settled.guaranteedOutputAtomic, 990n);
  // The SDK's open-delta form: SETTLE with the user paying, TAKE of the whole credit to the caller.
  const open = read([{ command: 'V4_SWAP', actions: [swap, { action: 'SETTLE', currency: USDC, amount: 0n, payerIsUser: true }, { action: 'TAKE', currency: NVDA, recipient: MSG_SENDER, amount: 0n }] }]);
  assert.equal(open.ok, true);
  if (open.ok) assert.equal(open.guaranteedOutputAtomic, 990n);
  const toAnother = read([{ command: 'V4_SWAP', actions: [swap, { action: 'SETTLE_ALL', currency: USDC, amount: 2_000_000n }, { action: 'TAKE', currency: NVDA, recipient: ATTACKER, amount: 0n }] }]);
  assert.deepEqual(toAnother.ok ? null : toAnother.code, 'uniswap_pays_another_address');
  const otherToken = read([{ command: 'V4_SWAP', actions: [{ ...swap, currency0: WETH, zeroForOne: true }, { action: 'SETTLE_ALL', currency: WETH, amount: 2_000_000n }, { action: 'TAKE_ALL', currency: NVDA, amount: 0n }] }]);
  assert.deepEqual(otherToken.ok ? null : otherToken.code, 'uniswap_pulls_another_token');
  // TAKE_PORTION (a fee) and the liquidity actions are not part of a Still swap.
  for (const type of [0x10, 0x00, 0x02, 0x08, 0x13]) {
    const reading = read([{ command: 'V4_SWAP', actions: [swap, { action: 'RAW', type, input: '0x' }] }]);
    assert.deepEqual(reading.ok ? null : reading.code, 'uniswap_v4_action_not_allowed', `action 0x${type.toString(16)}`);
  }
});

test('a call read one way here and another onchain is refused: dirty words, odd tails', () => {
  const clean = encodeUniswapExecuteV1([v3()], DEADLINE);
  assert.equal(readUniswapExecuteV1(clean, usdcToNvda).ok, true);
  const junk = readUniswapExecuteV1(`${clean}ab`, usdcToNvda);
  assert.deepEqual(junk.ok ? null : junk.code, 'uniswap_router_call_not_canonical');
  // One attribution suffix after the arguments is what a Builder Code looks like, and the router ignores it.
  const code = Buffer.from('bc_still').toString('hex');
  const suffixed = `${clean}${code}${(code.length / 2).toString(16).padStart(2, '0')}00${'8021'.repeat(8)}`;
  assert.equal(readUniswapExecuteV1(suffixed, usdcToNvda).ok, true);
  // A recipient word with dirty high bits: the router reads the whole word, viem the low twenty bytes.
  const legInput = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [MSG_SENDER as Hex, 2_000_000n, 990n, encodeUniswapV3PathV1([USDC, NVDA], [500]), true],
  );
  const dirty = `0x${'ff'.repeat(12)}${legInput.slice(26)}` as Hex;
  const reading = readUniswapExecuteV1(encodeUniswapExecuteV1([{ command: 'RAW', type: 0x00, input: dirty }], DEADLINE), usdcToNvda);
  assert.deepEqual(reading.ok ? null : reading.code, 'uniswap_command_input_invalid');
  assert.deepEqual(readUniswapExecuteV1('0x3593564c', usdcToNvda).ok ? null : 'refused', 'refused');
});

test('what the Trading API really builds is read: its own 22-byte tag after the arguments (audit SW-1, measured 2026-11-14)', () => {
  // The operator's real 2026-09-23 buy, wallet replaced: refused as "not canonical" before this rule.
  const expected = { wallet: REAL.wallet, input: { kind: 'erc20', address: REAL.input }, output: { kind: 'erc20', address: REAL.output }, amountInAtomic: REAL.amountInAtomic } as const;
  const real = readUniswapExecuteV1(REAL.data, expected);
  assert.equal(real.ok, true, real.ok ? '' : real.code);
  if (real.ok) assert.deepEqual([real.commands, real.guaranteedOutputAtomic, real.minimumSources, real.deadline], [[0x00], REAL.minimumAtomic, 1, REAL.deadline]);
  // The same bytes for another wallet, or for one unit more, are still refused.
  assert.deepEqual(((r) => (r.ok ? null : r.code))(readUniswapExecuteV1(REAL.data, { ...expected, wallet: ATTACKER })), 'uniswap_pays_another_address');
  assert.equal(readUniswapExecuteV1(REAL.data, { ...expected, amountInAtomic: REAL.amountInAtomic + 1n }).ok, false);
  // Every tag seen on Base, after a clean call, alone or before one attribution suffix.
  const clean = encodeUniswapExecuteV1([v3()], DEADLINE);
  const code = Buffer.from('bc_still').toString('hex');
  const attribution = `${code}${(code.length / 2).toString(16).padStart(2, '0')}00${'8021'.repeat(8)}`;
  for (const tag of UNISWAP_API_TAGS_V1) {
    assert.equal(readUniswapExecuteV1(`${clean}${tag}`, usdcToNvda).ok, true, tag);
    assert.equal(readUniswapExecuteV1(`${clean}${tag}${attribution}`, usdcToNvda).ok, true, tag);
  }
  const notCanonical = (tail: string) => {
    const reading = readUniswapExecuteV1(`${clean}${tail}`, usdcToNvda);
    return reading.ok ? null : reading.code;
  };
  const tag = UNISWAP_API_TAGS_V1[0];
  // Anything else behind the arguments is still refused: another word, a timestamp cut short, a tag grown past
  // 24 bytes after its timestamp, bytes after the attribution, a suffix whose length does not match.
  for (const tail of [`756e6979${tag.slice(8)}`, tag.slice(0, 20), `${tag}${'00'.repeat(15)}`, `${tag}${attribution}ab`, `${tag}${code}0900${'8021'.repeat(8)}`, `ab${tag}`]) {
    assert.equal(notCanonical(tail), 'uniswap_router_call_not_canonical', tail);
  }
});

// ---------------------------------------------------------------------------
// The guard, end to end: the review's minimum and the quote's deadline.
// ---------------------------------------------------------------------------

function approveData(spender: string, amount: bigint) {
  return `0x095ea7b3${spender.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}
const expiresAt = new Date(Date.now() + 60_000).toISOString();
const guardContext = {
  amountDecimal: '2',
  inputAsset: { kind: 'erc20', address: USDC, decimals: 6 } as const,
  outputAsset: { kind: 'erc20', address: NVDA, decimals: 18 } as const,
  swapper: WALLET,
  routerVersion: '2.0' as const,
  expiresAt,
  minimumOutputAtomic: '990',
};
const guard = (routerCall: string, context = guardContext) => validateUniswapSwap({ chain: 8453, context, calls: [
  { to: USDC, value: '0', data: approveData(PERMIT2_ADDRESS, 2_000_000n) },
  { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: routerCall },
] });

test('the guard holds the router call to the reviewed minimum and the quote’s deadline', () => {
  const deadline = BigInt(Math.floor(Date.parse(expiresAt) / 1000));
  const allowed = guard(encodeUniswapExecuteV1([v3()], deadline));
  assert.equal(allowed.success, true);
  if (allowed.success) {
    assert.deepEqual([allowed.semantics.guaranteedOutputRaw, allowed.semantics.recipients], ['990', [WALLET]]);
    assert.match(allowed.checks.join(' '), /Router calldata decoded/);
  }
  const below = guard(encodeUniswapExecuteV1([v3({ amountOutMin: 989n })], deadline));
  assert.deepEqual(below.success ? null : below.code, 'uniswap_minimum_below_review');
  // The audit's probe: a deadline of 2^255.
  const forever = guard(encodeUniswapExecuteV1([v3()], 1n << 255n));
  assert.deepEqual(forever.success ? null : forever.code, 'uniswap_deadline_invalid');
  const past = guard(encodeUniswapExecuteV1([v3()], BigInt(Math.floor(Date.now() / 1000) - 10)));
  assert.deepEqual(past.success ? null : past.code, 'uniswap_deadline_invalid');
  const attacker = guard(encodeUniswapExecuteV1([v3({ recipient: ATTACKER })], deadline));
  assert.deepEqual(attacker.success ? null : attacker.code, 'uniswap_pays_another_address');
});

test('the guard passes the API’s real router call with its tag, at a fresh deadline', () => {
  // Word 2 of the arguments is the deadline: the real bytes, tag and all, with only the deadline moved to now.
  const fresh = BigInt(Math.floor(Date.parse(expiresAt) / 1000));
  const data = `${REAL.data.slice(0, 10 + 128)}${fresh.toString(16).padStart(64, '0')}${REAL.data.slice(10 + 192)}`;
  const context = { ...guardContext, amountDecimal: '0.1', outputAsset: { kind: 'erc20', address: REAL.output, decimals: 18 } as const, swapper: REAL.wallet, minimumOutputAtomic: REAL.minimumAtomic.toString() };
  const result = validateUniswapSwap({ chain: 8453, context, calls: [
    { to: USDC, value: '0', data: approveData(PERMIT2_ADDRESS, REAL.amountInAtomic) },
    { to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data },
  ] });
  assert.equal(result.success, true, result.success ? '' : result.code);
  if (result.success) assert.deepEqual([result.semantics.guaranteedOutputRaw, result.semantics.recipients], [REAL.minimumAtomic.toString(), [REAL.wallet]]);
});
