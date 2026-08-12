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

/**
 * T67C.1 Part 2 §5 — what the card says about a provider's verified history.
 *
 * Deliberately a set of separate measurements. There is no composite figure and
 * no place to put one: a success rate, a median shortfall and a p90
 * confirmation time answer different questions in different units, and the
 * single number a reader would remember is the one that would tell them least.
 *
 * `requiredSampleSize` travels with `sampleSize` so a Not-scored card can say
 * "8 verified routes · 10 required" instead of leaving an unexplained absence.
 */
export const ProviderHistoryProjectionV1Schema = z
  .object({
    status: z.enum(['eligible', 'not_scored']),
    scope: z.enum(['personal', 'network']).nullable(),
    notScoredReason: z
      .enum(['feature_disabled', 'no_verified_history', 'insufficient_history', 'unsupported_provider'])
      .nullable(),
    sampleSize: z.number().int().nonnegative(),
    requiredSampleSize: z.number().int().positive(),
    uniqueWalletCount: z.number().int().nonnegative().nullable(),
    completedCount: z.number().int().nonnegative().nullable(),
    failedCount: z.number().int().nonnegative().nullable(),
    partialFailureCount: z.number().int().nonnegative().nullable(),
    successRateBps: z.number().int().min(0).max(10_000).nullable(),
    medianAdverseShortfallBps: z.number().int().nonnegative().nullable(),
    p90AdverseShortfallBps: z.number().int().nonnegative().nullable(),
    floorBreachRateBps: z.number().int().min(0).max(10_000).nullable(),
    medianGasErrorBps: z.number().int().nullable(),
    p90ConfirmationMs: z.number().int().nonnegative().nullable(),
    /** The exact snapshot this card was calibrated against, pinned so the card
     * remains checkable after newer snapshots exist. */
    cutoffAt: z.string().datetime({ offset: true }).nullable(),
    snapshotHash: HashV1Schema.nullable(),
    aggregationVersion: z.string().min(1).max(120).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const eligible = value.status === 'eligible';
    if (eligible === (value.notScoredReason !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notScoredReason'],
        message: 'Not scored requires a reason; eligible must not carry one',
      });
    }
    if (eligible && (value.snapshotHash === null || value.cutoffAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotHash'],
        message: 'An eligible history names the snapshot and cutoff it came from',
      });
    }
    if (!eligible && value.snapshotHash !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotHash'],
        message: 'A Not scored history must not claim a snapshot',
      });
    }
  });
export type ProviderHistoryProjectionV1 = z.infer<typeof ProviderHistoryProjectionV1Schema>;

export const RoutePlanRouteV1Schema = z
  .object({
    candidateHash: HashV1Schema,
    provider: ProviderRefV1Schema,
    expectedOutput: TokenAmountV1Schema,
    minimumOutput: TokenAmountV1Schema,
    estimatedGas: GasEstimateV1Schema,
    priceImpact: PercentageV1Schema.nullable(),
    slippage: PercentageV1Schema,
    quoteObservedAt: z.string().datetime({ offset: true }),
    quoteExpiresAt: z.string().datetime({ offset: true }),
    quoteAgeSeconds: z.number().int().nonnegative(),
    callCount: z.number().int().nonnegative(),
    approvalCount: z.number().int().nonnegative(),
    pathScore: PathScoreV1Schema,
    evidence: RoutePlanEvidenceSummaryV1Schema,
    // --- T67C.1 Part 2 -----------------------------------------------------
    // Additive and OPTIONAL. A projection built under swap-path-score/v1 omits
    // every field below, so it canonicalises — and therefore hashes — exactly
    // as it did before this task, and every Route Card already stored keeps
    // validating unchanged.
    providerHistory: ProviderHistoryProjectionV1Schema.optional(),
    /** The quoted net result. Always the raw figure, so the two are comparable
     * side by side rather than one silently standing in for the other. */
    rawNetResult: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable().optional(),
    historyAdjustedNetResult: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable().optional(),
    calibrationApplied: z.boolean().optional(),
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
    /** Absent on a v1 projection — which is what keeps the hash unchanged. */
    scoringVersion: z.string().min(1).max(120).optional(),
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
