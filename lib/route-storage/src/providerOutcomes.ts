import {
  ProviderReliabilitySnapshotV1Schema,
  RouteProviderOutcomeV1Schema,
  type ProviderReliabilitySnapshotV1,
  type RouteProviderOutcomeV1,
} from '@mioagent/route-outcomes';

// ---------------------------------------------------------------------------
// T67C.1 — the write decisions for outcomes and snapshots, in ONE place.
//
// Both repositories call these. The in-memory fake must refuse exactly what
// Postgres refuses: three production bugs in T65 came from a fake that accepted
// a write the database would have rejected, so the tests passed and the server
// 500'd. Here the unique indexes are `route_provider_outcomes_proof_unique`,
// `route_provider_outcomes_proof_hash_unique` and
// `provider_reliability_snapshots_hash_unique` — and the functions below are
// the single description of what each of them means.
// ---------------------------------------------------------------------------

export type OutcomeWriteEffectV1 =
  /** Nothing stored yet — write it. */
  | { kind: 'insert' }
  /** Byte-identical row already stored. Idempotent; the caller reports it as
   * already recorded rather than doing anything. */
  | { kind: 'return_existing' }
  /** A row exists that disagrees. Never overwritten — the disagreement IS the
   * finding, and erasing it would destroy the only evidence of it. */
  | { kind: 'conflict'; reason: string };

export function providerOutcomeInsertEffectV1(
  existing: RouteProviderOutcomeV1 | null,
  incoming: RouteProviderOutcomeV1,
): OutcomeWriteEffectV1 {
  if (!existing) return { kind: 'insert' };
  if (existing.outcomeHash === incoming.outcomeHash) return { kind: 'return_existing' };
  if (existing.proofHash !== incoming.proofHash) {
    // The proof changed after it was final. That is either a defect or
    // tampering, and in both cases the stored reading must survive to show it.
    return { kind: 'conflict', reason: 'proof_hash_changed' };
  }
  // Same proof, same proof hash, different derivation — the derivation logic
  // changed under a version that did not. Refusing is what surfaces that.
  return { kind: 'conflict', reason: 'derivation_disagrees' };
}

export function reliabilitySnapshotInsertEffectV1(
  existing: ProviderReliabilitySnapshotV1 | null,
  incoming: ProviderReliabilitySnapshotV1,
): OutcomeWriteEffectV1 {
  if (!existing) return { kind: 'insert' };
  // A snapshot hash covers every statistic and the member set. Equal hash means
  // an identical rebuild, which is precisely the no-op a repeated
  // `reliability:rebuild` must be.
  if (existing.snapshotHash === incoming.snapshotHash) return { kind: 'return_existing' };
  return { kind: 'conflict', reason: 'snapshot_hash_collision' };
}

/** Parses through the production schema, so a row that somehow got into the
 * table in a shape the contract forbids is caught on the way OUT too. */
export function assertProviderOutcomeV1(value: unknown): RouteProviderOutcomeV1 {
  return RouteProviderOutcomeV1Schema.parse(value);
}

export function assertReliabilitySnapshotV1(value: unknown): ProviderReliabilitySnapshotV1 {
  return ProviderReliabilitySnapshotV1Schema.parse(value);
}

export class ProviderOutcomeConflictError extends Error {
  constructor(readonly reason: string) {
    super(`provider outcome write conflict: ${reason}`);
    this.name = 'ProviderOutcomeConflictError';
  }
}

export interface ProviderOutcomeQueryV1 {
  /** Personal aggregation narrows to one tenant AND wallet. Omitting both is
   * the network view — which is why `listProviderOutcomes` is never exposed
   * through an API: it would hand one tenant another tenant's raw rows. */
  tenantId?: string;
  walletAddress?: string;
  providerId?: string;
  fromAsset?: string;
  toAsset?: string;
  /** Inclusive lower bound on occurredAt. */
  from?: Date;
  /** Inclusive upper bound on occurredAt — the snapshot cutoff. */
  to?: Date;
  limit?: number;
}

export interface ReliabilitySnapshotQueryV1 {
  scope: 'personal' | 'network';
  providerId: string;
  fromAsset: string;
  toAsset: string;
  tenantId?: string;
  walletAddress?: string;
  /** Only snapshots cut off at or before this instant are eligible — the rule
   * that stops a run from being informed by its own result. */
  cutoffAtOrBefore?: Date;
  /** STRICTLY before. The read path uses this rather than the inclusive bound:
   * a snapshot cut off at the exact instant a run started could contain an
   * outcome from that same instant, and "before" should mean before. */
  cutoffStrictlyBefore?: Date;
  /** Snapshots taken under a different threshold set are a different kind of
   * claim, so they are filtered in SQL rather than read and then discarded —
   * otherwise the "latest" snapshot could be one this server cannot use, and
   * the pair would look uncalibratable while a usable older one sat behind it. */
  aggregationVersion?: string;
}

export interface ProviderOutcomeRepositoryV1 {
  insertProviderOutcome(outcome: RouteProviderOutcomeV1): Promise<OutcomeWriteEffectV1>;
  getProviderOutcomeByProofId(input: {
    tenantId: string;
    proofId: string;
  }): Promise<RouteProviderOutcomeV1 | null>;
  listProviderOutcomes(query: ProviderOutcomeQueryV1): Promise<RouteProviderOutcomeV1[]>;
  insertReliabilitySnapshot(
    snapshot: ProviderReliabilitySnapshotV1,
    memberOutcomeIds: readonly string[],
  ): Promise<OutcomeWriteEffectV1>;
  getLatestReliabilitySnapshot(
    query: ReliabilitySnapshotQueryV1,
  ): Promise<ProviderReliabilitySnapshotV1 | null>;
  listSnapshotMemberIds(snapshotId: string): Promise<string[]>;
  /**
   * How many member rows a snapshot actually has.
   *
   * One cheap query, used on the READ path to confirm a snapshot still has the
   * membership it claims. Recomputing the full outcome-set hash would mean
   * loading every member on every comparison, which is the aggregation that is
   * explicitly not allowed to happen inside an HTTP request —
   * `verifySnapshotMembershipV1` does that, and the rebuild command runs it.
   */
  countSnapshotMembers(snapshotId: string): Promise<number>;
}

/** Shared filter, so the fake and the SQL agree on what a window means. */
export function matchesOutcomeQueryV1(
  outcome: RouteProviderOutcomeV1,
  query: ProviderOutcomeQueryV1,
): boolean {
  if (query.tenantId !== undefined && outcome.tenantId !== query.tenantId) return false;
  if (
    query.walletAddress !== undefined &&
    outcome.walletAddress !== query.walletAddress.toLowerCase()
  ) {
    return false;
  }
  if (query.providerId !== undefined && outcome.providerId !== query.providerId) return false;
  if (query.fromAsset !== undefined && outcome.fromAsset !== query.fromAsset) return false;
  if (query.toAsset !== undefined && outcome.toAsset !== query.toAsset) return false;
  const at = Date.parse(outcome.occurredAt);
  if (query.from !== undefined && at < query.from.getTime()) return false;
  if (query.to !== undefined && at > query.to.getTime()) return false;
  return true;
}
