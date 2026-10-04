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
import { logger } from '@mioagent/utils';
import {
  briefInput,
  NOW,
  TOKEN,
  FEED,
} from '../../../lib/rwa-market-reality/test/fixtures/stockBrief.js';
import { AGGREGATE3_ABI_V1 } from '../lib/dividendWalletRead.js';
import { stockBriefRuntime, stockBriefCacheV1 } from '../lib/stockBriefRead.js';
import { createMemoryStockInboxRepositoryV1, type RwaSignalRowV1 } from '@mioagent/route-storage';
import { stockInboxRuntime } from '../lib/stockInboxRead.js';
import { stocksTodayRouter } from './stocksToday.js';
import { createMiorailPrivateMcpServerV1 } from './mcpPrivate/server.js';
import { createMiorailMcpServerV1 } from './mcp/server.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const original = { ...stockBriefRuntime };
const originalInbox = { ...stockInboxRuntime };
let signals: RwaSignalRowV1[];
let wallets: string[];
let calls: string[];
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
  signals = [];
  const repository = createMemoryStockInboxRepositoryV1(() => signals);
  Object.assign(stockInboxRuntime, {
    repository: () => repository,
    now: () => stockBriefRuntime.now(),
    secret: () => 'stock-inbox-test-secret-32-characters',
  });
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
    changes: async (
      addresses: string[],
      _since: string,
      _until: string,
      rows: RwaSignalRowV1[] = [],
    ) => {
      assert.deepEqual(addresses, [TOKEN]);
      return {
        ...FEED,
        cards: rows.map((row) => ({ ...row, subjectTicker: 'NVDAc', officialTicker: null })),
      };
    },
  });
});
afterEach(() => {
  Object.assign(stockBriefRuntime, original);
  Object.assign(stockInboxRuntime, originalInbox);
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

test('a cached balance does not cache away a delayed change or move its receipt past the bounded inbox read', async () => {
  const first = await request(app()).get('/stocks/today');
  const later = new Date(NOW.getTime() + 5_000);
  stockBriefRuntime.now = () => later;
  stockBriefRuntime.changes = async (addresses, since, until) => {
    assert.deepEqual(addresses, [TOKEN]);
    assert.equal(since, first.body.generatedAt);
    assert.equal(until, later.toISOString());
    return {
      ...FEED,
      cards: [
        {
          signalId: '1',
          chainId: 8453,
          kind: 'official_asset_multiplier_changed',
          subjectAddress: TOKEN,
          subjectTicker: 'NVDAc',
          officialAddress: null,
          officialTicker: null,
          occurredAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
          recordedAt: new Date(NOW.getTime() + 2_000).toISOString(),
          facts: { multiplierWad: '1005000000000000000' },
        },
      ],
    };
  };
  const refreshed = await request(app()).get(
    `/stocks/today?since=${encodeURIComponent(first.body.generatedAt)}`,
  );
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.generatedAt, later.toISOString());
  assert.equal(refreshed.body.balanceReadAt, first.body.balanceReadAt);
  assert.equal(refreshed.body.inbox.heldCount, 1);
  assert.equal(refreshed.body.changes.cards[0].signalId, '1');
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
  // A failed overview leaves one line with a code, never the message.
  const warnings: Array<{ message: string; meta: unknown }> = [];
  const warn = logger.warn;
  logger.warn = ((message: string, meta?: unknown) => {
    warnings.push({ message, meta });
  }) as typeof logger.warn;
  try {
    const failed = await request(app()).get('/stocks/today');
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, { code: 'stock_brief_unread' });
  } finally {
    logger.warn = warn;
  }
  assert.deepEqual(warnings, [{ message: 'Stock overview read failed', meta: { code: 'error', kind: 'Error' } }]);
});

function event(
  id: number,
  recordedAt = new Date(NOW.getTime() - 1000).toISOString(),
): RwaSignalRowV1 {
  return {
    signalId: String(id),
    chainId: 8453,
    subjectAddress: TOKEN,
    officialAddress: null,
    kind: 'official_asset_multiplier_changed',
    occurredAt: '2026-09-20T10:00:00.000Z',
    recordedAt,
    facts: { multiplierWad: '1050000000000000000' },
  };
}
async function connected(wallet: `0x${string}` = WALLET) {
  const client = new Client({ name: 'shared-inbox-test', version: '1' });
  const server = createMiorailPrivateMcpServerV1({
    tenantId: `eip155:8453:${wallet}`,
    walletAddress: wallet,
    chainId: 8453,
    tokenId: 'test-grant',
    source: 'oauth',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test('web receipts are shared with MCP, MCP receipts with web, while another wallet remains unread', async () => {
  signals.push(event(1));
  const before = await request(app()).get('/stocks/today');
  assert.equal(before.body.inbox.items.length, 1);
  assert.equal(before.body.inbox.reviewedAt, null);
  assert.equal((await request(app()).get('/stocks/today')).body.inbox.items.length, 1);
  const marked = await request(app())
    .post('/stocks/inbox/read')
    .send({ reviewToken: before.body.inbox.reviewToken });
  assert.equal(marked.status, 200);
  const mcp = await connected();
  try {
    assert.equal(mcp.client.getServerVersion()?.version, '1.6.0');
    assert.equal((await mcp.client.listTools()).tools.length, 32);
    const first = (
      await mcp.client.callTool({ name: 'miorail_get_my_stocks_today', arguments: {} })
    ).structuredContent as any;
    assert.equal(first.inbox.items.length, 0);
    assert.equal(first.inbox.reviewedAt, marked.body.reviewedAt);
    signals.push(event(2)); // Same recordedAt as event 1, inserted AFTER its acknowledgment.
    const second = (
      await mcp.client.callTool({ name: 'miorail_get_my_stocks_today', arguments: {} })
    ).structuredContent as any;
    assert.deepEqual(
      second.inbox.items.map((i: any) => i.signalId),
      ['2'],
    );
    const reply = await mcp.client.callTool({
      name: 'miorail_mark_stock_updates_read',
      arguments: { reviewToken: second.inbox.reviewToken },
    });
    assert.equal(reply.isError, undefined);
    assert.equal((await request(app()).get('/stocks/today')).body.inbox.items.length, 0);
    assert.equal((await request(app(OTHER)).get('/stocks/today')).body.inbox.items.length, 2);
    const history = await request(app()).get('/stocks/today?view=history');
    assert.equal(history.body.inbox.items.length, 2);
    assert.equal(history.body.inbox.reviewToken, null);
  } finally {
    await mcp.close();
  }
});

test('one issuer transaction is one news update in web and MCP; its proof reviews every supporting log', async () => {
  const transactionHash = `0x${'a'.repeat(64)}`;
  signals.push(
    {
      ...event(1),
      kind: 'official_asset_corporate_action_announced',
      facts: { transactionHash, event: 'announcement', payloadState: 'topic_only' },
    },
    {
      ...event(2),
      facts: { transactionHash, event: 'multiplier_updated', multiplierWad: '1000537939576369481' },
    },
    {
      ...event(3),
      facts: {
        transactionHash,
        event: 'ui_multiplier_updated',
        multiplierWad: '1000537939576369481',
      },
    },
  );
  const web = (await request(app()).get('/stocks/today')).body;
  assert.equal(web.changes.cards.length, 3);
  assert.equal(web.inbox.items.length, 1);
  assert.equal(web.inbox.heldCount, 1);
  assert.deepEqual(web.inbox.items[0].evidenceSignalIds, ['3', '2', '1']);
  const mcp = await connected();
  try {
    const response = await mcp.client.callTool({
      name: 'miorail_get_my_stocks_today',
      arguments: {},
    });
    const news = response.structuredContent as any;
    assert.deepEqual(news.inbox.items, web.inbox.items);
    const marked = await mcp.client.callTool({
      name: 'miorail_mark_stock_updates_read',
      arguments: { reviewToken: news.inbox.reviewToken },
    });
    assert.equal(marked.isError, undefined);
    assert.equal((marked.structuredContent as any).markedCount, 3);
    assert.equal((await request(app()).get('/stocks/today')).body.inbox.items.length, 0);
    const history = (await request(app()).get('/stocks/today?view=history')).body;
    assert.equal(history.inbox.items.length, 1);
    assert.equal(history.changes.cards.length, 3);
    assert.equal((await request(app(OTHER)).get('/stocks/today')).body.inbox.items.length, 1);
  } finally {
    await mcp.close();
  }
});

test('page acknowledgment leaves unseen pages and concurrent findings unread; the fixed baseline survives weeks', async () => {
  signals.push(...Array.from({ length: 102 }, (_, i) => event(i + 1)));
  const first = (await request(app()).get('/stocks/today')).body;
  assert.equal(first.inbox.items.length, 50);
  assert.ok(first.inbox.nextCursor);
  assert.equal(
    (
      await request(app(OTHER)).get(
        `/stocks/today?cursor=${encodeURIComponent(first.inbox.nextCursor)}`,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app()).get(
        `/stocks/today?cursor=${encodeURIComponent(first.inbox.reviewToken)}`,
      )
    ).status,
    400,
  );
  assert.equal(
    first.changesTruncated,
    false,
    'a paginated page can be reviewed without dropping other pages',
  );
  signals.push(event(103));
  const next = (
    await request(app()).get(`/stocks/today?cursor=${encodeURIComponent(first.inbox.nextCursor)}`)
  ).body;
  assert.equal(next.inbox.items.length, 50);
  assert.equal(
    new Set([...first.inbox.items, ...next.inbox.items].map((i) => i.signalId)).size,
    100,
  );
  assert.equal(
    (await request(app()).post('/stocks/inbox/read').send({ reviewToken: first.inbox.reviewToken }))
      .status,
    200,
  );
  const unread = (await request(app()).get('/stocks/today')).body;
  assert.ok(unread.inbox.items.some((i: { signalId: string }) => i.signalId === '103'));
  assert.equal(
    (
      await request(app()).get(
        `/stocks/today?cursor=${encodeURIComponent(unread.inbox.nextCursor)}`,
      )
    ).body.inbox.items.length,
    3,
  );
  stockBriefRuntime.now = () => new Date(NOW.getTime() + 20 * 86_400_000);
  assert.equal(
    (await request(app()).get(`/stocks/today?cursor=${encodeURIComponent(first.inbox.nextCursor)}`))
      .status,
    400,
  );
  stockBriefCacheV1.clear();
  const weeksLater = (await request(app()).get('/stocks/today')).body;
  assert.equal(weeksLater.since, first.since);
  assert.equal(weeksLater.windowClamped, false);
  assert.equal(weeksLater.inbox.items.length, 50);
  assert.equal(weeksLater.changesUnavailable, false);
});

test('forged, expired and foreign-wallet proofs cannot save receipts; failures expose no proof', async () => {
  signals.push(event(1));
  const brief = (await request(app()).get('/stocks/today')).body;
  assert.equal(
    (
      await request(app(null))
        .post('/stocks/inbox/read')
        .send({ reviewToken: brief.inbox.reviewToken })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(app(OTHER))
        .post('/stocks/inbox/read')
        .send({ reviewToken: brief.inbox.reviewToken })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app())
        .post('/stocks/inbox/read')
        .send({ signalIds: ['1'], wallet: WALLET })
    ).status,
    400,
  );
  const [body, mac] = brief.inbox.reviewToken.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  payload.ids = ['2'];
  const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
  assert.equal(
    (await request(app()).post('/stocks/inbox/read').send({ reviewToken: forged })).status,
    400,
  );
  stockBriefRuntime.now = () => new Date(NOW.getTime() + 16 * 60_000);
  assert.equal(
    (await request(app()).post('/stocks/inbox/read').send({ reviewToken: brief.inbox.reviewToken }))
      .status,
    400,
  );
  assert.equal((await request(app()).get('/stocks/today')).body.inbox.items.length, 1);
  stockBriefRuntime.changes = async () => {
    throw new Error('secret-db-location');
  };
  const failed = (await request(app()).get('/stocks/today')).body;
  assert.equal(failed.inbox.reviewToken, null);
  assert.equal(failed.changesUnavailable, true);
  assert.doesNotMatch(JSON.stringify(failed), /secret-db-location/);
  const mcp = await connected();
  try {
    const invalid = await mcp.client.callTool({
      name: 'miorail_mark_stock_updates_read',
      arguments: { reviewToken: brief.inbox.reviewToken },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await mcp.close();
  }
});
