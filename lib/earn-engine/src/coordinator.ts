import type {
  EarnEvidenceV1,
  EarnProtocolV1,
  EarnRouteCardV1,
  EarnRouteIntentV1,
  EarnScoreV1,
} from '@mioagent/route-domain';
import { buildEarnCandidateV1, type EarnAdapterResultV1 } from './adapters.js';
import { EARN_PROTOCOLS_V1 } from './pinned-config.js';
import { buildEarnScoreV1 } from './scoring.js';
import {
  degradeEarnRankingForUnavailableProvidersV1,
  rankEarnCandidatesV1,
  type EarnRankingResultV1,
} from './ranking.js';
import { buildEarnRouteCardV1, type EarnRouteCardEntryV1 } from './routeCard.js';
import type { EarnDataSourceV1 } from './types.js';

/** Applies the intent's protocol constraint to the two pinned protocols.
 * "Use Moonwell only" → include_only[moonwell]; "Do not use Morpho" →
 * exclude[morpho]. Unknown protocol names are simply ignored (they can never
 * add a venue — there is no dynamic discovery). */
export function selectEarnProtocolsV1(
  constraint: EarnRouteIntentV1['protocolConstraint'],
  all: readonly EarnProtocolV1[] = EARN_PROTOCOLS_V1,
): EarnProtocolV1[] {
  const names = new Set(constraint.protocols.map((protocol) => protocol.toLowerCase()));
  if (constraint.mode === 'any') return [...all];
  if (constraint.mode === 'include_only') return all.filter((protocol) => names.has(protocol));
  return all.filter((protocol) => !names.has(protocol));
}

export type EarnComparisonResultV1 =
  | {
      ok: true;
      routeCard: EarnRouteCardV1;
      entries: EarnRouteCardEntryV1[];
      ranking: EarnRankingResultV1;
      failures: Extract<EarnAdapterResultV1, { ok: false }>[];
    }
  | { ok: false; reason: string; failures: Extract<EarnAdapterResultV1, { ok: false }>[] };

export interface CompareEarnRoutesInputV1 {
  intent: EarnRouteIntentV1;
  now: Date;
  ttlMs?: number;
}

/**
 * The end-to-end earn comparison: pinned protocols (filtered by constraint) →
 * live/injected observations → validated candidates + evidence → per-candidate
 * Earn Score → deterministic ranking → Earn Route Card. No dynamic discovery,
 * no live calls of its own — every I/O goes through the injected data source.
 *
 * Provider availability (T63A §4) is honest end to end:
 *   both providers answer  → ranked comparison, possibly with a recommendation;
 *   one provider answers   → degraded card, candidate shown, NO recommendation;
 *   neither answers        → failure, no card at all.
 */
export async function compareEarnRoutesV1(
  deps: { dataSource: EarnDataSourceV1 },
  input: CompareEarnRoutesInputV1,
): Promise<EarnComparisonResultV1> {
  const protocols = selectEarnProtocolsV1(input.intent.protocolConstraint);
  if (protocols.length === 0) {
    return { ok: false, reason: 'no_protocols_selected', failures: [] };
  }

  const entries: EarnRouteCardEntryV1[] = [];
  const failures: Extract<EarnAdapterResultV1, { ok: false }>[] = [];
  const evidences: EarnEvidenceV1[] = [];
  const scores: EarnScoreV1[] = [];

  for (const protocol of protocols) {
    const result = await buildEarnCandidateV1({ dataSource: deps.dataSource }, { intent: input.intent, protocol, now: input.now });
    if (!result.ok) {
      failures.push(result);
      continue;
    }
    const score = buildEarnScoreV1({ candidate: result.candidate, evidence: result.evidence, now: input.now });
    entries.push({ candidate: result.candidate, score, evidence: result.evidence });
    evidences.push(result.evidence);
    scores.push(score);
  }

  if (entries.length === 0) {
    // Every requested provider failed: no data at all, so no card — an empty
    // comparison is a failure, never a "nothing beats nothing" recommendation.
    return { ok: false, reason: failures.length > 0 ? 'all_providers_unavailable' : 'no_candidates', failures };
  }

  const ranked = rankEarnCandidatesV1(
    entries.map((entry) => ({ candidate: entry.candidate, score: entry.score })),
    input.intent.optimizationMode,
  );
  const ranking = degradeEarnRankingForUnavailableProvidersV1(
    ranked,
    failures.map((failure) => failure.protocol),
    entries.map((entry) => entry.candidate.protocol),
  );
  const routeCard = buildEarnRouteCardV1({ intent: input.intent, entries, ranking, now: input.now, ttlMs: input.ttlMs });

  return { ok: true, routeCard, entries, ranking, failures };
}
