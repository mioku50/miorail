import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { encodeFunctionResult } from 'viem';
import type { B20ReaderV1 } from '@mioagent/b20-control';
import { dividendCalendarV1 } from '@mioagent/rwa-market-reality/dividends';
import { StockBriefV1Schema } from '@mioagent/rwa-market-reality/stock-brief';
import {
  briefInput,
  NOW,
  TOKEN,
  FEED,
} from '../../../lib/rwa-market-reality/test/fixtures/stockBrief.js';
import { AGGREGATE3_ABI_V1 } from '../lib/dividendWalletRead.js';
import { stockBriefRuntime, stockBriefCacheV1 } from '../lib/stockBriefRead.js';
import { stocksTodayRouter } from './stocksToday.js';
import { createMiorailPrivateMcpServerV1 } from './mcpPrivate/server.js';
import { createMiorailMcpServerV1 } from './mcp/server.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const original = { ...stockBriefRuntime };
let wallets: string[];
let calls: string[];
function app(wallet: string | null = WALLET) {
  const server = express();
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
  wallets = [];
  calls = [];
  stockBriefCacheV1.clear();
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`;
  const reader = {
    async readBlockHeader(tag: string) {
      calls.push(tag);
      return { ok: true, value: { timestamp: NOW.getTime() / 1000 }, raw: '' };
    },
    async call(input: { blockTag: string }) {
      calls.push(input.blockTag);
      const value = encodeFunctionResult({
        abi: AGGREGATE3_ABI_V1,
        functionName: 'aggregate3',
        result: [10n ** 18n, 2n * 10n ** 18n, BigInt(NOW.getTime() / 1000 + 3600)].map((value) => ({
          success: true,
          returnData: word(value),
        })),
      });
      return { ok: true, value, raw: value };
    },
  } as unknown as B20ReaderV1;
  Object.assign(stockBriefRuntime, {
    now: () => NOW,
    available: async () => true,
    reader: () => reader,
    dividends: async (wallet: string) => {
      wallets.push(wallet);
      return briefInput().dividends;
    },
    calendar: async () => ({
      ...dividendCalendarV1({ now: NOW, tokens: [] }),
      stocks: [{ tokenAddress: TOKEN }],
    }),
    references: async () => briefInput().references,
    watches: async (userId: string) => {
      assert.ok(userId.startsWith('eip155:8453:'));
      return [];
    },
    changes: async (addresses: string[]) => {
      assert.deepEqual(addresses, [TOKEN]);
      return FEED;
    },
  });
});
afterEach(() => {
  Object.assign(stockBriefRuntime, original);
  stockBriefCacheV1.clear();
});

test('the web route rejects foreign-wallet input and unauthenticated reads without touching the chain', async () => {
  assert.equal((await request(app(null)).get('/stocks/today')).status, 401);
  assert.equal((await request(app()).get(`/stocks/today?wallet=${OTHER}`)).status, 400);
  assert.equal(
    (await request(app()).get('/stocks/today?since=2026-10-01T00:00:00.000Z')).status,
    400,
  );
  assert.deepEqual(wallets, []);
});

test('web and real connected MCP return the same personal calculation and keep separate wallet caches', async () => {
  const web = await request(app()).get('/stocks/today');
  assert.equal(web.status, 200);
  assert.equal(web.headers['cache-control'], 'private, no-store');
  const parsed = StockBriefV1Schema.parse(web.body);
  assert.equal(parsed.holdings[0]?.schedule?.effectiveAt, '2026-09-30T22:00:00.000Z');
  assert.equal(new Set(calls).size, 1, 'controls and balances use the same block');
  const client = new Client({ name: 'personal-read-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMiorailPrivateMcpServerV1({
    tenantId: `eip155:8453:${WALLET}`,
    walletAddress: WALLET,
    chainId: 8453,
    tokenId: 'session',
    source: 'browser_session',
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: 'miorail_get_my_stocks_today', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, web.body);
    assert.deepEqual(wallets, [WALLET]);
    await request(app(OTHER)).get('/stocks/today');
    assert.deepEqual(wallets, [WALLET, OTHER]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('the anonymous MCP has no personal-wallet tool', async () => {
  const client = new Client({ name: 'anonymous-read-test', version: '1' });
  const server = createMiorailMcpServerV1();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    assert.equal(
      (await client.listTools()).tools.some((tool) => tool.name === 'miorail_get_my_stocks_today'),
      false,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('a cached refresh keeps the original read cursor so a return visit cannot skip changes', async () => {
  const first = await request(app()).get('/stocks/today');
  stockBriefRuntime.now = () => new Date(NOW.getTime() + 5_000);
  const refreshed = await request(app()).get(
    `/stocks/today?since=${encodeURIComponent(first.body.generatedAt)}`,
  );
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.generatedAt, first.body.generatedAt);
  assert.deepEqual(wallets, [WALLET], 'one chain read inside the cache TTL');
});

test('a zero effectiveAt is a successfully read absence of a pending plan', async () => {
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`;
  const reader = stockBriefRuntime.reader()!;
  reader.call = async () => {
    const value = encodeFunctionResult({
      abi: AGGREGATE3_ABI_V1,
      functionName: 'aggregate3',
      result: [10n ** 18n, 0n, 0n].map((value) => ({ success: true, returnData: word(value) })),
    });
    return { ok: true, value, raw: value };
  };
  const response = await request(app()).get('/stocks/today');
  assert.equal(response.status, 200);
  assert.equal(response.body.holdings[0].scheduleRead, 'read');
  assert.equal(response.body.holdings[0].schedule, null);
});

test('failed changes and references are gaps while chain failure cannot look like an empty wallet', async () => {
  Object.assign(stockBriefRuntime, {
    references: async () => {
      throw new Error('private-rpc-url');
    },
    changes: async () => {
      throw new Error('private-db-url');
    },
  });
  const body = (await request(app()).get('/stocks/today')).body;
  assert.equal(body.changesUnavailable, true);
  assert.equal(body.holdings[0].reference, null);
  assert.doesNotMatch(JSON.stringify(body), /private-rpc-url|private-db-url/);
  stockBriefCacheV1.clear();
  stockBriefRuntime.dividends = async () => {
    throw new Error('secret-rpc-url');
  };
  const failed = await request(app()).get('/stocks/today');
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.body, { code: 'stock_brief_unread' });
});
