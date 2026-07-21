import {
  EarnRouteCardV1Schema,
  hashEarnRouteCardV1,
  stableHashV1,
  type EarnCandidateV1,
  type EarnEvidenceKindV1,
  type EarnEvidenceV1,
  type EarnRouteCardV1,
  type EarnRouteIntentV1,
  type EarnScoreV1,
  type HashV1,
} from '@mioagent/route-domain';
import { earnFreshnessStateV1 } from './evidence.js';
import { earnLiquidityStateV1 } from './scoring.js';
import type { EarnRankingResultV1 } from './ranking.js';

const ZERO_HASH_V1 = `0x${'0'.repeat(64)}` as HashV1;
const DEFAULT_TTL_MS = 5 * 60_000;

export interface EarnRouteCardEntryV1 {
  candidate: EarnCandidateV1;
  score: EarnScoreV1;
  evidence: EarnEvidenceV1;
}

function collectMissingEvidenceV1(score: EarnScoreV1): EarnEvidenceKindV1[] {
  const set = new Set<EarnEvidenceKindV1>();
  for (const dimension of score.dimensions) {
    for (const kind of dimension.missingEvidence) set.add(kind);
  }
  return [...set];
}

export interface BuildEarnRouteCardInputV1 {
  intent: EarnRouteIntentV1;
  entries: EarnRouteCardEntryV1[];
  ranking: EarnRankingResultV1;
  now: Date;
  ttlMs?: number;
}

/**
 * Projects the comparison into an EarnRouteCardV1: a recommendation OR an
 * honest degraded state, plus every candidate with its APY composition,
 * liquidity, withdrawal mechanics, evidence freshness and missing evidence.
 * Never writes "lowest risk" — that comes only from the recommendationReason,
 * which the ranker withholds without risk evidence (spec §6).
 */
export function buildEarnRouteCardV1(input: BuildEarnRouteCardInputV1): EarnRouteCardV1 {
  const { intent, entries, ranking, now } = input;
  const byHash = new Map<string, EarnRouteCardEntryV1>(
    entries.map((entry) => [entry.candidate.candidateHash, entry]),
  );
  const ordered = ranking.orderedCandidateHashes
    .map((hash) => byHash.get(hash))
    .filter((entry): entry is EarnRouteCardEntryV1 => entry !== undefined);

  const comparisons = ordered.map((entry) => ({
    candidate: entry.candidate,
    score: entry.score,
    apyComposition: {
      baseApyBps: entry.candidate.baseApyBps,
      rewardApyBps: entry.candidate.rewardApyBps,
      netApyBps: entry.candidate.netApyBps,
    },
    liquidityState: earnLiquidityStateV1(entry.candidate.availableLiquidityAtomic, entry.candidate.amount.amountAtomic),
    freshnessState: earnFreshnessStateV1(entry.evidence, now),
    missingEvidence: collectMissingEvidenceV1(entry.score),
  }));

  const isDegraded = ranking.recommendedCandidateHash === null;
  const nowIso = now.toISOString();
  const cardBase = {
    schemaVersion: 'earn-route-card/v1' as const,
    id: `earn-route-card:${stableHashV1('earn-route-card', { intentHash: intent.intentHash }).slice(2, 26)}`,
    tenantId: intent.tenantId,
    walletAddress: intent.walletAddress,
    chainId: intent.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: (isDegraded ? 'degraded' : 'ready') as 'degraded' | 'ready',
    intentHash: intent.intentHash,
    routeCardHash: ZERO_HASH_V1,
    optimizationMode: intent.optimizationMode,
    amount: intent.amount,
    recommendedCandidateHash: ranking.recommendedCandidateHash,
    recommendationReason: ranking.recommendationReason,
    degradedReason: ranking.degradedReason,
    comparisons,
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
  };
  return EarnRouteCardV1Schema.parse({
    ...cardBase,
    routeCardHash: hashEarnRouteCardV1(cardBase as unknown as EarnRouteCardV1),
  });
}
