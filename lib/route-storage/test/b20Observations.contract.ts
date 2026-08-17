import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { measuredMoversV1 } from '@mioagent/opportunity-rail';

import {
  B20_MEASUREMENT_VERSION_V1,
  RouteStorageConflictError,
  observationEvidenceHashV1,
  observationIdV1,
  type B20ObservationRepositoryV1,
  type B20OpportunityObservationV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T69-B §13/§16.30 — one contract, both observation repositories.
//
// The two rules worth the whole file: a retry is FREE, and a disagreement is
// LOUD. Getting the first wrong burns ~20 metered calls per token per pass.
// Getting the second wrong silently replaces the record of what was true at a
// block with a different claim about the same block.
// ---------------------------------------------------------------------------

export interface B20ObservationHarnessV1 {
  repository: B20ObservationRepositoryV1;
  /** Insert a canonical launch the observations can hang off, returning its id.
   * Postgres has a foreign key; the fake must need one too. */
  seedLaunch(input: {
    id: string;
    tokenAddress: string;
    detectedAt: string;
    blockNumber?: string;
    /** Defaults to 'live'. A backfilled row carries `detectedAt = now`, so the
     * queue can only tell it apart by this. */
    ingestionSource?: 'live' | 'backfill';
  }): Promise<void>;
}

const T0 = '2026-08-04T00:00:00.000Z';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOKEN = '0xb200000000000000000000d6f666fe8b27595c01';
const PROFILE_IDENTITY = `${USDC}:100000000:300:300`;

export const observationHashV1 = (seed: string): string => `0x${seed.repeat(64).slice(0, 64)}`;

/** A provisional observation, which is the shape with the most constraints on
 * it — every other state is a relaxation of this one. */
export function observationFixtureV1(
  overrides: Partial<B20OpportunityObservationV1> = {},
): B20OpportunityObservationV1 {
  const draft = {
    launchId: `${observationHashV1('1')}:0`,
    chainId: 8453 as const,
    tokenAddress: TOKEN,
    referenceQuoteAsset: USDC as typeof USDC,
    referencePositionAtomic: '100000000',
    maxRoundTripBps: 300,
    maxExitSlippageBps: 300,
    profileIdentity: PROFILE_IDENTITY,
    state: 'provisional' as const,
    reasonCode: 'quoted_pre_entry' as const,
    factoryConfirmed: true,
    initialized: true,
    entryRouteFound: true,
    exitRouteFound: true,
    entryRouteHash: observationHashV1('a'),
    exitRouteHash: observationHashV1('b'),
    entrySourceKey: 'aerodrome|usdc>token:volatile',
    exitSourceKey: 'aerodrome|token>usdc:volatile',
    // The default fixture is an Aerodrome measurement, and Aerodrome has no
    // hooks. Tests that care override it.
    poolHookAddress: null as string | null,
    entryOutputAtomic: '4000000000000000000000',
    optimisticExitReturnAtomic: '99000000',
    optimisticRoundTripBps: 100,
    largestPassingSizeAtomic: '4000000000000000000000',
    firstFailingSizeAtomic: '8000000000000000000000',
    capacityProbeCount: 4,
    capacityToleranceBps: 300,
    capacityStable: true,
    capacitySamplesHash: observationHashV1('c'),
    routeCoverage: 'complete' as const,
    // The default fixture is an Aerodrome-only measurement, which is exactly
    // the shape 1,662 stored launches are frozen in.
    venuesConsulted: ['aerodrome'] as string[] | null,
    viableRouteConfirmed: true,
    bestRouteConfirmed: true,
    controlsSnapshotHash: observationHashV1('d'),
    controlsBlockNumber: '49500000',
    transfersPaused: false,
    transferPolicyState: 'open' as const,
    controlsComplete: true,
    observationBlockNumber: '49500000',
    observationBlockHash: observationHashV1('e'),
    quoteAlignment: 'latest_not_anchored' as const,
    measuredAt: T0,
    staleAfter: '2026-08-04T00:30:00.000Z',
    measurementVersion: B20_MEASUREMENT_VERSION_V1,
    ...overrides,
  };
  // Identity and evidence are DERIVED, never passed in — a fixture that let a
  // caller set them independently would let a test assert an identity the
  // production path could never produce.
  return {
    ...draft,
    id: observationIdV1({
      launchId: draft.launchId,
      observationBlockNumber: draft.observationBlockNumber,
      measurementVersion: draft.measurementVersion,
      profileIdentity: draft.profileIdentity,
    }),
    evidenceHash: observationEvidenceHashV1(draft),
    createdAt: draft.measuredAt,
  } as B20OpportunityObservationV1;
}

export function describeB20ObservationRepositoryV1(
  name: string,
  createHarness: () => Promise<B20ObservationHarnessV1>,
): void {
  async function seeded(): Promise<B20ObservationHarnessV1> {
    const harness = await createHarness();
    await harness.seedLaunch({
      id: `${observationHashV1('1')}:0`,
      tokenAddress: TOKEN,
      detectedAt: T0,
    });
    return harness;
  }

  describe(`${name}: an observation is written once and never edited`, () => {
    test('a provisional observation round-trips through storage', async () => {
      const { repository } = await seeded();
      const stored = await repository.insertObservation(observationFixtureV1());
      assert.equal(stored.inserted, true);
      assert.equal(stored.observation.state, 'provisional');
      assert.equal(stored.observation.reasonCode, 'quoted_pre_entry');
      assert.equal(stored.observation.quoteAlignment, 'latest_not_anchored');
      const read = await repository.getObservation(stored.observation.id);
      assert.equal(read?.evidenceHash, stored.observation.evidenceHash);
    });

    test('a v4 hook address survives the round trip, and Aerodrome stores none', async () => {
      // The hook was decoded from the pool's Initialize log and then thrown
      // away for months. Storing it is the whole point, so a repository that
      // silently drops it must fail here.
      const { repository } = await seeded();
      const withHook = await repository.insertObservation(observationFixtureV1({
        poolHookAddress: '0x985c14baa2a18316ffda0aefb3a632fadfca2acc',
        entrySourceKey: 'uniswap-v4:0x07fff5bcbb831fd8e0f19d50334ed92b56b35d364712518a2aa37520a9246fe8',
      }));
      assert.equal(withHook.observation.poolHookAddress, '0x985c14baa2a18316ffda0aefb3a632fadfca2acc');
      const read = await repository.getObservation(withHook.observation.id);
      assert.equal(read?.poolHookAddress, '0x985c14baa2a18316ffda0aefb3a632fadfca2acc');

      // Null is the venue saying it has no hooks, and it must stay null rather
      // than becoming the zero address, which in v4 means something else: a v4
      // pool that HAS no hook.
      const aerodrome = await repository.insertObservation(observationFixtureV1({
        observationBlockNumber: '49500001',
      }));
      assert.equal(aerodrome.observation.poolHookAddress, null);
    });

    test('a hook that is not a lowercase address is refused by both repositories', async () => {
      // Parity: the in-memory fake must refuse exactly what the CHECK
      // constraint refuses. A checksummed address would compare unequal to the
      // pinned standard hook and quietly read as "unusual".
      const { repository } = await seeded();
      for (const bad of [
        '0x985C14BAA2A18316FFDA0AEFB3A632FADFCA2ACC',
        '0x985c14ba',
        'not-an-address',
        '',
      ]) {
        await assert.rejects(
          () => repository.insertObservation(observationFixtureV1({ poolHookAddress: bad })),
          `expected refusal for ${JSON.stringify(bad)}`,
        );
      }
    });

    test('the hook is not part of the evidence hash, because the pool id already commits to it', async () => {
      // A v4 pool id is the keccak of its PoolKey, and the PoolKey includes the
      // hook — so two observations of one pool cannot disagree about the hook
      // without disagreeing about `entrySourceKey` first. Hashing it again
      // would change every future hash to prove nothing new.
      const base = observationFixtureV1({ poolHookAddress: null });
      const hooked = observationFixtureV1({
        poolHookAddress: '0x985c14baa2a18316ffda0aefb3a632fadfca2acc',
      });
      assert.equal(hooked.evidenceHash, base.evidenceHash);
      assert.equal(hooked.id, base.id);
    });

    test('a retry with identical evidence returns the stored row and writes nothing', async () => {
      // §16.25. A pass that crashed after writing must not pay ~20 metered
      // calls to re-derive what is already there.
      const { repository } = await seeded();
      const first = await repository.insertObservation(observationFixtureV1());
      const second = await repository.insertObservation(observationFixtureV1());
      assert.equal(first.inserted, true);
      assert.equal(second.inserted, false);
      assert.equal(second.observation.id, first.observation.id);
      assert.equal((await repository.listRecentObservations({ limit: 10 })).length, 1);
    });

    test('a retry a second later is still identical, because evidence excludes the clock', async () => {
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1());
      const later = await repository.insertObservation(
        observationFixtureV1({ measuredAt: '2026-08-04T00:00:01.000Z', staleAfter: '2026-08-04T00:30:01.000Z' }),
      );
      assert.equal(later.inserted, false, 'wall time must not make a retry into a new fact');
    });

    test('different content under one identity is a conflict, never an overwrite', async () => {
      // §16.26. Two disagreeing measurements of one block are two facts, and
      // neither wins by arriving second.
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1());
      await assert.rejects(
        repository.insertObservation(observationFixtureV1({ optimisticRoundTripBps: 250 })),
        RouteStorageConflictError,
      );
      const stored = await repository.listRecentObservations({ limit: 10 });
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.optimisticRoundTripBps, 100, 'the original survives');
    });

    test('a different block is a different observation, not an update', async () => {
      // §11 — a changed pool or control state creates a NEW observation.
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1());
      const later = await repository.insertObservation(
        observationFixtureV1({
          observationBlockNumber: '49500100',
          measuredAt: '2026-08-04T00:10:00.000Z',
          staleAfter: '2026-08-04T00:40:00.000Z',
        }),
      );
      assert.equal(later.inserted, true);
      const history = await repository.listObservationsForLaunch({
        launchId: `${observationHashV1('1')}:0`,
        limit: 10,
      });
      assert.equal(history.length, 2, 'the earlier reading is kept');
      assert.equal(history[0]?.observationBlockNumber, '49500100', 'newest first');
    });

    test('a different profile at the same block is a different observation', async () => {
      // A result for 100 USDC says nothing about 500, so the two cannot share
      // an identity.
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1());
      const other = await repository.insertObservation(
        observationFixtureV1({
          profileIdentity: `${USDC}:500000000:300:300`,
          referencePositionAtomic: '500000000',
        }),
      );
      assert.equal(other.inserted, true);
      assert.equal((await repository.listRecentObservations({ limit: 10 })).length, 2);
    });
  });

  describe(`${name}: only canonical, due launches are offered`, () => {
    test('a canonical launch inside the age window is eligible', async () => {
      // §16.1.
      const { repository } = await seeded();
      const due = await repository.selectMeasurableLaunches({
        limit: 10,
        maxLaunchAgeMs: 48 * 3_600_000,
        minReMeasureIntervalMs: 20 * 60_000,
        now: '2026-08-04T01:00:00.000Z',
      });
      assert.equal(due.length, 1);
      assert.equal(due[0]?.tokenAddress, TOKEN);
      assert.equal(due[0]?.lastMeasuredAt, null);
    });

    test('the NEWEST unmeasured launch is offered first, because that is what Discover shows', async () => {
      // This ordering was oldest-first, on the reasoning that a backlog should
      // drain in arrival order. Discover lists launches newest-first, so that
      // made the top of the home screen the part the worker reached last: on
      // 2026-08-10 the newest fifty canonical launches had ZERO observations
      // between them while 1,828 older ones were ground through at 200/hour.
      const harness = await seeded();
      await harness.seedLaunch({
        id: `${observationHashV1('2')}:0`,
        tokenAddress: `0xb2${'1'.repeat(38)}`,
        detectedAt: '2026-08-04T00:50:00.000Z',
        blockNumber: '49500100',
      });
      const due = await harness.repository.selectMeasurableLaunches({
        limit: 10,
        maxLaunchAgeMs: 48 * 3_600_000,
        minReMeasureIntervalMs: 20 * 60_000,
        now: '2026-08-04T01:00:00.000Z',
      });
      assert.equal(due.length, 2);
      assert.equal(due[0]?.tokenAddress, `0xb2${'1'.repeat(38)}`, 'the newer launch comes first');
      assert.equal(due[1]?.tokenAddress, TOKEN);
    });

    test('a live launch outranks a backfilled one detected later', async () => {
      // The starvation case. A backfill writes `detectedAt = now()` — honestly,
      // since that IS when Miorail found the row — so on discovery time alone a
      // token from July sorts ahead of a launch from an hour ago. The 2026-08-16
      // historical gap is ~740,000 blocks, roughly 12,000 launches: filling it
      // would put all of them in front of the live feed the worker exists for.
      const harness = await seeded();
      await harness.seedLaunch({
        id: `${observationHashV1('4')}:0`,
        tokenAddress: `0xb2${'3'.repeat(38)}`,
        // Detected AFTER the live launch below, and still second.
        detectedAt: '2026-08-04T00:59:00.000Z',
        blockNumber: '48661648',
        ingestionSource: 'backfill',
      });
      await harness.seedLaunch({
        id: `${observationHashV1('5')}:0`,
        tokenAddress: `0xb2${'4'.repeat(38)}`,
        detectedAt: '2026-08-04T00:30:00.000Z',
        blockNumber: '49500300',
        ingestionSource: 'live',
      });
      const due = await harness.repository.selectMeasurableLaunches({
        limit: 10,
        maxLaunchAgeMs: 48 * 3_600_000,
        minReMeasureIntervalMs: 20 * 60_000,
        now: '2026-08-04T01:00:00.000Z',
      });
      const backfilled = due.findIndex((row) => row.tokenAddress === `0xb2${'3'.repeat(38)}`);
      const live = due.findIndex((row) => row.tokenAddress === `0xb2${'4'.repeat(38)}`);
      assert.ok(backfilled >= 0 && live >= 0, 'both launches must still be eligible');
      assert.ok(live < backfilled, 'a live launch must be offered before a backfilled one');
      // Historical rows are DEFERRED, never dropped: the gap still gets measured.
      assert.equal(due.at(-1)?.tokenAddress, `0xb2${'3'.repeat(38)}`);
    });

    test('a budget of one spends it on the newest live launch', async () => {
      // With `--max-candidates=1` the ordering IS the product: one backfilled
      // token at the head would cost the pass its only live measurement.
      const harness = await seeded();
      await harness.seedLaunch({
        id: `${observationHashV1('6')}:0`,
        tokenAddress: `0xb2${'5'.repeat(38)}`,
        detectedAt: '2026-08-04T00:59:30.000Z',
        blockNumber: '48661649',
        ingestionSource: 'backfill',
      });
      const due = await harness.repository.selectMeasurableLaunches({
        limit: 1,
        maxLaunchAgeMs: 48 * 3_600_000,
        minReMeasureIntervalMs: 20 * 60_000,
        now: '2026-08-04T01:00:00.000Z',
      });
      assert.equal(due.length, 1);
      assert.equal(due[0]?.ingestionSource, 'live');
    });

    test('a budget of one spends it on the newest, not the oldest', async () => {
      // The case that actually bit: a worker with `--max-candidates=1` takes
      // exactly one launch per pass, so the ordering IS the product.
      const harness = await seeded();
      await harness.seedLaunch({
        id: `${observationHashV1('3')}:0`,
        tokenAddress: `0xb2${'2'.repeat(38)}`,
        detectedAt: '2026-08-04T00:55:00.000Z',
        blockNumber: '49500200',
      });
      const due = await harness.repository.selectMeasurableLaunches({
        limit: 1,
        maxLaunchAgeMs: 48 * 3_600_000,
        minReMeasureIntervalMs: 20 * 60_000,
        now: '2026-08-04T01:00:00.000Z',
      });
      assert.equal(due.length, 1);
      assert.equal(due[0]?.tokenAddress, `0xb2${'2'.repeat(38)}`);
    });

    test('a launch stamped in the future is not a candidate', async () => {
      // Postgres has always carried `AND l.detected_at <= now`; the in-memory
      // repository did not, so it offered a candidate the real queue never
      // returns — and offered it FIRST, since the queue is newest-first.
      const harness = await seeded();
      await harness.seedLaunch({
        id: `${observationHashV1('9')}:0`,
        tokenAddress: `0xb2${'9'.repeat(38)}`,
        detectedAt: '2026-08-04T02:00:00.000Z',
        blockNumber: '49500900',
      });
      const due = await harness.repository.selectMeasurableLaunches({
        limit: 10,
        maxLaunchAgeMs: 48 * 3_600_000,
        minReMeasureIntervalMs: 20 * 60_000,
        now: '2026-08-04T01:00:00.000Z',
      });
      assert.deepEqual(due.map((launch) => launch.tokenAddress), [TOKEN]);
    });

    test('a launch older than the window is left alone', async () => {
      const { repository } = await seeded();
      const due = await repository.selectMeasurableLaunches({
        limit: 10,
        maxLaunchAgeMs: 60_000,
        minReMeasureIntervalMs: 20 * 60_000,
        now: '2026-08-06T00:00:00.000Z',
      });
      assert.equal(due.length, 0);
    });

    test('a launch measured recently is not re-measured', async () => {
      // §11 — the minimum interval. Re-reading a token every pass would spend
      // the whole budget on the first few.
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1());
      const soon = await repository.selectMeasurableLaunches({
        limit: 10,
        maxLaunchAgeMs: 48 * 3_600_000,
        minReMeasureIntervalMs: 20 * 60_000,
        now: '2026-08-04T00:05:00.000Z',
      });
      assert.equal(soon.length, 0);

      const later = await repository.selectMeasurableLaunches({
        limit: 10,
        maxLaunchAgeMs: 48 * 3_600_000,
        minReMeasureIntervalMs: 20 * 60_000,
        now: '2026-08-04T01:00:00.000Z',
      });
      assert.equal(later.length, 1);
      assert.equal(later[0]?.lastMeasuredAt, T0);
    });
  });

  // -------------------------------------------------------------------------
  // The other queue: launches one measurement away from a 24h comparison.
  //
  // The primary queue is newest-first, and has to be. What it cannot do is come
  // back. Production on 2026-08-17: 153 tokens carrying a comparable
  // measurement were overdue, 79 of them by more than twelve hours, and the
  // whole 48-hour window held no launch with two comparable observations more
  // than 15.5 hours apart — so the movers rail asked for a pair the cadence
  // could never produce.
  //
  // Everything below is about what this queue REFUSES, because the in-memory
  // repository must not be kinder than Postgres about any of it.
  // -------------------------------------------------------------------------
  describe(`${name}: the pair-forming queue returns launches one measurement from a pair`, () => {
    const PAIR_AGE_MS = 24 * 3_600_000;
    const PAIR_TOLERANCE_MS = 4 * 3_600_000;
    /** 24h after T0: measuring at this instant pairs with the T0 observation. */
    const IN_BAND = '2026-08-05T00:00:00.000Z';

    const remeasurable = (repository: B20ObservationHarnessV1['repository'], now: string, limit = 10) =>
      repository.selectRemeasurableLaunches({
        limit,
        maxLaunchAgeMs: 96 * 3_600_000,
        pairAgeMs: PAIR_AGE_MS,
        pairToleranceMs: PAIR_TOLERANCE_MS,
        now,
      });

    test('a comparable observation inside the band is offered', async () => {
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1());
      const due = await remeasurable(repository, IN_BAND);
      assert.equal(due.length, 1);
      assert.equal(due[0]?.tokenAddress, TOKEN);
      assert.equal(due[0]?.lastMeasuredAt, T0);
    });

    test('a measured profile miss is comparable evidence and is offered too', async () => {
      // `round_trip_above_tolerance` is a measurement, and the movers
      // projection pairs it. A queue that skipped it would starve exactly the
      // rows the live rail is made of.
      const { repository } = await seeded();
      await repository.insertObservation(
        observationFixtureV1({ state: 'rejected', reasonCode: 'round_trip_above_tolerance' }),
      );
      assert.equal((await remeasurable(repository, IN_BAND)).length, 1);
    });

    test('a launch whose newest reading is NOT comparable is refused', async () => {
      // The newest observation of ANY state decides. If the last thing Miorail
      // saw was a route failure, its market profile is not what a pair would
      // compare, and this queue must not claim otherwise.
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1());
      await repository.insertObservation(
        observationFixtureV1({
          state: 'rejected',
          reasonCode: 'no_exit_route',
          exitRouteFound: false,
          observationBlockNumber: '49500001',
          measuredAt: '2026-08-04T01:00:00.000Z',
          staleAfter: '2026-08-04T01:30:00.000Z',
        }),
      );
      assert.equal((await remeasurable(repository, IN_BAND)).length, 0);
    });

    test('an unmeasured newest reading is refused, however comparable the one before it was', async () => {
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1());
      await repository.insertObservation(
        observationFixtureV1({
          state: 'unmeasured',
          reasonCode: 'route_search_degraded',
          observationBlockNumber: '49500002',
          measuredAt: '2026-08-04T02:00:00.000Z',
          staleAfter: '2026-08-04T02:30:00.000Z',
        }),
      );
      assert.equal((await remeasurable(repository, IN_BAND)).length, 0);
    });

    test('the band is closed at both ends', async () => {
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1());
      // Too young: measuring now would produce a pair 19 hours apart, which the
      // movers projection refuses as `baseline_outside_window`.
      assert.equal((await remeasurable(repository, '2026-08-04T19:00:00.000Z')).length, 0);
      // Inside, at each edge.
      assert.equal((await remeasurable(repository, '2026-08-04T20:00:00.000Z')).length, 1);
      assert.equal((await remeasurable(repository, '2026-08-05T04:00:00.000Z')).length, 1);
      // Too old: a pair from here would be 29 hours apart. The launch is not
      // skipped forever — the primary queue still holds it — but this queue
      // makes no claim it can produce a pair.
      assert.equal((await remeasurable(repository, '2026-08-05T05:00:00.000Z')).length, 0);
    });

    test('a launch past the measurement window is refused', async () => {
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1());
      const due = await repository.selectRemeasurableLaunches({
        limit: 10,
        maxLaunchAgeMs: 60_000,
        pairAgeMs: PAIR_AGE_MS,
        pairToleranceMs: PAIR_TOLERANCE_MS,
        now: IN_BAND,
      });
      assert.equal(due.length, 0);
    });

    test('a never-measured launch is not in this queue at all', async () => {
      const { repository } = await seeded();
      assert.equal((await remeasurable(repository, IN_BAND)).length, 0);
    });

    test('oldest measurement first — the ordering the newest-first queue could not do', async () => {
      const harness = await seeded();
      const second = `${observationHashV1('2')}:0`;
      await harness.seedLaunch({
        id: second,
        tokenAddress: `0xb2${'1'.repeat(38)}`,
        detectedAt: T0,
        blockNumber: '49500100',
      });
      // The SECOND launch was measured later, so it must come second here even
      // though it is the newer launch — the whole point of this queue.
      await harness.repository.insertObservation(observationFixtureV1());
      await harness.repository.insertObservation(
        observationFixtureV1({
          launchId: second,
          tokenAddress: `0xb2${'1'.repeat(38)}`,
          measuredAt: '2026-08-04T02:00:00.000Z',
          staleAfter: '2026-08-04T02:30:00.000Z',
          observationBlockNumber: '49500100',
        }),
      );
      const due = await remeasurable(harness.repository, '2026-08-05T01:00:00.000Z');
      assert.deepEqual(
        due.map((launch) => launch.lastMeasuredAt),
        [T0, '2026-08-04T02:00:00.000Z'],
      );
    });

    test('the limit bounds the reservation', async () => {
      const harness = await seeded();
      await harness.seedLaunch({
        id: `${observationHashV1('3')}:0`,
        tokenAddress: `0xb2${'3'.repeat(38)}`,
        detectedAt: T0,
        blockNumber: '49500200',
      });
      await harness.repository.insertObservation(observationFixtureV1());
      await harness.repository.insertObservation(
        observationFixtureV1({
          launchId: `${observationHashV1('3')}:0`,
          tokenAddress: `0xb2${'3'.repeat(38)}`,
          observationBlockNumber: '49500200',
        }),
      );
      assert.equal((await remeasurable(harness.repository, IN_BAND)).length, 2);
      assert.equal((await remeasurable(harness.repository, IN_BAND, 1)).length, 1);
    });
  });

  describe(`${name}: a settled verdict earns a longer silence`, () => {
    // Production, 2026-08-10: 750 tokens, 72 observations each in 24 hours,
    // `count(distinct state) = 1`. 36,453 of them re-confirmed `no_entry_route`
    // on 541 tokens. A flat 20-minute interval spent the whole RPC budget
    // re-learning nothing, and starved the provisional tokens the rail exists
    // for. These tests pin the shape of the fix, not the burn.
    const HOUR = 3_600_000;
    const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

    async function measured(
      repository: B20ObservationHarnessV1['repository'],
      entries: { atMs: number; state: string; reasonCode: string }[],
    ): Promise<void> {
      let block = 49_500_000;
      for (const entry of entries) {
        block += 1;
        await repository.insertObservation(observationFixtureV1({
          state: entry.state as B20OpportunityObservationV1['state'],
          reasonCode: entry.reasonCode as B20OpportunityObservationV1['reasonCode'],
          // `no_entry_route` with a found entry route would be an observation
          // the production path could never produce.
          entryRouteFound: entry.reasonCode !== 'no_entry_route',
          exitRouteFound: entry.reasonCode !== 'no_entry_route' && entry.reasonCode !== 'no_exit_route',
          observationBlockNumber: String(block),
          measuredAt: at(entry.atMs),
          // Must follow `measuredAt`; the fixture default is pinned to T0.
          staleAfter: at(entry.atMs + 30 * 60_000),
        }));
      }
    }

    const due = (repository: B20ObservationHarnessV1['repository'], nowMs: number) =>
      repository.selectMeasurableLaunches({
        limit: 10,
        maxLaunchAgeMs: 72 * HOUR,
        minReMeasureIntervalMs: 20 * 60_000,
        now: at(nowMs),
      });

    test('a route-existence rejection waits hours, not minutes', async () => {
      const { repository } = await seeded();
      await measured(repository, [{ atMs: 0, state: 'rejected', reasonCode: 'no_entry_route' }]);
      assert.equal((await due(repository, HOUR)).length, 0, 'an hour is not long enough');
      assert.equal((await due(repository, 5 * HOUR)).length, 0);
      assert.equal((await due(repository, 7 * HOUR)).length, 1, 'six hours is');
    });

    test('the same verdict three times running earns a day', async () => {
      const { repository } = await seeded();
      await measured(repository, [
        { atMs: 0, state: 'rejected', reasonCode: 'no_entry_route' },
        { atMs: 6 * HOUR, state: 'rejected', reasonCode: 'no_entry_route' },
        { atMs: 12 * HOUR, state: 'rejected', reasonCode: 'no_entry_route' },
      ]);
      assert.equal((await due(repository, 19 * HOUR)).length, 0, 'six hours no longer suffices');
      assert.equal((await due(repository, 37 * HOUR)).length, 1);
    });

    test('the repeat count is consecutive — a different answer resets it', async () => {
      // Otherwise a token that recovered and then failed again would inherit
      // the silence it earned before recovering.
      const { repository } = await seeded();
      await measured(repository, [
        { atMs: 0, state: 'rejected', reasonCode: 'no_entry_route' },
        { atMs: 6 * HOUR, state: 'rejected', reasonCode: 'no_entry_route' },
        { atMs: 12 * HOUR, state: 'provisional', reasonCode: 'quoted_pre_entry' },
        { atMs: 13 * HOUR, state: 'rejected', reasonCode: 'no_entry_route' },
      ]);
      assert.equal((await due(repository, 20 * HOUR)).length, 1, 'back to six hours, not a day');
    });

    test('a rejection about price waits an hour, because price moves', async () => {
      const { repository } = await seeded();
      await measured(repository, [
        { atMs: 0, state: 'rejected', reasonCode: 'round_trip_above_tolerance' },
        { atMs: HOUR, state: 'rejected', reasonCode: 'round_trip_above_tolerance' },
        { atMs: 2 * HOUR, state: 'rejected', reasonCode: 'round_trip_above_tolerance' },
        { atMs: 3 * HOUR, state: 'rejected', reasonCode: 'round_trip_above_tolerance' },
      ]);
      // Four in a row, and it still gets an hour: repetition settles a question
      // about whether a route exists, not one about what it costs today.
      assert.equal((await due(repository, 3 * HOUR + 30 * 60_000)).length, 0);
      assert.equal((await due(repository, 4 * HOUR + 60_000)).length, 1);
    });

    test('an unreadable control is retried soon — that failure may be ours', async () => {
      // The recurring defect this rail is built against. `controls_unread`
      // carries `unmeasured`, not `rejected`, precisely because it describes
      // our own read failing rather than the token — and the answer to a read
      // that did not complete is to read again, not to wait a day.
      const { repository } = await seeded();
      await measured(repository, [
        { atMs: 0, state: 'unmeasured', reasonCode: 'controls_unread' },
        { atMs: 25 * 60_000, state: 'unmeasured', reasonCode: 'controls_unread' },
        { atMs: 50 * 60_000, state: 'unmeasured', reasonCode: 'controls_unread' },
        { atMs: 75 * 60_000, state: 'unmeasured', reasonCode: 'controls_unread' },
      ]);
      assert.equal((await due(repository, 100 * 60_000)).length, 1, 'still the base interval');
    });

    test('a provisional token keeps the short interval it was built for', async () => {
      const { repository } = await seeded();
      await measured(repository, [
        { atMs: 0, state: 'provisional', reasonCode: 'quoted_pre_entry' },
        { atMs: 25 * 60_000, state: 'provisional', reasonCode: 'quoted_pre_entry' },
        { atMs: 50 * 60_000, state: 'provisional', reasonCode: 'quoted_pre_entry' },
        { atMs: 75 * 60_000, state: 'provisional', reasonCode: 'quoted_pre_entry' },
      ]);
      assert.equal((await due(repository, 100 * 60_000)).length, 1);
    });
  });

  describe(`${name}: one worker measures at a time`, () => {
    test('a second worker cannot take a held lease', async () => {
      const { repository } = await createHarness();
      const first = await repository.acquireMeasureLease({ owner: 'a', now: T0, ttlMs: 600_000 });
      assert.ok(first);
      assert.equal(await repository.acquireMeasureLease({ owner: 'b', now: T0, ttlMs: 600_000 }), null);
    });

    test('an expired lease frees the lane, so a crashed worker cannot block forever', async () => {
      const { repository } = await createHarness();
      await repository.acquireMeasureLease({ owner: 'a', now: T0, ttlMs: 600_000 });
      const later = new Date(Date.parse(T0) + 700_000).toISOString();
      assert.ok(await repository.acquireMeasureLease({ owner: 'b', now: later, ttlMs: 600_000 }));
    });

    test('a released lease is free immediately, and only its owner may release it', async () => {
      const { repository } = await createHarness();
      await repository.acquireMeasureLease({ owner: 'a', now: T0, ttlMs: 600_000 });
      await repository.releaseMeasureLease({ owner: 'b', now: T0 });
      assert.equal(await repository.acquireMeasureLease({ owner: 'c', now: T0, ttlMs: 600_000 }), null);
      await repository.releaseMeasureLease({ owner: 'a', now: T0 });
      assert.ok(await repository.acquireMeasureLease({ owner: 'c', now: T0, ttlMs: 600_000 }));
    });
  });

  describe(`${name}: the feed is a stable, canonical-only page`, () => {
    /** Three launches at ascending blocks, each with one observation. */
    async function threeLaunches(): Promise<B20ObservationHarnessV1> {
      const harness = await createHarness();
      for (const [index, seed] of ['1', '2', '3'].entries()) {
        await harness.seedLaunch({
          id: `${observationHashV1(seed)}:0`,
          tokenAddress: TOKEN,
          detectedAt: T0,
          blockNumber: String(1000 + index),
        });
        await harness.repository.insertObservation(
          observationFixtureV1({
            launchId: `${observationHashV1(seed)}:0`,
            observationBlockNumber: String(49_500_000 + index),
            measuredAt: new Date(Date.parse(T0) + index * 1000).toISOString(),
            staleAfter: new Date(Date.parse(T0) + index * 1000 + 1_800_000).toISOString(),
          }),
        );
      }
      return harness;
    }

    test('the newest launch block comes first', async () => {
      const { repository } = await threeLaunches();
      const page = await repository.listFeed({ limit: 10, now: T0 });
      assert.deepEqual(
        page.rows.map((row) => row.launch.blockNumber),
        ['1002', '1001', '1000'],
      );
      assert.ok(page.rows.every((row) => row.observation !== null));
    });

    test('a launch with no observation still appears, with none', async () => {
      // §21.4 — the launch is real evidence. "Never measured" is a state, not
      // a reason to hide it.
      const harness = await createHarness();
      await harness.seedLaunch({ id: `${observationHashV1('9')}:0`, tokenAddress: TOKEN, detectedAt: T0 });
      const page = await harness.repository.listFeed({ limit: 10, now: T0 });
      assert.equal(page.rows.length, 1);
      assert.equal(page.rows[0]?.observation, null);
    });

    test('pagination stays stable while newer launches arrive', async () => {
      // §21.8. The cursor encodes the ordering KEY, not an offset — a feed that
      // grows at the top would make offset pagination repeat or skip rows.
      const harness = await threeLaunches();
      const first = await harness.repository.listFeed({ limit: 2, now: T0 });
      assert.equal(first.rows.length, 2);
      assert.ok(first.nextCursor);

      // A newer launch arrives ABOVE the page boundary.
      await harness.seedLaunch({
        id: `${observationHashV1('4')}:0`,
        tokenAddress: TOKEN,
        detectedAt: T0,
        blockNumber: '1009',
      });

      const second = await harness.repository.listFeed({
        limit: 2,
        cursor: first.nextCursor,
        now: T0,
      });
      const seen = [...first.rows, ...second.rows].map((row) => row.launch.id);
      assert.equal(new Set(seen).size, seen.length, 'no row is returned twice');
      assert.ok(
        !second.rows.some((row) => row.launch.blockNumber === '1009'),
        'the newly arrived launch does not appear below the boundary',
      );
    });

    test('the latest observation is chosen deterministically', async () => {
      // §21.5. Two observations for one launch: the newest by measuredAt, and
      // the tie broken to a total order rather than left to the planner.
      const harness = await createHarness();
      const launchId = `${observationHashV1('1')}:0`;
      await harness.seedLaunch({ id: launchId, tokenAddress: TOKEN, detectedAt: T0 });
      await harness.repository.insertObservation(observationFixtureV1());
      await harness.repository.insertObservation(
        observationFixtureV1({
          observationBlockNumber: '49500100',
          state: 'rejected',
          reasonCode: 'transfers_paused',
          transfersPaused: true,
          measuredAt: '2026-08-04T00:10:00.000Z',
          staleAfter: '2026-08-04T00:40:00.000Z',
        }),
      );
      const page = await harness.repository.listFeed({ limit: 10, now: T0 });
      assert.equal(page.rows[0]?.observation?.state, 'rejected', 'the newer measurement wins');
      assert.equal(page.rows[0]?.observation?.observationBlockNumber, '49500100');
      // Repeated reads agree.
      const again = await harness.repository.listFeed({ limit: 10, now: T0 });
      assert.equal(again.rows[0]?.observation?.id, page.rows[0]?.observation?.id);
    });

    test('a state filter selects only that state', async () => {
      const harness = await threeLaunches();
      const provisional = await harness.repository.listFeed({ limit: 10, now: T0, states: ['provisional'] });
      assert.equal(provisional.rows.length, 3);
      const rejected = await harness.repository.listFeed({ limit: 10, now: T0, states: ['rejected'] });
      assert.equal(rejected.rows.length, 0);
    });

    test('an observation from an unsupported measurement version is not current', async () => {
      // A row this build cannot interpret is not shown as the live measurement.
      const harness = await createHarness();
      await harness.seedLaunch({ id: `${observationHashV1('1')}:0`, tokenAddress: TOKEN, detectedAt: T0 });
      await harness.repository.insertObservation(observationFixtureV1());
      const page = await harness.repository.listFeed({
        limit: 10,
        now: T0,
        measurementVersions: ['b20-observation/v99'],
      });
      assert.equal(page.rows.length, 1);
      assert.equal(page.rows[0]?.observation, null);
    });

    test('one token resolves to its own launch and history', async () => {
      // §4 — and never another token's observation, whatever it is called.
      const harness = await createHarness();
      await harness.seedLaunch({ id: `${observationHashV1('1')}:0`, tokenAddress: TOKEN, detectedAt: T0 });
      await harness.repository.insertObservation(observationFixtureV1());
      const found = await harness.repository.getFeedRowForToken({ tokenAddress: TOKEN, historyLimit: 10 });
      assert.ok(found);
      assert.equal(found.row.launch.tokenAddress, TOKEN);
      assert.equal(found.history.length, 1);
      assert.equal(
        await harness.repository.getFeedRowForToken({
          tokenAddress: '0xb200000000000000000000ffffffffffffffffff',
          historyLimit: 10,
        }),
        null,
        'an unknown address is not another token’s card',
      );
    });

    test('the pipeline counts describe one moment', async () => {
      const harness = await threeLaunches();
      const counts = await harness.repository.pipelineCounts({ now: T0, maxLaunchAgeMs: 48 * 3_600_000 });
      assert.equal(counts.canonicalLaunchCount, 3);
      assert.equal(counts.observationCount, 3);
      assert.equal(counts.launchesAwaitingMeasurement, 0);
    });

    test('a launch awaiting measurement is counted as such', async () => {
      const harness = await createHarness();
      await harness.seedLaunch({ id: `${observationHashV1('7')}:0`, tokenAddress: TOKEN, detectedAt: T0 });
      const counts = await harness.repository.pipelineCounts({ now: T0, maxLaunchAgeMs: 48 * 3_600_000 });
      assert.equal(counts.canonicalLaunchCount, 1);
      assert.equal(counts.launchesAwaitingMeasurement, 1);
      assert.equal(counts.observationCount, 0);
    });
  });

  // -------------------------------------------------------------------------
  // T73 §3 — the mover pairing, identical in both stores.
  //
  // The in-memory store must not be kinder than Postgres: same baseline
  // choice, same tolerance, same null when nothing compatible exists.
  // -------------------------------------------------------------------------
  describe(`${name}: a mover pair is the latest comparable market observation and its nearest baseline`, () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const pairsOf = (repository: B20ObservationRepositoryV1, now: string, toleranceMs = 4 * 60 * 60 * 1000) =>
      repository.listMoverPairs({
        limit: 10,
        now,
        baselineAgeMs: DAY_MS,
        baselineToleranceMs: toleranceMs,
        maxLaunchAgeMs: 30 * 24 * 60 * 60 * 1000,
      });

    test('a launch with one observation has no baseline, and is not dropped', async () => {
      // "No baseline" is a real answer — Miorail has not been measuring long
      // enough. Dropping the launch would make the rail look shorter than the
      // feed for no stated reason.
      const { repository } = await seeded();
      await repository.insertObservation(
        observationFixtureV1({ observationBlockNumber: '49531075', measuredAt: T0, staleAfter: '2026-08-04T00:30:00.000Z' }),
      );
      const pairs = await pairsOf(repository, '2026-08-04T00:10:00.000Z');
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0]!.latest.measuredAt, T0);
      assert.equal(pairs[0]!.baseline, null);
    });

    test('the baseline is the observation NEAREST 24h back, not merely the newest older one', async () => {
      // With dense measurement, "newest older than 24h" silently shortens the
      // interval — and the rail's label promises 24 hours.
      const { repository } = await seeded();
      const latestAt = '2026-08-05T12:00:00.000Z';
      for (const [block, measuredAt] of [
        ['49531000', '2026-08-04T09:00:00.000Z'], // 27h back
        ['49531010', '2026-08-04T11:30:00.000Z'], // 24.5h back — nearest
        ['49531020', '2026-08-04T14:00:00.000Z'], // 22h back
        ['49531099', latestAt],
      ] as const) {
        await repository.insertObservation(
          observationFixtureV1({
            observationBlockNumber: block,
            measuredAt,
            staleAfter: new Date(Date.parse(measuredAt) + 30 * 60 * 1000).toISOString(),
          }),
        );
      }
      const pairs = await pairsOf(repository, '2026-08-05T12:10:00.000Z');
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0]!.latest.measuredAt, latestAt);
      assert.equal(pairs[0]!.baseline?.measuredAt, '2026-08-04T11:30:00.000Z');
    });

    test('a baseline outside the tolerance is not used', async () => {
      const { repository } = await seeded();
      await repository.insertObservation(
        observationFixtureV1({ observationBlockNumber: '49530000', measuredAt: '2026-08-01T12:00:00.000Z', staleAfter: '2026-08-01T12:30:00.000Z' }),
      );
      await repository.insertObservation(
        observationFixtureV1({ observationBlockNumber: '49531099', measuredAt: '2026-08-05T12:00:00.000Z', staleAfter: '2026-08-05T12:30:00.000Z' }),
      );
      const pairs = await pairsOf(repository, '2026-08-05T12:10:00.000Z', 60 * 60 * 1000);
      assert.equal(pairs[0]!.baseline, null);
    });

    test('the latest observation is never also its own baseline', async () => {
      const { repository } = await seeded();
      await repository.insertObservation(
        observationFixtureV1({ observationBlockNumber: '49531099', measuredAt: '2026-08-05T12:00:00.000Z', staleAfter: '2026-08-05T12:30:00.000Z' }),
      );
      // A zero-length interval would render as a 0% change with full confidence.
      const pairs = await pairsOf(repository, '2026-08-05T12:10:00.000Z', DAY_MS);
      assert.notEqual(pairs[0]!.baseline?.id, pairs[0]!.latest.id);
    });

    test('a degraded refresh does not erase the last comparable profile or replace its baseline', async () => {
      const { repository } = await seeded();
      const comparableThen = '2026-08-04T09:00:00.000Z';
      const degradedThen = '2026-08-04T09:30:00.000Z';
      const comparableNow = '2026-08-05T09:05:00.000Z';
      const degradedNow = '2026-08-05T09:35:00.000Z';
      for (const [block, measuredAt, degraded] of [
        ['49531000', comparableThen, false],
        ['49531001', degradedThen, true],
        ['49574000', comparableNow, false],
        ['49574001', degradedNow, true],
      ] as const) {
        await repository.insertObservation(
          observationFixtureV1({
            observationBlockNumber: block,
            measuredAt,
            staleAfter: new Date(Date.parse(measuredAt) + 30 * 60 * 1000).toISOString(),
            ...(degraded ? { state: 'unmeasured' as const, reasonCode: 'controls_incomplete' } : {}),
          }),
        );
      }

      const pairs = await pairsOf(repository, '2026-08-05T09:40:00.000Z');
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0]!.latest.measuredAt, comparableNow);
      assert.equal(pairs[0]!.baseline?.measuredAt, comparableThen);
    });

    test('the launch identity travels with the pair', async () => {
      const { repository } = await seeded();
      await repository.insertObservation(observationFixtureV1({ measuredAt: T0, staleAfter: '2026-08-04T00:30:00.000Z' }));
      const pairs = await pairsOf(repository, '2026-08-04T00:10:00.000Z');
      assert.equal(pairs[0]!.launch.tokenAddress, TOKEN);
      assert.equal(pairs[0]!.launch.canonical, true);
      assert.ok(pairs[0]!.launch.decimals !== undefined);
    });

    test('the active market read crosses a 100-row Discover page boundary', async () => {
      // Production had its first fresh exit at launch rank 621. A repository
      // clamp inherited from the paginated feed returned a healthy empty rail.
      const harness = await createHarness();
      const ids = new Set<string>();
      for (let index = 0; index < 101; index += 1) {
        const transactionHash = `0x${(index + 1).toString(16).padStart(64, '0')}`;
        const launchId = `${transactionHash}:0`;
        ids.add(launchId);
        await harness.seedLaunch({
          id: launchId,
          tokenAddress: TOKEN,
          detectedAt: T0,
          blockNumber: String(3_000 + index),
        });
        await harness.repository.insertObservation(
          observationFixtureV1({
            launchId,
            observationBlockNumber: String(49_600_000 + index),
            measuredAt: T0,
            staleAfter: '2026-08-04T00:30:00.000Z',
          }),
        );
      }
      const pairs = await harness.repository.listMoverPairs({
        limit: 200,
        now: '2026-08-04T00:10:00.000Z',
        baselineAgeMs: DAY_MS,
        baselineToleranceMs: 4 * 60 * 60 * 1000,
        maxLaunchAgeMs: 30 * DAY_MS,
      });
      assert.equal(pairs.filter((pair) => ids.has(pair.launch.id)).length, 101);
    });
  });

  // -------------------------------------------------------------------------
  // T73-LIVE §4 — the 24h rail is load-bearing on retention.
  //
  // Movers compares two measurements of the SAME token about a day apart. That
  // only exists if a second measurement is INSERTED beside the first rather
  // than replacing it. An "upsert the latest observation per token" storage
  // design would look correct in every other test in this file, serve a
  // perfectly good Discover feed, and make the Movers rail empty forever — with
  // no error anywhere, because nothing would have failed.
  //
  // So this walks the actual production sequence: measure, wait a day, measure
  // again, and follow the result all the way into the projection the card
  // renders.
  // -------------------------------------------------------------------------
  describe(`${name}: measurements accumulate, and a day apart they become a mover`, () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const MEASURED_A = '2026-08-04T09:00:00.000Z';
    const MEASURED_B = '2026-08-05T09:05:00.000Z';
    const NOW = '2026-08-05T09:15:00.000Z';

    /** Enough exit capacity to clear the rail's own thin-pool floor. */
    const CAPACITY_A = '1000000000000000000000';
    const CAPACITY_B = '2000000000000000000000';

    async function measureTwice(): Promise<B20ObservationRepositoryV1> {
      const { repository } = await seeded();
      await repository.insertObservation(
        observationFixtureV1({
          observationBlockNumber: '49600000',
          measuredAt: MEASURED_A,
          staleAfter: new Date(Date.parse(MEASURED_A) + 30 * 60 * 1000).toISOString(),
          largestPassingSizeAtomic: CAPACITY_A,
        }),
      );
      await repository.insertObservation(
        observationFixtureV1({
          observationBlockNumber: '49643000',
          measuredAt: MEASURED_B,
          staleAfter: new Date(Date.parse(MEASURED_B) + 30 * 60 * 1000).toISOString(),
          largestPassingSizeAtomic: CAPACITY_B,
        }),
      );
      return repository;
    }

    test('the second measurement does not replace the first', async () => {
      const repository = await measureTwice();
      const counts = await repository.pipelineCounts({ now: NOW, maxLaunchAgeMs: 30 * DAY_MS });
      // Two rows. One would mean the baseline the 24h card needs was destroyed
      // by the very pass that was supposed to complete the pair.
      assert.equal(counts.observationCount, 2);
    });

    test('listMoverPairs returns measurement A as the baseline for B', async () => {
      const repository = await measureTwice();
      const pairs = await repository.listMoverPairs({
        limit: 10,
        now: NOW,
        baselineAgeMs: DAY_MS,
        baselineToleranceMs: 4 * 60 * 60 * 1000,
        maxLaunchAgeMs: 30 * DAY_MS,
      });
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0]!.latest.measuredAt, MEASURED_B);
      assert.equal(pairs[0]!.baseline?.measuredAt, MEASURED_A);
      assert.notEqual(pairs[0]!.baseline?.id, pairs[0]!.latest.id);
    });

    test('the pair becomes an eligible mover in the projection the card renders', async () => {
      const repository = await measureTwice();
      const pairs = await repository.listMoverPairs({
        limit: 10,
        now: NOW,
        baselineAgeMs: DAY_MS,
        baselineToleranceMs: 4 * 60 * 60 * 1000,
        maxLaunchAgeMs: 30 * DAY_MS,
      });
      const projected = measuredMoversV1({
        pairs: pairs.map((pair) => ({
          launch: {
            tokenAddress: pair.launch.tokenAddress,
            symbol: pair.launch.symbol,
            name: pair.launch.name,
            decimals: pair.launch.decimals,
            canonical: pair.launch.canonical,
          },
          latest: pair.latest,
          baseline: pair.baseline,
        })),
        now: new Date(NOW),
        baselineAgeMs: DAY_MS,
        baselineToleranceMs: 4 * 60 * 60 * 1000,
        minExitCoverageBps: 2_500,
        limit: 5,
      });
      // The whole point: two passes a day apart, and the rail has a row.
      assert.equal(projected.excluded.length, 0, JSON.stringify(projected.excluded));
      assert.equal(projected.movers.length, 1);
      assert.equal(projected.movers[0]!.tokenAddress, TOKEN);
    });

    test('one measurement alone is honestly not a mover', async () => {
      const { repository } = await seeded();
      await repository.insertObservation(
        observationFixtureV1({
          observationBlockNumber: '49643000',
          measuredAt: MEASURED_B,
          staleAfter: new Date(Date.parse(MEASURED_B) + 30 * 60 * 1000).toISOString(),
          largestPassingSizeAtomic: CAPACITY_B,
        }),
      );
      const pairs = await repository.listMoverPairs({
        limit: 10,
        now: NOW,
        baselineAgeMs: DAY_MS,
        baselineToleranceMs: 4 * 60 * 60 * 1000,
        maxLaunchAgeMs: 30 * DAY_MS,
      });
      const projected = measuredMoversV1({
        pairs: pairs.map((pair) => ({
          launch: {
            tokenAddress: pair.launch.tokenAddress,
            symbol: pair.launch.symbol,
            name: pair.launch.name,
            decimals: pair.launch.decimals,
            canonical: pair.launch.canonical,
          },
          latest: pair.latest,
          baseline: pair.baseline,
        })),
        now: new Date(NOW),
        baselineAgeMs: DAY_MS,
        baselineToleranceMs: 4 * 60 * 60 * 1000,
        minExitCoverageBps: 2_500,
        limit: 5,
      });
      assert.equal(projected.movers.length, 0);
      // Named, not dropped: time is the only thing missing, and the card says so.
      assert.equal(projected.excluded[0]?.reason, 'no_baseline');
    });
  });

  // -------------------------------------------------------------------------
  // T73-LIVE-DB §10 — a launch nobody has measured yet.
  //
  // The feed reads `l.<cols>, o.*` across a LEFT JOIN. The observation row
  // shares `token_address` and `launch_id` with the launch, a driver flattens
  // each row into one object, and the LAST duplicate wins — so with no
  // observation, `o.*` is all NULLs and the launch's own address was overwritten
  // with one. `String(null)` is the four-character string "null", which fails
  // the address regex and 500s the entire page.
  //
  // It hid on Neon because every launch in that window had an observation, and
  // the duplicate then carried the same value. It surfaced on the first
  // production database where discovery had run ahead of measurement — which is
  // the normal state of a catching-up pipeline.
  // -------------------------------------------------------------------------
  describe(`${name}: a launch with no observation keeps its own identity`, () => {
    test('the token address is the launch address, not "null"', async () => {
      const { repository } = await seeded();
      const page = await repository.listFeed({
        limit: 10,
        cursor: null,
        maxLaunchAgeMs: 30 * 24 * 60 * 60 * 1000,
        now: '2026-08-04T12:00:00.000Z',
      });
      assert.equal(page.rows.length, 1);
      const [row] = page.rows;
      assert.equal(row!.observation, null, 'nothing has measured this launch');
      assert.equal(row!.launch.tokenAddress, TOKEN);
      assert.match(row!.launch.tokenAddress, /^0x[0-9a-f]{40}$/);
    });

    test('every launch field survives, not only the address', async () => {
      const { repository } = await seeded();
      const page = await repository.listFeed({
        limit: 10,
        cursor: null,
        maxLaunchAgeMs: 30 * 24 * 60 * 60 * 1000,
        now: '2026-08-04T12:00:00.000Z',
      });
      const launch = page.rows[0]!.launch;
      // Each of these is a column that `o.*` could shadow the day an
      // observation gains a column of the same name.
      assert.notEqual(launch.id, 'null');
      assert.match(launch.blockNumber, /^[0-9]+$/);
      assert.match(launch.transactionHash, /^0x[0-9a-f]{64}$/);
      assert.equal(typeof launch.detectedAt, 'string');
      assert.ok(!Number.isNaN(Date.parse(launch.detectedAt)));
      assert.equal(launch.canonical, true);
      assert.ok(launch.name.length > 0 && launch.name !== 'null');
      assert.ok(launch.symbol.length > 0 && launch.symbol !== 'null');
    });

    test('the page cursor is built from a real launch id', async () => {
      // A cursor carrying "null" paginates to nowhere, silently.
      const { repository } = await seeded();
      const page = await repository.listFeed({
        limit: 1,
        cursor: null,
        maxLaunchAgeMs: 30 * 24 * 60 * 60 * 1000,
        now: '2026-08-04T12:00:00.000Z',
      });
      if (page.nextCursor !== null) {
        assert.ok(!page.nextCursor.includes('null'));
      }
      assert.notEqual(page.rows[0]!.launch.id, 'null');
    });

    test('an unmeasured launch and a measured one both project correctly', async () => {
      const { repository } = await seeded();
      await repository.insertObservation(
        observationFixtureV1({ measuredAt: T0, staleAfter: '2026-08-04T00:30:00.000Z' }),
      );
      const page = await repository.listFeed({
        limit: 10,
        cursor: null,
        maxLaunchAgeMs: 30 * 24 * 60 * 60 * 1000,
        now: '2026-08-04T12:00:00.000Z',
      });
      // Same launch, now measured: the address must be identical either way.
      assert.equal(page.rows[0]!.launch.tokenAddress, TOKEN);
      assert.ok(page.rows[0]!.observation !== null);
      assert.equal(page.rows[0]!.observation!.tokenAddress, TOKEN);
    });
  });

}
