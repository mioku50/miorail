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

test('InMemoryRateLimiter - reset at the window boundary', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const limiter = new InMemoryRateLimiter({ windowMs: 50, max: 1 });

  const res1 = await limiter.consume('user-5');
  assert.strictEqual(res1.success, true);

  const res2 = await limiter.consume('user-5');
  assert.strictEqual(res2.success, false);

  now += 50;

  const res3 = await limiter.consume('user-5');
  assert.strictEqual(res3.success, true);
});

test('InMemoryRateLimiter - cleanup removes records at their expiry', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const limiter = new InMemoryRateLimiter({ windowMs: 50, max: 1 });

  await limiter.consume('user-6');

  now += 50;

  limiter.cleanup();

  assert.strictEqual(limiter.size, 0);
});

test('InMemoryRateLimiter - finite storage evicts the least recently used key', async (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const limiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 3 });
  for (const key of ['a', 'b', 'c']) await limiter.consume(key);
  assert.strictEqual((await limiter.consume('a')).success, false);
  await limiter.consume('d');
  assert.strictEqual(limiter.size, 3);
  assert.strictEqual((await limiter.consume('a')).success, false, 'a recent blocked key remains blocked');
  assert.strictEqual((await limiter.consume('b')).success, true, 'eviction forgets the cold key rather than blocking it');
  assert.strictEqual(limiter.size, 3);
});

test('InMemoryRateLimiter - expired keys are swept without an explicit cleanup caller', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const limiter = new InMemoryRateLimiter({ windowMs: 50, max: 1, maxKeys: 2000 });
  await limiter.consume('expired');
  now += 50;
  for (let i = 0; i < 998; i++) await limiter.consume(`fresh-${i}`);
  assert.strictEqual(limiter.size, 999);
  await limiter.consume('sweep-trigger');
  assert.strictEqual(limiter.size, 999, 'the expired key was removed during the thousandth call');
});

test('InMemoryRateLimiter - full storage does not scan the map on each new key', async (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const limiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 5 });
  const sweep = t.mock.method(limiter, 'cleanup');
  for (let i = 0; i < 2500; i++) {
    assert.strictEqual((await limiter.consume(`key-${i}`)).success, true);
    assert.ok(limiter.size <= 5);
  }
  assert.strictEqual(sweep.mock.callCount(), 2, 'overflow must not add a full scan per insertion');
});

test('InMemoryRateLimiter - default storage is bounded at fifty thousand keys', async (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const limiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 1 });
  for (let i = 0; i < 50_005; i++) await limiter.consume(`key-${i}`);
  assert.strictEqual(limiter.size, 50_000);
});

test('InMemoryRateLimiter - invalid storage ceilings are rejected', () => {
  for (const maxKeys of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new InMemoryRateLimiter({ windowMs: 1000, max: 1, maxKeys }), /maxKeys/);
  }
});
