import test from 'node:test';
import assert from 'node:assert';
import { InMemoryRateLimiter } from './rate-limit.js';

test('InMemoryRateLimiter - consume tokens successfully', async () => {
  const limiter = new InMemoryRateLimiter({ windowMs: 1000, max: 2 });

  const res1 = await limiter.consume('user-1');
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.remaining, 1);

  const res2 = await limiter.consume('user-1');
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.remaining, 0);
});

test('InMemoryRateLimiter - reject when limit exceeded', async () => {
  const limiter = new InMemoryRateLimiter({ windowMs: 1000, max: 1 });

  const res1 = await limiter.consume('user-2');
  assert.strictEqual(res1.success, true);

  const res2 = await limiter.consume('user-2');
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.remaining, 0);
});

test('InMemoryRateLimiter - isolation between keys', async () => {
  const limiter = new InMemoryRateLimiter({ windowMs: 1000, max: 1 });

  const res1 = await limiter.consume('user-3');
  assert.strictEqual(res1.success, true);

  const res2 = await limiter.consume('user-4');
  assert.strictEqual(res2.success, true);
});

test('InMemoryRateLimiter - reset after window expires', async () => {
  const limiter = new InMemoryRateLimiter({ windowMs: 50, max: 1 });

  const res1 = await limiter.consume('user-5');
  assert.strictEqual(res1.success, true);

  const res2 = await limiter.consume('user-5');
  assert.strictEqual(res2.success, false);

  // Wait for window to expire
  await new Promise(resolve => setTimeout(resolve, 60));

  const res3 = await limiter.consume('user-5');
  assert.strictEqual(res3.success, true);
});

test('InMemoryRateLimiter - cleanup removes expired records', async () => {
  const limiter = new InMemoryRateLimiter({ windowMs: 50, max: 1 });

  await limiter.consume('user-6');

  // Wait for window to expire
  await new Promise(resolve => setTimeout(resolve, 60));

  limiter.cleanup();

  // Since it's private, we can't assert on store size directly easily without casting
  // @ts-expect-error Accessing private property for testing
  const storeSize = limiter.store.size;
  assert.strictEqual(storeSize, 0);
});
