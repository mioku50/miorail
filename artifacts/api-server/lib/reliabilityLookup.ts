import {
  DEFAULT_RELIABILITY_THRESHOLDS_V1,
  aggregationVersionV1,
  selectEligibleSnapshotV1,
  type ProviderReliabilityAssessmentV1,
  type ReliabilityThresholdsV1,
  type SnapshotReadV1,
} from '@mioagent/route-outcomes';
import type { ProviderOutcomeRepositoryV1 } from '@mioagent/route-storage';
import type { RouteCandidateV1 } from '@mioagent/route-domain';
import { logger } from '@mioagent/utils';

// ---------------------------------------------------------------------------
// T67C.1 Part 2 §1 — the snapshot reader.
//
// Two indexed lookups plus one count per candidate. No aggregation happens
// here: the statistics were computed by `reliability:rebuild` and sealed, and
// recomputing them inside a comparison the user is waiting on would make the
// number depend on how busy the server was.
//
// Every snapshot it returns is fetched BEFORE a winner is chosen, and the hash
// and cutoff travel into the Route Card — so the card names the exact statistic
// it was ranked against, and stays checkable after newer snapshots exist.
// ---------------------------------------------------------------------------

export interface ReliabilityLookupDependenciesV1 {
  outcomes: ProviderOutcomeRepositoryV1;
  thresholds?: ReliabilityThresholdsV1;
  tenantId: string;
  walletAddress: string;
  /** When the current Route Run was created. Snapshots must be cut off
   * strictly before it. */
  runStartedAt: Date;
}

export function createReliabilityLookupV1(deps: ReliabilityLookupDependenciesV1) {
  const thresholds = deps.thresholds ?? DEFAULT_RELIABILITY_THRESHOLDS_V1;
  const expectedAggregationVersion = aggregationVersionV1(thresholds);

  return async function loadReliability(
    candidates: readonly RouteCandidateV1[],
  ): Promise<ReadonlyMap<string, ProviderReliabilityAssessmentV1>> {
    const result = new Map<string, ProviderReliabilityAssessmentV1>();
    for (const candidate of candidates) {
      const providerId = candidate.provider.id.toLowerCase();
      const fromAsset = candidate.inputAmount.asset.assetId;
      const toAsset = candidate.expectedOutput.asset.assetId;
      const pair = { providerId, fromAsset, toAsset } as const;

      const read = async (
        scope: 'personal' | 'network',
      ): Promise<SnapshotReadV1> => {
        const snapshot = await deps.outcomes.getLatestReliabilitySnapshot({
          scope,
          ...pair,
          ...(scope === 'personal'
            ? { tenantId: deps.tenantId, walletAddress: deps.walletAddress }
            : {}),
          // Both filters in the query rather than after it: the "latest" row
          // that this server cannot use would otherwise hide a usable older one
          // behind it, and the pair would look uncalibratable.
          cutoffStrictlyBefore: deps.runStartedAt,
          aggregationVersion: expectedAggregationVersion,
        });
        if (!snapshot) return { snapshot: null, memberCount: null };
        return {
          snapshot,
          memberCount: await deps.outcomes.countSnapshotMembers(snapshot.id),
        };
      };

      const [personal, network] = await Promise.all([read('personal'), read('network')]);
      const { assessment, rejections } = selectEligibleSnapshotV1({
        ...pair,
        tenantId: deps.tenantId,
        walletAddress: deps.walletAddress,
        personal,
        network,
        thresholds,
        expectedAggregationVersion,
        runStartedAt: deps.runStartedAt,
        featureEnabled: true,
      });
      if (rejections.length > 0) {
        // "Not scored" with no explanation is how a mismatched aggregation
        // version stays invisible for a month.
        logger.warn('Reliability snapshot discarded', { provider: providerId, rejections });
      }
      result.set(candidate.candidateHash, assessment);
    }
    return result;
  };
}
