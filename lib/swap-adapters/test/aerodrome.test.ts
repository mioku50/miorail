import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { RouteIntentV1 } from '@mioagent/route-domain';

import {
  AERODROME_ROUTER_V1,
  AERODROME_SELECTORS_V1,
  AERODROME_USDC_V1,
  AERODROME_WETH_V1,
  AerodromeSwapRouteAdapter,
  candidateRoutesV1,
  createAerodromeReaderV1,
  createDefaultSwapAdapters,
  decodeAddressV1,
  decodeUintArrayV1,
  encodeExactApproveV1,
  encodeGetAmountsOutV1,
  encodeSwapExactEthForTokensV1,
  encodeSwapExactTokensForEthV1,
  encodeSwapExactTokensForTokensV1,
  aerodromeSourceKeyV1,
  parseAerodromeSourceKeyV1,
  sameAerodromeRouteV1,
  getEligibleSwapAdapters,
  redactRpcTextV1,
  selectorV1,
  type AerodromeReaderV1,
} from '../src/index.js';
import { makeIntent, withProtocolConstraint } from './fixtures.js';

const FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da' as const;
const NOW = new Date('2026-07-27T10:00:00.000Z');

function reader(overrides: Partial<AerodromeReaderV1> = {}): AerodromeReaderV1 {
  return {
    async readDefaultFactory() {
      return { ok: true, value: FACTORY };
    },
    async readAmountsOut() {
      return { ok: false, reason: 'no_route' };
    },
    async readBlockNumber() {
      return '30000000';
    },
    async readAllowance() {
      return { ok: true, value: 0n };
    },
    ...overrides,
  };
}

describe('the ABI encoding is computed, not copied', () => {
  test('selectors match the canonical keccak of their signatures', () => {
    // Two independently known selectors, as a check that selectorV1 itself is
    // right. If this function were wrong every call would hit a different
    // method and revert in a way that looks like "no pool".
    assert.equal(selectorV1('transfer(address,uint256)'), 'a9059cbb');
    assert.equal(selectorV1('balanceOf(address)'), '70a08231');
    assert.equal(AERODROME_SELECTORS_V1.getAmountsOut.length, 8);
    assert.equal(AERODROME_SELECTORS_V1.defaultFactory.length, 8);
  });

  test('a one-hop call encodes to selector + amount + offset + length + one tuple', () => {
    const data = encodeGetAmountsOutV1(1_000_000n, [
      { from: AERODROME_USDC_V1, to: AERODROME_WETH_V1, stable: false, factory: FACTORY },
    ]);
    const body = data.slice(10);
    // 2 head words + 1 length word + 4 tuple words.
    assert.equal(body.length, 64 * 7);
    assert.equal(BigInt(`0x${body.slice(0, 64)}`), 1_000_000n);
    assert.equal(BigInt(`0x${body.slice(64, 128)}`), 64n, 'array offset');
    assert.equal(BigInt(`0x${body.slice(128, 192)}`), 1n, 'array length');
    assert.ok(body.slice(192, 256).endsWith(AERODROME_USDC_V1.slice(2)));
    assert.ok(body.slice(256, 320).endsWith(AERODROME_WETH_V1.slice(2)));
    assert.equal(BigInt(`0x${body.slice(320, 384)}`), 0n, 'stable=false');
    assert.ok(body.slice(384, 448).endsWith(FACTORY.slice(2)));
  });

  test('a two-hop call encodes both legs and the stable flag', () => {
    const data = encodeGetAmountsOutV1(5n, [
      { from: AERODROME_USDC_V1, to: AERODROME_WETH_V1, stable: true, factory: FACTORY },
      { from: AERODROME_WETH_V1, to: AERODROME_USDC_V1, stable: false, factory: FACTORY },
    ]);
    const body = data.slice(10);
    assert.equal(body.length, 64 * 11);
    assert.equal(BigInt(`0x${body.slice(128, 192)}`), 2n);
    assert.equal(BigInt(`0x${body.slice(320, 384)}`), 1n, 'first leg stable=true');
  });

  test('an empty route is refused rather than encoded', () => {
    assert.throws(() => encodeGetAmountsOutV1(1n, []), /at least one leg/);
  });

  test('uint256[] decoding rejects every malformed shape', () => {
    const word = (value: bigint) => value.toString(16).padStart(64, '0');
    const good = `0x${word(32n)}${word(2n)}${word(1000n)}${word(998n)}`;
    assert.deepEqual(decodeUintArrayV1(good), [1000n, 998n]);
    assert.equal(decodeUintArrayV1('0x'), null);
    assert.equal(decodeUintArrayV1('0xabc'), null);
    // Length claims more words than the payload holds.
    assert.equal(decodeUintArrayV1(`0x${word(32n)}${word(9n)}${word(1n)}`), null);
    // A zero-length array is not a quote.
    assert.equal(decodeUintArrayV1(`0x${word(32n)}${word(0n)}`), null);
  });

  test('address decoding refuses a dirty high word and the zero address', () => {
    const clean = `0x${'0'.repeat(24)}${FACTORY.slice(2)}`;
    assert.equal(decodeAddressV1(clean), FACTORY);
    assert.equal(decodeAddressV1(`0x${'1'.repeat(24)}${FACTORY.slice(2)}`), null);
    assert.equal(decodeAddressV1(`0x${'0'.repeat(64)}`), null);
    assert.equal(decodeAddressV1('0x1234'), null);
  });
});

describe('route enumeration', () => {
  test('direct pools come first, then the two-hop permutations', () => {
    const routes = candidateRoutesV1({ from: AERODROME_USDC_V1, to: AERODROME_WETH_V1, factory: FACTORY });
    assert.equal(routes[0]?.length, 1);
    assert.equal(routes[0]?.[0]?.stable, false);
    assert.equal(routes[1]?.[0]?.stable, true);
    // USDC and WETH are both intermediates, and neither may be the middle of a
    // route that already ends at it.
    assert.ok(routes.every((route) => route.length <= 2));
    assert.equal(routes.length, 2, 'no intermediate is left for a USDC/WETH pair');
  });

  test('a pair with a spare intermediate gets the two-hop routes', () => {
    const other = '0x1111111111111111111111111111111111111111' as const;
    const routes = candidateRoutesV1({ from: other, to: AERODROME_USDC_V1, factory: FACTORY });
    // 2 direct + 4 permutations through WETH.
    assert.equal(routes.length, 6);
    assert.ok(routes.slice(2).every((route) => route[0]?.to === AERODROME_WETH_V1));
  });

  test('a pair with itself yields nothing', () => {
    assert.deepEqual(candidateRoutesV1({ from: AERODROME_USDC_V1, to: AERODROME_USDC_V1, factory: FACTORY }), []);
  });
});

describe('the adapter quotes through the Router', () => {
  const intent = (): RouteIntentV1 => makeIntent();

  test('it asks every allowed route and keeps the best output', async () => {
    const asked: number[] = [];
    const adapter = new AerodromeSwapRouteAdapter({
      reader: reader({
        async readAmountsOut(input) {
          asked.push(input.route.length);
          // The stable pool prices better here; nothing in the adapter could
          // have known that in advance.
          if (input.route[0]?.stable === true) return { ok: true, value: [input.amountIn, 2_000n] };
          return { ok: true, value: [input.amountIn, 1_000n] };
        },
      }),
    });
    const result = await adapter.quote({
      intent: intent(),
      walletAddress: '0x1111111111111111111111111111111111111111',
      requestId: 'req-1',
      now: NOW,
    });
    assert.equal(result.outcome, 'quoted');
    if (result.outcome !== 'quoted') return;
    assert.equal(result.candidate.expectedOutput.amountAtomic, '2000');
    assert.equal(result.candidate.provider.id, 'aerodrome');
    assert.ok(asked.length >= 2, 'both curves are quoted');
  });

  test('a tie is won by the shorter route', async () => {
    const adapter = new AerodromeSwapRouteAdapter({
      reader: reader({
        async readAmountsOut(input) {
          return { ok: true, value: [input.amountIn, ...input.route.map(() => 1_000n)].slice(0, input.route.length + 1) };
        },
      }),
    });
    const result = await adapter.quote({
      intent: intent(),
      walletAddress: '0x1111111111111111111111111111111111111111',
      requestId: 'req-1',
      now: NOW,
    });
    assert.equal(result.outcome, 'quoted');
    if (result.outcome !== 'quoted') return;
    assert.equal(result.candidate.liquiditySources.length, 1, 'the one-hop route wins the tie');
  });

  test('price impact is reported as unmeasured rather than invented', async () => {
    const adapter = new AerodromeSwapRouteAdapter({
      reader: reader({
        async readAmountsOut(input) {
          return { ok: true, value: [input.amountIn, 1_000n] };
        },
      }),
    });
    const result = await adapter.quote({
      intent: intent(),
      walletAddress: '0x1111111111111111111111111111111111111111',
      requestId: 'req-1',
      now: NOW,
    });
    assert.equal(result.outcome, 'quoted');
    if (result.outcome !== 'quoted') return;
    assert.equal(result.candidate.priceImpact, null);
    assert.ok(result.candidate.trustMetadata.riskFlags.includes('price_impact_unmeasured'));
    // A direct contract read involves no aggregator.
    assert.equal(result.candidate.trustMetadata.usesExternalAggregators, false);
    assert.equal(result.candidate.trustMetadata.sourceIndependence, 'independent');
  });

  test('it claims no pool address it never read', async () => {
    const adapter = new AerodromeSwapRouteAdapter({
      reader: reader({
        async readAmountsOut(input) {
          return { ok: true, value: [input.amountIn, 1_000n] };
        },
      }),
    });
    const result = await adapter.quote({
      intent: intent(),
      walletAddress: '0x1111111111111111111111111111111111111111',
      requestId: 'req-1',
      now: NOW,
    });
    assert.equal(result.outcome, 'quoted');
    if (result.outcome !== 'quoted') return;
    // getAmountsOut returns amounts, not addresses. A CREATE2-derived pool
    // address here would assert something never observed.
    assert.deepEqual(result.evidence[0]?.pools, []);
    assert.ok(result.candidate.liquiditySources[0]?.protocol.startsWith('aerodrome-'));
    assert.equal(result.candidate.liquiditySources[0]?.poolAddress, null);
  });

  test('every route reverting is "no route", not a provider outage', async () => {
    const adapter = new AerodromeSwapRouteAdapter({ reader: reader() });
    const result = await adapter.quote({
      intent: intent(),
      walletAddress: '0x1111111111111111111111111111111111111111',
      requestId: 'req-1',
      now: NOW,
    });
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.outcome === 'unavailable' && result.errorCode, 'provider_no_route');
  });

  test('a broken endpoint is not reported as missing liquidity', async () => {
    const adapter = new AerodromeSwapRouteAdapter({
      reader: reader({
        async readAmountsOut() {
          return { ok: false, reason: 'rpc_timeout' };
        },
      }),
    });
    const result = await adapter.quote({
      intent: intent(),
      walletAddress: '0x1111111111111111111111111111111111111111',
      requestId: 'req-1',
      now: NOW,
    });
    assert.notEqual(result.outcome, 'quoted');
    assert.equal(result.outcome !== 'quoted' && result.errorCode, 'provider_unreachable');
  });

  test('no reader and no RPC URL is not_configured, and reaches nothing', async () => {
    const adapter = new AerodromeSwapRouteAdapter();
    const result = await adapter.quote({
      intent: intent(),
      walletAddress: '0x1111111111111111111111111111111111111111',
      requestId: 'req-1',
      now: NOW,
    });
    assert.equal(result.outcome, 'not_configured');
  });
});

describe('the RPC seam', () => {
  test('a revert is decoded as no_route rather than an error', async () => {
    const client = createAerodromeReaderV1({
      rpcUrl: 'https://rpc.invalid/key',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    });
    const result = await client.readAmountsOut({
      amountIn: 1n,
      route: [{ from: AERODROME_USDC_V1, to: AERODROME_WETH_V1, stable: false, factory: FACTORY }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'no_route');
  });

  test('a zero output is no_route, not a quote of nothing', async () => {
    const word = (value: bigint) => value.toString(16).padStart(64, '0');
    const client = createAerodromeReaderV1({
      rpcUrl: 'https://rpc.invalid/key',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${word(32n)}${word(2n)}${word(5n)}${word(0n)}` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    });
    const result = await client.readAmountsOut({
      amountIn: 5n,
      route: [{ from: AERODROME_USDC_V1, to: AERODROME_WETH_V1, stable: false, factory: FACTORY }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'no_route');
  });

  test('every call targets the pinned Router and nothing else', async () => {
    const targets: string[] = [];
    const client = createAerodromeReaderV1({
      rpcUrl: 'https://rpc.invalid/key',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        targets.push(String(body.params?.[0]?.to ?? ''));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
    await client.readDefaultFactory();
    await client.readAmountsOut({
      amountIn: 1n,
      route: [{ from: AERODROME_USDC_V1, to: AERODROME_WETH_V1, stable: false, factory: FACTORY }],
    });
    assert.deepEqual(new Set(targets), new Set([AERODROME_ROUTER_V1]));
  });

  test('an unset RPC URL never opens a socket', async () => {
    let called = false;
    const client = createAerodromeReaderV1({
      rpcUrl: '',
      fetchImpl: (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    const result = await client.readDefaultFactory();
    assert.equal(result.ok === false && result.reason, 'not_configured');
    assert.equal(called, false);
  });

  test('RPC text is redacted before it can be logged', () => {
    const redacted = redactRpcTextV1('failed calling https://base-mainnet.g.alchemy.com/v2/SECRETKEY now');
    assert.ok(!redacted.includes('SECRETKEY'));
    assert.ok(redacted.includes('<url>'));
  });
});

describe('the registry', () => {
  test('Routes registers released quote adapters before honest manifested providers', () => {
    const ids = createDefaultSwapAdapters().map((adapter) => adapter.id);
    assert.deepEqual(ids, [
      'uniswap',
      'kyberswap',
      'aerodrome',
      'o1-exchange',
      'hydrex',
      'balancer',
    ]);
  });

  test('a swap intent selects all three', () => {
    const selection = getEligibleSwapAdapters(makeIntent());
    assert.equal(selection.outcome, 'selected');
    assert.deepEqual(selection.adapters.map((adapter) => adapter.id), [
      'uniswap',
      'kyberswap',
      'aerodrome',
    ]);
  });

  test('an include_only constraint can pick Aerodrome alone', () => {
    const intent = withProtocolConstraint(makeIntent(), { mode: 'include_only', protocols: ['aerodrome'] });
    const selection = getEligibleSwapAdapters(intent);
    assert.deepEqual(selection.adapters.map((adapter) => adapter.id), ['aerodrome']);
  });

  test('an exclude constraint can drop it', () => {
    const intent = withProtocolConstraint(makeIntent(), { mode: 'exclude', protocols: ['aerodrome'] });
    const selection = getEligibleSwapAdapters(intent);
    assert.ok(!selection.adapters.some((adapter) => adapter.id === 'aerodrome'));
  });
});

describe('scope limits are refused, not attempted', () => {
  test('ETH → WETH is a wrap and has no pool to quote', async () => {
    let asked = false;
    const adapter = new AerodromeSwapRouteAdapter({
      reader: reader({
        async readAmountsOut() {
          asked = true;
          return { ok: false, reason: 'no_route' };
        },
      }),
    });
    const result = await adapter.quote({
      intent: makeIntent({ from: 'ETH', to: 'WETH' }),
      walletAddress: '0x1111111111111111111111111111111111111111',
      requestId: 'req-1',
      now: NOW,
    });
    assert.equal(result.outcome, 'unsupported');
    assert.equal(asked, false, 'a wrap must not be quoted as a pool');
  });
});

describe('execution is out of scope in this slice', () => {
  test('the adapter advertises no execution surface of its own', () => {
    // T67B ships the QUOTE path. Calldata, the approval branch and the
    // provider guard are the next slice. Until they exist the composer's own
    // provider allowlist rejects this candidate with `unsupported_provider`
    // (lib/transaction-composer/src/coordinator.ts) — a graceful refusal
    // rather than a swap built from the wrong router ABI.
    //
    // This asserts the adapter does not grow a build/execute method by
    // accident before that guard is widened to match.
    const adapter = new AerodromeSwapRouteAdapter() as unknown as Record<string, unknown>;
    for (const forbidden of ['build', 'buildSwap', 'execute', 'submit', 'encodeSwap']) {
      assert.equal(adapter[forbidden], undefined, `adapter must not expose ${forbidden} yet`);
    }
  });
});

// ---------------------------------------------------------------------------
// T67B.1 — swap encoding
// ---------------------------------------------------------------------------

describe('T67B.1 the swap encoders refuse what must never be signed', () => {
  const swapArgs = {
    amountIn: 1_000_000n,
    amountOutMin: 1n,
    routes: [{ from: AERODROME_USDC_V1, to: AERODROME_WETH_V1, stable: false, factory: FACTORY }],
    to: '0x1111111111111111111111111111111111111111' as const,
    deadline: 1_800_000_000n,
  };

  test('the three swap selectors are the keccak of their signatures', () => {
    assert.equal(
      AERODROME_SELECTORS_V1.swapExactTokensForTokens,
      selectorV1('swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)'),
    );
    assert.equal(
      AERODROME_SELECTORS_V1.swapExactETHForTokens,
      selectorV1('swapExactETHForTokens(uint256,(address,address,bool,address)[],address,uint256)'),
    );
    assert.equal(
      AERODROME_SELECTORS_V1.swapExactTokensForETH,
      selectorV1('swapExactTokensForETH(uint256,uint256,(address,address,bool,address)[],address,uint256)'),
    );
    // The one selector whose canonical value is public knowledge, as a check
    // that nothing above is self-confirming.
    assert.equal(`0x${AERODROME_SELECTORS_V1.approve}`, '0x095ea7b3');
  });

  test('a zero minimum output is refused — that is an unbounded-slippage swap', () => {
    assert.throws(() => encodeSwapExactTokensForTokensV1({ ...swapArgs, amountOutMin: 0n }), TypeError);
    assert.throws(() => encodeSwapExactEthForTokensV1({ ...swapArgs, amountOutMin: 0n }), TypeError);
    assert.throws(() => encodeSwapExactTokensForEthV1({ ...swapArgs, amountOutMin: 0n }), TypeError);
  });

  test('a zero input amount, a missing deadline and a three-hop route are refused', () => {
    assert.throws(() => encodeSwapExactTokensForTokensV1({ ...swapArgs, amountIn: 0n }), TypeError);
    assert.throws(() => encodeSwapExactTokensForTokensV1({ ...swapArgs, deadline: 0n }), TypeError);
    assert.throws(
      () =>
        encodeSwapExactTokensForTokensV1({
          ...swapArgs,
          routes: [...swapArgs.routes, ...swapArgs.routes, ...swapArgs.routes],
        }),
      TypeError,
    );
  });

  test('an unlimited approval is not encodable, because there is no such function', () => {
    // encodeExactApproveV1 takes an amount and writes it. The absence of an
    // "approve max" helper is the point: nothing in this integration can
    // produce one by calling the wrong overload.
    const data = encodeExactApproveV1(AERODROME_ROUTER_V1, 1_000_000n);
    assert.equal(BigInt(`0x${data.slice(74)}`), 1_000_000n);
    assert.throws(() => encodeExactApproveV1(AERODROME_ROUTER_V1, 0n), TypeError);
  });

  test('the ETH entrypoint has one fewer head word than the token entrypoints', () => {
    // The amount travels as msg.value, so it is not an argument. Getting this
    // wrong shifts every later word by 32 bytes.
    const tokens = encodeSwapExactTokensForTokensV1(swapArgs).slice(10);
    const eth = encodeSwapExactEthForTokensV1(swapArgs).slice(10);
    assert.equal(tokens.length - eth.length, 64);
    assert.equal(BigInt(`0x${tokens.slice(128, 192)}`), 160n, 'token head is five words');
    assert.equal(BigInt(`0x${eth.slice(64, 128)}`), 128n, 'ETH head is four words');
  });
});

describe('T67B.1 a route survives the Route Card as a source key', () => {
  test('a leg round-trips through its source key, factory and all', () => {
    const leg = { from: AERODROME_USDC_V1, to: AERODROME_WETH_V1, stable: true, factory: FACTORY };
    assert.deepEqual(parseAerodromeSourceKeyV1(aerodromeSourceKeyV1(leg)), leg);
  });

  test('a foreign or malformed key parses to null rather than to a guess', () => {
    assert.equal(parseAerodromeSourceKeyV1('uniswap:v3:0.05%'), null);
    assert.equal(parseAerodromeSourceKeyV1(`aerodrome:${FACTORY}:${AERODROME_USDC_V1}:${AERODROME_WETH_V1}:curve`), null);
    assert.equal(parseAerodromeSourceKeyV1(`aerodrome:${AERODROME_USDC_V1}:${AERODROME_WETH_V1}:stable`), null);
  });

  test('routes that differ only by curve or factory are not the same route', () => {
    const base = [{ from: AERODROME_USDC_V1, to: AERODROME_WETH_V1, stable: false, factory: FACTORY }];
    const other = '0x0000000000000000000000000000000000001234' as const;
    assert.equal(sameAerodromeRouteV1(base, [{ ...base[0]!, stable: true }]), false);
    assert.equal(sameAerodromeRouteV1(base, [{ ...base[0]!, factory: other }]), false);
    assert.equal(sameAerodromeRouteV1(base, [...base]), true);
  });
});

describe('T67B.1 the allowance read is honest about failure', () => {
  test('an unreadable allowance is a refusal, never a zero', async () => {
    const client = createAerodromeReaderV1({
      rpcUrl: 'https://rpc.example/key',
      fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xabc' })),
    });
    const result = await client.readAllowance({
      token: AERODROME_USDC_V1,
      owner: '0x1111111111111111111111111111111111111111',
      spender: AERODROME_ROUTER_V1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_response');
  });

  test('a well-formed allowance decodes', async () => {
    const client = createAerodromeReaderV1({
      rpcUrl: 'https://rpc.example/key',
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${(12345n).toString(16).padStart(64, '0')}` })),
    });
    const result = await client.readAllowance({
      token: AERODROME_USDC_V1,
      owner: '0x1111111111111111111111111111111111111111',
      spender: AERODROME_ROUTER_V1,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 12345n);
  });
});
