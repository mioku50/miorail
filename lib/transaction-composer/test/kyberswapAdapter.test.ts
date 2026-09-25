import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSkillExecutor, type BaseMcpSkillExecutor, type PluginHttpResponse } from '@mioagent/runtime-skills';
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

// ---------------------------------------------------------------------------
// The routeSummary survives our own transport.
//
// 2026-09-25: every NVDAc build answered HTTP 500. The route went through a
// pool whose summary nests `extra._ss.poolExtra` nine levels deep. The
// transport's redaction pass cut everything past depth 8 to '[truncated]', so
// route/build received an object KyberSwap never sent. The stub executor above
// never runs that transport, which is why "byte-preserved" passed while
// production failed.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';

/** Today's shape, trimmed: one Aerodrome CL leg that carries a sub-swap. */
const DEEP_ROUTE_SUMMARY = {
  tokenIn: USDC,
  amountIn: '100000',
  tokenOut: NVDA,
  amountOut: SUMMARY_AMOUNT_OUT,
  gas: '330498',
  route: [
    [
      {
        pool: '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9',
        tokenIn: USDC,
        tokenOut: NVDA,
        swapAmount: '100000',
        amountOut: SUMMARY_AMOUNT_OUT,
        exchange: 'aerodrome-cl-3',
        poolType: 'slipstream',
        extra: {
          _cs: '5094029034460558474',
          _ss: {
            pool: '0xca69c5a01fe47e7eff18114451a57d624583cd83',
            tokenIn: USDC,
            tokenOut: NVDA,
            swapAmount: '100000',
            amountOut: '44229',
            exchange: 'metric-propamm',
            poolType: 'metric-propamm',
            poolExtra: { swapDir: false, priceProvider: '', blockNumber: 51771439 },
            extra: null,
          },
          _ts: '1790332529',
          nSqrtRx96: '52688704991194138088866569254',
          nT: -8160,
          rAI: '0',
          ri: '23c87e7erfxE8YWL',
        },
      },
    ],
  ],
  routeID: 'b5a3c2c1-probe',
  checksum: '1234567890123456789',
  timestamp: 1790332529,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('the real transport hands route/build the routeSummary KyberSwap sent, however deep', async () => {
  const posted: Array<{ routeSummary: unknown }> = [];
  const fetchImpl = (async (_url: string, init: { method?: string; body?: string }) => {
    if (init.method === 'POST') {
      posted.push(JSON.parse(init.body ?? '{}'));
      return jsonResponse({ code: 0, data: { routerAddress: ROUTER, data: '0xabcdef01', transactionValue: '0' } });
    }
    return jsonResponse({ code: 0, data: { routerAddress: ROUTER, routeSummary: DEEP_ROUTE_SUMMARY } });
  }) as never;
  const real = loadSkillExecutor('kyberswap');
  assert.ok(real, 'the kyberswap namespace is loadable');
  const adapter = new KyberSwapBuildAdapter({
    executorFactory: () => ({
      ...real!,
      request: (input) => real!.request({ ...input, fetchImpl } as never),
    }),
  });
  const result = await adapter.build(buildInput());
  assert.equal(result.outcome, 'built', JSON.stringify(result));
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0]!.routeSummary, DEEP_ROUTE_SUMMARY);
});

test('a routeSummary our transport altered is never posted', async () => {
  let posts = 0;
  const adapter = new KyberSwapBuildAdapter({
    executorFactory: () =>
      mockExecutor(async (input) => {
        if (input.method === 'GET') {
          return {
            status: 200,
            data: {
              data: {
                routerAddress: ROUTER,
                routeSummary: { amountOut: SUMMARY_AMOUNT_OUT, route: [[{ extra: { poolExtra: '[truncated]' } }]] },
              },
            },
          };
        }
        posts += 1;
        return { status: 200, data: { data: { routerAddress: ROUTER, data: '0xabcdef01', transactionValue: '0' } } };
      }),
  });
  const result = await adapter.build(buildInput());
  assert.equal(result.outcome, 'invalid_response');
  assert.equal('errorCode' in result ? result.errorCode : null, 'kyberswap_route_summary_altered');
  assert.equal(posts, 0);
});
