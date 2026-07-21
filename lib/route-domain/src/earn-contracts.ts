import { z } from 'zod';
import { financialContentV1, stableHashV1, type HashV1 } from './hashing.js';
import {
  AddressV1Schema,
  AssetRefV1Schema,
  AtomicAmountV1Schema,
  GasEstimateV1Schema,
  HashV1Schema,
  ProviderRefV1Schema,
  TimestampV1Schema,
  TokenAmountV1Schema,
  financialEntityFieldsV1,
  validateFinancialChronologyV1,
} from './primitives.js';
import { ProtocolConstraintV1Schema, VerificationDepthV1Schema } from './route-contracts.js';
import {
  EvidenceSourceLinkV1Schema,
  ScoreConfidenceV1Schema,
  ScoreFreshnessV1Schema,
} from './score-contracts.js';

// ---------------------------------------------------------------------------
// T61 — Earn contract family (Moonwell + Morpho).
//
// A DELIBERATELY SEPARATE contract family, not an extension of the frozen swap
// V1 schemas (decision per T61 spec §2): RouteCandidateV1 is swap-shaped
// (expectedOutput / minimumOutput / priceImpact / slippage — meaningless for a
// deposit) and OptimizationModeV1 has no `best_net_yield` / `highest_liquidity`
// member. Earn therefore gets its own intent / candidate / evidence / score /
// route-card shapes here. The goal-agnostic execution + proof layers
// (ExecutionBlueprintV1, RouteProofV1) are reused unchanged.
//
// APY is ALWAYS integer basis points — never floating point (spec §3).
// ---------------------------------------------------------------------------

function addHashIssue(ctx: z.RefinementCtx, path: string, label: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: `${label} does not match the canonical V1 financial payload`,
  });
}

export const EarnOptimizationModeV1Schema = z.enum([
  'best_net_yield',
  'highest_liquidity',
  'simplest_route',
  'lowest_risk',
]);
export type EarnOptimizationModeV1 = z.infer<typeof EarnOptimizationModeV1Schema>;

export const EarnProtocolV1Schema = z.enum(['moonwell', 'morpho']);
export type EarnProtocolV1 = z.infer<typeof EarnProtocolV1Schema>;

export const EarnVenueKindV1Schema = z.enum(['moonwell_market', 'morpho_vault']);
export type EarnVenueKindV1 = z.infer<typeof EarnVenueKindV1Schema>;

/** Moonwell supply → redeem the mToken directly (`direct`); Morpho ERC-4626
 * vault → redeem shares (`vault_redeem`). Surfaced to the user verbatim. */
export const WithdrawalModelV1Schema = z.enum(['direct', 'vault_redeem']);
export type WithdrawalModelV1 = z.infer<typeof WithdrawalModelV1Schema>;

/** APY in integer basis points, or null when the datum is unknown/unavailable.
 * Integer only — floating-point APY is forbidden (spec §3). 1_000_000 bps
 * (10_000%) ceiling rejects absurd/garbage upstream values. */
const ApyBpsV1Schema = z.number().int().min(0).max(1_000_000).nullable();

export const EarnVenueRefV1Schema = z
  .object({
    kind: EarnVenueKindV1Schema,
    protocol: EarnProtocolV1Schema,
    /** The pinned deposit target (mToken market / ERC-4626 vault). */
    address: AddressV1Schema,
    identifier: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedKind = value.protocol === 'moonwell' ? 'moonwell_market' : 'morpho_vault';
    if (value.kind !== expectedKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: `Venue kind must be ${expectedKind} for protocol ${value.protocol}`,
      });
    }
  });
export type EarnVenueRefV1 = z.infer<typeof EarnVenueRefV1Schema>;

export const EarnContractSetV1Schema = z
  .object({
    /** Canonical USDC on Base. */
    asset: AddressV1Schema,
    /** The mToken market / ERC-4626 vault the USDC is deposited into. */
    target: AddressV1Schema,
    /** Recipient of the EXACT USDC approval (never unlimited). */
    approvalSpender: AddressV1Schema,
  })
  .strict();
export type EarnContractSetV1 = z.infer<typeof EarnContractSetV1Schema>;

// --- Earn intent -----------------------------------------------------------

const EarnRouteIntentV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'earn-route-intent/v1',
      z.enum(['draft', 'ready', 'needs_clarification', 'rejected']),
    ),
    intentHash: HashV1Schema,
    goal: z.literal('earn'),
    asset: AssetRefV1Schema,
    amount: TokenAmountV1Schema,
    optimizationMode: EarnOptimizationModeV1Schema,
    verificationDepth: VerificationDepthV1Schema,
    protocolConstraint: ProtocolConstraintV1Schema,
    executionRequested: z.boolean(),
  })
  .strict();

export type EarnRouteIntentV1 = z.infer<typeof EarnRouteIntentV1ObjectSchema>;

export function hashEarnRouteIntentV1(value: EarnRouteIntentV1): HashV1 {
  return stableHashV1('earn-route-intent/v1', financialContentV1(value, ['intentHash']));
}

export const EarnRouteIntentV1Schema = EarnRouteIntentV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.intentHash !== hashEarnRouteIntentV1(value)) addHashIssue(ctx, 'intentHash', 'intentHash');
  if (value.asset.chainId !== value.chainId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['asset', 'chainId'],
      message: 'Earn asset chain must match intent chain',
    });
  }
  if (value.amount.asset.assetId !== value.asset.assetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amount', 'asset'],
      message: 'Earn amount asset must match the earn asset',
    });
  }
  if (value.amount.asset.chainId !== value.chainId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amount', 'asset', 'chainId'],
      message: 'Amount asset chain must match intent chain',
    });
  }
});

// --- Earn candidate --------------------------------------------------------

const EarnCandidateV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'earn-candidate/v1',
      z.enum(['quoted', 'selected', 'expired', 'invalid', 'rejected']),
    ),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    protocol: EarnProtocolV1Schema,
    venue: EarnVenueRefV1Schema,
    asset: AssetRefV1Schema,
    amount: TokenAmountV1Schema,
    baseApyBps: ApyBpsV1Schema,
    rewardApyBps: ApyBpsV1Schema,
    netApyBps: ApyBpsV1Schema,
    /** null = no liquidity datum → liquidity dimension is Not scored (spec §4). */
    availableLiquidityAtomic: AtomicAmountV1Schema.nullable(),
    withdrawalModel: WithdrawalModelV1Schema,
    estimatedGas: GasEstimateV1Schema,
    callCount: z.number().int().min(0).max(100),
    approvalCount: z.number().int().min(0).max(100),
    observedAt: TimestampV1Schema,
    expiresAt: TimestampV1Schema,
    contracts: EarnContractSetV1Schema,
    provider: ProviderRefV1Schema,
  })
  .strict();

export type EarnCandidateV1 = z.infer<typeof EarnCandidateV1ObjectSchema>;

export function hashEarnCandidateV1(value: EarnCandidateV1): HashV1 {
  return stableHashV1('earn-candidate/v1', financialContentV1(value, ['candidateHash']));
}

const EXPECTED_WITHDRAWAL_MODEL_V1: Record<EarnProtocolV1, WithdrawalModelV1> = {
  moonwell: 'direct',
  morpho: 'vault_redeem',
};

export const EarnCandidateV1Schema = EarnCandidateV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.candidateHash !== hashEarnCandidateV1(value)) addHashIssue(ctx, 'candidateHash', 'candidateHash');
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Candidate expiry must be later than its observation time',
    });
  }
  if (value.amount.asset.assetId !== value.asset.assetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amount', 'asset'],
      message: 'Candidate amount asset must match the earn asset',
    });
  }
  if (value.venue.protocol !== value.protocol) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['venue', 'protocol'],
      message: 'Venue protocol must match candidate protocol',
    });
  }
  if (value.venue.address !== value.contracts.target) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contracts', 'target'],
      message: 'Deposit target must equal the venue address',
    });
  }
  if (value.withdrawalModel !== EXPECTED_WITHDRAWAL_MODEL_V1[value.protocol]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['withdrawalModel'],
      message: `Withdrawal model must be ${EXPECTED_WITHDRAWAL_MODEL_V1[value.protocol]} for ${value.protocol}`,
    });
  }
  // An ERC-20 deposit always needs exactly one approval + at least one action.
  if (value.approvalCount < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['approvalCount'],
      message: 'An ERC-20 deposit requires at least one approval',
    });
  }
  if (value.callCount < value.approvalCount + 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['callCount'],
      message: 'Call count must cover every approval plus the deposit action',
    });
  }
  // Never claim net yield above base + reward (no invented yield).
  if (value.netApyBps !== null && value.baseApyBps !== null) {
    const rewards = value.rewardApyBps ?? 0;
    if (value.netApyBps > value.baseApyBps + rewards) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['netApyBps'],
        message: 'Net APY cannot exceed base plus reward APY',
      });
    }
  }
});

// --- Earn evidence ---------------------------------------------------------

export const EarnEvidenceKindV1Schema = z.enum([
  'yield_rate',
  'liquidity',
  'fees',
  'withdrawal_terms',
  'market_identity',
  'contract_risk',
]);
export type EarnEvidenceKindV1 = z.infer<typeof EarnEvidenceKindV1Schema>;

export const EarnWithdrawalTermsV1Schema = z
  .object({
    model: WithdrawalModelV1Schema,
    instant: z.boolean(),
    noticePeriodSeconds: z.number().int().min(0).nullable(),
  })
  .strict();
export type EarnWithdrawalTermsV1 = z.infer<typeof EarnWithdrawalTermsV1Schema>;

export const EarnFeeTermsV1Schema = z
  .object({
    performanceFeeBps: z.number().int().min(0).max(1_000_000).nullable(),
    managementFeeBps: z.number().int().min(0).max(1_000_000).nullable(),
  })
  .strict();
export type EarnFeeTermsV1 = z.infer<typeof EarnFeeTermsV1Schema>;

const EarnEvidenceV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('earn-evidence/v1', z.enum(['fresh', 'stale', 'invalid'])),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceHash: HashV1Schema,
    protocol: EarnProtocolV1Schema,
    venue: EarnVenueRefV1Schema,
    provider: ProviderRefV1Schema,
    baseApyBps: ApyBpsV1Schema,
    rewardApyBps: ApyBpsV1Schema,
    netApyBps: ApyBpsV1Schema,
    availableLiquidityAtomic: AtomicAmountV1Schema.nullable(),
    fees: EarnFeeTermsV1Schema,
    withdrawalTerms: EarnWithdrawalTermsV1Schema,
    contracts: EarnContractSetV1Schema,
    blockNumber: AtomicAmountV1Schema.nullable(),
    observedAt: TimestampV1Schema,
    expiresAt: TimestampV1Schema,
    requestHash: HashV1Schema,
    responseHash: HashV1Schema,
    /** Two different brands (Moonwell vs Morpho) are NOT independent risk
     * confirmations by themselves (spec §4) — the engine sets this, never the
     * brand count. */
    sourceIndependence: z.enum(['independent', 'overlapping', 'unknown']),
  })
  .strict();

export type EarnEvidenceV1 = z.infer<typeof EarnEvidenceV1ObjectSchema>;

export function hashEarnEvidenceV1(value: EarnEvidenceV1): HashV1 {
  return stableHashV1('earn-evidence/v1', financialContentV1(value, ['evidenceHash']));
}

export const EarnEvidenceV1Schema = EarnEvidenceV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.evidenceHash !== hashEarnEvidenceV1(value)) addHashIssue(ctx, 'evidenceHash', 'evidenceHash');
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Evidence expiry must be later than its observation time',
    });
  }
});

// --- Earn score (mirrors PathScore: 4 dimensions, no overall score, §5) -----

export const EarnScoreDimensionNameV1Schema = z.enum([
  'net_yield',
  'liquidity',
  'route_simplicity',
  'transaction_safety',
]);
export type EarnScoreDimensionNameV1 = z.infer<typeof EarnScoreDimensionNameV1Schema>;

export const EARN_SCORE_DIMENSION_ORDER_V1: readonly EarnScoreDimensionNameV1[] = [
  'net_yield',
  'liquidity',
  'route_simplicity',
  'transaction_safety',
];

const EarnScoreDimensionV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('earn-score-dimension/v1', z.enum(['scored', 'not_scored'])),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    dimensionHash: HashV1Schema,
    dimension: EarnScoreDimensionNameV1Schema,
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
    missingEvidence: z.array(EarnEvidenceKindV1Schema),
  })
  .strict();

export type EarnScoreDimensionV1 = z.infer<typeof EarnScoreDimensionV1ObjectSchema>;

export function hashEarnScoreDimensionV1(value: EarnScoreDimensionV1): HashV1 {
  return stableHashV1('earn-score-dimension/v1', financialContentV1(value, ['dimensionHash']));
}

export const EarnScoreDimensionV1Schema = EarnScoreDimensionV1ObjectSchema.superRefine(
  (value, ctx) => {
    validateFinancialChronologyV1(value, ctx);
    if (value.dimensionHash !== hashEarnScoreDimensionV1(value)) {
      addHashIssue(ctx, 'dimensionHash', 'dimensionHash');
    }
    if (value.status === 'not_scored') {
      if (value.score !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['score'], message: 'Not scored dimensions must use score=null' });
      }
      if (value.confidence !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confidence'], message: 'Not scored dimensions must use confidence=null' });
      }
      if (value.freshness !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['freshness'], message: 'Not scored dimensions must use freshness=null' });
      }
      if (value.sources.length !== 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'Not scored dimensions must not claim evidence sources' });
      }
      if (value.notScoredReason === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notScoredReason'], message: 'Not scored dimensions require an explicit reason' });
      }
      if (value.notScoredReason === 'insufficient_evidence' && value.missingEvidence.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['missingEvidence'], message: 'Insufficient evidence requires missingEvidence' });
      }
      return;
    }
    if (value.notScoredReason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notScoredReason'], message: 'Scored dimensions must use notScoredReason=null' });
    }
    if (value.score === null || value.confidence === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['score'], message: 'Scored dimensions require score and confidence' });
    }
    if (value.sources.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'Scored dimensions require evidence sources' });
    }
    if (value.freshness === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['freshness'], message: 'Scored dimensions require freshness' });
    }
    if (value.missingEvidence.length !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['missingEvidence'], message: 'Scored dimensions cannot claim missing evidence' });
    }
  },
);

const EarnScoreV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('earn-score/v1', z.enum(['scored', 'partially_scored', 'not_scored'])),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    earnScoreHash: HashV1Schema,
    scoringVersion: z.string().min(1).max(120),
    dimensions: z.array(EarnScoreDimensionV1Schema).length(4),
  })
  .strict();

export type EarnScoreV1 = z.infer<typeof EarnScoreV1ObjectSchema>;

export function hashEarnScoreV1(value: EarnScoreV1): HashV1 {
  const content = financialContentV1(value, ['earnScoreHash', 'dimensions']);
  return stableHashV1('earn-score/v1', {
    ...content,
    dimensionHashes: value.dimensions.map((dimension) => dimension.dimensionHash),
  });
}

export const EarnScoreV1Schema = EarnScoreV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.earnScoreHash !== hashEarnScoreV1(value)) addHashIssue(ctx, 'earnScoreHash', 'earnScoreHash');
  const actualOrder = value.dimensions.map((dimension) => dimension.dimension);
  if (JSON.stringify(actualOrder) !== JSON.stringify(EARN_SCORE_DIMENSION_ORDER_V1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dimensions'],
      message: 'Earn Score dimensions must use the canonical V1 order',
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
        message: 'Earn Score dimension linkage must match its parent score',
      });
    }
    if (dimension.scoringVersion !== value.scoringVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions', index, 'scoringVersion'],
        message: 'Earn Score dimension scoringVersion must match its parent score',
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
      message: `Earn Score status must be ${expectedStatus}`,
    });
  }
});

// --- Earn Route Card (comparison of candidates, §6) ------------------------

export const EarnApyCompositionV1Schema = z
  .object({
    baseApyBps: ApyBpsV1Schema,
    rewardApyBps: ApyBpsV1Schema,
    netApyBps: ApyBpsV1Schema,
  })
  .strict();
export type EarnApyCompositionV1 = z.infer<typeof EarnApyCompositionV1Schema>;

export const EarnLiquidityStateV1Schema = z.enum(['high', 'medium', 'low', 'not_scored']);
export type EarnLiquidityStateV1 = z.infer<typeof EarnLiquidityStateV1Schema>;

export const EarnCandidateComparisonV1Schema = z
  .object({
    candidate: EarnCandidateV1Schema,
    score: EarnScoreV1Schema,
    apyComposition: EarnApyCompositionV1Schema,
    liquidityState: EarnLiquidityStateV1Schema,
    freshnessState: z.enum(['fresh', 'stale', 'unknown']),
    missingEvidence: z.array(EarnEvidenceKindV1Schema),
  })
  .strict();
export type EarnCandidateComparisonV1 = z.infer<typeof EarnCandidateComparisonV1Schema>;

const EarnRouteCardV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'earn-route-card/v1',
      z.enum(['ready', 'degraded', 'selected', 'stale', 'invalid']),
    ),
    intentHash: HashV1Schema,
    routeCardHash: HashV1Schema,
    optimizationMode: EarnOptimizationModeV1Schema,
    amount: TokenAmountV1Schema,
    /** null ⟺ honest degraded state (no recommendation, e.g. lowest_risk with
     * no risk evidence). */
    recommendedCandidateHash: HashV1Schema.nullable(),
    recommendationReason: z.string().min(1).max(2_000).nullable(),
    degradedReason: z.string().min(1).max(2_000).nullable(),
    comparisons: z.array(EarnCandidateComparisonV1Schema).min(1),
    expiresAt: TimestampV1Schema,
  })
  .strict();

export type EarnRouteCardV1 = z.infer<typeof EarnRouteCardV1ObjectSchema>;

export function hashEarnRouteCardV1(value: EarnRouteCardV1): HashV1 {
  const content = financialContentV1(value, ['routeCardHash', 'comparisons']);
  return stableHashV1('earn-route-card/v1', {
    ...content,
    comparisonCandidateHashes: value.comparisons.map((entry) => entry.candidate.candidateHash),
    comparisonScoreHashes: value.comparisons.map((entry) => entry.score.earnScoreHash),
  });
}

export const EarnRouteCardV1Schema = EarnRouteCardV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.routeCardHash !== hashEarnRouteCardV1(value)) addHashIssue(ctx, 'routeCardHash', 'routeCardHash');
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Earn Route Card expiry must be later than its creation time',
    });
  }

  const isDegraded = value.status === 'degraded';
  if (isDegraded) {
    if (value.recommendedCandidateHash !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedCandidateHash'], message: 'A degraded Earn Route Card must not recommend a candidate' });
    }
    if (value.recommendationReason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendationReason'], message: 'A degraded Earn Route Card must not carry a recommendation reason' });
    }
    if (value.degradedReason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['degradedReason'], message: 'A degraded Earn Route Card requires a degradedReason' });
    }
  } else {
    if (value.recommendedCandidateHash === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedCandidateHash'], message: 'A non-degraded Earn Route Card must recommend a candidate' });
    }
    if (value.recommendationReason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendationReason'], message: 'A non-degraded Earn Route Card requires a recommendation reason' });
    }
    if (value.degradedReason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['degradedReason'], message: 'Only a degraded Earn Route Card may carry a degradedReason' });
    }
  }

  const comparisonHashes = new Set<string>();
  let recommendedFound = false;
  for (const [index, entry] of value.comparisons.entries()) {
    if (entry.candidate.intentHash !== value.intentHash || entry.candidate.chainId !== value.chainId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparisons', index], message: 'Comparison candidate must match Route Card intent and chain' });
    }
    if (entry.score.candidateHash !== entry.candidate.candidateHash || entry.score.intentHash !== value.intentHash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparisons', index, 'score'], message: 'Comparison score must be bound to its candidate and intent' });
    }
    if (comparisonHashes.has(entry.candidate.candidateHash)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparisons', index, 'candidate'], message: 'Comparison candidate hashes must be unique' });
    }
    comparisonHashes.add(entry.candidate.candidateHash);
    if (value.recommendedCandidateHash !== null && entry.candidate.candidateHash === value.recommendedCandidateHash) {
      recommendedFound = true;
    }
  }
  if (value.recommendedCandidateHash !== null && !recommendedFound) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedCandidateHash'], message: 'Recommended candidate must appear among the comparisons' });
  }
});

export const EarnDomainSchemasV1 = {
  EarnRouteIntentV1Schema,
  EarnCandidateV1Schema,
  EarnEvidenceV1Schema,
  EarnScoreDimensionV1Schema,
  EarnScoreV1Schema,
  EarnRouteCardV1Schema,
} as const;
