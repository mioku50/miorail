import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import express from 'express';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { rateLimit } from './rate-limit';

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
