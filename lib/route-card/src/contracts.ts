import {
  EvidenceSetV1Schema,
  EvidenceTypeV1Schema,
  GasEstimateV1Schema,
  HashV1Schema,
  OptimizationModeV1Schema,
  PathScoreV1Schema,
  PercentageV1Schema,
  ProviderRefV1Schema,
  RouteCardV1Schema,
  TokenAmountV1Schema,
  stableHashV1,
  type HashV1,
} from '@mioagent/route-domain';
import {
  ComparisonConfidenceV1Schema,
  CrossCandidateOverlapV1Schema,
  SwapAdapterFailureV1Schema,
  SwapRouteEvaluationReasonV1Schema,
  SwapRouteEvaluationV1Schema,
} from '@mioagent/route-engine/contracts';
import { z } from 'zod';

export const RoutePlanEvidenceSummaryV1Schema = z
  .object({
    recordCount: z.number().int().nonnegative(),
    freeEvidenceCount: z.number().int().nonnegative(),
    paidEvidenceCount: z.number().int().nonnegative(),
    paidCostUsd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    missingEvidence: z.array(EvidenceTypeV1Schema),
    evidenceTypes: z.array(EvidenceTypeV1Schema),
    status: z.enum(['complete', 'partial', 'stale', 'invalid']),
    sourceIndependence: z.enum(['independent', 'overlapping', 'unknown']),
  })
  .strict();
export type RoutePlanEvidenceSummaryV1 = z.infer<typeof RoutePlanEvidenceSummaryV1Schema>;

export const RoutePlanRouteV1Schema = z
  .object({
    candidateHash: HashV1Schema,
    provider: ProviderRefV1Schema,
    expectedOutput: TokenAmountV1Schema,
    minimumOutput: TokenAmountV1Schema,
    estimatedGas: GasEstimateV1Schema,
    priceImpact: PercentageV1Schema,
    slippage: PercentageV1Schema,
    quoteObservedAt: z.string().datetime({ offset: true }),
    quoteExpiresAt: z.string().datetime({ offset: true }),
    quoteAgeSeconds: z.number().int().nonnegative(),
    callCount: z.number().int().nonnegative(),
    approvalCount: z.number().int().nonnegative(),
    pathScore: PathScoreV1Schema,
    evidence: RoutePlanEvidenceSummaryV1Schema,
  })
  .strict();
export type RoutePlanRouteV1 = z.infer<typeof RoutePlanRouteV1Schema>;

const RoutePlanProjectionV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('route-plan-projection/v1'),
    projectionHash: HashV1Schema,
    evaluationHash: HashV1Schema,
    routeCardHash: HashV1Schema.nullable(),
    routeRunId: z.string().min(1).max(200).nullable(),
    outcome: z.enum(['ready', 'constrained', 'degraded', 'failed']),
    reason: SwapRouteEvaluationReasonV1Schema,
    goalSummary: z.string().min(1).max(300),
    optimizationMode: OptimizationModeV1Schema,
    recommendedRoute: RoutePlanRouteV1Schema.nullable(),
    availableRoutes: z.array(RoutePlanRouteV1Schema),
    alternatives: z.array(RoutePlanRouteV1Schema),
    pathScore: PathScoreV1Schema.nullable(),
    comparisonConfidence: ComparisonConfidenceV1Schema,
    evidenceSummary: RoutePlanEvidenceSummaryV1Schema,
    crossCandidateOverlaps: z.array(CrossCandidateOverlapV1Schema),
    providerFailures: z.array(SwapAdapterFailureV1Schema),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    readOnly: z.literal(true),
  })
  .strict();

export type RoutePlanProjectionV1 = z.infer<typeof RoutePlanProjectionV1ObjectSchema>;

export function hashRoutePlanProjectionV1(value: RoutePlanProjectionV1): HashV1 {
  const { projectionHash: _projectionHash, ...content } = value;
  return stableHashV1('route-plan-projection/v1', content);
}

export const RoutePlanProjectionV1Schema = RoutePlanProjectionV1ObjectSchema.superRefine(
  (value, ctx) => {
    if (value.projectionHash !== hashRoutePlanProjectionV1(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectionHash'],
        message: 'projectionHash does not match the canonical route-plan-projection/v1 payload',
      });
    }
    if ((value.recommendedRoute === null) !== (value.pathScore === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pathScore'],
        message: 'Projection pathScore must match the recommended route state',
      });
    }
    if (
      value.recommendedRoute &&
      value.pathScore?.candidateHash !== value.recommendedRoute.candidateHash
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pathScore'],
        message: 'Projection pathScore must belong to recommendedRoute',
      });
    }
    if (
      ['degraded', 'failed'].includes(value.outcome) &&
      (value.routeCardHash !== null || value.recommendedRoute !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recommendedRoute'],
        message: 'Degraded and failed projections cannot claim a recommendation or Route Card',
      });
    }
  },
);

export const RouteCardProjectionInputsV1 = {
  Evaluation: SwapRouteEvaluationV1Schema,
  RouteCard: RouteCardV1Schema,
  EvidenceSet: EvidenceSetV1Schema,
} as const;
