import {
  CommerceRouteCardV1Schema,
  hashCommerceRouteCardV1,
  stableHashV1,
  ZERO_HASH_V1,
  type CommerceCandidateV1,
  type CommerceEvidenceKindV1,
  type CommerceEvidenceV1,
  type CommerceRouteCardV1,
  type CommerceRouteIntentV1,
  type CommerceScoreV1,
} from '@mioagent/route-domain';
import { denominationDeltaV1 } from './candidates.js';
import { commerceFreshnessStateV1 } from './evidence.js';
import type { CommerceRankingResultV1 } from './ranking.js';

const DEFAULT_TTL_MS_V1 = 2 * 60_000;

export interface CommerceRouteCardEntryV1 {
  candidate: CommerceCandidateV1;
  score: CommerceScoreV1;
  evidence: CommerceEvidenceV1;
}

function collectMissingEvidenceV1(score: CommerceScoreV1): CommerceEvidenceKindV1[] {
  const set = new Set<CommerceEvidenceKindV1>();
  for (const dimension of score.dimensions) {
    for (const kind of dimension.missingEvidence) set.add(kind);
  }
  return [...set];
}

export interface BuildCommerceRouteCardInputV1 {
  intent: CommerceRouteIntentV1;
  entries: CommerceRouteCardEntryV1[];
  ranking: CommerceRankingResultV1;
  now: Date;
  ttlMs?: number;
}

/**
 * Projects the comparison into a CommerceRouteCardV1: a recommendation OR an
 * honest degraded state, plus every denomination that was found with its exact
 * price, its fee basis, its stock state, its freshness, and the evidence it is
 * missing. Nothing is filtered out — an option the storefront cannot sell is
 * still shown, with the reason it cannot be chosen.
 */
export function buildCommerceRouteCardV1(input: BuildCommerceRouteCardInputV1): CommerceRouteCardV1 {
  const { intent, entries, ranking, now } = input;
  const byHash = new Map<string, CommerceRouteCardEntryV1>(
    entries.map((entry) => [entry.candidate.candidateHash, entry]),
  );
  const ordered = ranking.orderedCandidateHashes
    .map((hash) => byHash.get(hash))
    .filter((entry): entry is CommerceRouteCardEntryV1 => entry !== undefined);

  const comparisons = ordered.map((entry) => ({
    candidate: entry.candidate,
    score: entry.score,
    denominationDelta: denominationDeltaV1({
      requestedDecimal: intent.requestedValue.amountDecimal,
      candidate: entry.candidate,
    }),
    availability: entry.candidate.availability,
    freshnessState: commerceFreshnessStateV1(entry.evidence, now),
    missingEvidence: collectMissingEvidenceV1(entry.score),
  }));

  const isDegraded = ranking.recommendedCandidateHash === null;
  const nowIso = now.toISOString();
  const cardBase = {
    schemaVersion: 'commerce-route-card/v1' as const,
    id: `commerce-route-card:${stableHashV1('commerce-route-card', { intentHash: intent.intentHash }).slice(2, 26)}`,
    tenantId: intent.tenantId,
    walletAddress: intent.walletAddress,
    chainId: intent.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: (isDegraded ? 'degraded' : 'ready') as 'degraded' | 'ready',
    intentHash: intent.intentHash,
    routeCardHash: ZERO_HASH_V1,
    optimizationMode: intent.optimizationMode,
    requestedValue: intent.requestedValue,
    recommendedCandidateHash: ranking.recommendedCandidateHash,
    recommendationReason: ranking.recommendationReason,
    degradedReason: ranking.degradedReason,
    comparisons,
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS_V1)).toISOString(),
  };
  return CommerceRouteCardV1Schema.parse({
    ...cardBase,
    routeCardHash: hashCommerceRouteCardV1(cardBase as unknown as CommerceRouteCardV1),
  });
}
