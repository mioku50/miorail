import assert from 'node:assert/strict';
import test from 'node:test';
import type { BaseMcpSkillExecutor, PluginHttpResponse } from '@mioagent/runtime-skills';
import { KyberSwapBuildAdapter } from '../src/adapters/kyberswap.js';
import { NOW, WALLET, makeIntent } from './fixtures.js';

const ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';

function mockExecutor(
  handler: (input: Parameters<BaseMcpSkillExecutor['request']>[0]) => Promise<PluginHttpResponse> | PluginHttpResponse,
): BaseMcpSkillExecutor {
  return {
    namespace: 'kyberswap',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: { hosts: ['aggregator-api.kyberswap.com'], methods: ['GET', 'POST'], pathPrefixes: ['/base/api/v1/routes', '/base/api/v1/route/build'] },
      auth: 'none',
      risk: ['slippage'],
    },
    allowedPaths: ['/base/api/v1/routes', '/base/api/v1/route/build'],
    request: async (input) => handler(input),
  };
}

const SUMMARY_AMOUNT_OUT = '38100000000000000';

function defaultHandler(routeSummary: unknown = { note: 'route', amountOut: SUMMARY_AMOUNT_OUT }) {
  return async (input: Parameters<BaseMcpSkillExecutor['request']>[0]) => {
    if (input.method === 'GET') {
      return { status: 200, data: { data: { routerAddress: ROUTER, routeSummary } } };
    }
    return { status: 200, data: { data: { routerAddress: ROUTER, data: '0xabcdef01', transactionValue: '0' } } };
  };
}

function buildInput(intent = makeIntent(), walletAddress: string = WALLET) {
  return {
    intent,
    selectedCandidate: null as never,
    walletAddress: walletAddress as `0x${string}`,
    now: NOW,
    requestId: 'req-kyber-1',
  };
}

test('KyberSwap build adapter builds an approval plus swap call for USDC to ETH', async () => {
  const adapter = new KyberSwapBuildAdapter({ executorFactory: () => mockExecutor(defaultHandler()) });
  const result = await adapter.build(buildInput());
  assert.equal(result.outcome, 'built');
  if (result.outcome === 'built') {
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[1]!.to, ROUTER);
    assert.equal(result.routerAddress, ROUTER);
    // Build-side outputs come from the routeSummary actually POSTed to
    // route/build: amountOut + the intent's 50 bps slippage bound.
    assert.equal(result.expectedOutput.amountAtomic, SUMMARY_AMOUNT_OUT);
    assert.equal(result.minimumOutput.amountAtomic, ((BigInt(SUMMARY_AMOUNT_OUT) * BigInt(9_950)) / BigInt(10_000)).toString());
  }
});

test('KyberSwap build adapter rejects a routeSummary without a usable amountOut', async () => {
  const adapter = new KyberSwapBuildAdapter({ executorFactory: () => mockExecutor(defaultHandler({ note: 'route' })) });
  const result = await adapter.build(buildInput());
  assert.equal(result.outcome, 'invalid_response');
});

test('KyberSwap build adapter rejects a router mismatch on the GET routes response', async () => {
  const adapter = new KyberSwapBuildAdapter({
    executorFactory: () =>
      mockExecutor(async (input) =>
        input.method === 'GET'
          ? { status: 200, data: { data: { routerAddress: '0x2222222222222222222222222222222222222222', routeSummary: {} } } }
          : { status: 200, data: { data: { routerAddress: ROUTER, data: '0xabcdef01', transactionValue: '0' } } },
      ),
  });
  const result = await adapter.build(buildInput());
  assert.equal(result.outcome, 'router_mismatch');
});

test('KyberSwap build adapter rejects a router mismatch on the route/build response', async () => {
  const adapter = new KyberSwapBuildAdapter({
    executorFactory: () =>
      mockExecutor(async (input) =>
        input.method === 'GET'
          ? { status: 200, data: { data: { routerAddress: ROUTER, routeSummary: { amountOut: SUMMARY_AMOUNT_OUT } } } }
          : { status: 200, data: { data: { routerAddress: '0x3333333333333333333333333333333333333333', data: '0xabcdef01', transactionValue: '0' } } },
      ),
  });
  const result = await adapter.build(buildInput());
  assert.equal(result.outcome, 'invalid_response');
});

test('KyberSwap build adapter passes the routeSummary byte-preserved to route/build', async () => {
  const routeSummary = { amountIn: '1', amountOut: SUMMARY_AMOUNT_OUT, nested: { x: 1, y: [1, 2, 3] } };
  let capturedBody: unknown;
  const adapter = new KyberSwapBuildAdapter({
    executorFactory: () =>
      mockExecutor(async (input) => {
        if (input.method === 'GET') return { status: 200, data: { data: { routerAddress: ROUTER, routeSummary } } };
        capturedBody = input.body;
        return { status: 200, data: { data: { routerAddress: ROUTER, data: '0xabcdef01', transactionValue: '0' } } };
      }),
  });
  await adapter.build(buildInput());
  assert.deepEqual((capturedBody as { routeSummary: unknown }).routeSummary, routeSummary);
});

test('KyberSwap build adapter rejects a nonzero transactionValue', async () => {
  const adapter = new KyberSwapBuildAdapter({
    executorFactory: () =>
      mockExecutor(async (input) =>
        input.method === 'GET'
          ? { status: 200, data: { data: { routerAddress: ROUTER, routeSummary: { amountOut: SUMMARY_AMOUNT_OUT } } } }
          : { status: 200, data: { data: { routerAddress: ROUTER, data: '0xabcdef01', transactionValue: '1000' } } },
      ),
  });
  const result = await adapter.build(buildInput());
  assert.equal(result.outcome, 'rejected');
});

test('KyberSwap build adapter is not_configured when no matching executor exists', async () => {
  const adapter = new KyberSwapBuildAdapter({ executorFactory: () => null });
  const result = await adapter.build(buildInput());
  assert.equal(result.outcome, 'not_configured');
});

test('KyberSwap build adapter rejects a wallet mismatch', async () => {
  const adapter = new KyberSwapBuildAdapter({ executorFactory: () => mockExecutor(defaultHandler()) });
  const result = await adapter.build(buildInput(makeIntent(), '0x2222222222222222222222222222222222222222'));
  assert.equal(result.outcome, 'rejected');
});
