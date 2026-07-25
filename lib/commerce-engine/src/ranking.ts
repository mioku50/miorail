import type {
  CommerceCandidateV1,
  CommerceOptimizationModeV1,
  CommerceScoreV1,
  HashV1,
} from '@mioagent/route-domain';
import { commerceScoreValueV1 } from './scoring.js';

// ---------------------------------------------------------------------------
// Deterministic ranking. Two rules do the real work:
//
//   * an out-of-stock or unknown-availability candidate is ORDERED but never
//     recommended — the storefront has not said it can sell it;
//   * a mode whose deciding dimension is unscored produces NO recommendation,
//     with a stated reason, instead of falling back to a different dimension
//     and calling the result "best".
// ---------------------------------------------------------------------------

export interface CommerceRankingEntryV1 {
  candidate: CommerceCandidateV1;
  score: CommerceScoreV1;
}

export interface CommerceRankingResultV1 {
  orderedCandidateHashes: HashV1[];
  recommendedCandidateHash: HashV1 | null;
  recommendationReason: string | null;
  degradedReason: string | null;
}

const MODE_DIMENSION_V1 = {
  exact_denomination: 'denomination_match',
  lowest_total_cost: 'total_cost',
  fastest_delivery: 'delivery_certainty',
} as const;

const MODE_LABEL_V1: Record<CommerceOptimizationModeV1, string> = {
  exact_denomination: 'the closest available denomination',
  lowest_total_cost: 'the lowest total charge',
  fastest_delivery: 'the fastest delivery',
};

function comparableV1(entry: CommerceRankingEntryV1, mode: CommerceOptimizationModeV1): number | null {
  return commerceScoreValueV1(entry.score, MODE_DIMENSION_V1[mode]);
}

export function rankCommerceCandidatesV1(
  entries: readonly CommerceRankingEntryV1[],
  mode: CommerceOptimizationModeV1,
): CommerceRankingResultV1 {
  // Ordering: the deciding dimension descending, unscored last, then the
  // cheaper total, then the candidate hash so the order is fully determined.
  const ordered = [...entries].sort((left, right) => {
    const leftValue = comparableV1(left, mode);
    const rightValue = comparableV1(right, mode);
    if (leftValue !== rightValue) {
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      return rightValue - leftValue;
    }
    const leftTotal = BigInt(left.candidate.fees.totalAtomic);
    const rightTotal = BigInt(right.candidate.fees.totalAtomic);
    if (leftTotal !== rightTotal) return leftTotal < rightTotal ? -1 : 1;
    return left.candidate.candidateHash < right.candidate.candidateHash ? -1 : 1;
  });
  const orderedCandidateHashes = ordered.map((entry) => entry.candidate.candidateHash);

  const sellable = ordered.filter((entry) => entry.candidate.availability === 'in_stock');
  if (sellable.length === 0) {
    return {
      orderedCandidateHashes,
      recommendedCandidateHash: null,
      recommendationReason: null,
      degradedReason:
        'No denomination is confirmed in stock, so nothing is recommended. The options found are shown with the stock state the storefront reported.',
    };
  }

  const best = sellable[0];
  const bestValue = comparableV1(best, mode);
  if (bestValue === null) {
    return {
      orderedCandidateHashes,
      recommendedCandidateHash: null,
      recommendationReason: null,
      degradedReason: `${MODE_LABEL_V1[mode]} cannot be scored from the evidence available, so no option is recommended. The options found are listed with what is known about each.`,
    };
  }

  return {
    orderedCandidateHashes,
    recommendedCandidateHash: best.candidate.candidateHash,
    recommendationReason: `Selected for ${MODE_LABEL_V1[mode]}: ${best.candidate.product.name} ${best.candidate.product.packageValue} ${best.candidate.product.currency}, confirmed in stock by ${best.candidate.provider.displayName}.`,
    degradedReason: null,
  };
}

/**
 * Skips that mean "the data did not arrive". A denomination excluded because
 * it exceeds the ceiling the user authorized, or because it needs a recipient
 * they did not give, is a DELIBERATE exclusion — the comparison is still
 * complete for what was asked, so it keeps its recommendation.
 */
const BLINDING_SKIP_REASONS_V1: readonly string[] = [
  'provider_invalid_response',
  'price_unavailable',
  'fx_rate_unavailable',
];

/**
 * A comparison that could not read part of the catalogue keeps its candidates
 * but loses its recommendation: with one storefront and unreadable
 * denominations there is no honest "best" to name.
 */
export function degradeCommerceRankingV1(
  ranking: CommerceRankingResultV1,
  skipped: readonly string[],
): CommerceRankingResultV1 {
  const blinding = [...new Set(skipped.filter((reason) => BLINDING_SKIP_REASONS_V1.includes(reason)))];
  if (blinding.length === 0 || ranking.recommendedCandidateHash === null) return ranking;
  return {
    orderedCandidateHashes: ranking.orderedCandidateHashes,
    recommendedCandidateHash: null,
    recommendationReason: null,
    degradedReason: `Some denominations could not be quoted (${blinding.join(', ')}), so this comparison is incomplete and nothing is recommended.`,
  };
}
