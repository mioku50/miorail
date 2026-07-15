import { z } from 'zod';
import { financialContentV1, stableHashV1, type HashV1 } from './hashing.js';
import {
  DecimalAmountV1Schema,
  HashV1Schema,
  TimestampV1Schema,
  financialEntityFieldsV1,
  validateFinancialChronologyV1,
} from './primitives.js';
import {
  EvidenceTypeV1Schema,
  RouteCandidateV1Schema,
  type RouteCandidateV1,
} from './route-contracts.js';

function addHashIssue(ctx: z.RefinementCtx, path: string, label: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: `${label} does not match the canonical V1 financial payload`,
  });
}

export const PathScoreDimensionNameV1Schema = z.enum([
  'net_result',
  'quote_freshness',
  'route_simplicity',
  'transaction_safety',
]);
export type PathScoreDimensionNameV1 = z.infer<typeof PathScoreDimensionNameV1Schema>;

export const PATH_SCORE_DIMENSION_ORDER_V1: readonly PathScoreDimensionNameV1[] = [
  'net_result',
  'quote_freshness',
  'route_simplicity',
  'transaction_safety',
];

export const ScoreConfidenceV1Schema = z
  .object({
    value: z.number().min(0).max(1),
    label: z.enum(['low', 'medium', 'high']),
  })
  .strict();

export const ScoreFreshnessV1Schema = z
  .object({
    observedAt: TimestampV1Schema,
    expiresAt: TimestampV1Schema.nullable(),
    ageSeconds: z.number().int().nonnegative(),
    state: z.enum(['fresh', 'stale', 'unknown']),
  })
  .strict();

export const EvidenceSourceLinkV1Schema = z
  .object({
    evidenceId: z.string().min(1).max(200),
    evidenceHash: HashV1Schema,
    providerId: z.string().min(1).max(100),
  })
  .strict();

const PathScoreDimensionV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('path-score-dimension/v1', z.enum(['scored', 'not_scored'])),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    dimensionHash: HashV1Schema,
    dimension: PathScoreDimensionNameV1Schema,
    score: z.number().int().min(0).max(100).nullable(),
    notScoredReason: z
      .enum([
        'not_requested',
        'insufficient_evidence',
        'stale_evidence',
        'validation_failed',
        'scoring_error',
      ])
      .nullable(),
    confidence: ScoreConfidenceV1Schema.nullable(),
    sources: z.array(EvidenceSourceLinkV1Schema),
    freshness: ScoreFreshnessV1Schema.nullable(),
    scoringVersion: z.string().min(1).max(120),
    missingEvidence: z.array(EvidenceTypeV1Schema),
  })
  .strict();

export type PathScoreDimensionV1 = z.infer<typeof PathScoreDimensionV1ObjectSchema>;

export function hashPathScoreDimensionV1(value: PathScoreDimensionV1): HashV1 {
  return stableHashV1('path-score-dimension/v1', financialContentV1(value, ['dimensionHash']));
}

export const PathScoreDimensionV1Schema = PathScoreDimensionV1ObjectSchema.superRefine(
  (value, ctx) => {
    validateFinancialChronologyV1(value, ctx);
    if (value.dimensionHash !== hashPathScoreDimensionV1(value)) {
      addHashIssue(ctx, 'dimensionHash', 'dimensionHash');
    }
    if (value.status === 'not_scored') {
      if (value.score !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['score'],
          message: 'Not scored dimensions must use score=null',
        });
      }
      if (value.confidence !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['confidence'],
          message: 'Not scored dimensions must use confidence=null',
        });
      }
      if (value.freshness !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['freshness'],
          message: 'Not scored dimensions must use freshness=null',
        });
      }
      if (value.sources.length !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources'],
          message: 'Not scored dimensions must not claim evidence sources',
        });
      }
      if (value.notScoredReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['notScoredReason'],
          message: 'Not scored dimensions require an explicit reason',
        });
      }
      if (value.notScoredReason === 'insufficient_evidence' && value.missingEvidence.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['missingEvidence'],
          message: 'Insufficient evidence requires missingEvidence',
        });
      }
      return;
    }
    if (value.notScoredReason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notScoredReason'],
        message: 'Scored dimensions must use notScoredReason=null',
      });
    }
    if (value.score === null || value.confidence === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['score'],
        message: 'Scored dimensions require score and confidence',
      });
    }
    if (value.sources.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources'],
        message: 'Scored dimensions require evidence sources',
      });
    }
    if (value.freshness === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freshness'],
        message: 'Scored dimensions require freshness',
      });
    }
    if (value.missingEvidence.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['missingEvidence'],
        message: 'Scored dimensions cannot claim missing evidence',
      });
    }
  },
);

const PathScoreV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'path-score/v1',
      z.enum(['scored', 'partially_scored', 'not_scored']),
    ),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    pathScoreHash: HashV1Schema,
    scoringVersion: z.string().min(1).max(120),
    dimensions: z.array(PathScoreDimensionV1Schema).length(4),
  })
  .strict();

export type PathScoreV1 = z.infer<typeof PathScoreV1ObjectSchema>;

export function hashPathScoreV1(value: PathScoreV1): HashV1 {
  const content = financialContentV1(value, ['pathScoreHash', 'dimensions']);
  return stableHashV1('path-score/v1', {
    ...content,
    dimensionHashes: value.dimensions.map((dimension) => dimension.dimensionHash),
  });
}

export const PathScoreV1Schema = PathScoreV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.pathScoreHash !== hashPathScoreV1(value))
    addHashIssue(ctx, 'pathScoreHash', 'pathScoreHash');
  const actualOrder = value.dimensions.map((dimension) => dimension.dimension);
  if (JSON.stringify(actualOrder) !== JSON.stringify(PATH_SCORE_DIMENSION_ORDER_V1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dimensions'],
      message: 'Path Score dimensions must use the canonical V1 order',
    });
  }
  for (const [index, dimension] of value.dimensions.entries()) {
    if (
      dimension.intentHash !== value.intentHash ||
      dimension.candidateHash !== value.candidateHash ||
      dimension.evidenceSetHash !== value.evidenceSetHash ||
      dimension.tenantId !== value.tenantId ||
      dimension.walletAddress !== value.walletAddress ||
      dimension.chainId !== value.chainId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions', index],
        message: 'Path Score dimension linkage must match its parent score',
      });
    }
    if (dimension.scoringVersion !== value.scoringVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions', index, 'scoringVersion'],
        message: 'Path Score dimension scoringVersion must match its parent score',
      });
    }
  }
  const scoredCount = value.dimensions.filter((dimension) => dimension.status === 'scored').length;
  const expectedStatus =
    scoredCount === 4 ? 'scored' : scoredCount === 0 ? 'not_scored' : 'partially_scored';
  if (value.status !== expectedStatus) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: `Path Score status must be ${expectedStatus}`,
    });
  }
});

export const RouteCardEvidenceSummaryV1Schema = z
  .object({
    recordCount: z.number().int().nonnegative(),
    paidCostUsd: DecimalAmountV1Schema,
    missingEvidence: z.array(EvidenceTypeV1Schema),
    sourceIndependence: z.enum(['independent', 'overlapping', 'unknown']),
  })
  .strict();

const RouteCardV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('route-card/v1', z.enum(['ready', 'selected', 'stale', 'invalid'])),
    intentHash: HashV1Schema,
    selectedCandidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    pathScoreHash: HashV1Schema,
    routeCardHash: HashV1Schema,
    recommendedCandidate: RouteCandidateV1Schema,
    alternativeCandidates: z.array(RouteCandidateV1Schema),
    pathScore: PathScoreV1Schema,
    evidenceSummary: RouteCardEvidenceSummaryV1Schema,
    recommendationReason: z.string().min(1).max(2_000),
    expiresAt: TimestampV1Schema,
  })
  .strict();

export type RouteCardV1 = z.infer<typeof RouteCardV1ObjectSchema>;

export function hashRouteCardV1(value: RouteCardV1): HashV1 {
  const content = financialContentV1(value, [
    'routeCardHash',
    'recommendedCandidate',
    'alternativeCandidates',
    'pathScore',
  ]);
  return stableHashV1('route-card/v1', {
    ...content,
    recommendedCandidateHash: value.recommendedCandidate.candidateHash,
    alternativeCandidateHashes: value.alternativeCandidates.map(
      (candidate: RouteCandidateV1) => candidate.candidateHash,
    ),
    embeddedPathScoreHash: value.pathScore.pathScoreHash,
  });
}

export const RouteCardV1Schema = RouteCardV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.routeCardHash !== hashRouteCardV1(value))
    addHashIssue(ctx, 'routeCardHash', 'routeCardHash');
  if (
    value.selectedCandidateHash !== value.recommendedCandidate.candidateHash ||
    value.pathScoreHash !== value.pathScore.pathScoreHash ||
    value.intentHash !== value.recommendedCandidate.intentHash ||
    value.intentHash !== value.pathScore.intentHash ||
    value.evidenceSetHash !== value.pathScore.evidenceSetHash ||
    value.selectedCandidateHash !== value.pathScore.candidateHash
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedCandidateHash'],
      message: 'Route Card hashes must match embedded candidate and Path Score',
    });
  }
  const candidateHashes = new Set([value.selectedCandidateHash]);
  for (const [index, candidate] of value.alternativeCandidates.entries()) {
    if (candidate.intentHash !== value.intentHash || candidate.chainId !== value.chainId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['alternativeCandidates', index],
        message: 'Alternative candidate must match Route Card intent and chain',
      });
    }
    if (candidateHashes.has(candidate.candidateHash)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['alternativeCandidates', index, 'candidateHash'],
        message: 'Route Card candidate hashes must be unique',
      });
    }
    candidateHashes.add(candidate.candidateHash);
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Route Card expiry must be later than its creation time',
    });
  }
});
