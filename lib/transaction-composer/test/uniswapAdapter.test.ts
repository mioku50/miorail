import assert from 'node:assert/strict';
import test from 'node:test';
import type { RouteIntentV1 } from '@mioagent/route-domain';
import type { UniswapTradeTransport } from '@mioagent/swap-adapters';
import { UniswapSwapBuildAdapter } from '../src/adapters/uniswap.js';
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
