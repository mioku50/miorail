import {
  assessReliabilityV1,
  type ReliabilityThresholdsV1,
} from './aggregate.js';
import type {
  ProviderReliabilityAssessmentV1,
  ProviderReliabilitySnapshotV1,
} from './contracts.js';

// ---------------------------------------------------------------------------
// T67C.1 Part 2 §1 — which snapshot, if any, a candidate is judged against.
//
// Pure. The caller fetches; this decides. Everything below is a reason to
// REFUSE a snapshot that a naive "latest row wins" query would have returned,
// and each refusal is a way the statistic could otherwise become a lie:
//
//   * A snapshot cut off at or after the run started could contain the outcome
//     of the very trade being ranked.
//   * A snapshot taken under different thresholds is a different claim. Reading
//     it under today's rules silently reinterprets it.
//   * A reversed pair is a different market. USDC→WETH slippage says nothing
//     about WETH→USDC.
//   * A snapshot whose stored membership no longer matches its sample size has
//     lost the thing that made it checkable.
//
// None of these produce an error. They produce Not scored, which is a state the
// product knows how to show honestly.
// ---------------------------------------------------------------------------

export interface SnapshotReadV1 {
  snapshot: ProviderReliabilitySnapshotV1 | null;
  /** Rows actually present in `provider_reliability_snapshot_members`. Null
   * when the caller did not check — treated as a refusal, because an unchecked
   * membership is not a verified one. */
  memberCount: number | null;
}

export interface SelectEligibleSnapshotInputV1 {
  providerId: string;
  fromAsset: string;
  toAsset: string;
  tenantId: string;
  walletAddress: string;
  personal: SnapshotReadV1;
  network: SnapshotReadV1;
  thresholds: ReliabilityThresholdsV1;
  expectedAggregationVersion: string;
  /** The instant the current route run was created. */
  runStartedAt: Date;
  featureEnabled: boolean;
}

export const SNAPSHOT_REJECTION_REASONS_V1 = [
  'provider_mismatch',
  'pair_mismatch',
  'aggregation_version_mismatch',
  'not_before_run',
  'membership_unverified',
  'wrong_owner',
  'wrong_scope',
] as const;

export type SnapshotRejectionReasonV1 = (typeof SNAPSHOT_REJECTION_REASONS_V1)[number];

/**
 * Every reason a fetched snapshot cannot inform this run. Returns null when it
 * can. Exported so a test can name the rejection rather than only observe that
 * calibration did not happen.
 */
export function snapshotRejectionV1(
  read: SnapshotReadV1,
  input: SelectEligibleSnapshotInputV1,
  scope: 'personal' | 'network',
): SnapshotRejectionReasonV1 | null {
  const snapshot = read.snapshot;
  if (!snapshot) return null;
  if (snapshot.scope !== scope) return 'wrong_scope';
  if (snapshot.providerId !== input.providerId.toLowerCase()) return 'provider_mismatch';
  // Exact orientation. A reversed pair is a different market, and a query that
  // matched it would import one direction's slippage into the other.
  if (snapshot.fromAsset !== input.fromAsset || snapshot.toAsset !== input.toAsset) {
    return 'pair_mismatch';
  }
  if (snapshot.aggregationVersion !== input.expectedAggregationVersion) {
    return 'aggregation_version_mismatch';
  }
  if (Date.parse(snapshot.cutoffAt) >= input.runStartedAt.getTime()) return 'not_before_run';
  if (read.memberCount === null || read.memberCount !== snapshot.sampleSize) {
    return 'membership_unverified';
  }
  if (scope === 'personal') {
    if (
      snapshot.tenantId !== input.tenantId ||
      snapshot.walletAddress !== input.walletAddress.toLowerCase()
    ) {
      // Another wallet's personal history is another person's experience.
      return 'wrong_owner';
    }
  }
  return null;
}

export interface SelectEligibleSnapshotResultV1 {
  assessment: ProviderReliabilityAssessmentV1;
  /** Why a fetched snapshot was discarded, per scope. Empty when nothing was
   * discarded. Surfaced for logging: "Not scored" with no explanation is how a
   * misconfigured aggregation version stays invisible for a month. */
  rejections: Array<{ scope: 'personal' | 'network'; reason: SnapshotRejectionReasonV1 }>;
}

export function selectEligibleSnapshotV1(
  input: SelectEligibleSnapshotInputV1,
): SelectEligibleSnapshotResultV1 {
  const rejections: SelectEligibleSnapshotResultV1['rejections'] = [];
  const usable = (read: SnapshotReadV1, scope: 'personal' | 'network') => {
    const reason = snapshotRejectionV1(read, input, scope);
    if (reason) {
      rejections.push({ scope, reason });
      return null;
    }
    return read.snapshot;
  };

  // The sample-size and wallet-spread thresholds are applied by
  // assessReliabilityV1, which is the same function the aggregation tests
  // already pin. Only the gates above are new here.
  const assessment = assessReliabilityV1({
    providerId: input.providerId,
    fromAsset: input.fromAsset,
    toAsset: input.toAsset,
    personal: usable(input.personal, 'personal'),
    network: usable(input.network, 'network'),
    thresholds: input.thresholds,
    featureEnabled: input.featureEnabled,
  });

  return { assessment, rejections };
}
