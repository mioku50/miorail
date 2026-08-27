import { z } from 'zod';

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const SignedDigits = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const Timestamp = z.string().datetime();

export const MARKET_REALITY_MARKET_SESSIONS_V1 = [
  'regular_hours',
  'after_hours',
  'weekend',
  'unknown',
] as const;

export const MARKET_REALITY_PUBLICATION_MODES_V1 = [
  'live_reference',
  'holding_last_close',
  'corporate_action_hold',
  'stale',
  'unknown',
] as const;

export const MARKET_REALITY_REFERENCE_REASON_CODES_V1 = [
  'reviewed_calendar_regular_hours',
  'reviewed_calendar_after_hours',
  'reviewed_calendar_weekend',
  'reviewed_feed_holding_last_close',
  'reviewed_registry_corporate_action_hold',
  'reviewed_reference_stale',
  'reference_adapter_not_configured',
  'issuer_reference_not_reviewed',
  'exact_representation_not_reviewed',
  'reference_configuration_missing',
  'reference_identity_mismatch',
  'reference_read_failed',
  'reference_response_invalid',
  'calendar_semantics_missing',
  'calendar_outside_reviewed_range',
  'calendar_classification_failed',
] as const;

export const MarketRealityReferenceCalendarV1Schema = z
  .object({
    key: z.string().min(1).max(100),
    sourceUrls: z.array(z.string().url().startsWith('https://')).min(1).max(4),
    timeZone: z.literal('America/New_York'),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    regularOpenMinute: z.number().int().min(0).max(1_439),
    regularCloseMinute: z.number().int().min(1).max(1_440),
    /** The reviewed regular session in which a comparable publication must
     * have occurred. For an after-hours observation this can be the same
     * local date; for a weekend/holiday it is the preceding open date. */
    publicationSessionLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    publicationSessionOpenMinute: z.number().int().min(0).max(1_439),
    publicationSessionCloseMinute: z.number().int().min(1).max(1_440),
  })
  .strict();

export const MarketRealityReferenceEvidenceV1Schema = z
  .object({
    kind: z.literal('chainlink_feed'),
    source: z.string().min(1).max(160),
    blockNumber: Digits,
    blockHash: Hash,
    targetAddress: Address,
    evidenceHash: Hash,
  })
  .strict();

/** Reference health and reference basis semantics deliberately coexist here
 * as separate axes. `status/freshness` is the reader's health answer;
 * `marketSession/publicationMode` is the reviewed temporal meaning used by the
 * basis gate. */
export const MarketRealityReferenceStateV1Schema = z
  .object({
    status: z.enum(['fresh', 'stale', 'paused', 'unavailable', 'unknown']),
    /** Backward-compatible Phase 10C.1 presentation state. */
    session: z.enum([
      'regular_hours',
      'after_hours',
      'weekend',
      'reference_holding_last_close',
      'corporate_action_hold',
      'stale',
      'unknown',
    ]),
    marketSession: z.enum(MARKET_REALITY_MARKET_SESSIONS_V1),
    publicationMode: z.enum(MARKET_REALITY_PUBLICATION_MODES_V1),
    valueAtomic: SignedDigits.nullable(),
    decimals: z.number().int().min(0).max(36).nullable(),
    observedAt: Timestamp.nullable(),
    referenceUpdatedAt: Timestamp.nullable(),
    freshness: z.enum(['fresh', 'stale', 'unknown']),
    referenceSource: z.string().min(1).max(160).nullable(),
    referenceAddress: Address.nullable(),
    calendar: MarketRealityReferenceCalendarV1Schema.nullable(),
    evidence: MarketRealityReferenceEvidenceV1Schema.nullable(),
    /** Kept for 10C.1 consumers. Basis comparability is authoritative in the
     * separate `basis` object and never inferred from this flag. */
    comparable: z.literal(false),
    reasonCode: z.enum(MARKET_REALITY_REFERENCE_REASON_CODES_V1),
    reason: z.string().min(1).max(240).nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const completeValue =
      row.valueAtomic !== null &&
      row.decimals !== null &&
      row.observedAt !== null &&
      row.referenceUpdatedAt !== null &&
      row.referenceSource !== null &&
      row.referenceAddress !== null &&
      row.evidence !== null;
    if (completeValue !== (row.valueAtomic !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a reference value carries one complete exact-address evidence observation',
      });
    }
    if (row.evidence && row.referenceAddress !== row.evidence.targetAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', 'targetAddress'],
        message: 'reference evidence must target the configured reference address',
      });
    }
    if (row.status === 'fresh' && row.freshness !== 'fresh') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freshness'],
        message: 'fresh status requires fresh reference evidence',
      });
    }
    if (['stale', 'paused'].includes(row.status) && row.freshness !== 'stale') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freshness'],
        message: 'stale or held reference status is not fresh evidence',
      });
    }
    if (['unknown', 'unavailable'].includes(row.status) && row.freshness !== 'unknown') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freshness'],
        message: 'an unestablished reference has unknown freshness',
      });
    }
    if (row.marketSession !== 'unknown' && (row.calendar === null || row.observedAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['marketSession'],
        message: 'an established market session requires reviewed calendar evidence',
      });
    }
  });
export type MarketRealityReferenceStateV1 = z.infer<typeof MarketRealityReferenceStateV1Schema>;

export const MARKET_REALITY_BASIS_REASON_CODES_V1 = [
  'current_reference_comparable',
  'last_close_reference_comparable',
  'reference_unknown',
  'reference_read_failed',
  'reference_identity_mismatch',
  'reference_stale',
  'corporate_action_hold',
  'unreviewed_issuer_reference',
  'missing_normalized_exposure',
  'expired_quote',
  'measurement_failed',
  'no_route',
  'unsized_sell',
  'unsupported_semantics',
  'zero_supply',
  'supply_unknown',
  'reference_price_invalid',
  'reference_timing_outside_quote_window',
  'reference_publication_outside_reviewed_session',
  'not_recorded',
] as const;

export const MarketRealityBasisDecisionV1Schema = z
  .object({
    policy: z.literal('exact_normalized_price_same_quote_window_reviewed_publication_v1'),
    status: z.enum(['comparable', 'withheld']),
    kind: z.enum(['current_reference', 'last_close_reference', 'withheld']),
    premiumDiscountBps: SignedDigits.nullable(),
    reasonCode: z.enum(MARKET_REALITY_BASIS_REASON_CODES_V1),
    reason: z.string().min(1).max(300),
  })
  .strict()
  .superRefine((row, ctx) => {
    const expectedComparableReason =
      row.kind === 'current_reference'
        ? 'current_reference_comparable'
        : row.kind === 'last_close_reference'
          ? 'last_close_reference_comparable'
          : null;
    const validComparable =
      row.status === 'comparable' &&
      expectedComparableReason !== null &&
      row.reasonCode === expectedComparableReason &&
      row.premiumDiscountBps !== null;
    const validWithheld =
      row.status === 'withheld' &&
      row.kind === 'withheld' &&
      row.premiumDiscountBps === null &&
      !['current_reference_comparable', 'last_close_reference_comparable'].includes(
        row.reasonCode,
      );
    if (!validComparable && !validWithheld) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a comparable basis has a typed kind and exact bps; a withheld basis has neither',
      });
    }
  });
export type MarketRealityBasisDecisionV1 = z.infer<typeof MarketRealityBasisDecisionV1Schema>;

const SnapshotSupplyV1Schema = z
  .object({
    state: z.enum(['positive_supply', 'zero_supply', 'supply_unknown']),
    totalSupplyAtomic: Digits.nullable(),
    decimals: z.number().int().min(0).max(36).nullable(),
    blockNumber: Digits.nullable(),
    blockHash: Hash.nullable(),
    evidenceHash: Hash.nullable(),
    observedAt: Timestamp.nullable(),
    readOutcome: z.enum(['success', 'rpc_failure', 'decode_failure', 'not_observed']),
  })
  .strict();

const SnapshotRatioV1Schema = z
  .object({
    ratioKind: z.enum(['b20_multiplier', 'dinari_balance_per_share', 'backed_evm_multiplier']),
    application: z.enum(['apply_to_raw_balance', 'already_applied_by_token']),
    rawValue: Digits,
    scale: Digits,
    scaleSource: z.enum(['read_from_contract', 'reviewed_constant']),
    blockNumber: Digits,
    blockHash: Hash,
    evidenceHash: Hash,
    observedAt: Timestamp,
    lastCheckedAt: Timestamp,
  })
  .strict();

export const MarketRealityEvidenceSnapshotContractV1Schema = z
  .object({
    schemaVersion: z.literal('market-reality-evidence-snapshot/v1'),
    snapshotHash: Hash,
    runId: Hash,
    observationHash: Hash,
    chainId: z.literal(8453),
    tokenAddress: Address,
    issuerId: z.enum(['coinbase', 'dinari', 'backed']).nullable(),
    issuerInstrumentKey: z.string().min(1).max(200).nullable(),
    representationKind: z
      .enum(['b20_asset', 'rebasing_erc20', 'non_rebasing_erc4626_wrapper'])
      .nullable(),
    direction: z.enum(['buy', 'sell']),
    requestedCashAtomic: Digits.nullable(),
    requestedTokenAtomic: Digits.nullable(),
    testedTokenAtomic: Digits.nullable(),
    destination: z.enum(['USDC', 'ETH']),
    destinationAddress: Address,
    destinationDecimals: z.number().int().min(0).max(255),
    source: z.string().min(1).max(100),
    approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
    routePolicyKey: Hash,
    marketStatus: z.enum(['quoted', 'no_route', 'unsized', 'measurement_failed']),
    marketObservedAt: Timestamp,
    marketExpiresAt: Timestamp,
    normalizedExposureAtomic: Digits.nullable(),
    normalizedExposureDecimals: z.number().int().min(0).max(36).nullable(),
    normalization: z.enum([
      'fresh_ratio_applied',
      'reviewed_token_already_applied',
      'not_established',
    ]),
    ratio: SnapshotRatioV1Schema.nullable(),
    supply: SnapshotSupplyV1Schema,
    effectivePriceAtomic: Digits.nullable(),
    effectivePriceDecimals: z.literal(8).nullable(),
    reference: MarketRealityReferenceStateV1Schema,
    basis: MarketRealityBasisDecisionV1Schema,
    capturedAt: Timestamp,
  })
  .strict()
  .superRefine((row, ctx) => {
    if ((row.normalizedExposureAtomic === null) !== (row.normalizedExposureDecimals === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['normalizedExposureAtomic'],
        message: 'normalized exposure amount and decimals travel together',
      });
    }
    if ((row.effectivePriceAtomic === null) !== (row.effectivePriceDecimals === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectivePriceAtomic'],
        message: 'effective price amount and decimals travel together',
      });
    }
    if (
      row.normalization === 'fresh_ratio_applied' &&
      (row.ratio === null ||
        row.ratio.application !== 'apply_to_raw_balance' ||
        row.normalizedExposureAtomic === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['normalization'],
        message: 'fresh ratio normalization requires the exact ratio and normalized exposure',
      });
    }
    if (
      row.basis.status === 'comparable' &&
      (row.marketStatus !== 'quoted' ||
        row.normalizedExposureAtomic === null ||
        row.effectivePriceAtomic === null ||
        row.supply.state !== 'positive_supply')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['basis'],
        message: 'comparable basis requires a quoted normalized price and positive supply',
      });
    }
  });

export type MarketRealityEvidenceSnapshotV1 = z.infer<
  typeof MarketRealityEvidenceSnapshotContractV1Schema
>;
