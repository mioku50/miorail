import { ZERO_HASH_V1, stableHashV1, type HashV1 } from '@mioagent/route-domain';
import {
  ProviderReliabilityAssessmentV1Schema,
  ProviderReliabilitySnapshotV1Schema,
  hashOutcomeSetV1,
  hashProviderReliabilitySnapshotV1,
  type OutcomeProviderIdV1,
  type ProviderReliabilityAssessmentV1,
  type ProviderReliabilitySnapshotV1,
  type ReliabilityScopeV1,
  type RouteProviderOutcomeV1,
} from './contracts.js';
import { medianV1, p90V1, rateBpsV1 } from './quantiles.js';

// ---------------------------------------------------------------------------
// T67C.1 §5 — outcomes into snapshots.
//
// A snapshot is a sealed statement about a provider's past as of one instant.
// Two properties make it worth anything:
//
//   * It is reproducible. Given the same member outcomes in the same order,
//     anyone recomputes the same hash. That is why membership is persisted.
//   * It cannot see the future. Only outcomes at or before `cutoffAt` are in
//     it, so a snapshot can never contain the result of the trade it was used
//     to choose. Without that rule the loop is circular and the statistic is
//     an artefact of its own use.
// ---------------------------------------------------------------------------

export interface ReliabilityThresholdsV1 {
  windowDays: number;
  personalMinSamples: number;
  networkMinSamples: number;
  networkMinWallets: number;
}

export const DEFAULT_RELIABILITY_THRESHOLDS_V1: ReliabilityThresholdsV1 = {
  windowDays: 90,
  personalMinSamples: 10,
  networkMinSamples: 30,
  networkMinWallets: 3,
};

/**
 * The aggregation version, with the thresholds folded in.
 *
 * Lowering a sample threshold changes what "eligible" means, so snapshots taken
 * before and after are not the same kind of claim. Encoding the thresholds in
 * the version keeps old snapshots readable as what they were, instead of
 * silently reinterpreting them under new rules.
 */
export function aggregationVersionV1(thresholds: ReliabilityThresholdsV1): string {
  return [
    'provider-reliability/v1',
    `w${thresholds.windowDays}`,
    `p${thresholds.personalMinSamples}`,
    `n${thresholds.networkMinSamples}`,
    `u${thresholds.networkMinWallets}`,
  ].join(':');
}

export interface ReliabilityKeyV1 {
  providerId: OutcomeProviderIdV1;
  fromAsset: string;
  toAsset: string;
}

/** Deterministic member order: by occurrence, then by hash to break ties. Two
 * outcomes at the same millisecond must not be able to reorder the set and
 * change the snapshot hash. */
export function orderOutcomesV1(
  outcomes: readonly RouteProviderOutcomeV1[],
): RouteProviderOutcomeV1[] {
  return [...outcomes].sort(
    (left, right) =>
      Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
      left.outcomeHash.localeCompare(right.outcomeHash),
  );
}

/** Outcomes inside `(cutoff - windowDays, cutoff]`, for one provider and pair. */
export function selectWindowOutcomesV1(input: {
  outcomes: readonly RouteProviderOutcomeV1[];
  key: ReliabilityKeyV1;
  cutoffAt: Date;
  windowDays: number;
  /** Personal scope only. Omitted means every tenant — the network view. */
  tenantId?: string;
  walletAddress?: string;
}): RouteProviderOutcomeV1[] {
  const cutoffMs = input.cutoffAt.getTime();
  const floorMs = cutoffMs - input.windowDays * 24 * 60 * 60 * 1_000;
  return orderOutcomesV1(
    input.outcomes.filter((outcome) => {
      if (outcome.providerId !== input.key.providerId) return false;
      if (outcome.fromAsset !== input.key.fromAsset || outcome.toAsset !== input.key.toAsset) {
        return false;
      }
      if (input.tenantId !== undefined && outcome.tenantId !== input.tenantId) return false;
      if (
        input.walletAddress !== undefined &&
        outcome.walletAddress !== input.walletAddress.toLowerCase()
      ) {
        return false;
      }
      const at = Date.parse(outcome.occurredAt);
      // Inclusive at the cutoff, exclusive at the floor: an outcome exactly at
      // the cutoff already happened, one exactly a window ago has aged out.
      return at <= cutoffMs && at > floorMs;
    }),
  );
}

function gasErrorBps(outcome: RouteProviderOutcomeV1): bigint | null {
  if (outcome.estimatedGasAtomic === null || outcome.actualGasAtomic === null) return null;
  const estimated = BigInt(outcome.estimatedGasAtomic);
  if (estimated <= 0n) return null;
  return ((BigInt(outcome.actualGasAtomic) - estimated) * 10_000n) / estimated;
}

export interface BuiltReliabilitySnapshotV1 {
  snapshot: ProviderReliabilitySnapshotV1;
  /** In snapshot order. Persisted so the snapshot can be recomputed and shown
   * to be exactly the outcomes it claims. */
  members: RouteProviderOutcomeV1[];
}

export interface BuildReliabilitySnapshotInputV1 {
  scope: ReliabilityScopeV1;
  key: ReliabilityKeyV1;
  /** Already windowed and ordered, e.g. by `selectWindowOutcomesV1`. */
  outcomes: readonly RouteProviderOutcomeV1[];
  cutoffAt: Date;
  createdAt: Date;
  thresholds: ReliabilityThresholdsV1;
}

/**
 * Seals a snapshot over the given outcomes. Returns null for an empty set: a
 * snapshot over nothing states nothing, and an empty one would still be a row
 * a later query could pick up and treat as history.
 */
export function buildReliabilitySnapshotV1(
  input: BuildReliabilitySnapshotInputV1,
): BuiltReliabilitySnapshotV1 | null {
  const members = orderOutcomesV1(input.outcomes);
  if (members.length === 0) return null;

  const personal = input.scope === 'personal';
  const tenantIds = new Set(members.map((outcome) => outcome.tenantId));
  const wallets = new Set(members.map((outcome) => outcome.walletAddress));
  if (personal && (tenantIds.size !== 1 || wallets.size !== 1)) {
    throw new RangeError('A personal snapshot must cover exactly one tenant and wallet');
  }

  const completed = members.filter((outcome) => outcome.proofFinalStatus === 'completed');
  const failed = members.filter((outcome) => outcome.proofFinalStatus === 'failed');
  const partial = members.filter((outcome) => outcome.proofFinalStatus === 'partial_failure');

  // Shortfall is only defined where something was delivered. A revert is
  // already counted in the success rate; letting it also enter the shortfall
  // distribution would make one bad execution move two independent numbers.
  const shortfalls = members
    .filter((outcome) => outcome.adverseShortfallBps !== null)
    .map((outcome) => BigInt(outcome.adverseShortfallBps!));
  const breaches = members.filter((outcome) => outcome.floorBreached === true).length;
  const floorJudged = members.filter((outcome) => outcome.floorBreached !== null).length;
  const gasErrors = members
    .map(gasErrorBps)
    .filter((value): value is bigint => value !== null);
  const confirmations = members
    .filter((outcome) => outcome.confirmationMs !== null)
    .map((outcome) => BigInt(outcome.confirmationMs!));

  const outcomeSetHash = hashOutcomeSetV1(members.map((outcome) => outcome.outcomeHash as HashV1));
  const aggregationVersion = aggregationVersionV1(input.thresholds);

  const draft: ProviderReliabilitySnapshotV1 = {
    schemaVersion: 'provider-reliability-snapshot/v1',
    id: reliabilitySnapshotIdV1({
      scope: input.scope,
      key: input.key,
      cutoffAt: input.cutoffAt,
      outcomeSetHash,
      aggregationVersion,
    }),
    status: 'sealed',
    createdAt: input.createdAt.toISOString(),
    scope: input.scope,
    tenantId: personal ? members[0]!.tenantId : null,
    walletAddress: personal ? members[0]!.walletAddress : null,
    providerId: input.key.providerId,
    chainId: 8453,
    fromAsset: input.key.fromAsset,
    toAsset: input.key.toAsset,
    windowDays: input.thresholds.windowDays,
    cutoffAt: input.cutoffAt.toISOString(),
    sampleSize: members.length,
    uniqueWalletCount: wallets.size,
    completedCount: completed.length,
    failedCount: failed.length,
    partialFailureCount: partial.length,
    successRateBps: rateBpsV1(completed.length, members.length),
    medianAdverseShortfallBps: Number(medianV1(shortfalls) ?? 0n),
    p90AdverseShortfallBps: Number(p90V1(shortfalls) ?? 0n),
    floorBreachRateBps: floorJudged === 0 ? 0 : rateBpsV1(breaches, floorJudged),
    medianGasErrorBps: gasErrors.length === 0 ? null : Number(medianV1(gasErrors)),
    p90ConfirmationMs: confirmations.length === 0 ? null : Number(p90V1(confirmations)),
    outcomeSetHash,
    snapshotHash: ZERO_HASH_V1,
    aggregationVersion,
  };

  return {
    snapshot: ProviderReliabilitySnapshotV1Schema.parse({
      ...draft,
      snapshotHash: hashProviderReliabilitySnapshotV1(draft),
    }),
    members,
  };
}

/** Deterministic: identical inputs rebuild to the same id, so a repeated
 * rebuild inserts nothing rather than accumulating duplicate snapshots. */
export function reliabilitySnapshotIdV1(input: {
  scope: ReliabilityScopeV1;
  key: ReliabilityKeyV1;
  cutoffAt: Date;
  outcomeSetHash: HashV1;
  aggregationVersion: string;
}): string {
  return `provider-reliability-snapshot:${stableHashV1('provider-reliability-snapshot-id/v1', {
    scope: input.scope,
    providerId: input.key.providerId,
    fromAsset: input.key.fromAsset,
    toAsset: input.key.toAsset,
    cutoffAt: input.cutoffAt.toISOString(),
    outcomeSetHash: input.outcomeSetHash,
    aggregationVersion: input.aggregationVersion,
  }).slice(2)}`;
}

/** Recomputes the set hash from persisted members — the check that proves a
 * stored snapshot really is about the outcomes it lists. */
export function verifySnapshotMembershipV1(
  snapshot: ProviderReliabilitySnapshotV1,
  members: readonly RouteProviderOutcomeV1[],
): boolean {
  const ordered = orderOutcomesV1(members);
  if (ordered.length !== snapshot.sampleSize) return false;
  return hashOutcomeSetV1(ordered.map((outcome) => outcome.outcomeHash as HashV1)) === snapshot.outcomeSetHash;
}

export function personalSnapshotEligibleV1(
  snapshot: ProviderReliabilitySnapshotV1 | null,
  thresholds: ReliabilityThresholdsV1,
): boolean {
  return snapshot !== null && snapshot.scope === 'personal' && snapshot.sampleSize >= thresholds.personalMinSamples;
}

export function networkSnapshotEligibleV1(
  snapshot: ProviderReliabilitySnapshotV1 | null,
  thresholds: ReliabilityThresholdsV1,
): boolean {
  return (
    snapshot !== null &&
    snapshot.scope === 'network' &&
    snapshot.sampleSize >= thresholds.networkMinSamples &&
    // Thirty routes from one wallet is one trader's experience, not a network
    // reading. Without this a single heavy user would set everyone's ranking.
    snapshot.uniqueWalletCount >= thresholds.networkMinWallets
  );
}

export interface AssessReliabilityInputV1 {
  providerId: string;
  fromAsset: string;
  toAsset: string;
  personal: ProviderReliabilitySnapshotV1 | null;
  network: ProviderReliabilitySnapshotV1 | null;
  thresholds: ReliabilityThresholdsV1;
  featureEnabled: boolean;
}

/**
 * Picks the snapshot a candidate is judged against.
 *
 * Personal beats network whenever it qualifies, even if the network sample is
 * far larger: how a provider has behaved for THIS wallet is the more relevant
 * question, and a network median can hide a pair or size where this trader
 * consistently does worse.
 */
export function assessReliabilityV1(
  input: AssessReliabilityInputV1,
): ProviderReliabilityAssessmentV1 {
  const base = {
    schemaVersion: 'provider-reliability-assessment/v1' as const,
    providerId: input.providerId,
    fromAsset: input.fromAsset,
    toAsset: input.toAsset,
  };
  const personalSamples = input.personal?.sampleSize ?? 0;
  const networkSamples = input.network?.sampleSize ?? 0;

  const notScored = (
    reason: (typeof ProviderReliabilityAssessmentV1Schema)['_output']['notScoredReason'],
  ): ProviderReliabilityAssessmentV1 =>
    ProviderReliabilityAssessmentV1Schema.parse({
      ...base,
      status: 'not_scored',
      scope: null,
      snapshot: null,
      notScoredReason: reason,
      observedSamples: Math.max(personalSamples, networkSamples),
      requiredSamples: input.thresholds.personalMinSamples,
    });

  if (!input.featureEnabled) return notScored('feature_disabled');

  if (personalSnapshotEligibleV1(input.personal, input.thresholds)) {
    return ProviderReliabilityAssessmentV1Schema.parse({
      ...base,
      status: 'eligible',
      scope: 'personal',
      snapshot: input.personal,
      notScoredReason: null,
      observedSamples: personalSamples,
      requiredSamples: input.thresholds.personalMinSamples,
    });
  }
  if (networkSnapshotEligibleV1(input.network, input.thresholds)) {
    return ProviderReliabilityAssessmentV1Schema.parse({
      ...base,
      status: 'eligible',
      scope: 'network',
      snapshot: input.network,
      notScoredReason: null,
      observedSamples: networkSamples,
      requiredSamples: input.thresholds.networkMinSamples,
    });
  }
  if (personalSamples === 0 && networkSamples === 0) return notScored('no_verified_history');
  return notScored('insufficient_history');
}
