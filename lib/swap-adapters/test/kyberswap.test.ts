import assert from 'node:assert/strict';
import test from 'node:test';
import { KyberSwapRouteAdapter } from '../src/index.js';
import {
  KYBERSWAP_BASE_ROUTER,
  KYBERSWAP_NATIVE_ETH,
  NOW,
  WALLET,
  kyberResponse,
  makeIntent,
  mockKyberExecutor,
} from './fixtures.js';

function adapterFor(payload: unknown, observe?: (path: string) => void) {
  return new KyberSwapRouteAdapter({
    executorFactory: () =>
      mockKyberExecutor(async (input) => {
        observe?.(input.path);
        return { status: 200, data: payload };
      }),
    fallbackTtlMs: 20_000,
  });
}

test('KyberSwap normalizes a USDC to ETH route quote', async () => {
  const intent = makeIntent();
  const result = await adapterFor(kyberResponse(intent)).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'kyber-usdc-eth',
    now: NOW,
  });
  assert.equal(result.outcome, 'quoted');
  if (result.outcome !== 'quoted') return;
  assert.equal(result.candidate.provider.id, 'kyberswap');
  assert.equal(result.candidate.expectedOutput.amountAtomic, '38100000000000000');
  assert.equal(result.candidate.minimumOutput.amountAtomic, '37909500000000000');
  assert.equal(result.candidate.callCount, 2);
  assert.equal(result.candidate.approvalCount, 1);
  assert.equal(result.candidate.trustMetadata.sourceIndependence, 'overlapping');
});

test('KyberSwap normalizes ETH to USDC and uses the native sentinel', async () => {
  const intent = makeIntent({ from: 'ETH', to: 'USDC', amount: '0.5' });
  let path = '';
  const result = await adapterFor(kyberResponse(intent), (value) => {
    path = value;
  }).quote({ intent, walletAddress: WALLET, requestId: 'kyber-eth-usdc', now: NOW });
  assert.equal(result.outcome, 'quoted');
  assert.match(path, new RegExp(`tokenIn=${KYBERSWAP_NATIVE_ETH}`, 'i'));
  assert.match(path, /amountIn=500000000000000000/);
  if (result.outcome !== 'quoted') return;
  assert.equal(result.candidate.expectedOutput.amountDecimal, '1252');
  assert.equal(result.candidate.callCount, 1);
  assert.equal(result.candidate.approvalCount, 0);
});

test('KyberSwap sends slippage as integer basis points with source=miorail', async () => {
  const intent = makeIntent({ slippageConstraint: { maxBps: 125, source: 'user' } });
  let path = '';
  const result = await adapterFor(kyberResponse(intent), (value) => {
    path = value;
  }).quote({ intent, walletAddress: WALLET, requestId: 'kyber-slippage', now: NOW });
  assert.equal(result.outcome, 'quoted');
  assert.match(path, /slippageTolerance=125/);
  assert.match(path, /source=miorail/);
});

test('KyberSwap accepts only the documented Base router', async () => {
  const intent = makeIntent();
  const payload = kyberResponse(intent);
  assert.equal((payload.data as Record<string, unknown>).routerAddress, KYBERSWAP_BASE_ROUTER);
  const result = await adapterFor(payload).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'router-valid',
    now: NOW,
  });
  assert.equal(result.outcome, 'quoted');
});

test('KyberSwap rejects a router mismatch', async () => {
  const intent = makeIntent();
  const payload = kyberResponse(intent);
  (payload.data as Record<string, unknown>).routerAddress =
    '0x3333333333333333333333333333333333333333';
  const result = await adapterFor(payload).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'router-mismatch',
    now: NOW,
  });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.errorCode, 'provider_router_mismatch');
});

test('KyberSwap no-route response produces no fake candidate', async () => {
  const intent = makeIntent();
  const adapter = new KyberSwapRouteAdapter({
    executorFactory: () => mockKyberExecutor({ status: 404, data: { message: 'no route' } }),
  });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'no-route', now: NOW });
  assert.deepEqual(result, {
    outcome: 'unavailable',
    provider: 'kyberswap',
    errorCode: 'provider_no_route',
    retryable: false,
  });
});

test('KyberSwap 400 "route not found" is the router answering, not our failure', async () => {
  // The production shape, measured 2026-08-25: an unroutable pair comes back
  // as HTTP 400 with `{"code":4008,"message":"route not found"}`. Read as a
  // transport fault it turned eight of thirteen Coinbase tokenized equities
  // into "measurement did not finish" — a fact about Miorail printed where a
  // fact about the market belongs.
  const intent = makeIntent();
  const adapter = new KyberSwapRouteAdapter({
    executorFactory: () =>
      mockKyberExecutor({
        status: 400,
        data: { code: 4008, message: 'route not found', details: null },
      }),
  });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'no-route-400', now: NOW });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.outcome === 'unavailable' && result.errorCode, 'provider_no_route');
});

test('KyberSwap 400 "token not found" is coverage, not a market verdict', async () => {
  // Phase 10B.7, measured 2026-08-27 at the same size, direction and
  // destination as the other two NVIDIA representations:
  //
  //   Coinbase NVDAc  200                       quoted
  //   Backed  bNVDA   400 code 4008  route not found
  //   Backed  wbNVDA  400 code 4011  token not found
  //
  // 4008 is pathfinding — the same answer a garbage address gets, and a fact
  // about the market. 4011 is the router's token list: it never looked. Read
  // as `provider_http_error` it recorded OUR infrastructure as broken on 25
  // consecutive passes; read as `provider_no_route` it would state a market
  // verdict the router never gave.
  const intent = makeIntent();
  const adapter = new KyberSwapRouteAdapter({
    executorFactory: () =>
      mockKyberExecutor({
        status: 400,
        data: { code: 4011, message: 'token not found', details: null },
      }),
  });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'no-token', now: NOW });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.outcome === 'unavailable' && result.errorCode, 'provider_unsupported_token');
});

test('an unsupported token is never demoted to no route, at any HTTP status', async () => {
  // Coverage is checked BEFORE pathfinding, so a body carrying both words
  // cannot be read as the market refusing.
  const intent = makeIntent();
  const adapter = new KyberSwapRouteAdapter({
    executorFactory: () =>
      mockKyberExecutor({ status: 200, data: { message: 'token not found: no route' } }),
  });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'both-words', now: NOW });
  assert.equal(result.outcome === 'unavailable' && result.errorCode, 'provider_unsupported_token');
});

test('a 5xx saying "token not found" is still a fault, not coverage', async () => {
  const intent = makeIntent();
  const adapter = new KyberSwapRouteAdapter({
    executorFactory: () => mockKyberExecutor({ status: 503, data: { message: 'token not found' } }),
  });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'gateway-token', now: NOW });
  assert.equal(result.outcome === 'unavailable' && result.errorCode, 'provider_http_error');
});

test('KyberSwap 400 that is not about a route stays our failure', async () => {
  const intent = makeIntent();
  const adapter = new KyberSwapRouteAdapter({
    executorFactory: () =>
      mockKyberExecutor({ status: 400, data: { code: 4001, message: 'invalid amountIn' } }),
  });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'bad-request', now: NOW });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.outcome === 'unavailable' && result.errorCode, 'provider_http_error');
});

test('a 5xx is never allowed to become a statement about the asset', async () => {
  // A server fault whose body happens to carry the words is still a fault.
  const intent = makeIntent();
  const adapter = new KyberSwapRouteAdapter({
    executorFactory: () => mockKyberExecutor({ status: 502, data: { message: 'route not found' } }),
  });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'gateway', now: NOW });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.outcome === 'unavailable' && result.errorCode, 'provider_http_error');
});

test('KyberSwap normalizes a successful HTTP response that explicitly reports no route', async () => {
  const intent = makeIntent();
  const result = await adapterFor({ message: 'No route found for this pair' }).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'no-route-body',
    now: NOW,
  });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.errorCode, 'provider_no_route');
});

test('KyberSwap invalid schema is normalized', async () => {
  const intent = makeIntent();
  const result = await adapterFor({ data: { routeSummary: null } }).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'invalid-schema',
    now: NOW,
  });
  assert.equal(result.outcome, 'invalid_response');
  assert.equal(result.errorCode, 'provider_invalid_schema');
});

test('KyberSwap timeout is normalized and never throws', async () => {
  const intent = makeIntent();
  const adapter = new KyberSwapRouteAdapter({
    executorFactory: () =>
      mockKyberExecutor(async () => {
        throw new DOMException('timed out', 'AbortError');
      }),
  });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'timeout', now: NOW });
  assert.equal(result.outcome, 'timeout');
});

test('KyberSwap route adapter never calls route/build or the token API', async () => {
  const intent = makeIntent();
  const paths: string[] = [];
  const result = await adapterFor(kyberResponse(intent), (path) => paths.push(path)).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'read-endpoint-only',
    now: NOW,
  });
  assert.equal(result.outcome, 'quoted');
  assert.equal(paths.length, 1);
  assert.match(paths[0], /^\/base\/api\/v1\/routes\?/);
  assert.equal(paths.some((path) => /route\/build|public\/tokens|token-api/i.test(path)), false);
});

test('KyberSwap rejects response asset and chain mismatches', async () => {
  const intent = makeIntent();
  const assetMismatch = await adapterFor(kyberResponse(intent, {
    tokenOut: '0x3333333333333333333333333333333333333333',
  })).quote({ intent, walletAddress: WALLET, requestId: 'asset-mismatch', now: NOW });
  const chainMismatch = await adapterFor(kyberResponse(intent, { chainId: 1 })).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'chain-mismatch',
    now: NOW,
  });
  assert.equal(assetMismatch.outcome, 'rejected');
  assert.equal(chainMismatch.outcome, 'rejected');
  assert.equal(assetMismatch.errorCode, 'provider_asset_mismatch');
  assert.equal(chainMismatch.errorCode, 'provider_chain_mismatch');
});

test('KyberSwap rejects an already-expired quote', async () => {
  const intent = makeIntent();
  const result = await adapterFor(kyberResponse(intent, {
    expiresAt: '2026-07-15T11:59:59.000Z',
  })).quote({ intent, walletAddress: WALLET, requestId: 'expired', now: NOW });
  assert.equal(result.outcome, 'invalid_response');
  assert.equal(result.errorCode, 'provider_expired_quote');
});

test('KyberSwap returns not_configured when the explicit namespace executor is unavailable', async () => {
  const intent = makeIntent();
  const result = await new KyberSwapRouteAdapter({ executorFactory: () => null }).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'missing-executor',
    now: NOW,
  });
  assert.equal(result.outcome, 'not_configured');
});

test('KyberSwap response hash covers the complete validated routeSummary', async () => {
  const intent = makeIntent();
  const first = await adapterFor(kyberResponse(intent, { providerSpecific: { split: '60/40' } })).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'complete-summary',
    now: NOW,
  });
  const second = await adapterFor(kyberResponse(intent, { providerSpecific: { split: '70/30' } })).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'complete-summary',
    now: NOW,
  });
  assert.equal(first.outcome, 'quoted');
  assert.equal(second.outcome, 'quoted');
  if (first.outcome !== 'quoted' || second.outcome !== 'quoted') return;
  assert.notEqual(first.evidence[0].responseHash, second.evidence[0].responseHash);
});

test('KyberSwap response hash redacts secret-like provider fields', async () => {
  const intent = makeIntent();
  const first = await adapterFor(kyberResponse(intent, { authorization: 'secret-one' })).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'secret-redaction',
    now: NOW,
  });
  const second = await adapterFor(kyberResponse(intent, { authorization: 'secret-two' })).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'secret-redaction',
    now: NOW,
  });
  assert.equal(first.outcome, 'quoted');
  assert.equal(second.outcome, 'quoted');
  if (first.outcome !== 'quoted' || second.outcome !== 'quoted') return;
  assert.equal(first.evidence[0].responseHash, second.evidence[0].responseHash);
});

test('KyberSwap artifacts are deterministic with injected clock and routeSummary', async () => {
  const intent = makeIntent();
  const adapter = adapterFor(kyberResponse(intent));
  const input = { intent, walletAddress: WALLET, requestId: 'deterministic-kyber', now: NOW } as const;
  assert.deepEqual(await adapter.quote(input), await adapter.quote(input));
});

// ---------------------------------------------------------------------------
// The shape KyberSwap actually returns, captured from the live endpoint on
// 2026-08-08.
//
// Every fixture above states `priceImpact`. The API stopped sending it — there
// is no price-impact field in the response at all — and the adapter treated
// its absence as a malformed body. So `provider_invalid_schema`, on every
// quote, forever, while the whole suite stayed green against a shape nobody
// serves any more.
//
// It cost four screens: no KyberSwap quote left Aerodrome alone, one provider
// is `single_provider_available`, that outcome carries no recommendation, and
// with no recommendation there is no signable Route Card. "Review transaction"
// was dead because of a missing percentage.
//
// Field names are copied exactly, `routeID` and epoch `timestamp` included.
// ---------------------------------------------------------------------------

/** Verbatim from /base/api/v1/routes, trimmed to the fields the adapter reads. */
function liveKyberResponseV1(intent: ReturnType<typeof makeIntent>, overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    message: 'successfully',
    data: {
      routerAddress: KYBERSWAP_BASE_ROUTER,
      routeSummary: {
        tokenIn: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        amountIn: intent.amount.amountAtomic,
        amountInUsd: '0.10000368084064229',
        tokenOut: KYBERSWAP_NATIVE_ETH,
        amountOut: '51929875391875',
        amountOutUsd: '0.09990771528228602',
        gas: '435495',
        gasPrice: '6000000',
        gasUsd: '0.005027084329226023',
        l1FeeUsd: '0.000011063741447043221',
        route: [[{ exchange: 'uniswap-v3', pool: '0x'.padEnd(42, '1'), swapAmount: '100000' }]],
        routeID: 'e2a1-live',
        checksum: 'abc',
        timestamp: 1786211688,
        ...overrides,
      },
    },
  };
}

test('KyberSwap quotes the live response shape, which reports no price impact', async () => {
  const intent = makeIntent();
  const result = await adapterFor(liveKyberResponseV1(intent)).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'kyber-live-shape',
    now: NOW,
  });
  assert.equal(result.outcome, 'quoted', `refused with ${result.outcome === 'quoted' ? '' : result.errorCode}`);
});

test('price impact is derived from the two USD figures KyberSwap does send', async () => {
  const intent = makeIntent();
  const result = await adapterFor(liveKyberResponseV1(intent)).quote({
    intent,
    walletAddress: WALLET,
    requestId: 'kyber-derived-impact',
    now: NOW,
  });
  if (result.outcome !== 'quoted') throw new Error(`refused: ${result.errorCode}`);
  // (0.10000368084064229 - 0.09990771528228602) / 0.10000368084064229 ≈ 0.09596%,
  // which rounds to 10 bps and is rendered as a percentage on the candidate.
  assert.equal(result.candidate.priceImpact?.bps, 10);
});

test('a route worth more out than in reports zero impact, never a negative one', async () => {
  const intent = makeIntent();
  const result = await adapterFor(
    liveKyberResponseV1(intent, { amountInUsd: '0.0999', amountOutUsd: '0.1001' }),
  ).quote({ intent, walletAddress: WALLET, requestId: 'kyber-positive', now: NOW });
  if (result.outcome !== 'quoted') throw new Error(`refused: ${result.errorCode}`);
  assert.equal(result.candidate.priceImpact?.bps, 0);
});

test('with neither a price impact nor a USD pair, the refusal stands', async () => {
  // The derivation is a reading of provider data, not a way to always have a
  // number. No data still means no quote.
  const intent = makeIntent();
  const result = await adapterFor(
    liveKyberResponseV1(intent, { amountInUsd: undefined, amountOutUsd: undefined }),
  ).quote({ intent, walletAddress: WALLET, requestId: 'kyber-no-usd', now: NOW });
  assert.equal(result.outcome, 'invalid_response');
});
