import test, { describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  InMemoryProviderCacheStore,
  ProviderBudget,
  cachedProviderCall,
  clearProviderCacheForTests,
} from './providerCache.js';

describe('Provider Cache Orchestration', () => {
  beforeEach(() => {
    clearProviderCacheForTests();
  });

  test('cache hit avoids provider call', async () => {
    const store = new InMemoryProviderCacheStore();
    const budget = new ProviderBudget(20, 300);
    const fetcher = mock.fn(async () => ({ value: 'fresh' }));

    const first = await cachedProviderCall({
      key: 'provider:moralis:balances:8453:0xabc',
      provider: 'moralis',
      chainId: 8453,
      ttlSeconds: 1800,
      store,
      budget,
      fetcher,
    });
    assert.strictEqual(first.status, 'live');
    assert.strictEqual(first.providerCalled, true);
    assert.strictEqual(fetcher.mock.calls.length, 1);

    const second = await cachedProviderCall({
      key: 'provider:moralis:balances:8453:0xabc',
      provider: 'moralis',
      chainId: 8453,
      ttlSeconds: 1800,
      store,
      budget,
      fetcher,
    });
    assert.strictEqual(second.status, 'cached');
    assert.strictEqual(second.providerCalled, false);
    assert.deepStrictEqual(second.data, { value: 'fresh' });
    // Fetcher must NOT be called again on a cache hit.
    assert.strictEqual(fetcher.mock.calls.length, 1);
  });

  test('stale cache is returned when provider fails', async () => {
    const store = new InMemoryProviderCacheStore();
    const budget = new ProviderBudget(20, 300);

    // Seed a live entry with a zero TTL so it is immediately stale on the next read.
    const goodFetcher = async () => ({ tokens: ['USDC'] });
    await cachedProviderCall({
      key: 'provider:moralis:balances:8453:0xdef',
      provider: 'moralis',
      chainId: 8453,
      ttlSeconds: 0,
      store,
      budget,
      fetcher: goodFetcher,
    });

    // Yield so the next read sees the entry as expired.
    await new Promise((r) => setTimeout(r, 5));

    const failingFetcher = mock.fn(async () => {
      throw new Error('Moralis API error: 500');
    });
    const result = await cachedProviderCall({
      key: 'provider:moralis:balances:8453:0xdef',
      provider: 'moralis',
      chainId: 8453,
      ttlSeconds: 1,
      store,
      budget,
      fetcher: failingFetcher,
    });

    assert.strictEqual(result.status, 'stale');
    assert.strictEqual(result.providerCalled, true);
    assert.deepStrictEqual(result.data, { tokens: ['USDC'] });
    assert.ok(result.error?.includes('Moralis API error'));
  });

  test('in-flight dedup prevents duplicate provider calls', async () => {
    const store = new InMemoryProviderCacheStore();
    const budget = new ProviderBudget(20, 300);

    let resolves: (() => void) | null = null;
    const fetcher = mock.fn(async () => {
      await new Promise<void>((r) => {
        resolves = r;
      });
      return { value: 1 };
    });

    const key = 'provider:goplus:security:8453:0x123';
    const params = {
      key,
      provider: 'goplus' as const,
      chainId: 8453,
      ttlSeconds: 21600,
      store,
      budget,
      fetcher,
    };

    const p1 = cachedProviderCall(params);
    const p2 = cachedProviderCall(params);

    // Let the in-flight fetcher resolve.
    await new Promise((r) => setTimeout(r, 5));
    resolves!();

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.strictEqual(fetcher.mock.calls.length, 1);
    assert.strictEqual(r1.status, 'live');
    assert.strictEqual(r2.status, 'live');
    assert.deepStrictEqual(r1.data, { value: 1 });
  });

  test('provider budget exhaustion returns cached data without calling provider', async () => {
    const store = new InMemoryProviderCacheStore();
    // maxPerMinute = 1 so the second call is budget-blocked.
    const budget = new ProviderBudget(1, 300);

    const fetcher = mock.fn(async () => ({ value: 'live-data' }));

    const params = (ttlSeconds = 1800) => ({
      key: 'provider:moralis:balances:8453:0xbudget',
      provider: 'moralis' as const,
      chainId: 8453,
      ttlSeconds,
      store,
      budget,
      fetcher,
    });

    // Seed a live entry with a zero TTL so it is immediately stale on the next read.
    const first = await cachedProviderCall(params(0));
    assert.strictEqual(first.status, 'live');
    assert.strictEqual(first.budgetExhausted, false);
    assert.strictEqual(fetcher.mock.calls.length, 1);

    // Yield so the next read sees the entry as expired — but budget is now exhausted.
    await new Promise((r) => setTimeout(r, 5));
    const second = await cachedProviderCall(params(0));
    assert.strictEqual(second.status, 'stale');
    assert.strictEqual(second.budgetExhausted, true);
    assert.strictEqual(second.providerCalled, false);
    assert.deepStrictEqual(second.data, { value: 'live-data' });
    // Fetcher NOT called again.
    assert.strictEqual(fetcher.mock.calls.length, 1);
  });

  test('budget snapshot reports correct counts', async () => {
    const budget = new ProviderBudget(20, 300);
    assert.strictEqual(budget.snapshot('moralis').callsLastMinute, 0);
    budget.record('moralis');
    budget.record('moralis');
    const snap = budget.snapshot('moralis');
    assert.strictEqual(snap.callsLastMinute, 2);
    assert.strictEqual(snap.callsLastHour, 2);
    assert.strictEqual(snap.status, 'ok');
  });

  test('disabled budget (0 limits) blocks all calls', async () => {
    const store = new InMemoryProviderCacheStore();
    const budget = new ProviderBudget(0, 0);
    const fetcher = mock.fn(async () => ({ value: 'never' }));
    const result = await cachedProviderCall({
      key: 'provider:moralis:balances:8453:0xnone',
      provider: 'moralis',
      chainId: 8453,
      ttlSeconds: 1800,
      store,
      budget,
      fetcher,
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.providerCalled, false);
    assert.strictEqual(result.budgetExhausted, true);
    assert.strictEqual(fetcher.mock.calls.length, 0);
  });

  test('per-provider budget override disables one provider while leaving others running', async () => {
    // Global default 20/300, but Moralis is capped to 0 hourly calls -> disabled via budget.
    const budget = new ProviderBudget(20, 300, {
      moralis: { maxPerMinute: 20, maxPerHour: 0 },
    });
    assert.strictEqual(budget.canCall('moralis'), false);
    assert.strictEqual(budget.snapshot('moralis').status, 'disabled');
    // Other providers still use the global default and remain callable.
    assert.strictEqual(budget.canCall('goplus'), true);
    assert.strictEqual(budget.snapshot('goplus').status, 'ok');
    assert.strictEqual(budget.canCall('coingecko'), true);
  });

  test('per-provider budget override enforces an independent hourly cap', async () => {
    const budget = new ProviderBudget(20, 300, {
      goplus: { maxPerMinute: 20, maxPerHour: 1 },
    });
    assert.strictEqual(budget.canCall('goplus'), true);
    budget.record('goplus');
    // One hourly call recorded -> goplus is now rate-limited, moralis is unaffected.
    assert.strictEqual(budget.canCall('goplus'), false);
    assert.strictEqual(budget.snapshot('goplus').status, 'rate-limited');
    assert.strictEqual(budget.canCall('moralis'), true);
  });
});
