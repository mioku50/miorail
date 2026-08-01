import type {
  ProviderReliabilitySnapshotV1,
  RouteProviderOutcomeV1,
} from '@mioagent/route-outcomes';

import {
  ProviderOutcomeConflictError,
  assertProviderOutcomeV1,
  assertReliabilitySnapshotV1,
  matchesOutcomeQueryV1,
  providerOutcomeInsertEffectV1,
  reliabilitySnapshotInsertEffectV1,
  type OutcomeWriteEffectV1,
  type ProviderOutcomeQueryV1,
  type ProviderOutcomeRepositoryV1,
  type ReliabilitySnapshotQueryV1,
} from './providerOutcomes.js';

// In-memory repository for tests. It refuses exactly what Postgres refuses,
// via the SAME decision functions — see providerOutcomes.ts for why that is a
// hard rule here rather than a nicety.

export function createMemoryProviderOutcomeRepository(): ProviderOutcomeRepositoryV1 {
  const outcomes: RouteProviderOutcomeV1[] = [];
  const snapshots: ProviderReliabilitySnapshotV1[] = [];
  const members = new Map<string, string[]>();

  return {
    async insertProviderOutcome(outcome): Promise<OutcomeWriteEffectV1> {
      const parsed = assertProviderOutcomeV1(outcome);
      // Both unique indexes, checked the way the database checks them: by
      // proof id AND independently by proof hash.
      const byProof = outcomes.find((row) => row.proofId === parsed.proofId) ?? null;
      const effect = providerOutcomeInsertEffectV1(byProof, parsed);
      if (effect.kind === 'conflict') return effect;
      if (effect.kind === 'return_existing') return effect;
      const byHash = outcomes.find((row) => row.proofHash === parsed.proofHash);
      if (byHash) return { kind: 'conflict', reason: 'proof_hash_already_recorded' };
      // Cloned on insert: a caller mutating its own object afterwards must not
      // be able to change what the store returns.
      outcomes.push(structuredClone(parsed));
      return effect;
    },

    async getProviderOutcomeByProofId({ tenantId, proofId }) {
      const found = outcomes.find((row) => row.proofId === proofId && row.tenantId === tenantId);
      return found ? structuredClone(found) : null;
    },

    async listProviderOutcomes(query: ProviderOutcomeQueryV1) {
      const matched = outcomes
        .filter((row) => matchesOutcomeQueryV1(row, query))
        .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
      const limited = query.limit === undefined ? matched : matched.slice(0, query.limit);
      return limited.map((row) => structuredClone(row));
    },

    async insertReliabilitySnapshot(snapshot, memberOutcomeIds): Promise<OutcomeWriteEffectV1> {
      const parsed = assertReliabilitySnapshotV1(snapshot);
      if (memberOutcomeIds.length !== parsed.sampleSize) {
        throw new ProviderOutcomeConflictError('member_count_disagrees_with_sample_size');
      }
      if (new Set(memberOutcomeIds).size !== memberOutcomeIds.length) {
        throw new ProviderOutcomeConflictError('duplicate_member');
      }
      const existing = snapshots.find((row) => row.snapshotHash === parsed.snapshotHash) ?? null;
      const effect = reliabilitySnapshotInsertEffectV1(existing, parsed);
      if (effect.kind !== 'insert') return effect;
      snapshots.push(structuredClone(parsed));
      members.set(parsed.id, [...memberOutcomeIds]);
      return effect;
    },

    async getLatestReliabilitySnapshot(query: ReliabilitySnapshotQueryV1) {
      const matched = snapshots.filter((row) => {
        if (row.scope !== query.scope) return false;
        if (row.providerId !== query.providerId) return false;
        if (row.fromAsset !== query.fromAsset || row.toAsset !== query.toAsset) return false;
        if (query.scope === 'personal') {
          if (row.tenantId !== query.tenantId) return false;
          if (row.walletAddress !== (query.walletAddress ?? '').toLowerCase()) return false;
        }
        if (
          query.cutoffAtOrBefore !== undefined &&
          Date.parse(row.cutoffAt) > query.cutoffAtOrBefore.getTime()
        ) {
          return false;
        }
        if (
          query.cutoffStrictlyBefore !== undefined &&
          Date.parse(row.cutoffAt) >= query.cutoffStrictlyBefore.getTime()
        ) {
          return false;
        }
        if (
          query.aggregationVersion !== undefined &&
          row.aggregationVersion !== query.aggregationVersion
        ) {
          return false;
        }
        return true;
      });
      // Newest cutoff wins; the id breaks a tie so the answer is total.
      matched.sort(
        (left, right) =>
          Date.parse(right.cutoffAt) - Date.parse(left.cutoffAt) || right.id.localeCompare(left.id),
      );
      return matched[0] ? structuredClone(matched[0]) : null;
    },

    async listSnapshotMemberIds(snapshotId) {
      return [...(members.get(snapshotId) ?? [])];
    },

    async countSnapshotMembers(snapshotId) {
      return (members.get(snapshotId) ?? []).length;
    },
  };
}
