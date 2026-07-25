import {
  CommerceScoreDimensionV1Schema,
  CommerceScoreV1Schema,
  COMMERCE_SCORE_DIMENSION_ORDER_V1,
  hashCommerceScoreDimensionV1,
  hashCommerceScoreV1,
  stableHashV1,
  ZERO_HASH_V1,
  type CommerceCandidateV1,
  type CommerceEvidenceKindV1,
  type CommerceEvidenceV1,
  type CommerceScoreDimensionNameV1,
  type CommerceScoreDimensionV1,
  type CommerceScoreV1,
  type HashV1,
} from '@mioagent/route-domain';
import { commerceEvidenceAgeSecondsV1, commerceEvidenceSetHashV1, commerceFreshnessStateV1 } from './evidence.js';
import { decimalToAtomicV1, packageValueAsDecimalV1 } from './normalization.js';

// ---------------------------------------------------------------------------
// T64 — the Commerce Score: four dimensions, no overall number.
//
// The rule the console depends on: an unscored dimension NEVER lights up. It
// carries score=null, confidence=null, no sources, and a reason — it does not
// quietly become a zero, and it does not become a green bar.
//
// `delivery_certainty` is Not scored in V1 by construction: the storefront
// publishes no per-product fulfilment time, so there is nothing to score. It
// stays in the dimension list, visibly unscored, rather than being dropped.
// ---------------------------------------------------------------------------

export const COMMERCE_SCORING_VERSION_V1 = 'commerce-score/2026-07-25';

interface DimensionDraftV1 {
  dimension: CommerceScoreDimensionNameV1;
  score: number | null;
  notScoredReason: CommerceScoreDimensionV1['notScoredReason'];
  missingEvidence: CommerceEvidenceKindV1[];
  confidenceValue: number;
  confidenceLabel: 'low' | 'medium' | 'high';
}

export interface BuildCommerceScoreInputV1 {
  candidate: CommerceCandidateV1;
  evidence: CommerceEvidenceV1;
  requestedValueDecimal: string;
  /** The cheapest total among the compared candidates, for relative cost. */
  cheapestTotalAtomic: string;
  now: Date;
}

/** 100 for an exact denomination, decaying with the relative gap; a
 * denomination that cannot be read as an amount is Not scored, never guessed. */
export function denominationMatchScoreV1(input: {
  requestedDecimal: string;
  candidate: CommerceCandidateV1;
}): number | null {
  const requested = decimalToAtomicV1(input.requestedDecimal);
  const offeredDecimal =
    packageValueAsDecimalV1(input.candidate.product.packageValue) ?? input.candidate.fiatPrice.amountDecimal;
  const offered = decimalToAtomicV1(offeredDecimal);
  if (requested === null || offered === null) return null;
  const requestedValue = BigInt(requested);
  const offeredValue = BigInt(offered);
  if (requestedValue === BigInt(0)) return null;
  if (offeredValue === requestedValue) return 100;
  const delta = offeredValue > requestedValue ? offeredValue - requestedValue : requestedValue - offeredValue;
  // Relative gap in percent, clamped: a denomination twice the request scores 0.
  const gapPercent = Number((delta * BigInt(100)) / requestedValue);
  return Math.max(0, 100 - gapPercent);
}

/** 100 for the cheapest total in the comparison, decaying with the premium. */
export function totalCostScoreV1(input: { totalAtomic: string; cheapestTotalAtomic: string }): number | null {
  const cheapest = BigInt(input.cheapestTotalAtomic);
  const total = BigInt(input.totalAtomic);
  if (cheapest <= BigInt(0)) return null;
  if (total <= cheapest) return 100;
  const premiumPercent = Number(((total - cheapest) * BigInt(100)) / cheapest);
  return Math.max(0, 100 - premiumPercent);
}

function draftDimensionsV1(input: BuildCommerceScoreInputV1): DimensionDraftV1[] {
  const freshness = commerceFreshnessStateV1(input.evidence, input.now);
  const stale = freshness !== 'fresh';

  const denominationScore = stale ? null : denominationMatchScoreV1({
    requestedDecimal: input.requestedValueDecimal,
    candidate: input.candidate,
  });

  // An estimated total is not a comparable total. When the provider quoted no
  // settlement price, the cost dimension stays Not scored and names the fee
  // evidence it is missing.
  const costKnown = input.candidate.fees.totalBasis === 'exact_quote';
  const costScore = stale || !costKnown ? null : totalCostScoreV1({
    totalAtomic: input.candidate.fees.totalAtomic,
    cheapestTotalAtomic: input.cheapestTotalAtomic,
  });

  const availabilityScore = stale
    ? null
    : input.candidate.availability === 'in_stock'
      ? 100
      : input.candidate.availability === 'out_of_stock'
        ? 0
        : null;

  return [
    {
      dimension: 'denomination_match',
      score: denominationScore,
      notScoredReason: denominationScore === null ? (stale ? 'stale_evidence' : 'insufficient_evidence') : null,
      missingEvidence: denominationScore === null && !stale ? ['product_identity'] : [],
      confidenceValue: 0.9,
      confidenceLabel: 'high',
    },
    {
      dimension: 'total_cost',
      score: costScore,
      notScoredReason: costScore === null ? (stale ? 'stale_evidence' : 'insufficient_evidence') : null,
      missingEvidence: costScore === null && !stale ? ['fees'] : [],
      confidenceValue: 0.8,
      confidenceLabel: 'high',
    },
    {
      dimension: 'availability',
      score: availabilityScore,
      notScoredReason: availabilityScore === null ? (stale ? 'stale_evidence' : 'insufficient_evidence') : null,
      missingEvidence: availabilityScore === null && !stale ? ['availability'] : [],
      confidenceValue: 0.7,
      confidenceLabel: 'medium',
    },
    {
      // No approved source publishes a per-product fulfilment time, so this
      // dimension is honestly unscored rather than optimistically full.
      dimension: 'delivery_certainty',
      score: null,
      notScoredReason: 'insufficient_evidence',
      missingEvidence: ['delivery_terms'],
      confidenceValue: 0,
      confidenceLabel: 'low',
    },
  ];
}

export function buildCommerceScoreV1(input: BuildCommerceScoreInputV1): CommerceScoreV1 {
  const { candidate, evidence, now } = input;
  const evidenceSetHash = commerceEvidenceSetHashV1(evidence);
  const nowIso = now.toISOString();
  const freshnessState = commerceFreshnessStateV1(evidence, now);

  const dimensions = draftDimensionsV1(input).map((draft) => {
    const scored = draft.score !== null;
    const base = {
      schemaVersion: 'commerce-score-dimension/v1' as const,
      id: `commerce-dimension:${stableHashV1('commerce-dimension-id', {
        candidateHash: candidate.candidateHash,
        dimension: draft.dimension,
      }).slice(2, 26)}`,
      tenantId: candidate.tenantId,
      walletAddress: candidate.walletAddress,
      chainId: candidate.chainId,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: (scored ? 'scored' : 'not_scored') as 'scored' | 'not_scored',
      intentHash: candidate.intentHash,
      candidateHash: candidate.candidateHash,
      evidenceSetHash,
      dimensionHash: ZERO_HASH_V1,
      dimension: draft.dimension,
      score: draft.score,
      notScoredReason: scored ? null : (draft.notScoredReason ?? 'insufficient_evidence'),
      confidence: scored ? { value: draft.confidenceValue, label: draft.confidenceLabel } : null,
      sources: scored
        ? [{ evidenceId: evidence.id, evidenceHash: evidence.evidenceHash, providerId: evidence.provider.id }]
        : [],
      freshness: scored
        ? {
            observedAt: evidence.observedAt,
            expiresAt: evidence.expiresAt,
            ageSeconds: commerceEvidenceAgeSecondsV1(evidence, now),
            state: freshnessState,
          }
        : null,
      scoringVersion: COMMERCE_SCORING_VERSION_V1,
      missingEvidence: scored ? [] : draft.missingEvidence,
    };
    return CommerceScoreDimensionV1Schema.parse({
      ...base,
      dimensionHash: hashCommerceScoreDimensionV1(base as unknown as CommerceScoreDimensionV1),
    });
  });

  const scoredCount = dimensions.filter((dimension) => dimension.status === 'scored').length;
  const scoreBase = {
    schemaVersion: 'commerce-score/v1' as const,
    id: `commerce-score:${candidate.candidateHash.slice(2, 26)}`,
    tenantId: candidate.tenantId,
    walletAddress: candidate.walletAddress,
    chainId: candidate.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: (scoredCount === 4 ? 'scored' : scoredCount === 0 ? 'not_scored' : 'partially_scored') as
      | 'scored'
      | 'not_scored'
      | 'partially_scored',
    intentHash: candidate.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceSetHash,
    commerceScoreHash: ZERO_HASH_V1,
    scoringVersion: COMMERCE_SCORING_VERSION_V1,
    dimensions,
  };
  return CommerceScoreV1Schema.parse({
    ...scoreBase,
    commerceScoreHash: hashCommerceScoreV1(scoreBase as unknown as CommerceScoreV1),
  });
}

/** The dimension names, in canonical order — exported so a UI can render the
 * unscored ones instead of silently omitting them. */
export const COMMERCE_SCORE_DIMENSIONS_V1 = COMMERCE_SCORE_DIMENSION_ORDER_V1;

export function commerceScoreValueV1(
  score: CommerceScoreV1,
  dimension: CommerceScoreDimensionNameV1,
): number | null {
  return score.dimensions.find((entry) => entry.dimension === dimension)?.score ?? null;
}

export function commerceEvidenceSetHashForScoreV1(score: CommerceScoreV1): HashV1 {
  return score.evidenceSetHash;
}
