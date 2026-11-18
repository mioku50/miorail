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
    // The error cache stays on (it was 0 here, and so the remembered failure
    // was never asked; audit P3 Earn, 2026-11-18).
    const cached = createCachedEarnDataSourceV1(upstream.source, {
      ttlMs: 1_000,
      errorTtlMs: 5_000,
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

    // The remembered failure answers the same way, without asking the provider.
    clock = 12_000;
    const remembered = await cached.observe(input());
    assert.equal(remembered.ok, true, 'the failure the cache remembers shows the same last-known-good reading');
    if (remembered.ok) assert.equal(remembered.observation.observedAt, '2026-07-25T08:59:50.000Z');
    assert.equal(upstream.calls(), 2);

    clock = 70_000;
    const surrendered = await cached.observe(input());
    assert.equal(surrendered.ok, false);
    if (!surrendered.ok) assert.equal(surrendered.reason, 'provider_unreachable');
    // Past staleServeMs the remembered failure is the answer too.
    clock = 72_000;
    const stillFailing = await cached.observe(input());
    assert.equal(stillFailing.ok, false);
    assert.equal(upstream.calls(), 3);
  });

  // Audit P3 Earn, 2026-11-18, measured with the defaults: a good reading at
  // 0 s, then a failing provider. 31 s showed the old reading, 32 s answered
  // the cached error without asking anyone, 37 s showed the reading again.
  test('one last-known-good rule whether the failure is fresh or remembered: 0 s, 31 s, 32 s, 37 s', async () => {
    const upstream = countingSource({ ok: true, observation: observation() });
    const start = NOW.getTime();
    let clock = start;
    const cached = createCachedEarnDataSourceV1(upstream.source, { now: () => clock });
    const seen: Array<{ seconds: number; providerCalls: number; result: string; observedAt: string | null }> = [];
    for (const seconds of [0, 31, 32, 37]) {
      clock = start + seconds * 1000;
      const result = await cached.observe(input());
      seen.push({
        seconds,
        providerCalls: upstream.calls(),
        result: result.ok ? 'observation' : result.reason,
        observedAt: result.ok ? result.observation.observedAt : null,
      });
      if (seconds === 0) upstream.setResult({ ok: false, reason: 'provider_timeout' });
    }
    const observedAt = '2026-07-25T08:59:50.000Z';
    assert.deepEqual(seen, [
      { seconds: 0, providerCalls: 1, result: 'observation', observedAt },
      { seconds: 31, providerCalls: 2, result: 'observation', observedAt },
      { seconds: 32, providerCalls: 2, result: 'observation', observedAt },
      { seconds: 37, providerCalls: 3, result: 'observation', observedAt },
    ]);
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
