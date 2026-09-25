import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { InMemoryRateLimiter } from '@mioagent/utils';

import {
  createPublicReadCacheV1,
  publicStocksCachesV1,
  publicStocksRouter,
  publicStocksRuntime,
} from './publicStocks.js';

const NVDA = 'security:isin:US67066G1040';
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const ONE_K = '1000000000';

function appV1() {
  const app = express();
  app.use('/api/public/stocks', publicStocksRouter);
  return app;
}

type RuntimeV1 = typeof publicStocksRuntime;

/**
 * Every seam replaced, every call recorded, and everything put back after.
 * Nothing here may reach a database, a chain or a venue.
 */
function stubV1(t: test.TestContext, over: Partial<RuntimeV1> = {}) {
  const saved = { ...publicStocksRuntime };
  const calls: { read: string; args: unknown }[] = [];
  Object.assign(publicStocksRuntime, {
    limiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 1_000 }),
    enabled: () => true,
    storageAvailable: async () => true,
    dossierStorageAvailable: async () => true,
    chainConfigured: () => true,
    reviewed: async () => true,
    readIndex: async (args: unknown) => {
      calls.push({ read: 'index', args });
      return { schemaVersion: 'market-reality-index/v1', entries: [] } as never;
    },
    readReality: async (args: unknown) => {
      calls.push({ read: 'reality', args });
      return { schemaVersion: 'market-reality/v2', representations: [] } as never;
    },
    readHistory: async (question: unknown, window: unknown) => {
      calls.push({ read: 'history', args: { question, window } });
      return { schemaVersion: 'market-reality-history/v1' } as never;
    },
    readDossier: async (args: unknown) => {
      calls.push({ read: 'dossier', args });
      return { outcome: 'dossier' } as never;
    },
    readUseAccess: async (args: unknown) => {
      calls.push({ read: 'use_access', args });
      return { schemaVersion: 'representation-use-access/v1', wallet: null } as never;
    },
    ...over,
  });
  for (const cache of Object.values(publicStocksCachesV1)) cache.clear();
  t.after(() => {
    Object.assign(publicStocksRuntime, saved);
    for (const cache of Object.values(publicStocksCachesV1)) cache.clear();
  });
  return calls;
}

const realityPath = (size = ONE_K) =>
  `/api/public/stocks/market-reality/${encodeURIComponent(NVDA)}?direction=sell&requestedCashAtomic=${size}&destination=USDC`;

test('the board answers with no session at all', async (t) => {
  const calls = stubV1(t);
  const app = appV1();
  await request(app).get('/api/public/stocks/underlyings').expect(200);
  const reality = await request(app).get(realityPath()).expect(200);
  await request(app).get(`/api/public/stocks/official/${NVDAC}/dossier`).expect(200);
  await request(app).get(`/api/public/stocks/use-access/${NVDAC}`).expect(200);
  await request(app)
    .get(
      `/api/public/stocks/market-reality/${encodeURIComponent(NVDA)}/history?direction=sell&requestedCashAtomic=${ONE_K}&destination=USDC&window=7d`,
    )
    .expect(200);
  assert.deepEqual(
    calls.map((call) => call.read),
    ['index', 'reality', 'dossier', 'use_access', 'history'],
  );
  // The data behind a page, not the page: a search result must never open JSON.
  assert.equal(reality.headers['x-robots-tag'], 'noindex');
  assert.match(String(reality.headers['cache-control']), /public, max-age=30/);
});

test('the public door carries no wallet and no tenant, by construction', async (t) => {
  const calls = stubV1(t);
  const app = appV1();
  await request(app).get(`/api/public/stocks/official/${NVDAC}/dossier`).expect(200);
  await request(app).get(`/api/public/stocks/use-access/${NVDAC}`).expect(200);
  assert.deepEqual(calls.find((call) => call.read === 'dossier')?.args, {
    tokenAddress: NVDAC,
    tenantId: null,
  });
  assert.deepEqual(calls.find((call) => call.read === 'use_access')?.args, {
    tokenAddress: NVDAC,
    walletAddress: null,
  });
});

test('a repeated question is answered from the cache, and a burst shares one read', async (t) => {
  const calls = stubV1(t);
  const app = appV1();
  await Promise.all([
    request(app).get(realityPath()).expect(200),
    request(app).get(realityPath()).expect(200),
    request(app).get(realityPath()).expect(200),
  ]);
  await request(app).get(realityPath()).expect(200);
  assert.equal(calls.filter((call) => call.read === 'reality').length, 1);
  // A different exact question is a different read.
  await request(app).get(realityPath('100000000')).expect(200);
  assert.equal(calls.filter((call) => call.read === 'reality').length, 2);
});

test('a failure is never cached: the next caller asks again', async (t) => {
  let attempts = 0;
  stubV1(t, {
    readReality: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('upstream said something with a URL in it');
      return { schemaVersion: 'market-reality/v2', representations: [] } as never;
    },
  });
  const app = appV1();
  const failed = await request(app).get(realityPath()).expect(500);
  // A stable code, never the upstream message.
  assert.deepEqual(failed.body, { error: 'market_reality_failed', code: 'market_reality_failed' });
  await request(app).get(realityPath()).expect(200);
  assert.equal(attempts, 2);
});

test('only the four measured sizes are answered without a session', async (t) => {
  const calls = stubV1(t);
  const response = await request(appV1()).get(realityPath('1234567')).expect(400);
  assert.equal(response.body.code, 'size_not_on_public_ladder');
  assert.equal(calls.length, 0, 'an off-ladder size must not reach the assembly');
});

test('use & access is held to the reviewed corpus', async (t) => {
  const calls = stubV1(t, { reviewed: async () => false });
  const response = await request(appV1())
    .get('/api/public/stocks/use-access/0x1111111111111111111111111111111111111111')
    .expect(404);
  assert.equal(response.body.code, 'representation_not_reviewed');
  assert.match(String(response.body.detail), /never about the token/);
  assert.equal(calls.length, 0, 'an unreviewed address must not aim a chain read');
});

test('a ticker is not an address anywhere on this door', async (t) => {
  const calls = stubV1(t);
  const app = appV1();
  await request(app).get('/api/public/stocks/use-access/NVDAc').expect(400);
  await request(app).get('/api/public/stocks/official/NVDAc/dossier').expect(400);
  assert.equal(calls.length, 0);
});

test('the operator switch closes the public door too', async (t) => {
  const calls = stubV1(t, { enabled: () => false });
  const response = await request(appV1()).get('/api/public/stocks/underlyings').expect(404);
  assert.equal(response.body.code, 'route_intelligence_disabled');
  assert.equal(calls.length, 0);
});

test('one address is limited, and the limit is said in the headers', async (t) => {
  stubV1(t, { limiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 2 }) });
  const app = appV1();
  await request(app).get('/api/public/stocks/underlyings').expect(200);
  await request(app).get('/api/public/stocks/underlyings').expect(200);
  const refused = await request(app).get('/api/public/stocks/underlyings').expect(429);
  assert.equal(refused.body.code, 'rate_limited');
  assert.equal(refused.headers['x-ratelimit-remaining'], '0');
});

test('storage that will not answer is an outage here, not a finding', async (t) => {
  const calls = stubV1(t, { storageAvailable: async () => false });
  const response = await request(appV1()).get(realityPath()).expect(503);
  assert.equal(response.body.code, 'market_reality_storage_unavailable');
  assert.equal(calls.length, 0);
});

test('the cache expires on its own clock and evicts the oldest past its bound', async () => {
  let now = 0;
  const cache = createPublicReadCacheV1({ ttlMs: 1_000, max: 2, now: () => now });
  let runs = 0;
  const work = async () => {
    runs += 1;
    return runs;
  };
  assert.equal(await cache.read('a', work), 1);
  assert.equal(await cache.read('a', work), 1);
  now = 1_000;
  assert.equal(await cache.read('a', work), 2, 'a read at the TTL is a new read');
  await cache.read('b', work);
  await cache.read('c', work);
  // `a` was the oldest insertion and the bound is two.
  now = 1_001;
  assert.equal(await cache.read('a', work), 5);
});

test('the weekend is one public read per five-minute slot, and state none is an answer', async (t) => {
  const reads: string[] = [];
  stubV1(t, {
    now: () => new Date('2026-09-27T22:00:00.000Z'),
    readWeekend: async (now: Date) => {
      reads.push(now.toISOString());
      return {
        schemaVersion: 'weekend-market/v1',
        state: 'in_progress',
        generatedAt: now.toISOString(),
        window: null,
        stocks: [],
        called: null,
      } as never;
    },
  });
  const app = appV1();
  const first = await request(app).get('/api/public/stocks/weekend').expect(200);
  await request(app).get('/api/public/stocks/weekend').expect(200);
  assert.equal(first.body.state, 'in_progress');
  // A burst of readers inside one slot is one read.
  assert.deepEqual(reads, ['2026-09-27T22:00:00.000Z']);
  assert.equal(first.headers['x-robots-tag'], 'noindex');
});

test('a weekend read that fails is an outage, never cached', async (t) => {
  let attempts = 0;
  stubV1(t, {
    now: () => new Date('2026-09-27T22:00:00.000Z'),
    readWeekend: async () => {
      attempts += 1;
      throw new Error('database down');
    },
  });
  const app = appV1();
  const failed = await request(app).get('/api/public/stocks/weekend').expect(500);
  assert.equal(failed.body.code, 'weekend_market_failed');
  assert.doesNotMatch(JSON.stringify(failed.body), /database down/);
  await request(app).get('/api/public/stocks/weekend').expect(500);
  assert.equal(attempts, 2);
});
