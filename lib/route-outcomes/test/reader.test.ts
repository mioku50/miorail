import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  DEFAULT_RELIABILITY_THRESHOLDS_V1,
  aggregationVersionV1,
  buildReliabilitySnapshotV1,
  deriveRouteProviderOutcomeV1,
  selectEligibleSnapshotV1,
  snapshotRejectionV1,
  type ProviderReliabilitySnapshotV1,
  type ReliabilityScopeV1,
  type RouteProviderOutcomeV1,
  type SnapshotReadV1,
} from '../src/index.js';
import { WALLET_A, WALLET_B, WALLET_C, candidateFixtureV1, proofFixtureV1 } from './fixtures.js';

// T67C.1 Part 2 §1 — every reason a snapshot the query returned must still be
// refused. Each of these is a way the statistic could become a lie.

const THRESHOLDS = DEFAULT_RELIABILITY_THRESHOLDS_V1;
const VERSION = aggregationVersionV1(THRESHOLDS);
const CUTOFF = new Date('2026-07-27T12:00:00.000Z');
const RUN_STARTED = new Date('2026-07-27T13:00:00.000Z');

function outcome(index: number, wallet = WALLET_A, tenantId = 'tenant-1'): RouteProviderOutcomeV1 {
  const candidate = candidateFixtureV1({ providerId: 'uniswap', walletAddress: wallet, tenantId });
  const { proof, events } = proofFixtureV1({
    walletAddress: wallet,
    tenantId,
    candidateHash: candidate.candidateHash,
    proofId: `route-proof:${wallet}:${index}`,
    now: new Date(CUTOFF.getTime() - (index + 1) * 60_000),
  });
  const derived = deriveRouteProviderOutcomeV1({ proof, candidate, events, derivedAt: CUTOFF });
  if (!derived.derived) throw new Error(derived.reason);
  return derived.outcome;
}

function snapshot(input: {
  scope: ReliabilityScopeV1;
  count: number;
  wallets?: readonly `0x${string}`[];
  cutoffAt?: Date;
}): ProviderReliabilitySnapshotV1 {
  const wallets = input.wallets ?? [WALLET_A];
  const outcomes = Array.from({ length: input.count }, (_, index) =>
    outcome(index, wallets[index % wallets.length], `tenant-${index % wallets.length}`),
  );
  const built = buildReliabilitySnapshotV1({
    scope: input.scope,
    key: { providerId: 'uniswap', fromAsset: outcomes[0]!.fromAsset, toAsset: outcomes[0]!.toAsset },
    outcomes,
    cutoffAt: input.cutoffAt ?? CUTOFF,
    createdAt: input.cutoffAt ?? CUTOFF,
    thresholds: THRESHOLDS,
  });
  assert.ok(built);
  return built.snapshot;
}

function read(value: ProviderReliabilitySnapshotV1 | null): SnapshotReadV1 {
  return { snapshot: value, memberCount: value?.sampleSize ?? null };
}

function select(overrides: Partial<Parameters<typeof selectEligibleSnapshotV1>[0]> = {}) {
  const personalSnapshot = snapshot({ scope: 'personal', count: 12 });
  return selectEligibleSnapshotV1({
    providerId: 'uniswap',
    fromAsset: personalSnapshot.fromAsset,
    toAsset: personalSnapshot.toAsset,
    tenantId: 'tenant-0',
    walletAddress: WALLET_A,
    personal: read(personalSnapshot),
    network: read(null),
    thresholds: THRESHOLDS,
    expectedAggregationVersion: VERSION,
    runStartedAt: RUN_STARTED,
    featureEnabled: true,
    ...overrides,
  });
}

describe('the snapshot reader refuses what a "latest row" query would accept', () => {
  test('an eligible personal snapshot is selected', () => {
    const result = select();
    assert.equal(result.assessment.status, 'eligible');
    assert.equal(result.assessment.scope, 'personal');
    assert.deepEqual(result.rejections, []);
  });

  test('personal takes priority over an eligible network snapshot', () => {
    const network = snapshot({ scope: 'network', count: 30, wallets: [WALLET_A, WALLET_B, WALLET_C] });
    const result = select({ network: read(network) });
    assert.equal(result.assessment.scope, 'personal');
  });

  test('a snapshot cut off at or after the run start is refused', () => {
    // Otherwise the trade being ranked could appear in the history that ranked
    // it, and the statistic would be measuring its own effect.
    const atStart = snapshot({ scope: 'personal', count: 12, cutoffAt: RUN_STARTED });
    const result = select({ personal: read(atStart) });
    assert.equal(result.assessment.status, 'not_scored');
    assert.deepEqual(result.rejections, [{ scope: 'personal', reason: 'not_before_run' }]);
  });

  test('a reversed asset pair is a different market and is refused', () => {
    const base = snapshot({ scope: 'personal', count: 12 });
    const reversed = { ...base, fromAsset: base.toAsset, toAsset: base.fromAsset };
    const result = select({ personal: read(reversed) });
    assert.equal(result.assessment.status, 'not_scored');
    assert.deepEqual(result.rejections, [{ scope: 'personal', reason: 'pair_mismatch' }]);
  });

  test('another wallet\'s personal history is refused', () => {
    const other = snapshot({ scope: 'personal', count: 12, wallets: [WALLET_B] });
    const result = select({ personal: read(other) });
    assert.equal(result.assessment.status, 'not_scored');
    assert.deepEqual(result.rejections, [{ scope: 'personal', reason: 'wrong_owner' }]);
  });

  test('a snapshot from a different aggregation version is refused', () => {
    // Thresholds changed under it, so it is a different claim; reading it under
    // today's rules would silently reinterpret it.
    const result = select({ expectedAggregationVersion: aggregationVersionV1({ ...THRESHOLDS, personalMinSamples: 5 }) });
    assert.equal(result.assessment.status, 'not_scored');
    assert.deepEqual(result.rejections, [{ scope: 'personal', reason: 'aggregation_version_mismatch' }]);
  });

  test('a snapshot whose membership no longer matches is refused', () => {
    const base = snapshot({ scope: 'personal', count: 12 });
    // Missing members mean the snapshot has lost the thing that made it
    // checkable, so it can no longer be treated as evidence.
    const result = select({ personal: { snapshot: base, memberCount: 11 } });
    assert.equal(result.assessment.status, 'not_scored');
    assert.deepEqual(result.rejections, [{ scope: 'personal', reason: 'membership_unverified' }]);
  });

  test('an unchecked membership is not a verified one', () => {
    const base = snapshot({ scope: 'personal', count: 12 });
    const result = select({ personal: { snapshot: base, memberCount: null } });
    assert.equal(result.assessment.status, 'not_scored');
  });

  test('a snapshot for a different provider is refused', () => {
    const base = snapshot({ scope: 'personal', count: 12 });
    const result = select({ providerId: 'kyberswap', personal: read(base) });
    assert.equal(result.assessment.status, 'not_scored');
    assert.equal(result.rejections[0]?.reason, 'provider_mismatch');
  });

  test('a network snapshot presented as personal is refused', () => {
    const network = snapshot({ scope: 'network', count: 30, wallets: [WALLET_A, WALLET_B, WALLET_C] });
    const result = select({ personal: read(network) });
    assert.equal(result.rejections[0]?.reason, 'wrong_scope');
  });

  test('a network snapshot still needs its wallet spread after passing every gate', () => {
    const oneWallet = snapshot({ scope: 'network', count: 30, wallets: [WALLET_A] });
    const result = select({ personal: read(null), network: read(oneWallet) });
    assert.equal(result.assessment.status, 'not_scored');
    // Not a rejection: nothing about the snapshot is wrong, it simply does not
    // meet the threshold — and the two are different findings.
    assert.deepEqual(result.rejections, []);
  });

  test('the feature being off short-circuits everything', () => {
    const result = select({ featureEnabled: false });
    assert.equal(result.assessment.status, 'not_scored');
    assert.equal(result.assessment.notScoredReason, 'feature_disabled');
  });

  test('snapshotRejectionV1 says nothing about an absent snapshot', () => {
    assert.equal(
      snapshotRejectionV1(
        { snapshot: null, memberCount: null },
        {
          providerId: 'uniswap',
          fromAsset: 'a',
          toAsset: 'b',
          tenantId: 't',
          walletAddress: WALLET_A,
          personal: read(null),
          network: read(null),
          thresholds: THRESHOLDS,
          expectedAggregationVersion: VERSION,
          runStartedAt: RUN_STARTED,
          featureEnabled: true,
        },
        'personal',
      ),
      null,
    );
  });
});
