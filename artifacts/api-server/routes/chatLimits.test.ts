import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { chatLimitsRuntimeV1, chatLimitsV1 } from '../middleware/chatLimits.js';
import { chatRouter, chatRouteRuntime } from './chat.js';

const original = { limiter: chatLimitsRuntimeV1.limiter, timeoutMs: chatRouteRuntime.timeoutMs,
  factory: chatRouteRuntime.createApiToolAggregatorForUser };
beforeEach(() => { chatLimitsRuntimeV1.limiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 12 }); });
afterEach(() => {
  chatLimitsRuntimeV1.limiter = original.limiter;
  chatRouteRuntime.timeoutMs = original.timeoutMs;
  chatRouteRuntime.createApiToolAggregatorForUser = original.factory;
});

function fixture(router = false) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const address = `0x${String(req.get('x-test-wallet') === 'other' ? '2' : '1').repeat(40)}` as `0x${string}`;
    // Local fixture identity, never an HTTP-controlled identity in production.
    req.session = { user: { id: `eip155:8453:${address}`, address, chainId: 8453 } } as typeof req.session;
    next();
  });
  if (router) app.use('/api/chat', chatRouter);
  else app.post('/api/chat', chatLimitsV1, (_req, res) => { res.json({ ok: true }); });
  return app;
}

test('4000 characters are accepted; oversized and empty messages stop before tools are created', async () => {
  await request(fixture()).post('/api/chat').send({ message: 'x'.repeat(4000) }).expect(200);
  let created = 0;
  chatRouteRuntime.createApiToolAggregatorForUser = async () => { created++; throw new Error('unexpected tools'); };
  const app = fixture(true);
  for (const message of ['', 'x'.repeat(4001), '😀'.repeat(2001)]) {
    const res = await request(app).post('/api/chat').send({ message }).expect(400);
    assert.equal(res.body.code, 'invalid_chat_message');
  }
  assert.equal(created, 0);
});

test('a wallet gets 12 messages per minute across sessions and IPs; another wallet is independent', async () => {
  const app = fixture();
  for (let i = 0; i < 12; i++) {
    await request(app).post('/api/chat').set('X-Forwarded-For', `198.51.100.${i + 1}`)
      .send({ message: 'hello', walletAddress: `0x${String(i).padStart(40, '0')}` }).expect(200);
  }
  const denied = await request(app).post('/api/chat').send({ message: 'hello' }).expect(429);
  assert.equal(denied.body.code, 'chat_rate_limited');
  assert.ok(Number(denied.headers['retry-after']) > 0);
  await request(app).post('/api/chat').set('x-test-wallet', 'other').send({ message: 'hello' }).expect(200);
});

test('a hung real chat setup is bounded before it can read the database or call an LLM', async () => {
  chatRouteRuntime.timeoutMs = 10;
  chatRouteRuntime.createApiToolAggregatorForUser = async () => new Promise<never>(() => {});
  const result = await request(fixture(true)).post('/api/chat').send({ message: 'hello' }).expect(504);
  assert.equal(result.body.code, 'chat_timeout');
});
