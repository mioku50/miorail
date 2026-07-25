import type { CommerceRouteCardV1, CommerceRouteIntentV1 } from '@mioagent/route-domain';
import { buildCommerceCandidatesV1 } from './candidates.js';
import { decimalToAtomicV1 } from './normalization.js';
import { degradeCommerceRankingV1, rankCommerceCandidatesV1, type CommerceRankingResultV1 } from './ranking.js';
import { buildCommerceRouteCardV1, type CommerceRouteCardEntryV1 } from './routeCard.js';
import { buildCommerceScoreV1 } from './scoring.js';
import { validateCommerceIntentV1 } from './validation.js';
import type { CommerceCatalogSourceV1, CommerceFailureReasonV1 } from './types.js';

// ---------------------------------------------------------------------------
// The end-to-end commerce comparison:
//   validated intent → catalogue read → validated candidates + evidence →
//   per-candidate Commerce Score → deterministic ranking → Commerce Route Card.
//
// No I/O of its own; the catalogue source is injected, so unit tests never
// open a socket and a deployment can swap the storefront without touching the
// comparison.
// ---------------------------------------------------------------------------

export type CommerceComparisonResultV1 =
  | {
      ok: true;
      routeCard: CommerceRouteCardV1;
      entries: CommerceRouteCardEntryV1[];
      ranking: CommerceRankingResultV1;
      skipped: CommerceFailureReasonV1[];
    }
  | { ok: false; reason: CommerceFailureReasonV1 };

export interface CompareCommerceRoutesInputV1 {
  intent: CommerceRouteIntentV1;
  now: Date;
  ttlMs?: number;
}

export async function compareCommerceRoutesV1(
  deps: { catalog: CommerceCatalogSourceV1 },
  input: CompareCommerceRoutesInputV1,
): Promise<CommerceComparisonResultV1> {
  const { intent, now } = input;

  const validated = validateCommerceIntentV1(intent);
  if (!validated.ok) return { ok: false, reason: validated.reason };

  const requestedAtomic = decimalToAtomicV1(intent.requestedValue.amountDecimal);
  if (requestedAtomic === null) return { ok: false, reason: 'price_out_of_range' };

  const catalog = await deps.catalog.search({
    query: intent.query,
    kind: intent.kind,
    country: intent.country,
    requestedValueDecimal: intent.requestedValue.amountDecimal,
    requestedCurrency: intent.requestedValue.currency,
    now,
  });
  if (!catalog.ok) return { ok: false, reason: catalog.reason };

  const built = buildCommerceCandidatesV1({
    intent,
    observation: catalog.observation,
    requestedAtomic,
    now,
  });
  if (!built.ok) return { ok: false, reason: built.reason };

  const cheapestTotalAtomic = built.builds
    .map((build) => build.candidate.fees.totalAtomic)
    .reduce((cheapest, total) => (BigInt(total) < BigInt(cheapest) ? total : cheapest));

  const entries: CommerceRouteCardEntryV1[] = built.builds.map((build) => ({
    candidate: build.candidate,
    evidence: build.evidence,
    score: buildCommerceScoreV1({
      candidate: build.candidate,
      evidence: build.evidence,
      requestedValueDecimal: intent.requestedValue.amountDecimal,
      cheapestTotalAtomic,
      now,
    }),
  }));

  const ranked = rankCommerceCandidatesV1(
    entries.map((entry) => ({ candidate: entry.candidate, score: entry.score })),
    intent.optimizationMode,
  );
  const ranking = degradeCommerceRankingV1(ranked, built.skipped);
  const routeCard = buildCommerceRouteCardV1({ intent, entries, ranking, now, ttlMs: input.ttlMs });

  return { ok: true, routeCard, entries, ranking, skipped: built.skipped };
}
