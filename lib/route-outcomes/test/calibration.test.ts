import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  DEFAULT_RELIABILITY_THRESHOLDS_V1,
  ProviderReliabilityAssessmentV1Schema,
  ProviderReliabilitySnapshotV1Schema,
  ReliabilityEvidenceError,
  hashProviderReliabilitySnapshotV1,
  assessReliabilityV1,
  buildReliabilityEvidenceV1,
  buildReliabilitySnapshotV1,
  calibrateNetResultV1,
  calibratedExpectedOutputV1,
  compareRiskLexicographicV1,
  deriveRouteProviderOutcomeV1,
  rankingNetOutputV1,
  reliabilityEvidencePayloadV1,
  type ProviderReliabilityAssessmentV1,
  type ProviderReliabilitySnapshotV1,
  type RouteProviderOutcomeV1,
} from '../src/index.js';
import { WALLET_A, candidateFixtureV1, proofFixtureV1 } from './fixtures.js';

const THRESHOLDS = DEFAULT_RELIABILITY_THRESHOLDS_V1;
const CUTOFF = new Date('2026-07-27T12:00:00.000Z');

function outcomeAt(index: number, actualOutputAtomic: string): RouteProviderOutcomeV1 {
  const candidate = candidateFixtureV1({ providerId: 'uniswap' });
  const { proof, events } = proofFixtureV1({
    candidateHash: candidate.candidateHash,
    actualOutputAtomic,
    proofId: `route-proof:${index}`,
    now: new Date(CUTOFF.getTime() - (index + 1) * 60_000),
  });
  const derived = deriveRouteProviderOutcomeV1({ proof, candidate, events, derivedAt: CUTOFF });
  if (!derived.derived) throw new Error(derived.reason);
  return derived.outcome;
}

/** A sealed personal snapshot whose median adverse shortfall is `shortfallBps`. */
function snapshotWithShortfall(shortfallBps: number, count = 12): ProviderReliabilitySnapshotV1 {
  const expected = 1_000_000_000_000_000_000n;
  const actual = expected - (expected * BigInt(shortfallBps)) / 10_000n;
  const outcomes = Array.from({ length: count }, (_, index) => outcomeAt(index, actual.toString()));
  const built = buildReliabilitySnapshotV1({
    scope: 'personal',
    key: { providerId: 'uniswap', fromAsset: outcomes[0]!.fromAsset, toAsset: outcomes[0]!.toAsset },
    outcomes,
    cutoffAt: CUTOFF,
    createdAt: CUTOFF,
    thresholds: THRESHOLDS,
  });
  assert.ok(built);
  return built.snapshot;
}

function eligible(snapshot: ProviderReliabilitySnapshotV1): ProviderReliabilityAssessmentV1 {
  return assessReliabilityV1({
    providerId: snapshot.providerId,
    fromAsset: snapshot.fromAsset,
    toAsset: snapshot.toAsset,
    personal: snapshot,
    network: null,
    thresholds: THRESHOLDS,
    featureEnabled: true,
  });
}

function notScored(): ProviderReliabilityAssessmentV1 {
  return assessReliabilityV1({
    providerId: 'uniswap',
    fromAsset: 'from',
    toAsset: 'to',
    personal: null,
    network: null,
    thresholds: THRESHOLDS,
    featureEnabled: true,
  });
}

describe('history-adjusted expectations', () => {
  test('the calibrated expectation discounts by the median shortfall', () => {
    assert.equal(calibratedExpectedOutputV1(1_000_000n, 100), 990_000n);
    assert.equal(calibratedExpectedOutputV1(1_000_000n, 0), 1_000_000n);
  });

  test('the discount is floored, so it never rounds in the provider\'s favour', () => {
    // 3 × (10000 - 1) / 10000 = 2.9997 → 2, not 3.
    assert.equal(calibratedExpectedOutputV1(3n, 1), 2n);
  });

  test('calibration never raises an expectation above the quote', () => {
    const snapshot = snapshotWithShortfall(0);
    const result = calibrateNetResultV1({
      candidateHash: '0x'.padEnd(66, '1') as `0x${string}`,
      rawExpectedOutputAtomic: '1000',
      costOutputAtomic: '10',
      assessment: eligible(snapshot),
    });
    assert.equal(BigInt(result.calibratedExpectedOutputAtomic) <= 1_000n, true);
  });

  test('an eligible snapshot produces a lower adjusted net result than the raw one', () => {
    const snapshot = snapshotWithShortfall(200);
    const result = calibrateNetResultV1({
      candidateHash: '0x'.padEnd(66, '1') as `0x${string}`,
      rawExpectedOutputAtomic: '1000000000000000000',
      costOutputAtomic: '1000000000000000',
      assessment: eligible(snapshot),
    });
    assert.equal(result.calibrated, true);
    assert.equal(result.appliedShortfallBps, 200);
    assert.equal(result.scope, 'personal');
    assert.equal(result.snapshotHash, snapshot.snapshotHash);
    assert.equal(result.cutoffAt, snapshot.cutoffAt);
    assert.equal(
      BigInt(result.calibratedNetOutputAtomic!) < BigInt(result.rawNetOutputAtomic!),
      true,
    );
    // The quote itself is untouched.
    assert.equal(result.rawExpectedOutputAtomic, '1000000000000000000');
  });

  test('Not scored leaves both figures equal and names itself uncalibrated', () => {
    const result = calibrateNetResultV1({
      candidateHash: '0x'.padEnd(66, '1') as `0x${string}`,
      rawExpectedOutputAtomic: '1000',
      costOutputAtomic: '10',
      assessment: notScored(),
    });
    assert.equal(result.calibrated, false);
    assert.equal(result.appliedShortfallBps, 0);
    assert.equal(result.snapshotHash, null);
    assert.equal(result.cutoffAt, null);
    assert.equal(result.calibratedNetOutputAtomic, result.rawNetOutputAtomic);
  });

  test('an unpriceable candidate stays unscored rather than being calibrated around', () => {
    const result = calibrateNetResultV1({
      candidateHash: '0x'.padEnd(66, '1') as `0x${string}`,
      rawExpectedOutputAtomic: '1000',
      costOutputAtomic: null,
      assessment: eligible(snapshotWithShortfall(100)),
    });
    assert.equal(result.rawNetOutputAtomic, null);
    assert.equal(result.calibratedNetOutputAtomic, null);
    assert.equal(rankingNetOutputV1(result), null);
  });

  test('a cost that exceeds the output is not reported as a negative amount', () => {
    const result = calibrateNetResultV1({
      candidateHash: '0x'.padEnd(66, '1') as `0x${string}`,
      rawExpectedOutputAtomic: '100',
      costOutputAtomic: '500',
      assessment: notScored(),
    });
    assert.equal(result.rawNetOutputAtomic, null);
  });

  test('ranking uses the adjusted figure when calibrated and the raw one otherwise', () => {
    const calibrated = calibrateNetResultV1({
      candidateHash: '0x'.padEnd(66, '1') as `0x${string}`,
      rawExpectedOutputAtomic: '1000000',
      costOutputAtomic: '0',
      assessment: eligible(snapshotWithShortfall(1_000)),
    });
    assert.equal(rankingNetOutputV1(calibrated), 900_000n);

    const uncalibrated = calibrateNetResultV1({
      candidateHash: '0x'.padEnd(66, '2') as `0x${string}`,
      rawExpectedOutputAtomic: '950000',
      costOutputAtomic: '0',
      assessment: notScored(),
    });
    assert.equal(rankingNetOutputV1(uncalibrated), 950_000n);

    // The whole point: history changes the winner. The provider that quoted
    // MORE loses to the one that historically delivers what it says.
    assert.equal(rankingNetOutputV1(uncalibrated)! > rankingNetOutputV1(calibrated)!, true);
  });
});

describe('lowest_risk is lexicographic, never a blended score', () => {
  /** An eligible assessment with exactly the statistics under test. The
   * snapshot is re-sealed after each override, so the comparator is never fed
   * a shape the schema would reject in production. */
  function row(
    stats: {
      successRateBps?: number;
      shortfallBps?: number;
      floorBreachRateBps?: number;
      p90ConfirmationMs?: number | null;
    },
    providerId = 'uniswap',
  ) {
    const base = snapshotWithShortfall(100);
    const shortfall = stats.shortfallBps ?? 100;
    const draft = {
      ...base,
      successRateBps: stats.successRateBps ?? 10_000,
      medianAdverseShortfallBps: shortfall,
      p90AdverseShortfallBps: shortfall,
      floorBreachRateBps: stats.floorBreachRateBps ?? 0,
      p90ConfirmationMs: stats.p90ConfirmationMs === undefined ? 5_000 : stats.p90ConfirmationMs,
      // The counts must still add up to sampleSize, so the success rate is
      // expressed through them rather than contradicting them.
      completedCount: base.sampleSize,
      failedCount: 0,
      partialFailureCount: 0,
    };
    const snapshot = ProviderReliabilitySnapshotV1Schema.parse({
      ...draft,
      snapshotHash: hashProviderReliabilitySnapshotV1(draft as ProviderReliabilitySnapshotV1),
    });
    return {
      providerId,
      assessment: ProviderReliabilityAssessmentV1Schema.parse({
        schemaVersion: 'provider-reliability-assessment/v1',
        providerId,
        fromAsset: snapshot.fromAsset,
        toAsset: snapshot.toAsset,
        status: 'eligible',
        scope: 'personal',
        snapshot,
        notScoredReason: null,
        observedSamples: snapshot.sampleSize,
        requiredSamples: 10,
      }),
    };
  }

  test('success rate decides first', () => {
    const better = row({ successRateBps: 10_000, shortfallBps: 900 }, 'a');
    const worse = row({ successRateBps: 9_000, shortfallBps: 1 }, 'b');
    // A much better tail does NOT buy back a worse success rate. Under any
    // weighted score it would, which is exactly what this forbids.
    assert.equal(compareRiskLexicographicV1(better, worse) < 0, true);
  });

  test('p90 shortfall breaks a success-rate tie', () => {
    const tighter = row({ successRateBps: 9_500, shortfallBps: 20 }, 'a');
    const looser = row({ successRateBps: 9_500, shortfallBps: 300 }, 'b');
    assert.equal(compareRiskLexicographicV1(tighter, looser) < 0, true);
  });

  test('floor breach rate, then confirmation time, then provider id', () => {
    const common = { successRateBps: 9_500, shortfallBps: 20 };
    const cleaner = row({ ...common, floorBreachRateBps: 0 }, 'a');
    const breachier = row({ ...common, floorBreachRateBps: 500 }, 'b');
    assert.equal(compareRiskLexicographicV1(cleaner, breachier) < 0, true);

    const fast = row({ ...common, p90ConfirmationMs: 4_000 }, 'z');
    const slow = row({ ...common, p90ConfirmationMs: 20_000 }, 'a');
    assert.equal(compareRiskLexicographicV1(fast, slow) < 0, true);

    const left = row({ ...common, p90ConfirmationMs: 4_000 }, 'aerodrome');
    const right = row({ ...common, p90ConfirmationMs: 4_000 }, 'uniswap');
    assert.equal(compareRiskLexicographicV1(left, right) < 0, true);
  });

  test('an unmeasured confirmation time does not win the tie it cannot answer', () => {
    const measured = row({ successRateBps: 9_500, shortfallBps: 20, p90ConfirmationMs: 30_000 }, 'a');
    const unmeasured = row({ successRateBps: 9_500, shortfallBps: 20, p90ConfirmationMs: null }, 'b');
    assert.equal(compareRiskLexicographicV1(measured, unmeasured) < 0, true);
  });

  test('a provider with no eligible snapshot sorts last, not as risky', () => {
    // Absence of evidence is not evidence. It is also not a passing grade.
    const measured = row({ successRateBps: 5_000 }, 'a');
    const unknown = { providerId: 'b', assessment: notScored() };
    assert.equal(compareRiskLexicographicV1(measured, unknown) < 0, true);
    assert.equal(compareRiskLexicographicV1(unknown, measured) > 0, true);
  });
});

describe('reliability evidence carries statistics and nothing else', () => {
  test('the payload holds no proof ids, wallets or tenant ids', () => {
    const snapshot = snapshotWithShortfall(100);
    const payload = reliabilityEvidencePayloadV1(snapshot);
    const serialized = JSON.stringify(payload);
    // A network snapshot is built from other people's trades, and an evidence
    // record ends up inside a Route Card and a publishable proof bundle.
    assert.equal(serialized.includes('route-proof:'), false);
    assert.equal(serialized.includes(WALLET_A), false);
    assert.equal(serialized.includes('tenant-'), false);
    assert.equal(Object.hasOwn(payload, 'sampleSize'), true);
    assert.equal(Object.hasOwn(payload, 'snapshotHash'), true);
  });

  test('an eligible assessment becomes a valid provider_reliability record', () => {
    const snapshot = snapshotWithShortfall(100);
    const candidate = candidateFixtureV1({ providerId: 'uniswap' });
    const record = buildReliabilityEvidenceV1({
      candidate,
      assessment: eligible(snapshot),
      runStartedAt: new Date(CUTOFF.getTime() + 1_000),
    });
    assert.ok(record);
    assert.equal(record.evidenceType, 'provider_reliability');
    assert.equal(record.provider.id, 'miorail_verified_route_history');
    assert.equal(record.freeOrPaid, 'free');
    assert.equal(record.candidateHash, candidate.candidateHash);
  });

  test('Not scored produces no record at all', () => {
    // A record saying "no history" would count as evidence present, and every
    // missing-evidence check downstream would then be wrong about what it has.
    const record = buildReliabilityEvidenceV1({
      candidate: candidateFixtureV1({ providerId: 'uniswap' }),
      assessment: notScored(),
      runStartedAt: new Date(),
    });
    assert.equal(record, null);
  });

  test('a snapshot cut off AFTER the run started is refused', () => {
    // Otherwise the trade being ranked could appear in the history that ranked
    // it, and the statistic would be measuring its own effect.
    const snapshot = snapshotWithShortfall(100);
    assert.throws(
      () =>
        buildReliabilityEvidenceV1({
          candidate: candidateFixtureV1({ providerId: 'uniswap' }),
          assessment: eligible(snapshot),
          runStartedAt: new Date(Date.parse(snapshot.cutoffAt) - 1_000),
        }),
      (error: unknown) => {
        assert.ok(error instanceof ReliabilityEvidenceError);
        assert.equal(error.code, 'snapshot_not_before_run');
        return true;
      },
    );
  });

  test('a snapshot about a different pair is refused', () => {
    const snapshot = { ...snapshotWithShortfall(100), toAsset: 'eip155:8453/erc20:0xdead' };
    assert.throws(
      () =>
        buildReliabilityEvidenceV1({
          candidate: candidateFixtureV1({ providerId: 'uniswap' }),
          assessment: {
            ...eligible(snapshotWithShortfall(100)),
            snapshot,
          } as ProviderReliabilityAssessmentV1,
          runStartedAt: new Date(CUTOFF.getTime() + 1_000),
        }),
      /snapshot_pair_mismatch/,
    );
  });
});
