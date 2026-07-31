import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  DEFAULT_RELIABILITY_THRESHOLDS_V1,
  aggregationVersionV1,
  assessReliabilityV1,
  buildReliabilitySnapshotV1,
  deriveRouteProviderOutcomeV1,
  hashProviderReliabilitySnapshotV1,
  medianV1,
  nearestRankQuantileV1,
  p90V1,
  rateBpsV1,
  selectWindowOutcomesV1,
  verifySnapshotMembershipV1,
  type ProviderReliabilitySnapshotV1,
  type ReliabilityScopeV1,
  type RouteProviderOutcomeV1,
} from '../src/index.js';
import { WALLET_A, WALLET_B, WALLET_C, candidateFixtureV1, proofFixtureV1 } from './fixtures.js';

const THRESHOLDS = DEFAULT_RELIABILITY_THRESHOLDS_V1;
const CUTOFF = new Date('2026-07-27T12:00:00.000Z');

/** One derived outcome, with the knobs the aggregation actually reads. */
function outcome(input: {
  index: number;
  wallet?: `0x${string}`;
  tenantId?: string;
  providerId?: string;
  shortfallAtomic?: string;
  finalStatus?: 'completed' | 'failed' | 'partial_failure';
  occurredAt?: Date;
}): RouteProviderOutcomeV1 {
  const candidate = candidateFixtureV1({
    providerId: input.providerId ?? 'uniswap',
    tenantId: input.tenantId ?? 'tenant-1',
    walletAddress: input.wallet ?? WALLET_A,
  });
  const at = input.occurredAt ?? new Date(CUTOFF.getTime() - (input.index + 1) * 60_000);
  const { proof, events } = proofFixtureV1({
    tenantId: input.tenantId ?? 'tenant-1',
    walletAddress: input.wallet ?? WALLET_A,
    finalStatus: input.finalStatus ?? 'completed',
    candidateHash: candidate.candidateHash,
    actualOutputAtomic: input.shortfallAtomic ?? '999000000000000000',
    proofId: `route-proof:${input.index}`,
    now: at,
  });
  const derived = deriveRouteProviderOutcomeV1({
    proof,
    candidate,
    events,
    derivedAt: CUTOFF,
  });
  if (!derived.derived) throw new Error(`fixture did not derive: ${derived.reason}`);
  return derived.outcome;
}

function snapshotOf(
  outcomes: readonly RouteProviderOutcomeV1[],
  scope: ReliabilityScopeV1 = 'personal',
): ProviderReliabilitySnapshotV1 {
  const built = buildReliabilitySnapshotV1({
    scope,
    key: {
      providerId: 'uniswap',
      fromAsset: outcomes[0]!.fromAsset,
      toAsset: outcomes[0]!.toAsset,
    },
    outcomes,
    cutoffAt: CUTOFF,
    createdAt: CUTOFF,
    thresholds: THRESHOLDS,
  });
  assert.ok(built, 'expected a snapshot');
  return built.snapshot;
}

describe('quantiles are integer and deterministic', () => {
  test('nearest rank, no interpolation', () => {
    const values = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n];
    // ceil(0.5 × 10) - 1 = 4 → the 5th value. Never the 5.5 an average gives.
    assert.equal(medianV1(values), 5n);
    // ceil(0.9 × 10) - 1 = 8 → the 9th value.
    assert.equal(p90V1(values), 9n);
  });

  test('input order never changes the answer', () => {
    const ascending = [10n, 20n, 30n, 40n, 50n];
    const shuffled = [30n, 50n, 10n, 40n, 20n];
    assert.equal(medianV1(ascending), medianV1(shuffled));
    assert.equal(p90V1(ascending), p90V1(shuffled));
  });

  test('big values are not rounded through a float', () => {
    // Two amounts a Number cannot tell apart.
    const a = 9_007_199_254_740_993n;
    const b = 9_007_199_254_740_992n;
    assert.equal(medianV1([b, a]), b);
    assert.equal(p90V1([b, a]), a);
  });

  test('a quantile of nothing is null, not zero', () => {
    // Zero adverse shortfall would be the most flattering possible lie about a
    // provider with no history.
    assert.equal(medianV1([]), null);
    assert.equal(p90V1([]), null);
  });

  test('single sample answers with itself at every quantile', () => {
    assert.equal(nearestRankQuantileV1([42n], 1), 42n);
    assert.equal(nearestRankQuantileV1([42n], 10_000), 42n);
  });

  test('rates round half up and stay in basis points', () => {
    assert.equal(rateBpsV1(1, 3), 3_333);
    assert.equal(rateBpsV1(2, 3), 6_667);
    assert.equal(rateBpsV1(0, 10), 0);
    assert.equal(rateBpsV1(10, 10), 10_000);
  });
});

describe('a snapshot is a reproducible statement about a bounded past', () => {
  test('membership recomputes the outcome set hash', () => {
    const outcomes = Array.from({ length: 12 }, (_, index) => outcome({ index }));
    const built = buildReliabilitySnapshotV1({
      scope: 'personal',
      key: { providerId: 'uniswap', fromAsset: outcomes[0]!.fromAsset, toAsset: outcomes[0]!.toAsset },
      outcomes,
      cutoffAt: CUTOFF,
      createdAt: CUTOFF,
      thresholds: THRESHOLDS,
    });
    assert.ok(built);
    assert.equal(verifySnapshotMembershipV1(built.snapshot, built.members), true);
    // Shuffled members still verify: order is derived, not trusted.
    assert.equal(verifySnapshotMembershipV1(built.snapshot, [...built.members].reverse()), true);
  });

  test('changing one member changes the snapshot hash', () => {
    const outcomes = Array.from({ length: 12 }, (_, index) => outcome({ index }));
    const original = snapshotOf(outcomes);
    const altered = [
      ...outcomes.slice(0, 11),
      outcome({ index: 11, shortfallAtomic: '900000000000000000' }),
    ];
    const changed = snapshotOf(altered);
    assert.notEqual(changed.outcomeSetHash, original.outcomeSetHash);
    assert.notEqual(changed.snapshotHash, original.snapshotHash);
  });

  test('a member that is not in the set fails verification', () => {
    const outcomes = Array.from({ length: 12 }, (_, index) => outcome({ index }));
    const snapshot = snapshotOf(outcomes);
    const swapped = [...outcomes.slice(0, 11), outcome({ index: 99 })];
    assert.equal(verifySnapshotMembershipV1(snapshot, swapped), false);
  });

  test('a tampered snapshot no longer matches its own hash', () => {
    const snapshot = snapshotOf(Array.from({ length: 12 }, (_, index) => outcome({ index })));
    assert.notEqual(
      hashProviderReliabilitySnapshotV1({ ...snapshot, medianAdverseShortfallBps: 0 }),
      snapshot.snapshotHash,
    );
  });

  test('the window excludes anything after the cutoff — no future leakage', () => {
    // This is the rule that keeps the loop from closing on itself: the trade
    // being ranked must never appear in the history that ranked it.
    const inside = outcome({ index: 0, occurredAt: new Date(CUTOFF.getTime() - 1_000) });
    const atCutoff = outcome({ index: 1, occurredAt: CUTOFF });
    const after = outcome({ index: 2, occurredAt: new Date(CUTOFF.getTime() + 1_000) });
    const selected = selectWindowOutcomesV1({
      outcomes: [inside, atCutoff, after],
      key: { providerId: 'uniswap', fromAsset: inside.fromAsset, toAsset: inside.toAsset },
      cutoffAt: CUTOFF,
      windowDays: 90,
    });
    assert.deepEqual(
      selected.map((row) => row.proofId).sort(),
      [inside.proofId, atCutoff.proofId].sort(),
    );
  });

  test('the window drops anything older than windowDays', () => {
    const fresh = outcome({ index: 0 });
    const stale = outcome({
      index: 1,
      occurredAt: new Date(CUTOFF.getTime() - 91 * 24 * 60 * 60 * 1_000),
    });
    const selected = selectWindowOutcomesV1({
      outcomes: [fresh, stale],
      key: { providerId: 'uniswap', fromAsset: fresh.fromAsset, toAsset: fresh.toAsset },
      cutoffAt: CUTOFF,
      windowDays: 90,
    });
    assert.deepEqual(selected.map((row) => row.proofId), [fresh.proofId]);
  });

  test('a snapshot over no outcomes is not sealed at all', () => {
    const built = buildReliabilitySnapshotV1({
      scope: 'network',
      key: { providerId: 'uniswap', fromAsset: 'a', toAsset: 'b' },
      outcomes: [],
      cutoffAt: CUTOFF,
      createdAt: CUTOFF,
      thresholds: THRESHOLDS,
    });
    assert.equal(built, null);
  });

  test('counts and rates are consistent with the members', () => {
    const outcomes = [
      ...Array.from({ length: 8 }, (_, index) => outcome({ index })),
      outcome({ index: 8, finalStatus: 'failed' }),
      outcome({ index: 9, finalStatus: 'partial_failure' }),
    ];
    const snapshot = snapshotOf(outcomes);
    assert.equal(snapshot.sampleSize, 10);
    assert.equal(snapshot.completedCount, 8);
    assert.equal(snapshot.failedCount, 1);
    assert.equal(snapshot.partialFailureCount, 1);
    assert.equal(snapshot.successRateBps, 8_000);
  });

  test('a revert contributes to the failure count but not to the shortfall spread', () => {
    const withRevert = snapshotOf([
      ...Array.from({ length: 9 }, (_, index) => outcome({ index })),
      outcome({ index: 9, finalStatus: 'failed' }),
    ]);
    const withoutRevert = snapshotOf(Array.from({ length: 9 }, (_, index) => outcome({ index })));
    assert.equal(withRevert.failedCount, 1);
    assert.equal(
      withRevert.medianAdverseShortfallBps,
      withoutRevert.medianAdverseShortfallBps,
      'a revert must not also move the shortfall distribution',
    );
  });

  test('the aggregation version carries the thresholds that produced it', () => {
    // Lowering a threshold changes what "eligible" means; old snapshots must
    // stay readable as what they were, not be reinterpreted under new rules.
    assert.equal(aggregationVersionV1(THRESHOLDS), 'provider-reliability/v1:w90:p10:n30:u3');
    assert.notEqual(
      aggregationVersionV1({ ...THRESHOLDS, personalMinSamples: 5 }),
      aggregationVersionV1(THRESHOLDS),
    );
  });
});

describe('eligibility and scope selection', () => {
  const pair = { fromAsset: 'from', toAsset: 'to' };

  function assess(input: {
    personal?: ProviderReliabilitySnapshotV1 | null;
    network?: ProviderReliabilitySnapshotV1 | null;
    featureEnabled?: boolean;
  }) {
    return assessReliabilityV1({
      providerId: 'uniswap',
      ...pair,
      personal: input.personal ?? null,
      network: input.network ?? null,
      thresholds: THRESHOLDS,
      featureEnabled: input.featureEnabled ?? true,
    });
  }

  test('nine personal routes is Not scored; ten is eligible', () => {
    const nine = snapshotOf(Array.from({ length: 9 }, (_, index) => outcome({ index })));
    const ten = snapshotOf(Array.from({ length: 10 }, (_, index) => outcome({ index })));
    const below = assess({ personal: nine });
    assert.equal(below.status, 'not_scored');
    assert.equal(below.notScoredReason, 'insufficient_history');
    assert.equal(below.observedSamples, 9);
    assert.equal(below.requiredSamples, 10);
    assert.equal(assess({ personal: ten }).status, 'eligible');
  });

  test('a network snapshot needs both the sample count and the wallet spread', () => {
    const wallets = [WALLET_A, WALLET_B, WALLET_C];
    const thirtyOneWallet = snapshotOf(
      Array.from({ length: 30 }, (_, index) => outcome({ index })),
      'network',
    );
    // Thirty routes from one wallet is one trader's experience, not a network
    // reading — without the spread rule a single heavy user sets the ranking.
    assert.equal(assess({ network: thirtyOneWallet }).status, 'not_scored');

    const thirtyThreeWallets = snapshotOf(
      Array.from({ length: 30 }, (_, index) =>
        outcome({ index, wallet: wallets[index % 3], tenantId: `tenant-${index % 3}` }),
      ),
      'network',
    );
    assert.equal(assess({ network: thirtyThreeWallets }).status, 'eligible');

    const twentyNine = snapshotOf(
      Array.from({ length: 29 }, (_, index) =>
        outcome({ index, wallet: wallets[index % 3], tenantId: `tenant-${index % 3}` }),
      ),
      'network',
    );
    assert.equal(assess({ network: twentyNine }).status, 'not_scored');
  });

  test('personal wins over network even when network has more samples', () => {
    // How a provider behaved for THIS wallet is the more relevant question; a
    // network median can hide a pair or size where this trader does worse.
    const personal = snapshotOf(Array.from({ length: 10 }, (_, index) => outcome({ index })));
    const network = snapshotOf(
      Array.from({ length: 30 }, (_, index) =>
        outcome({ index, wallet: [WALLET_A, WALLET_B, WALLET_C][index % 3], tenantId: `t${index % 3}` }),
      ),
      'network',
    );
    const assessment = assess({ personal, network });
    assert.equal(assessment.status, 'eligible');
    assert.equal(assessment.scope, 'personal');
    assert.equal(assessment.snapshot?.snapshotHash, personal.snapshotHash);
  });

  test('no history at all is named as such, not as insufficient', () => {
    const assessment = assess({});
    assert.equal(assessment.status, 'not_scored');
    assert.equal(assessment.notScoredReason, 'no_verified_history');
  });

  test('the feature being off is its own reason, and carries no snapshot', () => {
    const personal = snapshotOf(Array.from({ length: 20 }, (_, index) => outcome({ index })));
    const assessment = assess({ personal, featureEnabled: false });
    assert.equal(assessment.status, 'not_scored');
    assert.equal(assessment.notScoredReason, 'feature_disabled');
    assert.equal(assessment.snapshot, null);
  });
});
