import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { InMemoryReopenGameRepositoryV1 } from '@mioagent/route-storage';
import {
  ReopenGameResponseV1Schema,
} from '@mioagent/rwa-market-reality/reopen-game';
import {
  etInstantV1,
  weekendMarketV1,
  type WeekendMarketRunV1,
  type WeekendMarketStockInputV1,
} from '@mioagent/rwa-market-reality/weekend-market';

import { createPublicReadCacheV1 } from './publicStocks.js';
import {
  REOPEN_DEVICE_HEADER_V1,
  reopenClaimRouter,
  reopenGameCachesV1,
  reopenGameRouter,
  reopenGameRuntime,
} from './reopenGame.js';

const et = (localDate: string, clock: string): Date => {
  const [hour, minute] = clock.split(':').map(Number);
  return etInstantV1(localDate, hour! * 60 + minute!);
};

function hourly(fromDate: string, fromClock: string, hours: number, mid: number, reference: number, referenceUpdatedAt: string): WeekendMarketRunV1[] {
  const start = et(fromDate, fromClock).getTime();
  return Array.from({ length: hours }, (_, index) => ({
    at: new Date(start + index * 3_600_000).toISOString(),
    mid,
    reference,
    referenceUpdatedAt,
  }));
}

const STOCKS: WeekendMarketStockInputV1[] = ['NVDA', 'TSLA', 'AAPL', 'AMZN', 'MSTR'].map((symbol, index) => ({
  tokenAddress: `0xb2${String(index + 1).padStart(38, '0')}`,
  symbol,
  name: `${symbol} Inc.`,
  runs: [
    ...hourly('2026-10-09', '14:05', 2, 100.05, 100, et('2026-10-09', '15:59').toISOString()),
    ...hourly('2026-10-10', '10:05', 30, 101, 100, et('2026-10-09', '15:59').toISOString()),
  ],
}));

const WALLET = '0x3333333333333333333333333333333333333333';

/** Every seam replaced, and put back after. Nothing reaches a database. */
function stubV1(t: test.TestContext, now: Date, signedIn: string | null = null) {
  const saved = { ...reopenGameRuntime };
  const savedCache = reopenGameCachesV1.shared;
  const repository = new InMemoryReopenGameRepositoryV1();
  let clock = now;
  let tokens = 0;
  Object.assign(reopenGameRuntime, {
    repository: () => repository,
    stocks: async () => STOCKS,
    weekend: async (at: Date) => weekendMarketV1({ now: at, stocks: STOCKS }),
    storageAvailable: async () => true,
    enabled: () => true,
    now: () => clock,
    newDeviceToken: () => `${String(++tokens).padStart(2, '0')}${'x'.repeat(41)}`,
  });
  reopenGameCachesV1.shared = createPublicReadCacheV1({ ttlMs: 30_000, max: 4 });
  t.after(() => {
    Object.assign(reopenGameRuntime, saved);
    reopenGameCachesV1.shared = savedCache;
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = signedIn
      ? { user: { id: `eip155:8453:${signedIn}`, address: signedIn, chainId: 8453 } }
      : {};
    next();
  });
  app.use('/api/public/reopen', reopenGameRouter);
  app.use('/api/reopen', reopenClaimRouter);
  return {
    app,
    repository,
    setNow: (next: Date) => {
      clock = next;
    },
  };
}

describe('Call the reopen over HTTP', () => {
  test('a visitor reads the round with no game of their own, never cached for others', async (t) => {
    const { app } = stubV1(t, et('2026-10-10', '12:00'));
    const response = await request(app).get('/api/public/reopen');
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    const game = ReopenGameResponseV1Schema.parse(response.body);
    assert.equal(game.round?.state, 'open');
    assert.equal(game.round?.number, 1);
    assert.equal(game.me, null);
  });

  test('a first pick without a wallet hands the device a token, and the token plays again', async (t) => {
    const { app } = stubV1(t, et('2026-10-10', '12:00'));
    const first = await request(app)
      .post('/api/public/reopen/picks')
      .send({ roundId: '2026-10-09', picks: { NVDA: 'up' } });
    assert.equal(first.status, 200);
    assert.match(first.body.device, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(first.body.game.me.picks, { NVDA: 'up' });
    assert.equal(first.body.game.me.signed, false);

    const again = await request(app)
      .post('/api/public/reopen/picks')
      .set(REOPEN_DEVICE_HEADER_V1, first.body.device)
      .send({ roundId: '2026-10-09', picks: { NVDA: 'down', TSLA: 'up' } });
    assert.equal(again.status, 200);
    assert.equal(again.body.device, null, 'the same device, no new token');
    assert.deepEqual(again.body.game.me.picks, { NVDA: 'down', TSLA: 'up' });

    const read = await request(app).get('/api/public/reopen').set(REOPEN_DEVICE_HEADER_V1, first.body.device);
    assert.deepEqual(read.body.me.picks, { NVDA: 'down', TSLA: 'up' });
  });

  test('a pick for another stock, another round, or after the lock is refused', async (t) => {
    const { app, setNow } = stubV1(t, et('2026-10-10', '12:00'));
    const unknown = await request(app).post('/api/public/reopen/picks').send({ roundId: '2026-10-09', picks: { META: 'up' } });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'unknown_stock');
    const other = await request(app).post('/api/public/reopen/picks').send({ roundId: '2026-10-02', picks: { NVDA: 'up' } });
    assert.equal(other.status, 409);
    assert.equal(other.body.code, 'round_not_open');
    const malformed = await request(app).post('/api/public/reopen/picks').send({ roundId: '2026-10-09', picks: { NVDA: 'maybe' } });
    assert.equal(malformed.status, 400);
    setNow(et('2026-10-11', '17:00'));
    const late = await request(app).post('/api/public/reopen/picks').send({ roundId: '2026-10-09', picks: { NVDA: 'up' } });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'round_locked');
  });

  test('a signed-in reader plays as their wallet', async (t) => {
    const { app, repository } = stubV1(t, et('2026-10-10', '12:00'), WALLET);
    const response = await request(app).post('/api/public/reopen/picks').send({ roundId: '2026-10-09', picks: { MSTR: 'up' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.device, null);
    assert.equal(response.body.game.me.signed, true);
    assert.deepEqual((await repository.picksOf(`w:${WALLET}`)).map((row) => row.picks), [{ MSTR: 'up' }]);
  });

  test('signing in moves a device’s picks to the wallet; without a session it is refused', async (t) => {
    const visitor = stubV1(t, et('2026-10-10', '12:00'));
    const first = await request(visitor.app).post('/api/public/reopen/picks').send({ roundId: '2026-10-09', picks: { NVDA: 'up' } });
    const token = first.body.device as string;
    const refused = await request(visitor.app).post('/api/reopen/claim').set(REOPEN_DEVICE_HEADER_V1, token);
    assert.equal(refused.status, 401);

    // The same store, now with a session.
    const signed = express();
    signed.use(express.json());
    signed.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } };
      next();
    });
    signed.use('/api/reopen', reopenClaimRouter);
    const claimed = await request(signed).post('/api/reopen/claim').set(REOPEN_DEVICE_HEADER_V1, token);
    assert.equal(claimed.status, 200);
    assert.deepEqual(claimed.body, { merged: true, moved: 1, dropped: 0 });
    assert.deepEqual((await visitor.repository.picksOf(`w:${WALLET}`)).map((row) => row.picks), [{ NVDA: 'up' }]);
    const twice = await request(signed).post('/api/reopen/claim').set(REOPEN_DEVICE_HEADER_V1, token);
    assert.deepEqual(twice.body, { merged: false, moved: 0, dropped: 0 });
  });
});
