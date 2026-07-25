import { z } from 'zod';
import { financialContentV1, stableHashV1, type HashV1 } from './hashing.js';
import {
  AddressV1Schema,
  AssetRefV1Schema,
  AtomicAmountV1Schema,
  DecimalAmountV1Schema,
  HashV1Schema,
  ProviderRefV1Schema,
  TimestampV1Schema,
  TokenAmountV1Schema,
  financialEntityFieldsV1,
  validateFinancialChronologyV1,
} from './primitives.js';
import {
  EvidenceSourceLinkV1Schema,
  ScoreConfidenceV1Schema,
  ScoreFreshnessV1Schema,
} from './score-contracts.js';

// ---------------------------------------------------------------------------
// T64 — Commerce contract family (Bitrefill).
//
// A third DELIBERATELY SEPARATE family, for the same reason Earn was split from
// Swap (T61 §2): a gift card has no expectedOutput / priceImpact / slippage and
// no APY / withdrawal model. It has a product, a country, a currency, an exact
// denomination, an exact price with fees, an availability, and — uniquely — an
// ORDER that has to be created and a DIGITAL GOOD that has to be delivered.
//
// Two rules distinguish this family from every other one in the product:
//
//   1. PAYMENT IS NOT A CALL BATCH. Bitrefill settles through x402 (an
//      EIP-3009 authorization the USER signs), not through an EIP-5792 batch,
//      so Commerce does NOT reuse ExecutionBlueprintV1. Modelling it as a
//      Blueprint would claim `calls` the wallet never executes. What the user
//      reviews and signs instead is CommercePaymentRequirementsV1 below: exact
//      asset, exact recipient, exact ceiling, exact expiry.
//
//   2. A PAID TRANSACTION IS NOT A PROOF. CommerceRouteProofV1 carries three
//      independent legs — payment, order, delivery — and `finalStatus:
//      'delivered'` is unreachable unless all three are confirmed. A settled
//      payment with no confirmed order is `order_unconfirmed`, which is a
//      RECONCILIATION state, never a success.
//
// Redemption codes, PINs, and eSIM QR URLs are bearer credentials. They appear
// in NO schema in this file, are never hashed, and are never persisted — the
// contracts carry delivery COUNTS and STATES only.
// ---------------------------------------------------------------------------

function addHashIssue(ctx: z.RefinementCtx, path: string, label: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: `${label} does not match the canonical V1 financial payload`,
  });
}

/** Unsigned base-10 comparison for atomic amounts (strings, never Number). */
function atomicCompareV1(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export const CommerceProviderV1Schema = z.enum(['bitrefill']);
export type CommerceProviderV1 = z.infer<typeof CommerceProviderV1Schema>;

export const CommerceProductKindV1Schema = z.enum(['gift_card', 'esim', 'topup']);
export type CommerceProductKindV1 = z.infer<typeof CommerceProductKindV1Schema>;

/** How the purchased good reaches the buyer. One model per kind — a gift card
 * is a code, an eSIM is a profile, a top-up is a carrier credit. */
export const CommerceDeliveryModelV1Schema = z.enum(['digital_code', 'esim_profile', 'carrier_topup']);
export type CommerceDeliveryModelV1 = z.infer<typeof CommerceDeliveryModelV1Schema>;

export const COMMERCE_DELIVERY_MODEL_BY_KIND_V1: Record<CommerceProductKindV1, CommerceDeliveryModelV1> = {
  gift_card: 'digital_code',
  esim: 'esim_profile',
  topup: 'carrier_topup',
};

/** `unknown` is a first-class value: a provider that does not report stock is
 * NOT reported as in stock, and the availability dimension goes Not scored. */
export const CommerceAvailabilityV1Schema = z.enum(['in_stock', 'out_of_stock', 'unknown']);
export type CommerceAvailabilityV1 = z.infer<typeof CommerceAvailabilityV1Schema>;

/** ISO-3166-1 alpha-2, uppercase. */
export const CommerceCountryCodeV1Schema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Expected an uppercase ISO-3166-1 alpha-2 country code');
export type CommerceCountryCodeV1 = z.infer<typeof CommerceCountryCodeV1Schema>;

/** ISO-4217, uppercase. */
export const CommerceCurrencyCodeV1Schema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Expected an uppercase ISO-4217 currency code');
export type CommerceCurrencyCodeV1 = z.infer<typeof CommerceCurrencyCodeV1Schema>;

export const CommerceFiatPriceV1Schema = z
  .object({
    amountDecimal: DecimalAmountV1Schema,
    currency: CommerceCurrencyCodeV1Schema,
  })
  .strict();
export type CommerceFiatPriceV1 = z.infer<typeof CommerceFiatPriceV1Schema>;

/**
 * A product + denomination as the provider itself identifies it.
 *
 * `packageValue` is the provider's EXACT string ("10", "25", "1GB, 7 Days").
 * It is never parsed into a number and never reformatted: a transformed
 * package value is rejected by the provider at order creation, so the only
 * safe representation is the verbatim one.
 */
export const CommerceProductRefV1Schema = z
  .object({
    provider: CommerceProviderV1Schema,
    /** The provider's own product identifier (Bitrefill slug, e.g. `steam-usa`). */
    productId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    kind: CommerceProductKindV1Schema,
    country: CommerceCountryCodeV1Schema,
    currency: CommerceCurrencyCodeV1Schema,
    packageValue: z.string().min(1).max(80),
    /**
     * T64.2.1: the provider's fixed-denomination package id (`steam-usa<&>5`).
     * A FIXED denomination must be ordered by this id — `packageValue` is the
     * field for range-priced products, and sending it for a fixed one is not
     * the documented contract. Additive and optional so a pre-T64.2.1
     * candidate still parses; when it is absent the order falls back to the
     * value, which is what a range product needs anyway.
     */
    packageId: z.string().min(1).max(300).nullable().default(null),
    /** Top-ups need a phone/account identifier; gift cards must not ask for one. */
    recipientRequired: z.boolean(),
  })
  .strict();
export type CommerceProductRefV1 = z.infer<typeof CommerceProductRefV1Schema>;

// --- Commerce intent -------------------------------------------------------

export const CommerceOptimizationModeV1Schema = z.enum([
  'exact_denomination',
  'lowest_total_cost',
  'fastest_delivery',
]);
export type CommerceOptimizationModeV1 = z.infer<typeof CommerceOptimizationModeV1Schema>;

const CommerceRouteIntentV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'commerce-route-intent/v1',
      z.enum(['draft', 'ready', 'needs_clarification', 'rejected']),
    ),
    intentHash: HashV1Schema,
    goal: z.literal('commerce'),
    /** The brand/product text the user asked for, e.g. "Steam". */
    query: z.string().min(1).max(200),
    kind: CommerceProductKindV1Schema,
    country: CommerceCountryCodeV1Schema,
    requestedValue: CommerceFiatPriceV1Schema,
    /** Settlement asset — canonical USDC on Base in V1. */
    paymentAsset: AssetRefV1Schema,
    /** Hard ceiling on what may ever be charged for this intent. */
    maxSpendAtomic: AtomicAmountV1Schema,
    /** Phone/account for a top-up; null for anything that needs no recipient. */
    recipientInput: z.string().min(1).max(120).nullable(),
    optimizationMode: CommerceOptimizationModeV1Schema,
    executionRequested: z.boolean(),
  })
  .strict();

export type CommerceRouteIntentV1 = z.infer<typeof CommerceRouteIntentV1ObjectSchema>;

export function hashCommerceRouteIntentV1(value: CommerceRouteIntentV1): HashV1 {
  return stableHashV1('commerce-route-intent/v1', financialContentV1(value, ['intentHash']));
}

export const CommerceRouteIntentV1Schema = CommerceRouteIntentV1ObjectSchema.superRefine(
  (value, ctx) => {
    validateFinancialChronologyV1(value, ctx);
    if (value.intentHash !== hashCommerceRouteIntentV1(value)) {
      addHashIssue(ctx, 'intentHash', 'intentHash');
    }
    if (value.paymentAsset.chainId !== value.chainId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paymentAsset', 'chainId'],
        message: 'Commerce payment asset chain must match intent chain',
      });
    }
    if (atomicCompareV1(value.maxSpendAtomic, '0') <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxSpendAtomic'],
        message: 'A commerce intent requires a positive spend ceiling',
      });
    }
  },
);

// --- Price, fees, candidate ------------------------------------------------

/**
 * The total the buyer actually pays, decomposed. `providerFeeAtomic` /
 * `networkFeeAtomic` are nullable because an unreported fee must stay unknown
 * rather than being silently folded in as zero — but the TOTAL is never
 * inferred: it is the number the provider quoted, and it can never be below
 * the product price.
 */
export const CommerceFeeBreakdownV1Schema = z
  .object({
    productPriceAtomic: AtomicAmountV1Schema,
    providerFeeAtomic: AtomicAmountV1Schema.nullable(),
    networkFeeAtomic: AtomicAmountV1Schema.nullable(),
    totalAtomic: AtomicAmountV1Schema,
    /**
     * `exact_quote` — the provider quoted this settlement total itself.
     * `minimum`    — only the product price is known, so the real charge is
     *                AT LEAST this. A minimum can never be presented as the
     *                final price: the total-cost dimension goes Not scored and
     *                the exact number arrives with the checkout the user
     *                reviews before signing.
     */
    totalBasis: z.enum(['exact_quote', 'minimum']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (atomicCompareV1(value.totalAtomic, value.productPriceAtomic) < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalAtomic'],
        message: 'Total charge cannot be below the product price',
      });
    }
    if (value.providerFeeAtomic !== null && value.networkFeeAtomic !== null) {
      const expected =
        BigInt(value.productPriceAtomic) + BigInt(value.providerFeeAtomic) + BigInt(value.networkFeeAtomic);
      if (BigInt(value.totalAtomic) !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['totalAtomic'],
          message: 'Total must equal product price plus every reported fee',
        });
      }
    }
    // A minimum is by definition a total whose fees are unknown. Claiming a
    // fee AND calling the total a minimum is contradictory.
    if (value.totalBasis === 'minimum' && (value.providerFeeAtomic !== null || value.networkFeeAtomic !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalBasis'],
        message: 'A minimum total cannot also report its fees',
      });
    }
  });
export type CommerceFeeBreakdownV1 = z.infer<typeof CommerceFeeBreakdownV1Schema>;

/** The pinned settlement pair for a candidate: which token moves, and to whom.
 * Both are re-checked against the pinned commerce config before any review. */
export const CommercePaymentTargetV1Schema = z
  .object({
    asset: AddressV1Schema,
    payTo: AddressV1Schema,
  })
  .strict();
export type CommercePaymentTargetV1 = z.infer<typeof CommercePaymentTargetV1Schema>;

const CommerceCandidateV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'commerce-candidate/v1',
      z.enum(['quoted', 'selected', 'expired', 'invalid', 'rejected']),
    ),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    product: CommerceProductRefV1Schema,
    /** The denomination in the product's own currency, exactly as quoted. */
    fiatPrice: CommerceFiatPriceV1Schema,
    /** What the buyer pays, in the settlement asset. */
    payment: TokenAmountV1Schema,
    fees: CommerceFeeBreakdownV1Schema,
    availability: CommerceAvailabilityV1Schema,
    deliveryModel: CommerceDeliveryModelV1Schema,
    recipientRequired: z.boolean(),
    paymentTarget: CommercePaymentTargetV1Schema,
    observedAt: TimestampV1Schema,
    expiresAt: TimestampV1Schema,
    provider: ProviderRefV1Schema,
  })
  .strict();

export type CommerceCandidateV1 = z.infer<typeof CommerceCandidateV1ObjectSchema>;

export function hashCommerceCandidateV1(value: CommerceCandidateV1): HashV1 {
  return stableHashV1('commerce-candidate/v1', financialContentV1(value, ['candidateHash']));
}

export const CommerceCandidateV1Schema = CommerceCandidateV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.candidateHash !== hashCommerceCandidateV1(value)) {
    addHashIssue(ctx, 'candidateHash', 'candidateHash');
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Candidate expiry must be later than its observation time',
    });
  }
  if (value.payment.asset.chainId !== value.chainId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payment', 'asset', 'chainId'],
      message: 'Candidate payment asset chain must match candidate chain',
    });
  }
  if (value.payment.asset.address !== value.paymentTarget.asset) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['paymentTarget', 'asset'],
      message: 'Payment target asset must equal the settlement asset',
    });
  }
  // The charge shown to the user IS the total — no separate "plus fees at
  // checkout" number can exist behind it.
  if (value.payment.amountAtomic !== value.fees.totalAtomic) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payment', 'amountAtomic'],
      message: 'Payment amount must equal the total charge',
    });
  }
  if (value.fiatPrice.currency !== value.product.currency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fiatPrice', 'currency'],
      message: 'Quoted price currency must match the product currency',
    });
  }
  if (value.recipientRequired !== value.product.recipientRequired) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recipientRequired'],
      message: 'Candidate recipient requirement must match the product',
    });
  }
  const expectedDelivery = COMMERCE_DELIVERY_MODEL_BY_KIND_V1[value.product.kind];
  if (value.deliveryModel !== expectedDelivery) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryModel'],
      message: `Delivery model must be ${expectedDelivery} for ${value.product.kind}`,
    });
  }
  // An out-of-stock product is allowed to exist as a VISIBLE candidate (the
  // console never hides a route), but it can never be `selected`.
  if (value.status === 'selected' && value.availability !== 'in_stock') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'Only an in-stock candidate can be selected',
    });
  }
});

// --- Commerce evidence -----------------------------------------------------

export const CommerceEvidenceKindV1Schema = z.enum([
  'price',
  'fees',
  'availability',
  'delivery_terms',
  'product_identity',
]);
export type CommerceEvidenceKindV1 = z.infer<typeof CommerceEvidenceKindV1Schema>;

const CommerceEvidenceV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('commerce-evidence/v1', z.enum(['fresh', 'stale', 'invalid'])),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceHash: HashV1Schema,
    provider: ProviderRefV1Schema,
    /** Provider PATH only. A full URL is rejected so a query string carrying a
     * token, a session id, or a wallet address can never enter the evidence. */
    endpoint: z
      .string()
      .regex(/^\/[A-Za-z0-9/_-]{1,200}$/, 'Evidence endpoint must be a bare provider path'),
    product: CommerceProductRefV1Schema,
    fiatPrice: CommerceFiatPriceV1Schema,
    fees: CommerceFeeBreakdownV1Schema,
    availability: CommerceAvailabilityV1Schema,
    observedAt: TimestampV1Schema,
    expiresAt: TimestampV1Schema,
    requestHash: HashV1Schema,
    responseHash: HashV1Schema,
    /** One storefront is one source. Two products from the same catalogue are
     * NOT independent confirmations, and the engine says so here. */
    sourceIndependence: z.enum(['independent', 'overlapping', 'unknown']),
  })
  .strict();

export type CommerceEvidenceV1 = z.infer<typeof CommerceEvidenceV1ObjectSchema>;

export function hashCommerceEvidenceV1(value: CommerceEvidenceV1): HashV1 {
  return stableHashV1('commerce-evidence/v1', financialContentV1(value, ['evidenceHash']));
}

export const CommerceEvidenceV1Schema = CommerceEvidenceV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.evidenceHash !== hashCommerceEvidenceV1(value)) {
    addHashIssue(ctx, 'evidenceHash', 'evidenceHash');
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Evidence expiry must be later than its observation time',
    });
  }
});

// --- Commerce score (4 dimensions, no overall score) -----------------------

export const CommerceScoreDimensionNameV1Schema = z.enum([
  'denomination_match',
  'total_cost',
  'availability',
  'delivery_certainty',
]);
export type CommerceScoreDimensionNameV1 = z.infer<typeof CommerceScoreDimensionNameV1Schema>;

export const COMMERCE_SCORE_DIMENSION_ORDER_V1: readonly CommerceScoreDimensionNameV1[] = [
  'denomination_match',
  'total_cost',
  'availability',
  'delivery_certainty',
];

const CommerceScoreDimensionV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('commerce-score-dimension/v1', z.enum(['scored', 'not_scored'])),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    dimensionHash: HashV1Schema,
    dimension: CommerceScoreDimensionNameV1Schema,
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
    missingEvidence: z.array(CommerceEvidenceKindV1Schema),
  })
  .strict();

export type CommerceScoreDimensionV1 = z.infer<typeof CommerceScoreDimensionV1ObjectSchema>;

export function hashCommerceScoreDimensionV1(value: CommerceScoreDimensionV1): HashV1 {
  return stableHashV1('commerce-score-dimension/v1', financialContentV1(value, ['dimensionHash']));
}

export const CommerceScoreDimensionV1Schema = CommerceScoreDimensionV1ObjectSchema.superRefine(
  (value, ctx) => {
    validateFinancialChronologyV1(value, ctx);
    if (value.dimensionHash !== hashCommerceScoreDimensionV1(value)) {
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

const CommerceScoreV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('commerce-score/v1', z.enum(['scored', 'partially_scored', 'not_scored'])),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    commerceScoreHash: HashV1Schema,
    scoringVersion: z.string().min(1).max(120),
    dimensions: z.array(CommerceScoreDimensionV1Schema).length(4),
  })
  .strict();

export type CommerceScoreV1 = z.infer<typeof CommerceScoreV1ObjectSchema>;

export function hashCommerceScoreV1(value: CommerceScoreV1): HashV1 {
  const content = financialContentV1(value, ['commerceScoreHash', 'dimensions']);
  return stableHashV1('commerce-score/v1', {
    ...content,
    dimensionHashes: value.dimensions.map((dimension) => dimension.dimensionHash),
  });
}

export const CommerceScoreV1Schema = CommerceScoreV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.commerceScoreHash !== hashCommerceScoreV1(value)) {
    addHashIssue(ctx, 'commerceScoreHash', 'commerceScoreHash');
  }
  const actualOrder = value.dimensions.map((dimension) => dimension.dimension);
  if (JSON.stringify(actualOrder) !== JSON.stringify(COMMERCE_SCORE_DIMENSION_ORDER_V1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dimensions'],
      message: 'Commerce Score dimensions must use the canonical V1 order',
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
        message: 'Commerce Score dimension linkage must match its parent score',
      });
    }
    if (dimension.scoringVersion !== value.scoringVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions', index, 'scoringVersion'],
        message: 'Commerce Score dimension scoringVersion must match its parent score',
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
      message: `Commerce Score status must be ${expectedStatus}`,
    });
  }
});

// --- Commerce Route Card ---------------------------------------------------

export const CommerceCandidateComparisonV1Schema = z
  .object({
    candidate: CommerceCandidateV1Schema,
    score: CommerceScoreV1Schema,
    /** Requested vs offered denomination, so "closest available" is visible. */
    denominationDelta: z
      .object({
        requestedDecimal: DecimalAmountV1Schema,
        offeredDecimal: DecimalAmountV1Schema,
        exact: z.boolean(),
      })
      .strict(),
    availability: CommerceAvailabilityV1Schema,
    freshnessState: z.enum(['fresh', 'stale', 'unknown']),
    missingEvidence: z.array(CommerceEvidenceKindV1Schema),
  })
  .strict();
export type CommerceCandidateComparisonV1 = z.infer<typeof CommerceCandidateComparisonV1Schema>;

const CommerceRouteCardV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'commerce-route-card/v1',
      z.enum(['ready', 'degraded', 'selected', 'stale', 'invalid']),
    ),
    intentHash: HashV1Schema,
    routeCardHash: HashV1Schema,
    optimizationMode: CommerceOptimizationModeV1Schema,
    requestedValue: CommerceFiatPriceV1Schema,
    recommendedCandidateHash: HashV1Schema.nullable(),
    recommendationReason: z.string().min(1).max(2_000).nullable(),
    degradedReason: z.string().min(1).max(2_000).nullable(),
    comparisons: z.array(CommerceCandidateComparisonV1Schema).min(1),
    expiresAt: TimestampV1Schema,
  })
  .strict();

export type CommerceRouteCardV1 = z.infer<typeof CommerceRouteCardV1ObjectSchema>;

export function hashCommerceRouteCardV1(value: CommerceRouteCardV1): HashV1 {
  const content = financialContentV1(value, ['routeCardHash', 'comparisons']);
  return stableHashV1('commerce-route-card/v1', {
    ...content,
    comparisonCandidateHashes: value.comparisons.map((entry) => entry.candidate.candidateHash),
    comparisonScoreHashes: value.comparisons.map((entry) => entry.score.commerceScoreHash),
  });
}

export const CommerceRouteCardV1Schema = CommerceRouteCardV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.routeCardHash !== hashCommerceRouteCardV1(value)) {
    addHashIssue(ctx, 'routeCardHash', 'routeCardHash');
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Commerce Route Card expiry must be later than its creation time',
    });
  }

  if (value.status === 'degraded') {
    if (value.recommendedCandidateHash !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedCandidateHash'], message: 'A degraded Commerce Route Card must not recommend a candidate' });
    }
    if (value.recommendationReason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendationReason'], message: 'A degraded Commerce Route Card must not carry a recommendation reason' });
    }
    if (value.degradedReason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['degradedReason'], message: 'A degraded Commerce Route Card requires a degradedReason' });
    }
  } else {
    if (value.recommendedCandidateHash === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedCandidateHash'], message: 'A non-degraded Commerce Route Card must recommend a candidate' });
    }
    if (value.recommendationReason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendationReason'], message: 'A non-degraded Commerce Route Card requires a recommendation reason' });
    }
    if (value.degradedReason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['degradedReason'], message: 'Only a degraded Commerce Route Card may carry a degradedReason' });
    }
  }

  const seen = new Set<string>();
  let recommendedFound = false;
  let recommendedInStock = false;
  for (const [index, entry] of value.comparisons.entries()) {
    if (entry.candidate.intentHash !== value.intentHash || entry.candidate.chainId !== value.chainId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparisons', index], message: 'Comparison candidate must match Route Card intent and chain' });
    }
    if (entry.score.candidateHash !== entry.candidate.candidateHash || entry.score.intentHash !== value.intentHash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparisons', index, 'score'], message: 'Comparison score must be bound to its candidate and intent' });
    }
    if (entry.availability !== entry.candidate.availability) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparisons', index, 'availability'], message: 'Comparison availability must match its candidate' });
    }
    if (seen.has(entry.candidate.candidateHash)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparisons', index, 'candidate'], message: 'Comparison candidate hashes must be unique' });
    }
    seen.add(entry.candidate.candidateHash);
    if (value.recommendedCandidateHash !== null && entry.candidate.candidateHash === value.recommendedCandidateHash) {
      recommendedFound = true;
      recommendedInStock = entry.candidate.availability === 'in_stock';
    }
  }
  if (value.recommendedCandidateHash !== null && !recommendedFound) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedCandidateHash'], message: 'Recommended candidate must appear among the comparisons' });
  }
  // Recommending something the storefront cannot sell is a lie the card must
  // not be able to express, even if the ranker somehow produced it.
  if (value.recommendedCandidateHash !== null && recommendedFound && !recommendedInStock) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedCandidateHash'], message: 'Only an in-stock candidate can be recommended' });
  }
});

// --- Payment review (what the user actually signs) -------------------------

export const CommercePaymentSchemeV1Schema = z.literal('exact');
export const CommercePaymentNetworkV1Schema = z.literal('eip155:8453');

/**
 * The x402 payment terms, restated as a reviewable object.
 *
 * This is Commerce's stand-in for an Execution Blueprint. It is NOT a call
 * batch: the wallet signs an EIP-3009 authorization bound to exactly this
 * asset, this recipient, this ceiling and this expiry. Everything here is
 * copied from the provider's own 402 envelope and then re-checked against the
 * pinned commerce config — the server never invents a recipient or an amount,
 * and a client-supplied value is never trusted.
 */
const CommercePaymentRequirementsV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('commerce-payment-requirements/v1'),
    requirementsHash: HashV1Schema,
    scheme: CommercePaymentSchemeV1Schema,
    network: CommercePaymentNetworkV1Schema,
    asset: AddressV1Schema,
    payTo: AddressV1Schema,
    maxAmountAtomic: AtomicAmountV1Schema,
    /** The exact provider route being paid for; the host is pinned. */
    resource: z.string().min(1).max(500),
    invoiceId: z.string().min(1).max(200),
    candidateHash: HashV1Schema,
    createdAt: TimestampV1Schema,
    expiresAt: TimestampV1Schema,
  })
  .strict();

export type CommercePaymentRequirementsV1 = z.infer<typeof CommercePaymentRequirementsV1ObjectSchema>;

export function hashCommercePaymentRequirementsV1(value: CommercePaymentRequirementsV1): HashV1 {
  return stableHashV1('commerce-payment-requirements/v1', financialContentV1(value, ['requirementsHash']));
}

export const CommercePaymentRequirementsV1Schema =
  CommercePaymentRequirementsV1ObjectSchema.superRefine((value, ctx) => {
    if (value.requirementsHash !== hashCommercePaymentRequirementsV1(value)) {
      addHashIssue(ctx, 'requirementsHash', 'requirementsHash');
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Payment requirements must expire after they are created',
      });
    }
    if (atomicCompareV1(value.maxAmountAtomic, '0') <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxAmountAtomic'],
        message: 'Payment requirements need a positive ceiling',
      });
    }
  });

// --- Order --------------------------------------------------------------

export const CommercePaymentStateV1Schema = z.enum([
  'not_started',
  'awaiting_signature',
  'submitted',
  'settled',
  'failed',
  'expired',
]);
export type CommercePaymentStateV1 = z.infer<typeof CommercePaymentStateV1Schema>;

export const CommerceDeliveryStateV1Schema = z.enum([
  'not_started',
  'pending',
  'partially_delivered',
  'all_delivered',
  'failed',
  'unknown',
]);
export type CommerceDeliveryStateV1 = z.infer<typeof CommerceDeliveryStateV1Schema>;

// --- Provider status + invoice (T64.2) -------------------------------------

/**
 * The reconciled provider state. A closed set: an unrecognised provider string
 * becomes `unknown`, which forces reconciliation rather than being read as
 * progress.
 *
 * The ordering of these names is NOT a promise that they happen in sequence.
 * The family's rule still holds — payment settled ≠ order confirmed ≠ product
 * delivered — and each is carried by its own proof leg.
 */
export const CommerceProviderStatusV1Schema = z.enum([
  'invoice_created',
  'payment_pending',
  'payment_settled',
  'order_confirmed',
  'delivery_pending',
  'delivered',
  'expired',
  'cancelled',
  'unknown',
]);
export type CommerceProviderStatusV1 = z.infer<typeof CommerceProviderStatusV1Schema>;

/**
 * The EXACT payment requirements, taken from a created invoice and nowhere
 * else.
 *
 * This is the only object in the family that may state a precise settlement
 * amount. The Route Card carries an ESTIMATED MINIMUM derived from the
 * catalogue; that estimate is never overwritten by this, and this is never
 * synthesised from that. Both are shown, labelled differently.
 */
const CommerceInvoiceV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('commerce-invoice/v1'),
    invoiceHash: HashV1Schema,
    invoiceId: z.string().min(1).max(200),
    provider: CommerceProviderV1Schema,
    network: CommercePaymentNetworkV1Schema,
    asset: AddressV1Schema,
    payTo: AddressV1Schema,
    /** The exact charge. Positive, and never a minimum. */
    amountAtomic: AtomicAmountV1Schema,
    /** Only when the provider states it explicitly. null = not reported. */
    providerFeeAtomic: AtomicAmountV1Schema.nullable(),
    /** Where a failed crypto payment returns — the authenticated wallet. */
    refundAddress: AddressV1Schema,
    /**
     * T64.2.1: how `payTo` was established.
     *
     * `pinned` — it equals the constant Miorail pins for this provider, the
     *   strongest guarantee: a redirected payment is impossible.
     * `invoice_scoped` — the provider issued a per-invoice deposit address, so
     *   it can only be checked for FORM (a valid address on the pinned rail),
     *   not against a constant. That is a genuinely weaker guarantee and it is
     *   recorded here so no surface can present it as a pinned one.
     */
    recipientPolicy: z.enum(['pinned', 'invoice_scoped']).default('pinned'),
    paymentStatus: CommercePaymentStateV1Schema,
    orderStatus: CommerceProviderStatusV1Schema,
    observedAt: TimestampV1Schema,
    expiresAt: TimestampV1Schema,
  })
  .strict();

export type CommerceInvoiceV1 = z.infer<typeof CommerceInvoiceV1ObjectSchema>;

export function hashCommerceInvoiceV1(value: CommerceInvoiceV1): HashV1 {
  return stableHashV1('commerce-invoice/v1', financialContentV1(value, ['invoiceHash']));
}

export const CommerceInvoiceV1Schema = CommerceInvoiceV1ObjectSchema.superRefine((value, ctx) => {
  if (value.invoiceHash !== hashCommerceInvoiceV1(value)) addHashIssue(ctx, 'invoiceHash', 'invoiceHash');
  if (atomicCompareV1(value.amountAtomic, '0') <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amountAtomic'],
      message: 'An invoice must state a positive exact amount',
    });
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Invoice expiry must be later than the moment it was observed',
    });
  }
});

/** What the catalogue estimated BEFORE any invoice existed. Kept alongside the
 * exact amount so the two are never confused for one another. */
export const CommerceEstimateV1Schema = z
  .object({
    totalAtomic: AtomicAmountV1Schema,
    totalBasis: z.enum(['exact_quote', 'minimum']),
  })
  .strict();
export type CommerceEstimateV1 = z.infer<typeof CommerceEstimateV1Schema>;

/** One durable, append-only step in an order's life. Carries states only —
 * never a redemption code, a PIN, or an eSIM URL. */
export const CommerceOrderEventV1Schema = z
  .object({
    schemaVersion: z.literal('commerce-order-event/v1'),
    invoiceId: z.string().min(1).max(200),
    status: CommerceProviderStatusV1Schema,
    paymentState: CommercePaymentStateV1Schema,
    deliveryState: CommerceDeliveryStateV1Schema,
    detail: z.string().min(1).max(300).nullable(),
    observedAt: TimestampV1Schema,
  })
  .strict();
export type CommerceOrderEventV1 = z.infer<typeof CommerceOrderEventV1Schema>;

export const CommerceOrderStatusV1Schema = z.enum([
  'created',
  'payment_pending',
  'payment_confirmed',
  'fulfilling',
  'delivered',
  'failed',
  'expired',
]);
export type CommerceOrderStatusV1 = z.infer<typeof CommerceOrderStatusV1Schema>;

/** One cart line. `orderId` stays null until the provider confirms the line
 * exists — an unconfirmed line can never count as delivered. */
export const CommerceOrderItemV1Schema = z
  .object({
    productId: z.string().min(1).max(200),
    packageValue: z.string().min(1).max(80),
    orderId: z.string().min(1).max(200).nullable(),
    deliveryState: CommerceDeliveryStateV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.orderId === null && value.deliveryState === 'all_delivered') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deliveryState'],
        message: 'An item with no confirmed order id cannot be delivered',
      });
    }
  });
export type CommerceOrderItemV1 = z.infer<typeof CommerceOrderItemV1Schema>;

const CommerceOrderV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('commerce-order/v1', CommerceOrderStatusV1Schema),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    orderHash: HashV1Schema,
    provider: CommerceProviderV1Schema,
    /** The provider's price-locked checkout id. */
    invoiceId: z.string().min(1).max(200),
    items: z.array(CommerceOrderItemV1Schema).min(1).max(20),
    amount: TokenAmountV1Schema,
    payTo: AddressV1Schema,
    paymentState: CommercePaymentStateV1Schema,
    deliveryState: CommerceDeliveryStateV1Schema,
    paymentTransactionHash: HashV1Schema.nullable(),
    expiresAt: TimestampV1Schema,
    // T64.2, additive and defaulted so a pre-T64.2 order still parses.
    /** The reconciled provider state, distinct from this order's own status. */
    providerStatus: CommerceProviderStatusV1Schema.default('invoice_created'),
    /** What the catalogue estimated before the invoice existed. Never replaced
     * by the exact amount — both are kept and shown separately. */
    estimate: CommerceEstimateV1Schema.nullable().default(null),
    /** The created invoice, once one exists. `null` while a checkout is
     * pending, which is what makes `invoice_creation_unknown` expressible. */
    invoice: CommerceInvoiceV1Schema.nullable().default(null),
  })
  .strict();

export type CommerceOrderV1 = z.infer<typeof CommerceOrderV1ObjectSchema>;

export function hashCommerceOrderV1(value: CommerceOrderV1): HashV1 {
  // `providerStatus` is a reconciliation tag and `invoice`/`estimate` are
  // observations that arrive after the order exists; excluding them keeps the
  // orderHash stable as the order is reconciled, which is what lets the proof
  // stay bound to it.
  return stableHashV1(
    'commerce-order/v1',
    financialContentV1(value, ['orderHash', 'providerStatus', 'estimate', 'invoice']),
  );
}

export const CommerceOrderV1Schema = CommerceOrderV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.orderHash !== hashCommerceOrderV1(value)) addHashIssue(ctx, 'orderHash', 'orderHash');
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Order expiry must be later than its creation time',
    });
  }
  if (value.amount.asset.chainId !== value.chainId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amount', 'asset', 'chainId'],
      message: 'Order amount asset chain must match order chain',
    });
  }
  // Nothing is delivered before it is paid for.
  const deliveryStarted = value.deliveryState !== 'not_started' && value.deliveryState !== 'unknown';
  if (deliveryStarted && value.paymentState !== 'settled') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryState'],
      message: 'Delivery cannot progress before the payment settles',
    });
  }
  if (value.paymentState === 'settled' && value.paymentTransactionHash === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['paymentTransactionHash'],
      message: 'A settled payment requires its transaction hash',
    });
  }
  if (value.status === 'payment_confirmed' && value.paymentState !== 'settled') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'payment_confirmed requires a settled payment',
    });
  }
  // THE rule of this family: a delivered order needs settled payment, a
  // confirmed provider order id on every line, and complete delivery.
  if (value.status === 'delivered') {
    if (value.paymentState !== 'settled') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'A delivered order requires a settled payment' });
    }
    if (value.deliveryState !== 'all_delivered') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deliveryState'], message: 'A delivered order requires all items delivered' });
    }
    if (value.items.some((item) => item.orderId === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'A delivered order requires a provider order id on every item' });
    }
  }
  if (value.deliveryState === 'all_delivered' && value.items.some((item) => item.deliveryState !== 'all_delivered')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryState'],
      message: 'all_delivered requires every item delivered',
    });
  }
});

// --- Commerce Route Proof --------------------------------------------------

export const COMMERCE_PROOF_FINAL_STATUSES_V1 = [
  'pending',
  'delivered',
  'partial_delivery',
  /** Money left the wallet, the provider order is NOT confirmed. Never a success. */
  'order_unconfirmed',
  'payment_failed',
  'failed',
  'reconciliation_required',
] as const;
export type CommerceProofFinalStatusV1 = (typeof COMMERCE_PROOF_FINAL_STATUSES_V1)[number];

export const CommercePaymentLegV1Schema = z
  .object({
    state: CommercePaymentStateV1Schema,
    transactionHash: HashV1Schema.nullable(),
    settledAt: TimestampV1Schema.nullable(),
    amountAtomic: AtomicAmountV1Schema,
    payTo: AddressV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'settled' && (value.transactionHash === null || value.settledAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'A settled payment leg requires a transaction hash and a settlement time',
      });
    }
  });
export type CommercePaymentLegV1 = z.infer<typeof CommercePaymentLegV1Schema>;

export const CommerceOrderLegV1Schema = z
  .object({
    state: z.enum(['not_created', 'created', 'confirmed', 'failed', 'unknown']),
    invoiceId: z.string().min(1).max(200).nullable(),
    orderIds: z.array(z.string().min(1).max(200)),
    confirmedAt: TimestampV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'confirmed') {
      if (value.invoiceId === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['invoiceId'], message: 'A confirmed order leg requires an invoice id' });
      }
      if (value.orderIds.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['orderIds'], message: 'A confirmed order leg requires at least one provider order id' });
      }
      if (value.confirmedAt === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmedAt'], message: 'A confirmed order leg requires a confirmation time' });
      }
    }
  });
export type CommerceOrderLegV1 = z.infer<typeof CommerceOrderLegV1Schema>;

export const CommerceDeliveryLegV1Schema = z
  .object({
    state: CommerceDeliveryStateV1Schema,
    itemCount: z.number().int().min(1).max(20),
    deliveredCount: z.number().int().min(0).max(20),
    confirmedAt: TimestampV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.deliveredCount > value.itemCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deliveredCount'],
        message: 'Delivered count cannot exceed the item count',
      });
    }
    if (value.state === 'all_delivered' && value.deliveredCount !== value.itemCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'all_delivered requires every item delivered',
      });
    }
    if (value.state === 'all_delivered' && value.confirmedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmedAt'],
        message: 'A completed delivery requires a confirmation time',
      });
    }
  });
export type CommerceDeliveryLegV1 = z.infer<typeof CommerceDeliveryLegV1Schema>;

const CommerceRouteProofV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('commerce-route-proof/v1', z.enum(COMMERCE_PROOF_FINAL_STATUSES_V1)),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    orderHash: HashV1Schema,
    proofHash: HashV1Schema,
    payment: CommercePaymentLegV1Schema,
    order: CommerceOrderLegV1Schema,
    delivery: CommerceDeliveryLegV1Schema,
    finalStatus: z.enum(COMMERCE_PROOF_FINAL_STATUSES_V1),
  })
  .strict();

export type CommerceRouteProofV1 = z.infer<typeof CommerceRouteProofV1ObjectSchema>;

export function hashCommerceRouteProofV1(value: CommerceRouteProofV1): HashV1 {
  return stableHashV1('commerce-route-proof/v1', financialContentV1(value, ['proofHash']));
}

/**
 * The single place the three legs collapse into one verdict.
 *
 * Exported so no caller ever hand-picks a status: the API, the reconciler and
 * the schema all agree by construction. The ordering matters — a settled
 * payment whose order is not confirmed is `order_unconfirmed`, and that branch
 * is checked BEFORE any delivery branch so it cannot be skipped past.
 */
export function deriveCommerceProofFinalStatusV1(input: {
  payment: CommercePaymentLegV1;
  order: CommerceOrderLegV1;
  delivery: CommerceDeliveryLegV1;
}): CommerceProofFinalStatusV1 {
  const { payment, order, delivery } = input;
  if (payment.state === 'failed' || payment.state === 'expired') return 'payment_failed';
  if (payment.state !== 'settled') return 'pending';
  // Paid. From here on the order leg decides whether this can ever be a proof.
  if (order.state === 'failed') return 'failed';
  if (order.state !== 'confirmed') return 'order_unconfirmed';
  if (delivery.state === 'failed') return 'failed';
  if (delivery.state === 'all_delivered' && delivery.deliveredCount === delivery.itemCount) {
    return 'delivered';
  }
  if (delivery.deliveredCount > 0) return 'partial_delivery';
  if (delivery.state === 'unknown') return 'reconciliation_required';
  return 'pending';
}

export const CommerceRouteProofV1Schema = CommerceRouteProofV1ObjectSchema.superRefine(
  (value, ctx) => {
    validateFinancialChronologyV1(value, ctx);
    if (value.proofHash !== hashCommerceRouteProofV1(value)) addHashIssue(ctx, 'proofHash', 'proofHash');
    if (value.status !== value.finalStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finalStatus'],
        message: 'finalStatus must equal Commerce Route Proof status',
      });
    }
    // The proof cannot disagree with its own legs. Any hand-written status
    // that the derivation would not produce is rejected outright — this is
    // what makes "paid but no order" impossible to dress up as a success.
    const derived = deriveCommerceProofFinalStatusV1(value);
    if (value.finalStatus !== derived) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finalStatus'],
        message: `Commerce Route Proof status must be ${derived} for these payment, order, and delivery legs`,
      });
    }
    if (value.delivery.state !== 'not_started' && value.delivery.state !== 'unknown' && value.payment.state !== 'settled') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delivery', 'state'],
        message: 'Delivery cannot progress before the payment settles',
      });
    }
    if (value.order.state === 'confirmed' && value.payment.state !== 'settled') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['order', 'state'],
        message: 'An order is only confirmed once its payment has settled',
      });
    }
  },
);

export const CommerceDomainSchemasV1 = {
  CommerceRouteIntentV1Schema,
  CommerceCandidateV1Schema,
  CommerceEvidenceV1Schema,
  CommerceScoreDimensionV1Schema,
  CommerceScoreV1Schema,
  CommerceRouteCardV1Schema,
  CommercePaymentRequirementsV1Schema,
  CommerceOrderV1Schema,
  CommerceRouteProofV1Schema,
} as const;
