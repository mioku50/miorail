import assert from 'node:assert/strict';
import test from 'node:test';
import type { RouteIntentV1 } from '@mioagent/route-domain';
import type { UniswapTradeTransport } from '@mioagent/swap-adapters';
import { validateUniswapSwap } from '@mioagent/security/uniswapGuard';
import { UniswapSwapBuildAdapter, narrowUniswapApprovalsV1 } from '../src/adapters/uniswap.js';
import { NOW, WALLET, WETH_BASE, makeIntent } from './fixtures.js';

const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43';

function transportOf(handlers: {
  quote?: (body: unknown) => { status: number; payload: unknown };
  swap?: (body: unknown) => { status: number; payload: unknown };
}): UniswapTradeTransport {
  return {
    async post(path, body) {
      if (path === '/v1/quote') {
        return (
          handlers.quote?.(body) ?? {
            status: 200,
            payload: {
              routing: 'CLASSIC',
              quote: { routing: 'CLASSIC', output: { amount: '38000000000000000' } },
            },
          }
        );
      }
      return (
        handlers.swap?.(body) ?? {
          status: 200,
          payload: {
            from: WALLET,
            chainId: 8453,
            requestId: 'swap-req-1',
            calls: [
              { to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', value: '0', data: '0x095ea7b3' },
              { to: ROUTER, value: '0', data: '0x12345678' },
            ],
          },
        }
      );
    },
  };
}

function buildInput(intent: RouteIntentV1, walletAddress: string = WALLET) {
  return {
    intent,
    selectedCandidate: null as never,
    walletAddress: walletAddress as `0x${string}`,
    now: NOW,
    requestId: 'req-1',
  };
}

test('Uniswap build adapter builds calls for USDC to ETH', async () => {
  const adapter = new UniswapSwapBuildAdapter({ transport: transportOf({}) });
  const result = await adapter.build(buildInput(makeIntent()));
  assert.equal(result.outcome, 'built');
  if (result.outcome === 'built') {
    assert.equal(result.routerAddress, ROUTER);
    assert.equal(result.calls.length, 2);
    // Build-side outputs come from the quote object fed into /swap_5792.
    assert.equal(result.expectedOutput.amountAtomic, '38000000000000000');
    // 50 bps intent slippage bound: 38e15 * 9950 / 10000.
    assert.equal(result.minimumOutput.amountAtomic, '37810000000000000');
  }
});

test('Uniswap build adapter honors an explicit zero slippage constraint (never autoSlippage)', async () => {
  let capturedQuoteBody: Record<string, unknown> | undefined;
  const adapter = new UniswapSwapBuildAdapter({
    transport: transportOf({
      quote: (body) => {
        capturedQuoteBody = body as Record<string, unknown>;
        return {
          status: 200,
          payload: { routing: 'CLASSIC', quote: { routing: 'CLASSIC', output: { amount: '38000000000000000' } } },
        };
      },
    }),
  });
  const result = await adapter.build(buildInput(makeIntent({ slippageBps: 0 })));
  assert.equal(result.outcome, 'built');
  if (result.outcome === 'built') {
    // 0 bps: minimum output must equal expected output exactly.
    assert.equal(result.minimumOutput.amountAtomic, result.expectedOutput.amountAtomic);
  }
  // The request carries the explicit stored-intent constraint — including 0 —
  // and never falls back to provider-chosen auto slippage.
  assert.equal(capturedQuoteBody?.slippageTolerance, 0);
  assert.equal(typeof capturedQuoteBody?.slippageTolerance, 'number');
  assert.equal('autoSlippage' in (capturedQuoteBody ?? {}), false);
});

test('Uniswap build adapter sends slippageTolerance as a JSON number, not a decimal string', async () => {
  // The defect this closes: this assertion used to read `'0'`, pinning the
  // string form. Every prepare on a Uniswap route was answered
  //   400 RequestValidationError: "slippageTolerance" must be a number
  // and the suite stayed green, because it checked the value and not the type
  // the provider actually validates. Comparing worked (the quote client sends
  // a number), so the failure only ever appeared at the Review step.
  let capturedQuoteBody: Record<string, unknown> | undefined;
  const adapter = new UniswapSwapBuildAdapter({
    transport: transportOf({
      quote: (body) => {
        capturedQuoteBody = body as Record<string, unknown>;
        return {
          status: 200,
          payload: { routing: 'CLASSIC', quote: { routing: 'CLASSIC', output: { amount: '38000000000000000' } } },
        };
      },
    }),
  });
  const result = await adapter.build(buildInput(makeIntent()));
  assert.equal(result.outcome, 'built');
  assert.equal(typeof capturedQuoteBody?.slippageTolerance, 'number');
  // 50 bps is 0.5 percent — JSON.stringify must emit `0.5`, never `"0.50"`.
  assert.equal(capturedQuoteBody?.slippageTolerance, 0.5);
  assert.match(JSON.stringify(capturedQuoteBody), /"slippageTolerance":0\.5(?!")/);
});

test('a refused Uniswap request names which of the two calls was refused', async () => {
  // One shared `uniswap_http_400` for both phases meant the code shown to the
  // user could not say whether the quote or the calldata build was rejected.
  const quoteRefused = await new UniswapSwapBuildAdapter({
    transport: transportOf({ quote: () => ({ status: 400, payload: { errorCode: 'RequestValidationError' } }) }),
  }).build(buildInput(makeIntent()));
  assert.equal(quoteRefused.outcome, 'unavailable');
  if (quoteRefused.outcome === 'unavailable') {
    assert.equal(quoteRefused.errorCode, 'uniswap_quote_http_400');
  }

  const swapRefused = await new UniswapSwapBuildAdapter({
    transport: transportOf({ swap: () => ({ status: 400, payload: { errorCode: 'RequestValidationError' } }) }),
  }).build(buildInput(makeIntent()));
  assert.equal(swapRefused.outcome, 'unavailable');
  if (swapRefused.outcome === 'unavailable') {
    assert.equal(swapRefused.errorCode, 'uniswap_swap_http_400');
  }
});

test('Uniswap build adapter rejects a quote response without a usable output amount', async () => {
  const adapter = new UniswapSwapBuildAdapter({
    transport: transportOf({
      quote: () => ({ status: 200, payload: { routing: 'CLASSIC', quote: { routing: 'CLASSIC' } } }),
    }),
  });
  const result = await adapter.build(buildInput(makeIntent()));
  assert.equal(result.outcome, 'invalid_response');
});

test('Uniswap build adapter builds calls for USDC to WETH', async () => {
  const adapter = new UniswapSwapBuildAdapter({ transport: transportOf({}) });
  const result = await adapter.build(buildInput(makeIntent({ toAsset: WETH_BASE })));
  assert.equal(result.outcome, 'built');
});

test('Uniswap build adapter rejects a wallet mismatch', async () => {
  const adapter = new UniswapSwapBuildAdapter({ transport: transportOf({}) });
  const intent = makeIntent();
  const result = await adapter.build(buildInput(intent, '0x2222222222222222222222222222222222222222'));
  assert.equal(result.outcome, 'rejected');
});

test('Uniswap build adapter rejects an unsupported chain', async () => {
  const adapter = new UniswapSwapBuildAdapter({ transport: transportOf({}) });
  const intent = { ...makeIntent(), chainId: 84532 } as unknown as RouteIntentV1;
  const result = await adapter.build(buildInput(intent));
  assert.equal(result.outcome, 'rejected');
});

test('Uniswap build adapter surfaces a malformed swap_5792 response as invalid_response', async () => {
  const adapter = new UniswapSwapBuildAdapter({
    transport: transportOf({ swap: () => ({ status: 200, payload: { from: WALLET, chainId: 8453 } }) }),
  });
  const result = await adapter.build(buildInput(makeIntent()));
  assert.equal(result.outcome, 'invalid_response');
});

test('a transport that throws becomes an unavailable outcome, never an exception', async () => {
  // What this closes: `partnerFetch` throws on DNS failure, a reset connection
  // or its own 10s timeout, and nothing between it and the Express handler
  // caught. One transient blip reached the user as a bare 500 whose only
  // record was an access-log line — the composer cannot report a refusal it
  // was never given. KyberSwap's build adapter has always answered
  // `kyberswap_routes_unreachable` here.
  const quoteThrew = await new UniswapSwapBuildAdapter({
    transport: {
      async post(path) {
        if (path === '/v1/quote') throw new TypeError('fetch failed');
        throw new Error('unreachable');
      },
    },
  }).build(buildInput(makeIntent()));
  assert.equal(quoteThrew.outcome, 'unavailable');
  if (quoteThrew.outcome === 'unavailable') {
    assert.equal(quoteThrew.errorCode, 'uniswap_quote_unreachable');
    assert.equal(quoteThrew.retryable, true);
  }

  const swapThrew = await new UniswapSwapBuildAdapter({
    transport: {
      async post(path, body) {
        if (path === '/v1/quote') return transportOf({}).post(path, body);
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      },
    },
  }).build(buildInput(makeIntent()));
  assert.equal(swapThrew.outcome, 'unavailable');
  if (swapThrew.outcome === 'unavailable') {
    assert.equal(swapThrew.errorCode, 'uniswap_swap_unreachable');
  }
});

test('Uniswap build adapter is not_configured without an API key or transport override', async () => {
  const previous = process.env.UNISWAP_API_KEY;
  delete process.env.UNISWAP_API_KEY;
  try {
    const adapter = new UniswapSwapBuildAdapter();
    const result = await adapter.build(buildInput(makeIntent()));
    assert.equal(result.outcome, 'not_configured');
  } finally {
    if (previous !== undefined) process.env.UNISWAP_API_KEY = previous;
  }
});

// ---------------------------------------------------------------------------
// 2026-09-06 — the flag that removed the permit.
//
// `generatePermitAsTransaction: true` on the QUOTE request suppresses the
// permit instead of emitting it. Measured against the live API with the same
// body: with the flag, `permitData: false` and a batch of one call; without it,
// two — `Permit2.approve` then the swap. A wallet whose standing Permit2
// allowance had expired therefore signed a batch that could not pull its own
// USDC, and the bundler reported the revert as "failed to estimate gas".
//
// Pinned as the request body, because that is where the defect lived: every
// call downstream was correct about the calls it was given.
// ---------------------------------------------------------------------------
test('the quote request asks for an exact permit and never suppresses it', async () => {
  const captured: { body: Record<string, unknown> | null } = { body: null };
  const adapter = new UniswapSwapBuildAdapter({
    transport: transportOf({
      quote: (body) => {
        captured.body = body as Record<string, unknown>;
        return {
          status: 200,
          payload: {
            routing: 'CLASSIC',
            quote: { routing: 'CLASSIC', output: { amount: '38000000000000000' } },
          },
        };
      },
    }),
  });
  const result = await adapter.build(buildInput(makeIntent({ toAsset: WETH_BASE })));
  assert.equal(result.outcome, 'built');
  assert.ok(captured.body);
  // The permit must be written for exactly the input amount: the Safety Kernel
  // refuses any approval that is not the stored intent amount, so a permit for
  // 2^160-1 would trade one refusal for another.
  assert.equal(captured.body.permitAmount, 'EXACT');
  assert.ok(
    !('generatePermitAsTransaction' in captured.body),
    'the quote request must not carry generatePermitAsTransaction — there it removes the permit',
  );
});

test('a batch carrying a Permit2 approval beside the swap is built, not refused', async () => {
  const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
  const adapter = new UniswapSwapBuildAdapter({
    transport: transportOf({
      swap: () => ({
        status: 200,
        payload: {
          from: WALLET,
          chainId: 8453,
          requestId: 'swap-req-permit',
          calls: [
            { to: PERMIT2, value: '0', data: '0x87517c45' },
            { to: ROUTER, value: '0', data: '0x12345678' },
          ],
        },
      }),
    }),
  });
  const result = await adapter.build(buildInput(makeIntent({ toAsset: WETH_BASE })));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.calls.length, 2);
  // Exactly one call goes to the pinned router; the other is the permit.
  assert.equal(result.calls.filter((call) => call.to.toLowerCase() === ROUTER).length, 1);
  assert.equal(result.calls[0]!.to.toLowerCase(), PERMIT2);
});

test('the real transport asks the Trading API for the pinned router, on both requests', async () => {
  // 2026-09-23: with no version header the API built every swap for
  // UniversalRouterV2_1_2 (0xd6145b2D…9c40) and each one was refused as
  // `uniswap_router_not_pinned`. The tests above hand in their own transport,
  // so the headers the production transport sends were never looked at.
  const seen: { url: string; version: string | null }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), version: headers.get('x-universal-router-version') });
    const quote = String(url).endsWith('/v1/quote');
    return new Response(
      JSON.stringify(
        quote
          ? { routing: 'CLASSIC', quote: { routing: 'CLASSIC', output: { amount: '38000000000000000' } } }
          : {
              from: WALLET,
              chainId: 8453,
              requestId: 'swap-req-1',
              calls: [{ to: ROUTER, value: '0', data: '0x3593564c' }],
            },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const result = await new UniswapSwapBuildAdapter({ apiKey: 'test-key', fetchImpl }).build(buildInput(makeIntent()));
  assert.equal(result.outcome, 'built');
  assert.deepEqual(
    seen.map((row) => [row.url.replace('https://trade-api.gateway.uniswap.org', ''), row.version]),
    [
      ['/v1/quote', '2.0'],
      ['/v1/swap_5792', '2.0'],
    ],
  );
});

test('a batch addressed to a router this adapter did not pin is still refused', async () => {
  // Asking for 2.0 is a request, not a guarantee; the pin is what decides.
  const adapter = new UniswapSwapBuildAdapter({
    transport: transportOf({
      swap: () => ({
        status: 200,
        payload: {
          from: WALLET,
          chainId: 8453,
          requestId: 'swap-req-1',
          calls: [{ to: '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40', value: '0', data: '0x3593564c' }],
        },
      }),
    }),
  });
  const result = await adapter.build(buildInput(makeIntent()));
  assert.equal(result.outcome === 'router_mismatch' && result.errorCode, 'uniswap_router_not_pinned');
});

// ---------------------------------------------------------------------------
// 2026-09-23 — the approvals Uniswap writes, and the ones the kernel accepts.
// ---------------------------------------------------------------------------

const PERMIT2_V1 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const word = (value: bigint | string) =>
  (typeof value === 'string' ? value.replace(/^0x/, '').toLowerCase() : value.toString(16)).padStart(64, '0');
const approveCall = (spender: string, amount: bigint) => ({
  to: USDC_V1,
  value: '0',
  data: `0x095ea7b3${word(spender)}${word(amount)}`,
});
const permitCall = (token: string, spender: string, amount: bigint, expiration: bigint) => ({
  to: PERMIT2_V1,
  value: '0',
  data: `0x87517c45${word(token)}${word(spender)}${word(amount)}${word(expiration)}`,
});
const MAX_UINT256 = (1n << 256n) - 1n;
const NOW_SEC = BigInt(Math.floor(NOW.getTime() / 1000));
const QUOTE_EXPIRY = new Date(NOW.getTime() + 10 * 60_000).toISOString();
// What swap_5792 returned for a wallet with no Permit2 allowance, in shape.
const AS_UNISWAP_WROTE_IT = [
  approveCall(PERMIT2_V1, MAX_UINT256),
  permitCall(USDC_V1, ROUTER, 100_000_000n, NOW_SEC + 30n * 86_400n),
  { to: ROUTER, value: '0', data: '0x3593564c' },
];
const guardFor = (calls: { to: string; value: string; data: string }[]) =>
  validateUniswapSwap({
    chain: 8453,
    calls,
    context: {
      amountDecimal: '100',
      inputAsset: { kind: 'erc20', address: USDC_V1, decimals: 6 },
      outputAsset: { kind: 'native' },
      swapper: WALLET,
      routerVersion: '2.0',
      expiresAt: QUOTE_EXPIRY,
    },
    now: NOW,
  });

test('the batch as Uniswap wrote it is refused by the guard — that was every web Uniswap route', () => {
  const refused = guardFor(AS_UNISWAP_WROTE_IT);
  assert.equal(refused.success, false);
  assert.equal(!refused.success && refused.code, 'uniswap_approval_not_exact');
  // Even with the unlimited approve gone, the 30-day permit is refused.
  const permitOnly = guardFor(AS_UNISWAP_WROTE_IT.slice(1));
  assert.equal(!permitOnly.success && permitOnly.code, 'uniswap_permit2_not_exact');
});

test('the adapter narrows both approvals to this swap, and the guard accepts the result', async () => {
  const adapter = new UniswapSwapBuildAdapter({
    transport: transportOf({
      swap: () => ({
        status: 200,
        payload: { from: WALLET, chainId: 8453, requestId: 'swap-req-narrow', calls: AS_UNISWAP_WROTE_IT },
      }),
    }),
  });
  const result = await adapter.build(buildInput(makeIntent()));
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.quoteExpiry, QUOTE_EXPIRY);
  const expirySec = BigInt(Math.floor(Date.parse(QUOTE_EXPIRY) / 1000));
  assert.deepEqual(
    result.calls.map((call) => call.data),
    [
      approveCall(PERMIT2_V1, 100_000_000n).data,
      permitCall(USDC_V1, ROUTER, 100_000_000n, expirySec).data,
      '0x3593564c',
    ],
  );
  assert.equal(guardFor(result.calls as never).success, true);
});

test('only approvals that already name the input token and an accepted spender are touched', () => {
  const OTHER_ROUTER = '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40';
  const OTHER_TOKEN = '0x4200000000000000000000000000000000000006';
  const untouched = [
    approveCall(OTHER_ROUTER, MAX_UINT256),
    permitCall(USDC_V1, OTHER_ROUTER, MAX_UINT256, NOW_SEC + 86_400n),
    permitCall(OTHER_TOKEN, ROUTER, MAX_UINT256, NOW_SEC + 86_400n),
    { to: ROUTER, value: '0', data: '0x3593564c' },
  ];
  const narrowed = narrowUniswapApprovalsV1(untouched, {
    inputToken: USDC_V1,
    amountAtomic: '100000000',
    expiresAtSec: Number(NOW_SEC) + 600,
  });
  // Left exactly as written, for the kernel to refuse.
  assert.deepEqual(narrowed, untouched);
  // An expiry already inside the quote is not moved later.
  const early = permitCall(USDC_V1, ROUTER, 100_000_000n, NOW_SEC + 60n);
  assert.deepEqual(
    narrowUniswapApprovalsV1([early], { inputToken: USDC_V1, amountAtomic: '100000000', expiresAtSec: Number(NOW_SEC) + 600 }),
    [early],
  );
  // A native input approves nothing, so nothing is rewritten.
  assert.deepEqual(
    narrowUniswapApprovalsV1(AS_UNISWAP_WROTE_IT, { inputToken: null, amountAtomic: '1', expiresAtSec: 1 }),
    AS_UNISWAP_WROTE_IT,
  );
});

