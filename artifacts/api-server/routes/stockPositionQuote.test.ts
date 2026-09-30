import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { stableHashV1 } from '@mioagent/route-domain';
import { createMemoryOfficialCashExitRepository } from '@mioagent/route-storage';
import {
  buildQuoteArtifacts,
  KYBERSWAP_PROVIDER_V1,
  type SwapRouteAdapter,
} from '@mioagent/swap-adapters';
import { dividendCalendarV1 } from '@mioagent/rwa-market-reality/dividends';
import { StockPositionQuoteV1Schema } from '@mioagent/rwa-market-reality/stock-position-quote';
import {
  measureMyStockCashOutV1,
  stockPositionQuoteRuntime,
} from '../lib/stockPositionQuoteRead.js';
import { stockSellTermsLimiterV1 } from './rwaMarketReality.js';
import { stocksTodayRouter } from './stocksToday.js';
import { createMiorailPrivateMcpServerV1 } from './mcpPrivate/server.js';
import { createMiorailMcpServerV1 } from './mcp/server.js';

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-10-01T12:00:00.000Z');
const original = { ...stockPositionQuoteRuntime };
let clock: Date,
  balance: string,
  decimals: number,
  requests: Parameters<SwapRouteAdapter['quote']>[0][];
let mode: 'quote' | 'no_route' | 'failed', held: string[];
function app(wallet: string | null = WALLET) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    Object.assign(req, {
      session: {
        user: wallet ? { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } : null,
      },
    });
    next();
  });
  server.use('/stocks', stocksTodayRouter);
  return server;
}
beforeEach(() => {
  clock = NOW;
  balance = '88158';
  decimals = 8;
  requests = [];
  held = [];
  mode = 'quote';
  stockSellTermsLimiterV1.reset();
  const adapter: SwapRouteAdapter = {
    id: 'kyberswap',
    supports: () => true,
    async quote(input) {
      requests.push(input);
      if (mode !== 'quote')
        return {
          outcome: 'unavailable',
          provider: 'kyberswap',
          errorCode: mode === 'no_route' ? 'provider_no_route' : 'provider_timeout',
          retryable: mode === 'failed',
        };
      const artifacts = buildQuoteArtifacts({
        adapterId: 'kyberswap',
        intent: input.intent,
        provider: KYBERSWAP_PROVIDER_V1,
        requestId: input.requestId,
        providerQuoteId: null,
        requestHash: stableHashV1('test/request', input.requestId),
        responseHash: stableHashV1('test/response', input.requestId),
        expectedOutputAtomic: '201555',
        gas: {
          gasUnits: '210000',
          maxFeePerGasWei: null,
          estimatedCostNative: null,
          estimatedCostUsd: '0.05',
        },
        priceImpactBps: 10,
        observedAt: input.now.toISOString(),
        expiresAt: new Date(input.now.getTime() + 20_000).toISOString(),
        blockNumber: '52000001',
        provenance: { pools: [], liquiditySources: [] },
        riskFlags: [],
        usesExternalAggregators: true,
        sourceIndependence: 'unknown',
      });
      return { outcome: 'quoted', candidate: artifacts.candidate, evidence: [artifacts.evidence] };
    },
  };
  Object.assign(stockPositionQuoteRuntime, {
    now: () => clock,
    available: async () => true,
    calendar: async () => ({
      ...dividendCalendarV1({ now: NOW, tokens: [] }),
      stocks: [{ tokenAddress: TOKEN, tokenSymbol: 'NVDAc' }],
    }),
    holding: async ({ walletAddress }: { walletAddress: string }) => {
      held.push(walletAddress);
      return { ok: true, decimals, symbol: 'NVDA', balanceAtomic: balance, blockTag: '0x3197501' };
    },
    repository: () => createMemoryOfficialCashExitRepository(),
    adapters: () => [adapter],
    capture: () => undefined,
  });
});
afterEach(() => {
  Object.assign(stockPositionQuoteRuntime, original);
  stockSellTermsLimiterV1.reset();
});

test('authentication, strict input and reviewed contract checks precede balance/provider reads', async () => {
  assert.equal(
    (await request(app(null)).post('/stocks/cash-out').send({ tokenAddress: TOKEN })).status,
    401,
  );
  for (const extra of [{ wallet: OTHER }, { tokenAmountAtomic: '1' }, { router: OTHER }])
    assert.equal(
      (
        await request(app())
          .post('/stocks/cash-out')
          .send({ tokenAddress: TOKEN, ...extra })
      ).status,
      400,
    );
  assert.equal(
    (await request(app()).post('/stocks/cash-out').send({ tokenAddress: OTHER })).status,
    404,
  );
  assert.deepEqual(held, []);
  assert.deepEqual(requests, []);
});

test('the real SELL engine quotes only the whole fresh raw balance, privately, without approvals or simulation', async () => {
  const result = await request(app())
    .post('/stocks/cash-out')
    .send({ tokenAddress: TOKEN.toUpperCase().replace('0X', '0x') });
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  const quote = StockPositionQuoteV1Schema.parse(result.body);
  assert.equal(quote.holding.tokens, '0.00088158');
  assert.equal(quote.holding.balanceAtomic, '88158');
  assert.equal(quote.returnedAtomic, '201555');
  assert.equal(quote.status, 'quoted');
  assert.equal(quote.selectedSource, 'kyberswap');
  assert.deepEqual(held, [WALLET]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.intent.amount.amountAtomic, '88158');
  assert.equal(requests[0]!.intent.fromAsset?.address, TOKEN);
  assert.equal(requests[0]!.intent.toAsset?.symbol, 'USDC');
  assert.equal(requests[0]!.intent.executionRequested, false);
  assert.equal(quote.executionProven, false);
  assert.equal(quote.createsCalldata, false);
  assert.doesNotMatch(
    JSON.stringify(quote),
    /blueprint|clearance|0x1111111111111111111111111111111111111111/,
  );
  balance = '90001';
  await measureMyStockCashOutV1(WALLET, { tokenAddress: TOKEN });
  assert.equal(
    requests[1]!.intent.amount.amountAtomic,
    '90001',
    'a second explicit check rereads a changed balance',
  );
});

test('zero balance is distinct from a failed balance read and spends no quote', async () => {
  balance = '0';
  const empty = await measureMyStockCashOutV1(WALLET, { tokenAddress: TOKEN });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.returnedAtomic, null);
  assert.equal(requests.length, 0);
  stockPositionQuoteRuntime.holding = async () => ({ ok: false, code: 'secret-url' });
  const failed = await request(app()).post('/stocks/cash-out').send({ tokenAddress: TOKEN });
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.body, {
    error: 'stock_cash_out_balance_unread',
    code: 'stock_cash_out_balance_unread',
  });
});

test('provider no-route and an outage are distinct and provider-scoped', async () => {
  mode = 'no_route';
  assert.equal((await measureMyStockCashOutV1(WALLET, { tokenAddress: TOKEN })).status, 'no_route');
  mode = 'failed';
  const failed = await measureMyStockCashOutV1(WALLET, { tokenAddress: TOKEN });
  assert.equal(failed.status, 'not_established');
  assert.equal(failed.sources[0]?.errorCode, 'provider_timeout');
  assert.equal(failed.returnedAtomic, null);
});

test('a quoted source remains usable when another provider fails; its gap is retained', async () => {
  const good = stockPositionQuoteRuntime.adapters()[0]!;
  stockPositionQuoteRuntime.adapters = () => [
    good,
    {
      id: 'uniswap',
      supports: () => true,
      quote: async () => ({
        outcome: 'unavailable',
        provider: 'uniswap',
        errorCode: 'provider_timeout',
        retryable: true,
      }),
    },
  ];
  const quote = await measureMyStockCashOutV1(WALLET, { tokenAddress: TOKEN });
  assert.equal(quote.status, 'quoted');
  assert.equal(quote.selectedSource, 'kyberswap');
  assert.deepEqual(quote.approvedSources, ['kyberswap', 'uniswap']);
  assert.equal(quote.sources.find((s) => s.source === 'uniswap')?.status, 'measurement_failed');
});

test('measurements are private to this tenant and cannot become a public ladder or another owner read', async () => {
  const repository = createMemoryOfficialCashExitRepository();
  stockPositionQuoteRuntime.repository = () => repository;
  await measureMyStockCashOutV1(WALLET, { tokenAddress: TOKEN });
  assert.equal(
    await repository.latestCompletedRun({
      chainId: 8453,
      tokenAddress: TOKEN,
      scope: 'public_ladder',
    }),
    null,
  );
  assert.equal(
    await repository.latestCompletedRun({
      chainId: 8453,
      tokenAddress: TOKEN,
      scope: 'tenant_position',
      tenantId: `eip155:8453:${OTHER}`,
    }),
    null,
  );
  assert.equal(
    (
      await repository.latestCompletedRun({
        chainId: 8453,
        tokenAddress: TOKEN,
        scope: 'tenant_position',
        tenantId: `eip155:8453:${WALLET}`,
      })
    )?.observations[0]?.requestedTokenAtomic,
    '88158',
  );
});

test('a slow measurement retains an expired quote as dated evidence instead of reporting an outage', async () => {
  const actual = stockPositionQuoteRuntime.measure;
  stockPositionQuoteRuntime.measure = async (input) => {
    const run = await actual(input);
    clock = new Date(NOW.getTime() + 30_000);
    return run;
  };
  const quote = await measureMyStockCashOutV1(WALLET, { tokenAddress: TOKEN });
  assert.equal(quote.status, 'expired');
  assert.equal(quote.returnedAtomic, '201555');
  assert.equal(quote.observedAt, NOW.toISOString());
});

test('concurrent checks share one run, while a different wallet gets its own balance and run', async () => {
  const quotes = await Promise.all(
    Array.from({ length: 5 }, () => measureMyStockCashOutV1(WALLET, { tokenAddress: TOKEN })),
  );
  assert.equal(requests.length, 1);
  assert.ok(quotes.every((q) => q === quotes[0]));
  await measureMyStockCashOutV1(OTHER, { tokenAddress: TOKEN });
  assert.deepEqual(held, [WALLET, OTHER]);
  assert.equal(requests[1]!.intent.tenantId, `eip155:8453:${OTHER}`);
});

test('wallet rate budget is shared with SELL review and returns retry guidance', async () => {
  for (let i = 0; i < 10; i++)
    await stockSellTermsLimiterV1.current.consume(`stock-sell-terms:eip155:8453:${WALLET}`);
  const result = await request(app()).post('/stocks/cash-out').send({ tokenAddress: TOKEN });
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '60');
  assert.deepEqual(held, []);
});

test('a wrongly bound measurement and a thrown upstream secret cannot enter the response', async () => {
  const actual = stockPositionQuoteRuntime.measure;
  stockPositionQuoteRuntime.measure = async (input) => ({
    ...(await actual(input)),
    tenantId: `eip155:8453:${OTHER}`,
  });
  assert.equal(
    (await request(app()).post('/stocks/cash-out').send({ tokenAddress: TOKEN })).status,
    503,
  );
  stockPositionQuoteRuntime.holding = async () => {
    throw new Error('https://secret-rpc/key');
  };
  const failed = await request(app()).post('/stocks/cash-out').send({ tokenAddress: TOKEN });
  assert.doesNotMatch(JSON.stringify(failed.body), /secret|https/);
});

test('real connected MCP uses the same engine; the public registry cannot measure an owner position', async () => {
  for (const connected of [true, false]) {
    const server = connected
      ? createMiorailPrivateMcpServerV1({
          tenantId: `eip155:8453:${WALLET}`,
          walletAddress: WALLET,
          chainId: 8453,
          tokenId: 'test',
          source: 'browser_session',
        })
      : createMiorailMcpServerV1();
    const client = new Client({ name: 'position-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    try {
      const tool = (await client.listTools()).tools.find(
        (t) => t.name === 'miorail_measure_my_stock_cash_out',
      );
      assert.equal(Boolean(tool), connected);
      if (connected) {
        assert.equal(
          tool!.annotations?.readOnlyHint,
          false,
          'persists private measurement evidence',
        );
        assert.deepEqual(Object.keys(tool!.inputSchema.properties ?? {}), ['tokenAddress']);
        const result = await client.callTool({
          name: tool!.name,
          arguments: { tokenAddress: TOKEN },
        });
        assert.equal(result.isError, undefined);
        assert.deepEqual(
          result.structuredContent,
          (await request(app()).post('/stocks/cash-out').send({ tokenAddress: TOKEN })).body,
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});
