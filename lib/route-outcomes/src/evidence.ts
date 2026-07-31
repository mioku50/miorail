import {
  EvidenceRecordV1Schema,
  ZERO_HASH_V1,
  hashEvidenceRecordV1,
  stableHashV1,
  type EvidenceRecordV1,
  type RouteCandidateV1,
} from '@mioagent/route-domain';
import type {
  ProviderReliabilityAssessmentV1,
  ProviderReliabilitySnapshotV1,
} from './contracts.js';

// ---------------------------------------------------------------------------
// T67C.1 §7 — a reliability snapshot as an evidence record.
//
// Reliability enters scoring the same way a quote or a gas reading does: as one
// record in the evidence set, hashed, attributable, and carried into the Route
// Card and the eventual Route Proof. It gets no privileged path.
//
// The payload is aggregate statistics ONLY. No proof ids, no wallet list, no
// tenant ids — an evidence record ends up inside a Route Card and, later, a
// publishable proof bundle, and a network snapshot is built from other people's
// trades. The counts are what make it useful; the identities would only make it
// a leak.
// ---------------------------------------------------------------------------

export const RELIABILITY_EVIDENCE_SOURCE_V1 = 'miorail_verified_route_history' as const;

/** Exactly the fields §7 permits, in one place so nothing can drift in. */
export interface ReliabilityEvidencePayloadV1 {
  scope: ProviderReliabilitySnapshotV1['scope'];
  provider: string;
  fromAsset: string;
  toAsset: string;
  windowDays: number;
  cutoffAt: string;
  sampleSize: number;
  uniqueWalletCount: number;
  successRateBps: number;
  medianAdverseShortfallBps: number;
  p90AdverseShortfallBps: number;
  floorBreachRateBps: number;
  p90ConfirmationMs: number | null;
  snapshotHash: string;
  aggregationVersion: string;
}

export function reliabilityEvidencePayloadV1(
  snapshot: ProviderReliabilitySnapshotV1,
): ReliabilityEvidencePayloadV1 {
  return {
    scope: snapshot.scope,
    provider: snapshot.providerId,
    fromAsset: snapshot.fromAsset,
    toAsset: snapshot.toAsset,
    windowDays: snapshot.windowDays,
    cutoffAt: snapshot.cutoffAt,
    sampleSize: snapshot.sampleSize,
    uniqueWalletCount: snapshot.uniqueWalletCount,
    successRateBps: snapshot.successRateBps,
    medianAdverseShortfallBps: snapshot.medianAdverseShortfallBps,
    p90AdverseShortfallBps: snapshot.p90AdverseShortfallBps,
    floorBreachRateBps: snapshot.floorBreachRateBps,
    p90ConfirmationMs: snapshot.p90ConfirmationMs,
    snapshotHash: snapshot.snapshotHash,
    aggregationVersion: snapshot.aggregationVersion,
  };
}

export class ReliabilityEvidenceError extends Error {
  constructor(readonly code: 'snapshot_not_before_run' | 'snapshot_pair_mismatch') {
    super(code);
    this.name = 'ReliabilityEvidenceError';
  }
}

/**
 * A snapshot may only inform a run that started AFTER it was sealed.
 *
 * Without this the loop closes on itself: the trade being ranked would be
 * allowed to appear in the history that ranked it, and the statistic would be
 * measuring its own effect. `cutoffAt` is checked rather than `createdAt`
 * because the cutoff is what bounds the member outcomes.
 */
export function assertSnapshotPrecedesRunV1(
  snapshot: ProviderReliabilitySnapshotV1,
  runStartedAt: Date,
): void {
  if (Date.parse(snapshot.cutoffAt) > runStartedAt.getTime()) {
    throw new ReliabilityEvidenceError('snapshot_not_before_run');
  }
}

export interface BuildReliabilityEvidenceInputV1 {
  candidate: RouteCandidateV1;
  assessment: ProviderReliabilityAssessmentV1;
  runStartedAt: Date;
}

/**
 * Builds the evidence record for an eligible assessment. Returns null when the
 * assessment is Not scored — a record saying "we have no history" would be
 * counted as evidence present, and every missing-evidence check downstream
 * would then be wrong about what it has.
 */
export function buildReliabilityEvidenceV1(
  input: BuildReliabilityEvidenceInputV1,
): EvidenceRecordV1 | null {
  const { candidate, assessment } = input;
  if (assessment.status !== 'eligible' || assessment.snapshot === null) return null;
  const snapshot = assessment.snapshot;

  if (
    snapshot.fromAsset !== candidate.inputAmount.asset.assetId ||
    snapshot.toAsset !== candidate.expectedOutput.asset.assetId ||
    snapshot.providerId !== candidate.provider.id.toLowerCase()
  ) {
    throw new ReliabilityEvidenceError('snapshot_pair_mismatch');
  }
  assertSnapshotPrecedesRunV1(snapshot, input.runStartedAt);

  const payload = reliabilityEvidencePayloadV1(snapshot);
  const requestHash = stableHashV1('provider-reliability-evidence-request/v1', {
    scope: snapshot.scope,
    provider: snapshot.providerId,
    fromAsset: snapshot.fromAsset,
    toAsset: snapshot.toAsset,
    windowDays: snapshot.windowDays,
    cutoffAt: snapshot.cutoffAt,
    aggregationVersion: snapshot.aggregationVersion,
  });
  const responseHash = stableHashV1('provider-reliability-evidence-response/v1', payload);
  const idHash = stableHashV1('provider-reliability-evidence-id/v1', {
    candidateHash: candidate.candidateHash,
    snapshotHash: snapshot.snapshotHash,
  });

  const draft: EvidenceRecordV1 = {
    schemaVersion: 'evidence-record/v1',
    id: `evidence:provider-reliability:${idHash.slice(2)}`,
    tenantId: candidate.tenantId,
    walletAddress: candidate.walletAddress,
    chainId: candidate.chainId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.createdAt,
    status: 'observed',
    intentHash: candidate.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceHash: ZERO_HASH_V1,
    evidenceType: 'provider_reliability',
    provider: {
      id: RELIABILITY_EVIDENCE_SOURCE_V1,
      displayName: 'Miorail verified route history',
      kind: 'internal',
      operator: 'Miorail',
    },
    observedAt: snapshot.createdAt,
    // A statement about the past does not go stale the way a quote does. It is
    // superseded by a newer snapshot, which is a different mechanism.
    expiresAt: null,
    blockNumber: null,
    requestHash,
    responseHash,
    assets: [candidate.inputAmount.asset, candidate.expectedOutput.asset],
    pools: [],
    liquiditySources: [],
    freeOrPaid: 'free',
    cost: null,
    intelligenceChargeId: null,
    validationStatus: 'valid',
    validationErrors: [],
  };

  return EvidenceRecordV1Schema.parse({ ...draft, evidenceHash: hashEvidenceRecordV1(draft) });
}
