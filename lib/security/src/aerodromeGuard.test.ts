import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  AERODROME_BASE_ROUTER,
  decodeAerodromeSwapCalldata,
  validateAerodromeSwap,
  type AerodromeSwapContext,
} from './aerodromeGuard.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da';
const NOW = new Date('2026-07-27T10:00:00.000Z');
const EXPIRES = '2026-07-27T10:10:00.000Z';
const DEADLINE = BigInt(Math.floor(Date.parse(EXPIRES) / 1000));

const AMOUNT_IN = 1_000_000n; // 1 USDC
const MIN_OUT = 400_000_000_000_000n;

// ---------------------------------------------------------------------------
// A minimal, INDEPENDENT encoder.
//
// The guard must not be tested with the encoder it is meant to police: a
// shared bug would cancel out and every assertion below would pass on broken
// bytes. These few lines lay the words out by hand from the ABI spec.
// ---------------------------------------------------------------------------

const SELECTORS = {
  tokensForTokens: 'cac88ea9',
  ethForTokens: '903638a4',
  tokensForEth: 'c6b7f1b6',
  approve: '095ea7b3',
} as const;

function pad(value: string): string {
  return value.padStart(64, '0');
}
function addr(value: string): string {
  return pad(value.toLowerCase().replace(/^0x/, ''));
}
function uint(value: bigint): string {
  return pad(value.toString(16));
}

interface Leg {
  from: string;
  to: string;
  stable: boolean;
  factory: string;
}

function legWords(legs: Leg[]): string {
  return (
    uint(BigInt(legs.length)) +
    legs.map((leg) => addr(leg.from) + addr(leg.to) + uint(leg.stable ? 1n : 0n) + addr(leg.factory)).join('')
  );
}

function encodeTokensForTokens(o: {
  amountIn?: bigint;
  amountOutMin?: bigint;
  legs?: Leg[];
  to?: string;
  deadline?: bigint;
  selector?: string;
  offset?: bigint;
}): string {
  const legs = o.legs ?? [{ from: USDC, to: WETH, stable: false, factory: FACTORY }];
  return (
    `0x${o.selector ?? SELECTORS.tokensForTokens}` +
    uint(o.amountIn ?? AMOUNT_IN) +
    uint(o.amountOutMin ?? MIN_OUT) +
    uint(o.offset ?? 160n) +
    addr(o.to ?? WALLET) +
    uint(o.deadline ?? DEADLINE) +
    legWords(legs)
  );
}

function encodeEthForTokens(o: { amountOutMin?: bigint; legs?: Leg[]; to?: string; deadline?: bigint } = {}): string {
  const legs = o.legs ?? [{ from: WETH, to: USDC, stable: false, factory: FACTORY }];
  return (
    `0x${SELECTORS.ethForTokens}` +
    uint(o.amountOutMin ?? MIN_OUT) +
    uint(128n) +
    addr(o.to ?? WALLET) +
    uint(o.deadline ?? DEADLINE) +
    legWords(legs)
  );
}

function encodeApprove(spender: string, amount: bigint): string {
  return `0x${SELECTORS.approve}${addr(spender)}${uint(amount)}`;
}

function context(overrides: Partial<AerodromeSwapContext> = {}): AerodromeSwapContext {
  return {
    inputTokenAddress: USDC,
    inputIsNative: false,
    outputIsNative: false,
    amountInAtomic: AMOUNT_IN.toString(),
    minimumOutputAtomic: MIN_OUT.toString(),
    swapper: WALLET,
    recipient: WALLET,
    routerAddress: AERODROME_BASE_ROUTER,
    factory: FACTORY,
    route: [{ from: USDC, to: WETH, stable: false, factory: FACTORY }],
    expiresAt: EXPIRES,
    ...overrides,
  };
}

function run(calls: { to: string; value?: string; data?: string }[], ctx = context()) {
  return validateAerodromeSwap({ chain: 8453, calls, context: ctx, now: NOW });
}

const approveCall = { to: USDC, value: '0', data: encodeApprove(AERODROME_BASE_ROUTER, AMOUNT_IN) };
const swapCall = { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({}) };

describe('a volatile direct ERC-20 route', () => {
  test('is allowed with an exact approval', () => {
    const result = run([approveCall, swapCall]);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.semantics.hops, 1);
    assert.deepEqual(result.semantics.curves, ['volatile']);
    assert.equal(result.semantics.spendAmountRaw, AMOUNT_IN.toString());
    assert.deepEqual(result.semantics.recipients, [WALLET]);
    assert.equal(result.semantics.deadlineUnix, DEADLINE.toString());
  });

  test('is refused without one — an ERC-20 swap always carries its own approval', () => {
    const result = run([swapCall]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_approval_missing');
  });
});

describe('a stable direct route', () => {
  const legs = [{ from: USDC, to: WETH, stable: true, factory: FACTORY }];
  test('is allowed when the reviewed curve is stable too', () => {
    const result = run(
      [approveCall, { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ legs }) }],
      context({ route: legs }),
    );
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.semantics.curves, ['stable']);
  });

  test('is refused when the calldata flips the curve the user reviewed', () => {
    // Same pair, same factory, different pool. A stable-curve pool prices a
    // volatile pair completely differently, so this is a substitution.
    const result = run([
      approveCall,
      { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ legs }) },
    ]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_route_mismatch');
  });
});

describe('a two-hop route', () => {
  const INTERMEDIATE = '0x0000000000000000000000000000000000009999';
  const legs = [
    { from: USDC, to: INTERMEDIATE, stable: true, factory: FACTORY },
    { from: INTERMEDIATE, to: WETH, stable: false, factory: FACTORY },
  ];

  test('is allowed when both legs match and connect', () => {
    const result = run(
      [approveCall, { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ legs }) }],
      context({ route: legs }),
    );
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.semantics.hops, 2);
    assert.deepEqual(result.semantics.curves, ['stable', 'volatile']);
  });

  test('is refused when the legs do not connect', () => {
    const broken = [
      { from: USDC, to: INTERMEDIATE, stable: true, factory: FACTORY },
      { from: WETH, to: WETH, stable: false, factory: FACTORY },
    ];
    const result = run(
      [approveCall, { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ legs: broken }) }],
      context({ route: broken }),
    );
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_route_discontinuous');
  });

  test('refuses three hops outright, whatever the context claims', () => {
    const three = [
      { from: USDC, to: INTERMEDIATE, stable: false, factory: FACTORY },
      { from: INTERMEDIATE, to: WETH, stable: false, factory: FACTORY },
      { from: WETH, to: USDC, stable: false, factory: FACTORY },
    ];
    const result = run(
      [approveCall, { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ legs: three }) }],
      context({ route: three }),
    );
    assert.equal(result.success, false);
  });
});

describe('the things a wallet must never be handed', () => {
  test('a changed factory in the calldata', () => {
    const other = '0x0000000000000000000000000000000000001234';
    const legs = [{ from: USDC, to: WETH, stable: false, factory: other }];
    const result = run([approveCall, { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ legs }) }]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_route_mismatch');
  });

  test('a changed factory in the reviewed route itself', () => {
    const other = '0x0000000000000000000000000000000000001234';
    const legs = [{ from: USDC, to: WETH, stable: false, factory: other }];
    const result = run(
      [approveCall, { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ legs }) }],
      context({ route: legs }),
    );
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_route_factory_mismatch');
  });

  test('a weakened minimum output', () => {
    const result = run([
      approveCall,
      { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ amountOutMin: MIN_OUT - 1n }) },
    ]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_minimum_output_weakened');
  });

  test('a stronger minimum output is fine', () => {
    const result = run([
      approveCall,
      { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ amountOutMin: MIN_OUT + 1n }) },
    ]);
    assert.equal(result.success, true);
  });

  test('a recipient that is not the authenticated wallet', () => {
    const attacker = '0x2222222222222222222222222222222222222222';
    const result = run([
      approveCall,
      { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ to: attacker }) },
    ]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_recipient_mismatch');
  });

  test('a router that is not the pinned one', () => {
    const other = '0x3333333333333333333333333333333333333333';
    const result = run(
      [{ to: other, value: '0', data: encodeTokensForTokens({}) }],
      context({ routerAddress: other }),
    );
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_router_not_pinned');
  });

  test('a swap call sent to something other than the pinned router', () => {
    const other = '0x3333333333333333333333333333333333333333';
    const result = run([{ to: other, value: '0', data: encodeTokensForTokens({}) }]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_target_not_allowlisted');
  });

  test('an unlimited approval', () => {
    const unlimited = (1n << 256n) - 1n;
    const result = run([
      { to: USDC, value: '0', data: encodeApprove(AERODROME_BASE_ROUTER, unlimited) },
      swapCall,
    ]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_approval_not_exact');
  });

  test('an approval naming a spender that is not the Router', () => {
    const attacker = '0x2222222222222222222222222222222222222222';
    const result = run([{ to: USDC, value: '0', data: encodeApprove(attacker, AMOUNT_IN) }, swapCall]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_approval_spender_invalid');
  });

  test('an approval larger than the amount being swapped', () => {
    const result = run([
      { to: USDC, value: '0', data: encodeApprove(AERODROME_BASE_ROUTER, AMOUNT_IN + 1n) },
      swapCall,
    ]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_approval_not_exact');
  });

  test('a calldata input amount that disagrees with the stored intent', () => {
    const result = run([
      approveCall,
      { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ amountIn: AMOUNT_IN * 2n }) },
    ]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_amount_mismatch');
  });

  test('native value attached to an ERC-20 input swap', () => {
    const result = run([approveCall, { ...swapCall, value: '1' }]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_native_value_blocked');
  });

  test('a deadline that has already passed', () => {
    const past = BigInt(Math.floor(Date.parse('2026-07-27T09:00:00.000Z') / 1000));
    const result = run([
      approveCall,
      { to: AERODROME_BASE_ROUTER, value: '0', data: encodeTokensForTokens({ deadline: past }) },
    ]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_deadline_expired');
  });

  test('an expired quote window', () => {
    const result = run([approveCall, swapCall], context({ expiresAt: '2026-07-27T09:00:00.000Z' }));
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_quote_expired');
  });

  test('a third call nobody asked for', () => {
    const result = run([approveCall, swapCall, { to: WETH, value: '0', data: '0xdeadbeef' }]);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_batch_size_invalid');
  });

  test('a chain that is not Base mainnet', () => {
    const result = validateAerodromeSwap({ chain: 84532, calls: [approveCall, swapCall], context: context(), now: NOW });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_wrong_chain');
  });
});

describe('native ETH legs', () => {
  const ethContext = context({
    inputIsNative: true,
    inputTokenAddress: null,
    route: [{ from: WETH, to: USDC, stable: false, factory: FACTORY }],
  });

  test('an ETH input swap is allowed with matching value and no approval', () => {
    const result = run(
      [{ to: AERODROME_BASE_ROUTER, value: AMOUNT_IN.toString(), data: encodeEthForTokens() }],
      ethContext,
    );
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.semantics.spenders, []);
  });

  test('an ETH input swap whose value does not equal the intent is refused', () => {
    const result = run(
      [{ to: AERODROME_BASE_ROUTER, value: (AMOUNT_IN - 1n).toString(), data: encodeEthForTokens() }],
      ethContext,
    );
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_native_value_mismatch');
  });

  test('an ERC-20 entrypoint on a native-input intent is refused', () => {
    // Same route, same amounts — but swapExactTokensForTokens would try to
    // pull tokens the wallet is not spending, and the attached ETH would sit
    // in the Router.
    const result = run(
      [{ to: AERODROME_BASE_ROUTER, value: AMOUNT_IN.toString(), data: encodeTokensForTokens({ legs: ethContext.route }) }],
      ethContext,
    );
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_swap_function_mismatch');
  });

  test('an ERC-20 to ETH swap must use the ETH-output entrypoint', () => {
    const result = run(
      [approveCall, swapCall],
      context({ outputIsNative: true }),
    );
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, 'aerodrome_swap_function_mismatch');
  });

  test('an ERC-20 to ETH swap with the right entrypoint is allowed', () => {
    const data = `0x${SELECTORS.tokensForEth}${encodeTokensForTokens({}).slice(10)}`;
    const result = run([approveCall, { to: AERODROME_BASE_ROUTER, value: '0', data }], context({ outputIsNative: true }));
    assert.equal(result.success, true);
  });
});

describe('the decoder refuses what it cannot read', () => {
  test('an unknown selector', () => {
    assert.equal(decodeAerodromeSwapCalldata(`0xdeadbeef${'0'.repeat(64)}`), null);
  });

  test('a routes offset that does not point just past the head', () => {
    assert.equal(decodeAerodromeSwapCalldata(encodeTokensForTokens({ offset: 192n })), null);
  });

  test('trailing bytes after the last leg', () => {
    assert.equal(decodeAerodromeSwapCalldata(`${encodeTokensForTokens({})}${'0'.repeat(64)}`), null);
  });

  test('a stable flag that is neither 0 nor 1', () => {
    // Words: 0 amountIn, 1 amountOutMin, 2 offset, 3 to, 4 deadline,
    // 5 length, 6 leg.from, 7 leg.to, 8 leg.stable, 9 leg.factory.
    const body = encodeTokensForTokens({}).slice(10);
    const start = 8 * 64;
    assert.equal(BigInt(`0x${body.slice(start, start + 64)}`), 0n, 'word 8 is the curve flag');
    const tampered = `${body.slice(0, start)}${pad('2')}${body.slice(start + 64)}`;
    assert.equal(decodeAerodromeSwapCalldata(`0x${SELECTORS.tokensForTokens}${tampered}`), null);
  });

  test('an empty route', () => {
    assert.equal(decodeAerodromeSwapCalldata(encodeTokensForTokens({ legs: [] })), null);
  });

  test('a well-formed call decodes to exactly what was encoded', () => {
    const decoded = decodeAerodromeSwapCalldata(encodeTokensForTokens({}));
    assert.ok(decoded);
    assert.equal(decoded.kind, 'tokens_for_tokens');
    assert.equal(decoded.amountIn, AMOUNT_IN);
    assert.equal(decoded.amountOutMin, MIN_OUT);
    assert.equal(decoded.to, WALLET);
    assert.equal(decoded.deadline, DEADLINE);
    assert.deepEqual(decoded.route, [{ from: USDC, to: WETH, stable: false, factory: FACTORY }]);
  });
});
