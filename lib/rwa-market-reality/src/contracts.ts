import { z } from 'zod';

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const SignedDigits = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const Timestamp = z.string().datetime();

export const MarketRealityDirectionV1Schema = z.enum(['buy', 'sell']);
export type MarketRealityDirectionV1 = z.infer<typeof MarketRealityDirectionV1Schema>;

export const MarketRealityQuestionV1Schema = z
  .object({
    chainId: z.literal(8453),
    underlyingKey: z
      .string()
      .regex(/^[a-z0-9_]+:[a-z0-9_]+:.+$/)
      .max(200),
    direction: MarketRealityDirectionV1Schema,
    requestedCashAtomic: Digits,
    cashAsset: z.literal('USDC'),
    cashAddress: Address,
    cashDecimals: z.literal(6),
    destination: z.enum(['USDC', 'ETH']),
    exactSizeOnly: z.literal(true),
    baseOnly: z.literal(true),
  })
  .strict();
export type MarketRealityQuestionV1 = z.infer<typeof MarketRealityQuestionV1Schema>;

export const MarketRealityQuoteEvidenceV1Schema = z
  .object({
    kind: z.literal('router_quote'),
    source: z.string().min(1).max(100),
    direction: MarketRealityDirectionV1Schema,
    routeKey: z.string().min(1).max(300),
    candidateHash: Hash,
    evidenceHash: Hash,
    inputAtomic: Digits,
    outputAtomic: Digits,
    observedAt: Timestamp,
    expiresAt: Timestamp,
    blockNumber: Digits.nullable(),
  })
  .strict();

export const MarketRealitySourceObservationV1Schema = z
  .object({
    source: z.string().min(1).max(100),
    status: z.enum(['quoted', 'no_route', 'measurement_failed', 'not_measured']),
    errorCode: z.string().min(1).max(120).nullable(),
    quoteEvidence: MarketRealityQuoteEvidenceV1Schema.nullable(),
    simulationEvidence: z
      .object({
        kind: z.literal('route_simulation'),
        status: z.literal('not_simulated'),
        evidenceHash: z.null(),
      })
      .strict(),
  })
  .strict();

export const MarketRealityReferenceStateV1Schema = z
  .object({
    status: z.enum(['fresh', 'stale', 'paused', 'unavailable', 'unknown']),
    session: z.enum(['regular', 'after_hours', 'weekend', 'held', 'unknown']),
    valueAtomic: SignedDigits.nullable(),
    decimals: z.number().int().min(0).max(36).nullable(),
    observedAt: Timestamp.nullable(),
    comparable: z.boolean(),
    reason: z.string().min(1).max(240).nullable(),
  })
  .strict();
export type MarketRealityReferenceStateV1 = z.infer<typeof MarketRealityReferenceStateV1Schema>;

export const MarketRealityRepresentationV1Schema = z
  .object({
    tokenAddress: Address,
    issuerId: z.enum(['coinbase', 'dinari', 'backed']),
    issuerInstrumentKey: z.string().min(1).max(200),
    representationKind: z.enum(['b20_asset', 'rebasing_erc20', 'non_rebasing_erc4626_wrapper']),
    status: z.enum(['full', 'unavailable', 'not_measured', 'measurement_failed']),
    routePolicyKey: Hash.nullable(),
    exactTestedTokenAtomic: Digits.nullable(),
    normalizedExposureAtomic: Digits.nullable(),
    normalizedExposureDecimals: z.number().int().min(0).max(36).nullable(),
    normalization: z.enum([
      'fresh_ratio_applied',
      'reviewed_token_already_applied',
      'not_established',
    ]),
    returnedCashAtomic: Digits.nullable(),
    effectivePriceAtomic: Digits.nullable(),
    effectivePriceDecimals: z.literal(8).nullable(),
    premiumDiscountBps: SignedDigits.nullable(),
    reference: MarketRealityReferenceStateV1Schema,
    sources: z.array(MarketRealitySourceObservationV1Schema).max(16),
    observedAt: Timestamp.nullable(),
    expiresAt: Timestamp.nullable(),
  })
  .strict();

export const MarketRealityResponseV1Schema = z
  .object({
    schemaVersion: z.literal('market-reality/v1'),
    question: MarketRealityQuestionV1Schema,
    coverage: z
      .object({
        policy: z.literal('same_approved_router_set_exact_size_and_destination'),
        reviewedRepresentations: z.number().int().min(0),
        comparableRepresentations: z.number().int().min(0),
        status: z.enum(['complete', 'incomplete']),
        reason: z.string().min(1).max(300).nullable(),
      })
      .strict(),
    ranking: z
      .object({
        status: z.enum(['available', 'withheld']),
        orderedTokenAddresses: z.array(Address),
        reason: z.string().min(1).max(300).nullable(),
      })
      .strict(),
    quoteEvidenceIsExecutionProof: z.literal(false),
    representations: z.array(MarketRealityRepresentationV1Schema).max(256),
    assembledAt: Timestamp,
  })
  .strict();
export type MarketRealityResponseV1 = z.infer<typeof MarketRealityResponseV1Schema>;
