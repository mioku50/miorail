import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  B20_MEASUREMENT_VERSION_V1,
  InMemoryB20DiscoverRepositoryV1,
  InMemoryB20ObservationRepositoryV1,
  observationIdV1,
  type B20StoredLaunchV1,
} from '@mioagent/route-storage';
import { OPPORTUNITY_QUOTE_ASSET_V1, profileIdentityV1 } from '@mioagent/opportunity-rail';

import {
  B20MeasureArgError,
  B20_MEASURE_DEFAULTS_V1,
  B20_MEASURE_EXIT_CODES_V1,
  B20_MEASURE_REFERENCE_PROFILE_V1,
  formatB20MeasureSummaryV1,
  parseB20MeasureArgsV1,
} from './b20MeasureCli.js';
import {
  cheapFilterResultV1,
  measureFailureReasonV1,
  runB20MeasurePassV1,
  transferPolicyStateV1,
  type ControlMeasurementV1,
  type MeasurePassConfigV1,
  type MeasurementDepsV1,
  type ObservationAnchorV1,
  type RouteMeasurementV1,
} from './b20MeasureRun.js';

// Resolved without `import.meta`, so this file compiles under the scripts
// tsconfig's CommonJS target as well as running under tsx.
const ROOT = process.cwd().endsWith(`${path.sep}scripts`) ? path.join(process.cwd(), '..') : process.cwd();

// ---------------------------------------------------------------------------
// T69-B §3/§4/§14 — the worker, with no network and no database.
//
// What every test here is really guarding: this runs unattended, over tokens
// nobody asked about, and publishes the result. The failure that matters is not
// a crash — it is a confident wrong sentence about somebody's token, written at
// 3am by a process with no user in front of it.
// ---------------------------------------------------------------------------

const LANE = {
  chainId: 8453 as const,
  factoryAddress: '0xb20f000000000000000000000000000000000000' as const,
  decoderVersion: 'b20-created/v1' as const,
};
const TOKEN = '0xb200000000000000000000d6f666fe8b27595c01';
const T0 = '2026-08-04T00:00:00.000Z';
const hashOf = (seed: string): string => `0x${seed.repeat(64).slice(0, 64)}`;

const ANCHOR: ObservationAnchorV1 = {
  blockNumber: '49500000',
  blockHash: hashOf('e'),
  blockTag: '0x2f3f0c0',
};

const CONFIG: MeasurePassConfigV1 = {
  ...B20_MEASURE_DEFAULTS_V1,
  profile: B20_MEASURE_REFERENCE_PROFILE_V1,
};

/** A healthy round trip: 100 USDC in, 99 USDC back — 100 bps. */
const GOOD_ROUTES: RouteMeasurementV1 = {
  entryRouteFound: true,
  exitRouteFound: true,
  degraded: false,
  candidatesTotal: 10,
  candidatesAnswered: 10,
  entryOutputAtomic: '4000000000000000000000',
  exitReturnAtomic: '99000000',
  quoteAssetUsed: OPPORTUNITY_QUOTE_ASSET_V1,
  positionAtomicUsed: '100000000',
  entryRouteHash: null,
  exitRouteHash: null,
  entrySourceKey: 'aerodrome|usdc>token:volatile',
  exitSourceKey: 'aerodrome|token>usdc:volatile',
  probes: [
    { sizeAtomic: '2000000000000000000000', slippageBps: 10 },
    { sizeAtomic: '4000000000000000000000', slippageBps: 50 },
    { sizeAtomic: '8000000000000000000000', slippageBps: 900 },
  ],
  routerCalls: 14,
};

const OPEN_CONTROLS: ControlMeasurementV1 = {
  controls: {
    factoryConfirmed: true,
    initialized: true,
    transfersPaused: false,
    transferPolicyState: 'open',
    controlsComplete: true,
  },
  snapshotHash: hashOf('d'),
  blockNumber: ANCHOR.blockNumber,
  controlCalls: 15,
};

interface FakeDepsV1 extends MeasurementDepsV1 {
  calls: string[];
}

function fakeDeps(overrides: Partial<MeasurementDepsV1> = {}): FakeDepsV1 {
  const calls: string[] = [];
  const base: MeasurementDepsV1 = {
    quoteAlignment: 'latest_not_anchored',
    async readAnchor() {
      calls.push('anchor');
      return ANCHOR;
    },
    async readFactoryStatus() {
      calls.push('factory');
      return { isB20: true, initialized: true };
    },
    async analyseRoutes() {
      calls.push('routes');
      return GOOD_ROUTES;
    },
    async readControls() {
      calls.push('controls');
      return OPEN_CONTROLS;
    },
  };
  return { ...base, ...overrides, calls } as FakeDepsV1;
}

function launchFixture(overrides: Partial<B20StoredLaunchV1> = {}): B20StoredLaunchV1 {
  const transactionHash = overrides.transactionHash ?? hashOf('1');
  return {
    chainId: 8453,
    factoryAddress: LANE.factoryAddress,
    tokenAddress: TOKEN,
    variant: 'asset',
    name: 'o1 mascot',
    symbol: 'DINo1',
    decimals: 18,
    blockNumber: '1050',
    blockHash: hashOf('a'),
    transactionHash,
    transactionIndex: 2,
    logIndex: 0,
    detectedAt: T0,
    confirmationCount: 12,
    blockTimestamp: null,
    decoderVersion: LANE.decoderVersion,
    canonical: true,
    nonCanonicalAt: null,
    createdAt: T0,
    ...overrides,
    // Derived last: the identity is the log, so a fixture must not let a
    // caller set it independently of the transaction it came from.
    id: `${transactionHash}:0`,
  };
}

async function seed(launches: B20StoredLaunchV1[]): Promise<{
  discover: InMemoryB20DiscoverRepositoryV1;
  observations: InMemoryB20ObservationRepositoryV1;
}> {
  const discover = new InMemoryB20DiscoverRepositoryV1();
  await discover.initialiseCursor({ key: LANE, startBlock: '1000', now: T0 });
  await discover.acquireWorkerLease({ key: LANE, owner: 'seed', now: T0, ttlMs: 600_000 });
  await discover.commitRange({
    key: LANE,
    owner: 'seed',
    launches,
    nextBlock: '1100',
    nextBlockHash: hashOf('b'),
    run: {
      id: 'seed-run',
      ...LANE,
      startedAt: T0,
      finishedAt: T0,
      startCursorBlock: '1000',
      endCursorBlock: '1100',
      confirmedHead: '2000',
      scannedFromBlock: '1001',
      scannedToBlock: '1100',
      launchesRead: launches.length,
      launchesInserted: launches.length,
      duplicates: 0,
      budgetExhausted: false,
      operatorState: null,
      errorCategory: null,
      result: 'success',
    },
    now: T0,
  });
  await discover.releaseWorkerLease({ key: LANE, owner: 'seed', now: T0 });
  return { discover, observations: new InMemoryB20ObservationRepositoryV1(discover) };
}

async function pass(
  observations: InMemoryB20ObservationRepositoryV1,
  deps: MeasurementDepsV1,
  overrides: Partial<MeasurePassConfigV1> = {},
  owner = 'worker-a',
  now: string = '2026-08-04T01:00:00.000Z',
) {
  return runB20MeasurePassV1({
    observations,
    deps,
    config: { ...CONFIG, ...overrides },
    owner,
    now: () => new Date(now),
  });
}

describe('the four steps run in the order that spends the least', () => {
  test('the anchor comes first, then the factory, then routes, then controls', async () => {
    // §16.3/§16.4. Reversing routes and controls would spend ~15 paced calls on
    // every token that turns out to have no pool.
    const { observations } = await seed([launchFixture()]);
    const deps = fakeDeps();
    await pass(observations, deps);
    assert.deepEqual(deps.calls, ['anchor', 'factory', 'routes', 'controls']);
  });

  test('a token the factory disowns costs no router call at all', async () => {
    const { observations } = await seed([launchFixture()]);
    const deps = fakeDeps({
      async readFactoryStatus() {
        return { isB20: false, initialized: null };
      },
    });
    const outcome = await pass(observations, deps);
    assert.ok(!deps.calls.includes('routes'), 'no route search for a non-B20 address');
    assert.ok(!deps.calls.includes('controls'));
    assert.equal(outcome.byState.rejected, 1);
    assert.equal(outcome.routerCalls, 0);
  });

  test('a token with no exit route costs no control read', async () => {
    const { observations } = await seed([launchFixture()]);
    const deps = fakeDeps({
      async analyseRoutes() {
        return { ...GOOD_ROUTES, exitRouteFound: false, exitReturnAtomic: null };
      },
    });
    await pass(observations, deps);
    assert.ok(!deps.calls.includes('controls'), 'the deep read is for candidates only');
  });
});

describe('one block anchors one observation', () => {
  test('the stored observation carries the anchor block and its hash', async () => {
    // §16.23.
    const { observations } = await seed([launchFixture()]);
    await pass(observations, fakeDeps());
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.observationBlockNumber, ANCHOR.blockNumber);
    assert.equal(stored?.observationBlockHash, ANCHOR.blockHash);
    assert.equal(stored?.controlsBlockNumber, ANCHOR.blockNumber, 'controls at the same block');
  });

  test('the router quotes are recorded as NOT anchored to that block', async () => {
    // §4 — Aerodrome's getAmountsOut takes no block tag. Presenting the quote
    // and the control read as one atomic snapshot would be a claim nothing
    // measured, so the row says which is which.
    const { observations } = await seed([launchFixture()]);
    await pass(observations, fakeDeps());
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.quoteAlignment, 'latest_not_anchored');
  });

  test('no anchor means no observation at all', async () => {
    // §16.24. A measurement of no particular moment is not a measurement.
    const { observations } = await seed([launchFixture()]);
    const deps = fakeDeps({
      async readAnchor() {
        return null;
      },
    });
    const outcome = await pass(observations, deps);
    assert.equal(outcome.observationsWritten, 0);
    assert.equal((await observations.listRecentObservations({ limit: 5 })).length, 0);
    assert.ok(!deps.calls.includes('factory'), 'nothing is read without a block to read it at');
  });
});

describe('only canonical launches are measured', () => {
  test('a canonical launch is selected', async () => {
    // §16.1.
    const { observations } = await seed([launchFixture()]);
    const outcome = await pass(observations, fakeDeps());
    assert.equal(outcome.eligible, 1);
    assert.equal(outcome.observationsWritten, 1);
  });

  test('a launch the chain took back is skipped entirely', async () => {
    // §16.2/§12. A reorged-out launch is not a token anybody should be shown a
    // measurement of.
    const { discover, observations } = await seed([launchFixture({ blockNumber: '1090' })]);
    await discover.acquireWorkerLease({ key: LANE, owner: 'seed', now: T0, ttlMs: 600_000 });
    await discover.rewindForReorg({
      key: LANE,
      owner: 'seed',
      rewindToBlock: '1050',
      rewindToBlockHash: hashOf('d'),
      run: {
        id: 'reorg-run',
        ...LANE,
        startedAt: T0,
        finishedAt: T0,
        startCursorBlock: '1100',
        endCursorBlock: '1050',
        confirmedHead: null,
        scannedFromBlock: null,
        scannedToBlock: null,
        launchesRead: 0,
        launchesInserted: 0,
        duplicates: 0,
        budgetExhausted: false,
        operatorState: 'reorg_rewound',
        errorCategory: 'reorg_detected',
        result: 'reorg_rewound',
      },
      now: T0,
    });
    const deps = fakeDeps();
    const outcome = await pass(observations, deps);
    assert.equal(outcome.eligible, 0);
    assert.equal(outcome.result, 'nothing_eligible');
    assert.equal(deps.calls.length, 0, 'the endpoint is not touched for a launch the chain removed');
  });
});

describe('a background pass can never certify', () => {
  test('a clean measurement is provisional, and says why', async () => {
    // §16.9/§16.11.
    const { observations } = await seed([launchFixture()]);
    const outcome = await pass(observations, fakeDeps());
    assert.equal(outcome.byState.provisional, 1);
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.state, 'provisional');
    assert.equal(stored?.reasonCode, 'quoted_pre_entry');
  });

  test('the round trip costs what was SPENT, not what the profile asked for', async () => {
    // B20's v4 pools are quoted in native ETH, so the position actually spent
    // is wei while the profile's is USDC atoms. Costing the trip against the
    // profile compares a wei return to a USDC input: the return dwarfs it, a
    // loss reads as a gain, and the clamp reports a flattering 0 bps. Measured
    // on mainnet: 0.03 ETH in, 0.0286 ETH back — a 449 bps loss stored as 0.
    const { observations } = await seed([launchFixture()]);
    await pass(
      observations,
      fakeDeps({
        async analyseRoutes() {
          return {
            ...GOOD_ROUTES,
            quoteAssetUsed: '0x0000000000000000000000000000000000000000' as const,
            positionAtomicUsed: '30000000000000000',
            entryOutputAtomic: '4000000000000000000000',
            exitReturnAtomic: '28653551773253690',
          };
        },
      }),
    );
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.referenceQuoteAsset, '0x0000000000000000000000000000000000000000');
    assert.equal(stored?.referencePositionAtomic, '30000000000000000');
    assert.equal(stored?.optimisticRoundTripBps, 449, 'the loss is reported, not clamped away');
  });

  test('nothing this worker writes is ever qualified', async () => {
    const { observations } = await seed([
      launchFixture({ transactionHash: hashOf('1') }),
      launchFixture({ transactionHash: hashOf('2') }),
    ]);
    await pass(observations, fakeDeps());
    for (const stored of await observations.listRecentObservations({ limit: 10 })) {
      assert.notEqual(stored.state, 'qualified' as never);
    }
  });

  test('an optimistic round trip that already fails may reject', async () => {
    // §16.10. Sound: if the flattering number fails, the real one fails worse.
    const { observations } = await seed([launchFixture()]);
    const outcome = await pass(
      observations,
      fakeDeps({
        async analyseRoutes() {
          return { ...GOOD_ROUTES, exitReturnAtomic: '80000000' };
        },
      }),
    );
    assert.equal(outcome.byState.rejected, 1);
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.reasonCode, 'round_trip_above_tolerance');
  });

  test('a paused token is rejected, and the reason is stored', async () => {
    // §16.18.
    const { observations } = await seed([launchFixture()]);
    await pass(
      observations,
      fakeDeps({
        async readControls() {
          return { ...OPEN_CONTROLS, controls: { ...OPEN_CONTROLS.controls, transfersPaused: true } };
        },
      }),
    );
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.state, 'rejected');
    assert.equal(stored?.reasonCode, 'transfers_paused');
    assert.equal(stored?.transfersPaused, true);
  });

  test('a degraded route search stores unmeasured, never a rejection', async () => {
    // §16.6/§16.8. The AERO incident: a throttled search rendered as "no route
    // out of this token exists" about one of the deepest pools on Base.
    const { observations } = await seed([launchFixture()]);
    await pass(
      observations,
      fakeDeps({
        async analyseRoutes() {
          return { ...GOOD_ROUTES, degraded: true, exitRouteFound: false, exitReturnAtomic: null };
        },
      }),
    );
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.state, 'unmeasured');
    assert.equal(stored?.reasonCode, 'route_search_degraded');
  });

  test('a factory read that did not answer is unmeasured, not not_b20', async () => {
    const { observations } = await seed([launchFixture()]);
    await pass(
      observations,
      fakeDeps({
        async readFactoryStatus() {
          return { isB20: null, initialized: null };
        },
      }),
    );
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.state, 'unmeasured');
    assert.equal(stored?.factoryConfirmed, false);
  });

  test('the capacity ladder is stored as measured boundaries', async () => {
    // §16.15/§16.16 — the largest PROBED pass and the first failure, with
    // nothing invented between them.
    const { observations } = await seed([launchFixture()]);
    await pass(observations, fakeDeps());
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.largestPassingSizeAtomic, '4000000000000000000000');
    assert.equal(stored?.firstFailingSizeAtomic, '8000000000000000000000');
    assert.equal(stored?.capacityProbeCount, 3);
    assert.equal(stored?.capacityStable, true);
    assert.ok(stored?.capacitySamplesHash, 'the probes are hashed so they stay checkable');
  });

  test('a non-monotonic ladder is stored as unstable', async () => {
    // §16.17.
    const { observations } = await seed([launchFixture()]);
    await pass(
      observations,
      fakeDeps({
        async analyseRoutes() {
          return {
            ...GOOD_ROUTES,
            probes: [
              { sizeAtomic: '2000000000000000000000', slippageBps: 10 },
              { sizeAtomic: '4000000000000000000000', slippageBps: 900 },
              { sizeAtomic: '8000000000000000000000', slippageBps: 20 },
            ],
          };
        },
      }),
    );
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.capacityStable, false);
    // And the capacity never takes the later flattering value.
    assert.equal(stored?.largestPassingSizeAtomic, '2000000000000000000000');
  });

  test('a partial search confirms viability but never optimality', async () => {
    // §16.12.
    const { observations } = await seed([launchFixture()]);
    await pass(
      observations,
      fakeDeps({
        async analyseRoutes() {
          return { ...GOOD_ROUTES, candidatesAnswered: 6 };
        },
      }),
    );
    const [stored] = await observations.listRecentObservations({ limit: 5 });
    assert.equal(stored?.routeCoverage, 'partial');
    assert.equal(stored?.viableRouteConfirmed, true);
    assert.equal(stored?.bestRouteConfirmed, false);
    assert.equal(stored?.state, 'provisional', 'a proven route may still be provisional');
  });
});

describe('budgets bound the pass without inventing observations', () => {
  test('a launch the budget never reached gets no observation', async () => {
    // §16.28. `not_checked` is a different fact from `unmeasured`: one means
    // nothing was attempted, the other means an attempt found nothing.
    const { observations } = await seed([
      launchFixture({ transactionHash: hashOf('1') }),
      launchFixture({ transactionHash: hashOf('2') }),
      launchFixture({ transactionHash: hashOf('3') }),
    ]);
    const outcome = await pass(observations, fakeDeps(), { maxDeepCandidates: 1 });
    assert.equal(outcome.attempted, 1);
    assert.equal(outcome.notChecked, 2);
    assert.equal(outcome.result, 'budget_exhausted');
    assert.equal((await observations.listRecentObservations({ limit: 10 })).length, 1);
  });

  test('the launch selection is capped', async () => {
    // §16.27.
    const { observations } = await seed([
      launchFixture({ transactionHash: hashOf('1') }),
      launchFixture({ transactionHash: hashOf('2') }),
      launchFixture({ transactionHash: hashOf('3') }),
    ]);
    const outcome = await pass(observations, fakeDeps(), { maxLaunches: 2 });
    assert.equal(outcome.eligible, 2);
  });

  test('a router-call ceiling stops the pass between candidates', async () => {
    const { observations } = await seed([
      launchFixture({ transactionHash: hashOf('1') }),
      launchFixture({ transactionHash: hashOf('2') }),
    ]);
    const outcome = await pass(observations, fakeDeps(), { maxRouterCalls: 10 });
    assert.equal(outcome.attempted, 1, 'the second candidate is not started');
    assert.equal(outcome.notChecked, 1);
  });

  test('a runtime ceiling stops the pass', async () => {
    const { observations } = await seed([
      launchFixture({ transactionHash: hashOf('1') }),
      launchFixture({ transactionHash: hashOf('2') }),
    ]);
    const outcome = await pass(observations, fakeDeps(), { maxRuntimeMs: -1 });
    assert.equal(outcome.attempted, 0);
    assert.equal(outcome.notChecked, 2);
    assert.equal((await observations.listRecentObservations({ limit: 10 })).length, 0);
  });

  test('one broken token does not starve the ones behind it', async () => {
    // §16.29.
    const { observations } = await seed([
      launchFixture({ transactionHash: hashOf('1') }),
      launchFixture({ transactionHash: hashOf('2') }),
      launchFixture({ transactionHash: hashOf('3') }),
    ]);
    let seen = 0;
    const outcome = await pass(
      observations,
      fakeDeps({
        async analyseRoutes() {
          seen += 1;
          if (seen === 1) throw new Error('this one token explodes');
          return GOOD_ROUTES;
        },
      }),
    );
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.attempted, 3);
    assert.equal(outcome.observationsWritten, 2, 'the other two are still measured');
  });
});

describe('a repeated pass is free', () => {
  test('a second pass at the same block writes nothing new', async () => {
    // §16.25 through the worker: re-measuring would spend ~20 metered calls to
    // learn what is already stored.
    const { observations } = await seed([launchFixture()]);
    await pass(observations, fakeDeps());
    const deps = fakeDeps();
    const outcome = await pass(observations, deps, { minReMeasureIntervalMs: 0 });
    assert.equal(outcome.idempotentRepeats, 1);
    assert.equal(outcome.observationsWritten, 0);
    assert.ok(!deps.calls.includes('routes'), 'no router call for an observation already stored');
    assert.equal((await observations.listRecentObservations({ limit: 10 })).length, 1);
  });

  test('the identity is the one the storage layer derives', async () => {
    const { observations } = await seed([launchFixture()]);
    await pass(observations, fakeDeps());
    const expected = observationIdV1({
      launchId: `${hashOf('1')}:0`,
      observationBlockNumber: ANCHOR.blockNumber,
      measurementVersion: B20_MEASUREMENT_VERSION_V1,
      profileIdentity: profileIdentityV1(B20_MEASURE_REFERENCE_PROFILE_V1),
    });
    assert.ok(await observations.getObservation(expected));
  });

  test('a second worker exits rather than measuring the same candidate', async () => {
    const { observations } = await seed([launchFixture()]);
    await observations.acquireMeasureLease({ owner: 'worker-b', now: '2026-08-04T01:00:00.000Z', ttlMs: 600_000 });
    const deps = fakeDeps();
    const outcome = await pass(observations, deps);
    assert.equal(outcome.result, 'run_already_active');
    assert.equal(deps.calls.length, 0);
  });

  test('the lease is released even when the pass finds nothing', async () => {
    const { observations } = await seed([]);
    await pass(observations, fakeDeps());
    assert.ok(
      await observations.acquireMeasureLease({ owner: 'other', now: '2026-08-04T02:00:00.000Z', ttlMs: 1000 }),
    );
  });
});

describe('the cheap filter never turns an outage into a verdict', () => {
  test('every unanswered read lands on a degraded result', () => {
    assert.equal(
      cheapFilterResultV1({ factory: { isB20: null, initialized: null }, routes: null }),
      'route_search_degraded',
    );
    assert.equal(
      cheapFilterResultV1({ factory: { isB20: true, initialized: null }, routes: null }),
      'route_search_degraded',
    );
    assert.equal(
      cheapFilterResultV1({ factory: { isB20: true, initialized: true }, routes: null }),
      'route_search_degraded',
    );
  });

  test('a sound factory answer is a verdict', () => {
    assert.equal(cheapFilterResultV1({ factory: { isB20: false, initialized: null }, routes: null }), 'not_b20');
    assert.equal(
      cheapFilterResultV1({ factory: { isB20: true, initialized: false }, routes: null }),
      'uninitialized',
    );
  });

  test('degradation is checked before the missing-route branches', () => {
    // Order matters: a throttled search that found nothing must never render
    // as "no route exists".
    assert.equal(
      cheapFilterResultV1({
        factory: { isB20: true, initialized: true },
        routes: { ...GOOD_ROUTES, degraded: true, entryRouteFound: false },
      }),
      'route_search_degraded',
    );
  });

  test('a route with no quote is quote_unavailable, not a missing route', () => {
    assert.equal(
      cheapFilterResultV1({
        factory: { isB20: true, initialized: true },
        routes: { ...GOOD_ROUTES, entryOutputAtomic: null },
      }),
      'quote_unavailable',
    );
  });
});

describe('the transfer-policy read keeps three answers apart', () => {
  const field = (key: string, status: string, value: string | null) => ({ key, status, value });

  test('ALWAYS_ALLOW is open, not a gate', () => {
    // §16.20. Treating the open value as a restriction would flag nearly every
    // token on the chain.
    assert.equal(
      transferPolicyStateV1({
        fields: [
          field('transfer_sender_policy', 'exact_chain_read', 'ALWAYS_ALLOW'),
          field('transfer_receiver_policy', 'exact_chain_read', 'ALWAYS_ALLOW (0x0)'),
        ],
      }),
      'open',
    );
  });

  test('anything else is restricted, and merely reported', () => {
    assert.equal(
      transferPolicyStateV1({
        fields: [field('transfer_receiver_policy', 'exact_chain_read', 'ALLOWLIST 0xabc')],
      }),
      'restricted',
    );
  });

  test('a failed read is not the same as a method this variant lacks', () => {
    // §16.21. One means something went wrong; the other is permanent and
    // expected. Fusing them makes a fully-read token look throttled.
    assert.equal(
      transferPolicyStateV1({
        fields: [
          field('transfer_sender_policy', 'unavailable', null),
          field('transfer_receiver_policy', 'exact_chain_read', 'ALWAYS_ALLOW'),
        ],
      }),
      'unavailable',
    );
    assert.equal(
      transferPolicyStateV1({
        fields: [field('transfer_sender_policy', 'unsupported_by_variant', null)],
      }),
      'unsupported_by_variant',
    );
    assert.equal(transferPolicyStateV1({ fields: [] }), 'unsupported_by_variant');
  });

  test('a non-enumerable policy is never resolved against an address', () => {
    // §9 — there is no wallet here, and B20 cannot list who a policy admits.
    const source = readFileSync(path.join(ROOT, 'scripts', 'b20MeasureRun.ts'), 'utf8');
    assert.ok(!source.includes('hasRole'), 'the worker must not check a policy against an address');
    assert.ok(!source.includes('balanceOf'));
  });
});

describe('the command line bounds everything a timer could spend', () => {
  test('the reference profile is 100 USDC at 3% / 3%', () => {
    // §5. A feed measurement parameter, not a user qualification.
    assert.equal(B20_MEASURE_REFERENCE_PROFILE_V1.positionAtomic, '100000000');
    assert.equal(B20_MEASURE_REFERENCE_PROFILE_V1.maxRoundTripBps, 300);
    assert.equal(B20_MEASURE_REFERENCE_PROFILE_V1.maxExitSlippageBps, 300);
  });

  test('every budget in the spec has a flag and a default', () => {
    const args = parseB20MeasureArgsV1([]);
    for (const key of [
      'maxLaunches',
      'maxDeepCandidates',
      'maxRouterCalls',
      'maxControlCalls',
      'maxRuntimeMs',
      'maxRetries',
      'maxConcurrentCandidates',
    ] as const) {
      assert.ok(typeof args[key] === 'number' && args[key] > 0, `${key} needs a positive default`);
    }
    assert.equal(parseB20MeasureArgsV1(['--max-candidates=3']).maxDeepCandidates, 3);
    assert.equal(parseB20MeasureArgsV1(['--max-runtime=2m']).maxRuntimeMs, 120_000);
  });

  test('nonsense is refused rather than coerced', () => {
    for (const bad of [
      '--max-candidates=0',
      '--max-router-calls=abc',
      '--max-runtime=soon',
      '--position=0',
      '--max-slippage-bps=20000',
      '--nonsense=1',
    ]) {
      assert.throws(() => parseB20MeasureArgsV1([bad]), B20MeasureArgError, `${bad} must be refused`);
    }
  });

  test('a rejected token is not an operator problem', () => {
    // No exit code means "a token failed". Paging on that would train an
    // operator to ignore the codes that matter.
    assert.equal(B20_MEASURE_EXIT_CODES_V1.success, 0);
    assert.equal(B20_MEASURE_EXIT_CODES_V1.nothing_eligible, 0);
    assert.equal(B20_MEASURE_EXIT_CODES_V1.budget_exhausted, 0);
    assert.notEqual(B20_MEASURE_EXIT_CODES_V1.run_already_active, 0);
  });

  test('the summary reports not_checked and never hides it', async () => {
    const { observations } = await seed([
      launchFixture({ transactionHash: hashOf('1') }),
      launchFixture({ transactionHash: hashOf('2') }),
    ]);
    const summary = formatB20MeasureSummaryV1(await pass(observations, fakeDeps(), { maxDeepCandidates: 1 }));
    assert.match(summary, /Not checked \(budget\): 1/);
    assert.match(summary, /not_checked/);
  });

  test('a provisional count always carries the pre-entry warning', async () => {
    const { observations } = await seed([launchFixture()]);
    const summary = formatB20MeasureSummaryV1(await pass(observations, fakeDeps()));
    assert.match(summary, /provisional: 1/);
    assert.match(summary, /quoted before the entry moved the pool/);
  });

  test('the summary never contains an endpoint or a credential', async () => {
    const { observations } = await seed([launchFixture()]);
    const summary = formatB20MeasureSummaryV1(await pass(observations, fakeDeps()));
    for (const forbidden of ['http', '://', 'postgres', 'key=']) {
      assert.ok(!summary.toLowerCase().includes(forbidden), `must not contain "${forbidden}"`);
    }
  });
});

describe('the worker is read-only against Base', () => {
  test('no signer, no submission, no state override, no probe balance', () => {
    // §15/§16.32.
    for (const file of ['b20_measure_opportunities.ts', 'b20MeasureRun.ts', 'b20MeasureCli.ts']) {
      const source = readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
      for (const forbidden of [
        'signTransaction',
        'privateKey',
        'sendCalls',
        'eth_sendRawTransaction',
        'wallet_sendCalls',
        'stateOverride',
        'state_override',
        'eth_sendTransaction',
        'moralis',
        'covalent',
        'zerion',
      ]) {
        assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `${file} must not mention ${forbidden}`);
      }
    }
  });

  test('the worker creates no clearance and no entry plan', () => {
    // The wallet-bound chain is a different path entirely, and a public feed
    // must not be able to start it.
    for (const file of ['b20_measure_opportunities.ts', 'b20MeasureRun.ts']) {
      const source = readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
      for (const forbidden of ['Clearance', 'EntryPlan', 'prepare-entry', 'submitApproved']) {
        assert.ok(!source.includes(forbidden), `${file} must not touch ${forbidden}`);
      }
    }
  });

  test('the generic swap allowlist is untouched', () => {
    // §16.33. Quoting an arbitrary token is a read; ROUTING into one is what
    // the allowlist exists to stop, and this task must not have widened it.
    const normalisation = readFileSync(
      path.join(ROOT, 'lib', 'swap-adapters', 'src', 'normalization.ts'),
      'utf8',
    );
    assert.match(normalisation, /isTrustedRouteAsset/);
    for (const file of ['b20_measure_opportunities.ts', 'b20MeasureRun.ts', 'b20MeasureCli.ts']) {
      const source = readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
      assert.ok(!source.includes('isTrustedRouteAsset'), `${file} must not reach into the allowlist`);
    }
  });
});

describe('a failed candidate says why, without saying where', () => {
  test('the reason survives; the endpoint and the addresses do not', () => {
    const reason = measureFailureReasonV1(
      new Error(
        'new row violates check constraint "b20_observations_quote_asset_check" ' +
          'at https://base-mainnet.example/v2/SECRET for 0xb200000000000000000000294511530ba9d34201',
      ),
    );
    assert.match(reason, /b20_observations_quote_asset_check/, 'the part that names the bug is kept');
    assert.doesNotMatch(reason, /https?:/);
    assert.doesNotMatch(reason, /SECRET/);
    assert.doesNotMatch(reason, /0xb200/);
    assert.ok(reason.length <= 200);
  });

  test('a non-Error is not stringified into whatever it happens to be', () => {
    assert.equal(measureFailureReasonV1({ rpcUrl: 'https://secret.example/key' }), 'unknown error');
  });
});
