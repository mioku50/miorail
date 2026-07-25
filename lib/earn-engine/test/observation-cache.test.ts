import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCachedEarnDataSourceV1,
  earnObservationCacheKeyV1,
  pinnedEarnVenueV1,
  type EarnDataSourceObserveInput,
  type EarnDataSourceV1,
  type EarnObservationResultV1,
  type EarnObservationV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T63A §5 — the observation cache. The properties under test are the ones that
// keep the cache honest: it coalesces, it expires, it forgets failures quickly,
// and — the important one — it NEVER re-stamps an observation, so a cache hit
// can not turn an old reading into a fresh one.
// ---------------------------------------------------------------------------

const MOONWELL_VENUE = pinnedEarnVenueV1('moonwell');
const MORPHO_VENUE = pinnedEarnVenueV1('morpho');
const NOW = new Date('2026-07-25T09:00:00.000Z');

function input(venue = MOONWELL_VENUE, protocol: 'moonwell' | 'morpho' = 'moonwell'): EarnDataSourceObserveInput {
  return { protocol, venue, amountAtomic: '500000000', now: NOW };
}

function observation(overrides: Partial<EarnObservationV1> = {}): EarnObservationV1 {
  return {
    baseApyBps: 500,
    rewardApyBps: 25,
    netApyBps: 525,
    availableLiquidityAtomic: '1000000000000',
    fees: { performanceFeeBps: null, managementFeeBps: null },
    withdrawalTerms: { model: 'direct', instant: true, noticePeriodSeconds: null },
    blockNumber: '49089882',
    observedAt: '2026-07-25T08:59:50.000Z',
    expiresAt: '2026-07-25T09:04:50.000Z',
    requestHash: `0x${'1'.repeat(64)}`,
    responseHash: `0x${'2'.repeat(64)}`,
    sourceIndependence: 'unknown',
    providerId: 'fake-live',
    providerDisplayName: 'Fake Live',
    ...overrides,
  };
}

interface CountingSource {
  source: EarnDataSourceV1;
  calls: () => number;
  setResult: (result: EarnObservationResultV1) => void;
  release: () => void;
  setDeferred: (deferred: boolean) => void;
}

function countingSource(initial: EarnObservationResultV1): CountingSource {
  let calls = 0;
  let result = initial;
  let deferred = false;
  let waiters: (() => void)[] = [];
  return {
    source: {
      id: 'fake-live',
      async observe() {
        calls += 1;
        if (deferred) await new Promise<void>((resolve) => waiters.push(resolve));
        return result;
      },
    },
    calls: () => calls,
    setResult: (next) => {
      result = next;
    },
    release: () => {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    },
    setDeferred: (value) => {
      deferred = value;
    },
  };
}

describe('earn observation cache', () => {
  test('concurrent observes for the same venue collapse into ONE upstream call', async () => {
    const upstream = countingSource({ ok: true, observation: observation() });
    upstream.setDeferred(true);
    const cached = createCachedEarnDataSourceV1(upstream.source, { ttlMs: 30_000, now: () => 0 });

    const pending = [cached.observe(input()), cached.observe(input()), cached.observe(input())];
    // All three are waiting on the single in-flight request.
    assert.equal(upstream.calls(), 1);
    upstream.release();
    const results = await Promise.all(pending);
    assert.equal(upstream.calls(), 1);
    for (const result of results) {
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.observation.responseHash, `0x${'2'.repeat(64)}`);
    }
  });

  test('the key is provider + pinned contract + chain, so venues never share an entry', async () => {
    const upstream = countingSource({ ok: true, observation: observation() });
    const cached = createCachedEarnDataSourceV1(upstream.source, { ttlMs: 30_000, now: () => 0 });
    await cached.observe(input(MOONWELL_VENUE, 'moonwell'));
    await cached.observe(input(MORPHO_VENUE, 'morpho'));
    await cached.observe(input(MOONWELL_VENUE, 'moonwell'));
    assert.equal(upstream.calls(), 2);
    assert.notEqual(
      earnObservationCacheKeyV1('fake-live', input(MOONWELL_VENUE, 'moonwell')),
      earnObservationCacheKeyV1('fake-live', input(MORPHO_VENUE, 'morpho')),
    );
    assert.match(earnObservationCacheKeyV1('fake-live', input()), /fake-live\|8453\|moonwell\|0x/);
  });

  test('a cache hit is served verbatim — the observation time is never re-stamped', async () => {
    const upstream = countingSource({ ok: true, observation: observation() });
    let clock = 0;
    const cached = createCachedEarnDataSourceV1(upstream.source, { ttlMs: 30_000, now: () => clock });

    const first = await cached.observe(input());
    clock = 29_000;
    const second = await cached.observe(input());
    assert.equal(upstream.calls(), 1);
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    // Same observedAt/expiresAt: freshness is judged against the PROVIDER's
    // observation instant, so age keeps accruing while it sits in the cache.
    assert.equal(second.observation.observedAt, first.observation.observedAt);
    assert.equal(second.observation.expiresAt, first.observation.expiresAt);

    clock = 31_000;
    await cached.observe(input());
    assert.equal(upstream.calls(), 2);
  });

  test('a stale upstream reading stays stale through the cache', async () => {
    const stale = observation({ observedAt: '2026-07-25T08:00:00.000Z', expiresAt: '2026-07-25T08:05:00.000Z' });
    const upstream = countingSource({ ok: true, observation: stale });
    const cached = createCachedEarnDataSourceV1(upstream.source, { ttlMs: 30_000, now: () => 0 });
    const result = await cached.observe(input());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(Date.parse(result.observation.expiresAt) < NOW.getTime(), true);
  });

  test('failures are remembered briefly, then retried', async () => {
    const upstream = countingSource({ ok: false, reason: 'provider_timeout' });
    let clock = 0;
    const cached = createCachedEarnDataSourceV1(upstream.source, {
      ttlMs: 30_000,
      errorTtlMs: 5_000,
      staleServeMs: 0,
      now: () => clock,
    });

    assert.equal((await cached.observe(input())).ok, false);
    clock = 4_000;
    assert.equal((await cached.observe(input())).ok, false);
    assert.equal(upstream.calls(), 1, 'a broken provider is not hammered inside the error TTL');

    clock = 6_000;
    upstream.setResult({ ok: true, observation: observation() });
    const recovered = await cached.observe(input());
    assert.equal(recovered.ok, true);
    assert.equal(upstream.calls(), 2, 'a recovered provider is picked up as soon as the error TTL lapses');
  });

  test('a last-known-good reading is served while the provider is failing, and expires honestly', async () => {
    const upstream = countingSource({ ok: true, observation: observation() });
    let clock = 0;
    const cached = createCachedEarnDataSourceV1(upstream.source, {
      ttlMs: 1_000,
      errorTtlMs: 0,
      staleServeMs: 60_000,
      now: () => clock,
    });

    const good = await cached.observe(input());
    assert.equal(good.ok, true);

    upstream.setResult({ ok: false, reason: 'provider_unreachable' });
    clock = 10_000;
    const rescued = await cached.observe(input());
    assert.equal(rescued.ok, true, 'last-known-good is shown rather than dropped');
    if (rescued.ok) {
      // Original timestamps: downstream this reads as stale, not as fresh data.
      assert.equal(rescued.observation.observedAt, '2026-07-25T08:59:50.000Z');
    }

    clock = 70_000;
    const surrendered = await cached.observe(input());
    assert.equal(surrendered.ok, false);
    if (!surrendered.ok) assert.equal(surrendered.reason, 'provider_unreachable');
  });

  test('staleServeMs=0 surfaces the failure immediately', async () => {
    const upstream = countingSource({ ok: true, observation: observation() });
    let clock = 0;
    const cached = createCachedEarnDataSourceV1(upstream.source, {
      ttlMs: 0,
      errorTtlMs: 0,
      staleServeMs: 0,
      now: () => clock,
    });
    assert.equal((await cached.observe(input())).ok, true);
    upstream.setResult({ ok: false, reason: 'provider_http_error' });
    clock = 1;
    assert.equal((await cached.observe(input())).ok, false);
  });
});
