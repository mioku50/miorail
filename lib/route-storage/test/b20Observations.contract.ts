import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

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
  seedLaunch(input: { id: string; tokenAddress: string; detectedAt: string }): Promise<void>;
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
}
