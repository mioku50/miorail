import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import express from 'express';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { rateLimit, rateLimitPathV1 } from './rate-limit';

test('Rate Limit Middleware', async (t) => {
  const app = express();
  const limiter = new InMemoryRateLimiter({ windowMs: 1000, max: 2 });

  app.use(rateLimit(limiter));

  app.get('/test', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  await t.test('allows requests within limit and sets headers', async () => {
    // First request
    const res1 = await request(app).get('/test');
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.headers['x-ratelimit-limit'], '2');
    assert.strictEqual(res1.headers['x-ratelimit-remaining'], '1');
    assert.ok(res1.headers['x-ratelimit-reset']);

    // Second request
    const res2 = await request(app).get('/test');
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.headers['x-ratelimit-remaining'], '0');
  });

  await t.test('blocks requests exceeding limit', async () => {
    // Third request (exceeds max of 2)
    const res3 = await request(app).get('/test');
    assert.strictEqual(res3.status, 429);
    assert.strictEqual(res3.body.error, 'Too Many Requests');
    assert.strictEqual(res3.headers['x-ratelimit-remaining'], '0');
  });
});

test('case and a trailing slash cannot obtain a second route budget', async () => {
  const app = express();
  app.use(rateLimit(new InMemoryRateLimiter({ windowMs: 60_000, max: 1 })));
  app.post('/api/auth/verify', (_req, res) => res.sendStatus(200));
  assert.strictEqual((await request(app).post('/api/auth/verify')).status, 200);
  assert.strictEqual((await request(app).post('/api/auth/VERIFY/')).status, 429);
});

test('encoded spellings spend the same budget even when Express rejects their route', async () => {
  const app = express();
  app.use(rateLimit(new InMemoryRateLimiter({ windowMs: 60_000, max: 2 })));
  app.post('/api/auth/verify', (_req, res) => res.sendStatus(200));
  assert.strictEqual((await request(app).post('/api/auth/%76erify')).status, 404);
  assert.strictEqual((await request(app).post('/api/auth/verify')).status, 200);
  assert.strictEqual((await request(app).post('/api/auth/VERIFY/')).status, 429);
});

test('malformed URL escapes cannot crash the limiter', async () => {
  for (const path of ['/%', '/%E0%A4%A', '/%ZZ/']) {
    assert.strictEqual(rateLimitPathV1(path), path.toLowerCase().replace(/\/$/, ''));
    const app = express();
    app.use(rateLimit(new InMemoryRateLimiter({ windowMs: 60_000, max: 1 })));
    app.use((_req, res) => res.sendStatus(200));
    assert.strictEqual((await request(app).get(path)).status, 200);
    assert.strictEqual((await request(app).get(path)).status, 429);
  }
  assert.strictEqual(rateLimitPathV1('/'), '/');
  assert.strictEqual(rateLimitPathV1('/api/auth/%76erify/'), '/api/auth/verify');
});

test('the 601st unique path is refused before allocating a path counter, with its actual limit', async (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const app = express();
  // Trust the test's synthetic client addresses; production trusts its own proxy.
  app.set('trust proxy', true);
  const perPath = new InMemoryRateLimiter({ windowMs: 60_000, max: 100 });
  const calls = t.mock.method(perPath, 'consume');
  app.use(rateLimit(perPath, new InMemoryRateLimiter({ windowMs: 60_000, max: 600 })));
  app.use((_req, res) => res.sendStatus(200));
  for (let i = 0; i < 600; i++) {
    assert.strictEqual((await request(app).get(`/api/unknown-${i}`).set('X-Forwarded-For', '198.51.100.1')).status, 200);
  }
  const blocked = await request(app).get('/api/another-unknown').set('X-Forwarded-For', '198.51.100.1');
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.headers['x-ratelimit-limit'], '600');
  assert.strictEqual(blocked.headers['x-ratelimit-remaining'], '0');
  assert.strictEqual(calls.mock.callCount(), 600);
  assert.strictEqual(perPath.size, 600);
  assert.strictEqual((await request(app).get('/api/another-unknown').set('X-Forwarded-For', '198.51.100.2')).status, 200);
});

test('stock icons have independent path budgets under the shared address ceiling', async () => {
  const app = express();
  app.use(rateLimit(
    new InMemoryRateLimiter({ windowMs: 60_000, max: 2 }),
    new InMemoryRateLimiter({ windowMs: 60_000, max: 600 }),
  ));
  app.use((_req, res) => res.sendStatus(200));
  for (const symbol of ['NVDA', 'AAPL', 'SONY']) {
    for (let i = 0; i < 2; i++) assert.strictEqual((await request(app).get(`/api/public/stocks/icons/${symbol}`)).status, 200);
  }
  assert.strictEqual((await request(app).get('/api/public/stocks/icons/NVDA')).status, 429);
  assert.strictEqual((await request(app).get('/api/public/stocks/icons/TSLA')).status, 200);
});
