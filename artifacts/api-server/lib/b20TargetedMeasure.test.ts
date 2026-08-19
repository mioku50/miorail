import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  b20ObservationNeedsRefreshV1,
  b20TargetedMeasureBudgetMsV1,
  b20TargetedMeasureInFlightCountV1,
  measureB20TokenOnDemandV1,
  B20_TARGETED_MEASURE_MAX_PER_REQUEST_V1,
} from './b20TargetedMeasure.js';

// ---------------------------------------------------------------------------
// The reading a reader causes.
//
// Every test here is about a bound or about a distinction. The bounds keep an
// HTTP request from becoming an unmetered measurement run; the distinctions
// keep Miorail's own failure from being reported as a fact about a token.
// ---------------------------------------------------------------------------

const TOKEN = '0xb200000000000000000000195a5f43905160ee03';

const LAUNCH = { launchId: `${TOKEN}:0`, tokenAddress: TOKEN, blockNumber: '49929300' };

/**
 * A pass whose only real part is the measurement it returns.
 *
 * `measureB20LaunchOnceV1` calls `deps.readAnchor()` first and stores nothing
 * without one, so a null anchor is the whole `provider_unavailable` path and
 * needs no other stub.
 */
function pass(options: {
  anchor?: boolean;
  state?: string;
  reasonCode?: string | null;
  throws?: boolean;
  delayMs?: number;
}) {
  const observation = {
    getObservation: async () => null,
    insertObservation: async (row: unknown) => ({ observation: row, inserted: true }),
  };
  return {
    observations: observation as never,
    deps: {
      readAnchor: async () => {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        if (options.throws) throw new Error('endpoint exploded');
        return options.anchor === false
          ? null
          : { blockNumber: '50044247', blockHash: `0x${'a'.repeat(64)}`, blockTag: '0x2fb9f14' };
      },
      readFactoryStatus: async () => ({ isB20: true, initialized: true }),
      analyseRoutes: async () => ({
        entryRouteFound: false,
        exitRouteFound: false,
        degraded: options.state === 'unmeasured',
        candidatesTotal: 1,
        candidatesAnswered: options.state === 'unmeasured' ? 0 : 1,
        entryOutputAtomic: null,
        exitReturnAtomic: null,
        entryRouteHash: null,
        exitRouteHash: null,
        entrySourceKey: null,
        exitSourceKey: null,
        poolHookAddress: null,
        probes: [],
        venuesConsulted: ['uniswap-v4'],
        routerCalls: 1,
        // The zero address is native ETH in the storage enum. B20's v4 pools
        // are ETH-quoted, which is why the pass records the pair it MEASURED
        // rather than the one the profile asked for.
        quoteAssetUsed: '0x0000000000000000000000000000000000000000',
        positionAtomicUsed: '30000000000000000',
        quoteAlignment: 'anchored',
      }),
      readControls: async () => null,
      quoteAlignment: 'anchored',
    } as never,
    config: {
      maxLaunches: 1,
      maxDeepCandidates: 1,
      maxRouterCalls: 10,
      maxControlCalls: 10,
      maxRuntimeMs: 60_000,
      maxRetries: 1,
      maxConcurrentCandidates: 1,
      observationStaleMs: 30 * 60 * 1000,
      minReMeasureIntervalMs: 20 * 60 * 1000,
      maxLaunchAgeMs: 48 * 60 * 60 * 1000,
      leaseTtlMs: 60_000,
      profile: {
        quoteAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        positionAtomic: '100000000',
        maxRoundTripBps: 300,
        maxExitSlippageBps: 300,
      },
    } as never,
    now: () => new Date('2026-08-19T12:00:00.000Z'),
  };
}

describe('a reading taken because somebody asked', () => {
  test('an anchor that did not read stores nothing and blames nobody', async () => {
    // The pass refuses to store an observation with no block, because an
    // observation of no particular moment is not a measurement. What reaches
    // the reader must say that, and must not say it about the token.
    const result = await measureB20TokenOnDemandV1({
      launch: LAUNCH,
      pass: pass({ anchor: false }),
      budgetMs: 5_000,
    });
    assert.equal(result.outcome, 'provider_unavailable');
    assert.equal(result.reason, null);
  });

  test('a reading that throws is an outcome, never an exception', async () => {
    // One broken token must not take down an answer whose other half is fine —
    // the same rule the pass applies inside a worker, applied to a request.
    const result = await measureB20TokenOnDemandV1({
      launch: LAUNCH,
      pass: pass({ throws: true }),
      budgetMs: 5_000,
    });
    assert.equal(result.outcome, 'failed');
  });

  test('an unmeasured verdict carries its reason code, not a sentence', async () => {
    const result = await measureB20TokenOnDemandV1({
      launch: LAUNCH,
      pass: pass({ state: 'unmeasured' }),
      budgetMs: 5_000,
    });
    assert.equal(result.outcome, 'measurement_incomplete');
    assert.equal(result.reason, 'route_search_degraded');
  });

  test('a completed reading is `measured` whatever it concluded', async () => {
    // `no_entry_route` is a finding, not a gap. The distinction the outcome
    // draws is whether Miorail finished, not whether the news was good.
    const result = await measureB20TokenOnDemandV1({
      launch: LAUNCH,
      pass: pass({}),
      budgetMs: 5_000,
    });
    assert.equal(result.outcome, 'measured');
  });

  test('the budget bounds the WAIT, and the reading keeps going', async () => {
    const slow = pass({ delayMs: 200 });
    const result = await measureB20TokenOnDemandV1({ launch: LAUNCH, pass: slow, budgetMs: 20 });
    assert.equal(result.outcome, 'timed_out');
    // Still running: a reader who asks again joins it rather than starting a
    // second, and the row lands when it lands.
    assert.equal(b20TargetedMeasureInFlightCountV1(), 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(b20TargetedMeasureInFlightCountV1(), 0);
  });

  test('two questions about one token share a single reading', async () => {
    const slow = pass({ delayMs: 60 });
    const [first, second] = await Promise.all([
      measureB20TokenOnDemandV1({ launch: LAUNCH, pass: slow, budgetMs: 5_000 }),
      measureB20TokenOnDemandV1({ launch: LAUNCH, pass: slow, budgetMs: 5_000 }),
    ]);
    assert.equal(first.outcome, 'measured');
    assert.equal(second.outcome, 'measured');
    assert.equal(b20TargetedMeasureInFlightCountV1(), 0);
  });
});

describe('what counts as needing a reading', () => {
  const now = new Date('2026-08-19T12:00:00.000Z');

  test('an absent observation needs one', () => {
    assert.equal(b20ObservationNeedsRefreshV1({ observation: null, now }), true);
  });

  test('a current observation does not', () => {
    assert.equal(
      b20ObservationNeedsRefreshV1({ observation: { staleAfter: '2026-08-19T12:30:00.000Z' }, now }),
      false,
    );
  });

  test('a stale one does, and the row decides — not this function', () => {
    // `staleAfter` is the measurement's own statement about itself, written
    // when it was taken. Re-deriving the window here would let two parts of the
    // product disagree about when a reading expires.
    assert.equal(
      b20ObservationNeedsRefreshV1({ observation: { staleAfter: '2026-08-19T11:30:00.000Z' }, now }),
      true,
    );
  });

  test('an unparseable stamp is treated as stale rather than as current', () => {
    assert.equal(b20ObservationNeedsRefreshV1({ observation: { staleAfter: 'nonsense' }, now }), true);
  });
});

describe('the bounds are explicit', () => {
  test('the budget has a default and honours an operator override', () => {
    assert.equal(b20TargetedMeasureBudgetMsV1({} as NodeJS.ProcessEnv), 25_000);
    assert.equal(
      b20TargetedMeasureBudgetMsV1({ MIORAIL_B20_TARGETED_MEASURE_BUDGET_MS: '4000' } as NodeJS.ProcessEnv),
      4_000,
    );
    // Nonsense falls back rather than becoming a zero budget, which would read
    // as "every reading timed out".
    assert.equal(
      b20TargetedMeasureBudgetMsV1({ MIORAIL_B20_TARGETED_MEASURE_BUDGET_MS: '0' } as NodeJS.ProcessEnv),
      25_000,
    );
  });

  test('a question may cause at most two readings', () => {
    assert.equal(B20_TARGETED_MEASURE_MAX_PER_REQUEST_V1, 2);
  });
});
