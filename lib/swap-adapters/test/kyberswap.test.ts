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
