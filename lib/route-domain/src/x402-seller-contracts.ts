import { z } from 'zod';

import { stableHashV1, type HashV1 } from './hashing.js';
import { HashV1Schema, TimestampV1Schema } from './primitives.js';
import { PublicProofVerificationResultV1Schema, PublicRouteProofBundleV1Schema } from './public-proof-contracts.js';

// 2026-09-06: 0.001 → 0.002 USDC. One price for every resource, because the
// thing being sold is the same in each: a measurement Miorail already took,
// with what it does NOT establish named beside it. A per-service price would
// be a claim that one of these answers is worth more than another, and nothing
// here measures that.
export const MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1 = '2000' as const;
export const MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1 = '0.002' as const;
export const MIORAIL_X402_INTELLIGENCE_ASSET_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

export const X402_INTELLIGENCE_SERVICES_V1 = [
  'b20_exit_analysis',
  'b20_liquidity_evidence',
  'enhanced_route_proof',
  // Two questions an agent cannot answer for itself and gets wrong silently.
  //
  // `stock_representation_choice`: "buy NVDA on Base" names three contracts
  // from three issuers with different structures and different markets. An
  // agent that picks by symbol picks by coincidence.
  //
  // `address_identity_check`: two different CHEESEBURGE contracts once sat on
  // one screen. A resemblance is not an identity, and the difference is only
  // visible against a reviewed corpus.
  'stock_representation_choice',
  'address_identity_check',
] as const;
export const X402IntelligenceServiceV1Schema = z.enum(X402_INTELLIGENCE_SERVICES_V1);
export type X402IntelligenceServiceV1 = z.infer<typeof X402IntelligenceServiceV1Schema>;

const X402_PRICE_V1 = {
  network: z.literal('eip155:8453'),
  chainId: z.literal(8453),
  asset: z.literal(MIORAIL_X402_INTELLIGENCE_ASSET_V1),
  symbol: z.literal('USDC'),
  decimals: z.literal(6),
  amountAtomic: z.literal(MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1),
  amountUsdc: z.literal(MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1),
} as const;

export const X402SellerCatalogV1Schema = z
  .object({
    schemaVersion: z.literal('x402-intelligence-catalog/v1'),
    provider: z.literal('Miorail'),
    chainId: z.literal(8453),
    enabled: z.boolean(),
    payment: z.object(X402_PRICE_V1).strict(),
    services: z
      .array(
        z
          .object({
            id: X402IntelligenceServiceV1Schema,
            method: z.literal('GET'),
            path: z.string().startsWith('/api/x402/intelligence/v1/'),
            description: z.string().min(1).max(300),
            input: z.array(z.string().min(1).max(120)).max(8),
          })
          .strict(),
      )
      .length(X402_INTELLIGENCE_SERVICES_V1.length),
    constraints: z.array(z.string().min(1).max(400)).min(1).max(12),
  })
  .strict();
export type X402SellerCatalogV1 = z.infer<typeof X402SellerCatalogV1Schema>;

const B20ObservationRefV1Schema = z
  .object({
    observationId: z.string().min(1),
    evidenceHash: HashV1Schema,
    observationBlockNumber: z.string().regex(/^\d+$/),
    measuredAt: TimestampV1Schema,
    staleAfter: TimestampV1Schema,
    freshness: z.enum(['fresh', 'stale']),
    measurementVersion: z.string().min(1).max(64),
  })
  .strict();

const X402DeliveredPaymentV1Schema = z.object({ ...X402_PRICE_V1, status: z.literal('settled_by_middleware') }).strict();

export const X402B20IntelligenceV1Schema = z
  .object({
    schemaVersion: z.literal('x402-b20-intelligence/v1'),
    service: z.enum(['b20_exit_analysis', 'b20_liquidity_evidence']),
    answerSource: z.literal('stored_deterministic_evidence'),
    chainId: z.literal(8453),
    token: z
      .object({
        address: z.string().regex(/^0x[0-9a-f]{40}$/),
        name: z.string(),
        symbol: z.string(),
        decimals: z.number().int().min(0).max(255).nullable(),
        variant: z.string(),
      })
      .strict(),
    observation: B20ObservationRefV1Schema.nullable(),
    analysis: z.record(z.string(), z.unknown()),
    missingEvidence: z.array(z.string().min(1).max(400)).max(24),
    caveats: z.array(z.string().min(1).max(500)).min(1).max(16),
    generatedAt: TimestampV1Schema,
    payment: X402DeliveredPaymentV1Schema,
    requestHash: HashV1Schema,
    dataHash: HashV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dataHash !== hashX402IntelligenceDataV1(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataHash'], message: 'dataHash does not match the delivered intelligence' });
    }
  });
export type X402B20IntelligenceV1 = z.infer<typeof X402B20IntelligenceV1Schema>;

export const X402EnhancedRouteProofV1Schema = z
  .object({
    schemaVersion: z.literal('x402-enhanced-route-proof/v1'),
    service: z.literal('enhanced_route_proof'),
    chainId: z.literal(8453),
    bundle: PublicRouteProofBundleV1Schema,
    verification: PublicProofVerificationResultV1Schema,
    explanation: z
      .object({
        finalStatus: z.string().min(1),
        reconciliationState: z.string().nullable(),
        transactionCount: z.number().int().min(0),
        eventCount: z.number().int().min(0),
        independentlyRecomputable: z.literal(true),
      })
      .strict(),
    caveats: z.array(z.string().min(1).max(500)).min(1).max(12),
    generatedAt: TimestampV1Schema,
    payment: X402DeliveredPaymentV1Schema,
    requestHash: HashV1Schema,
    dataHash: HashV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dataHash !== hashX402IntelligenceDataV1(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataHash'], message: 'dataHash does not match the delivered proof intelligence' });
    }
  });
export type X402EnhancedRouteProofV1 = z.infer<typeof X402EnhancedRouteProofV1Schema>;

// ---------------------------------------------------------------------------
// The two questions an agent gets wrong silently.
//
// Both are narrow projections rather than pass-throughs of the internal board
// or dossier. A field the buyer does not need is a field that can be read
// wrongly, and everything an agent needs here is: which contracts exist, which
// of them the market will actually take, and what Miorail did NOT establish.
// ---------------------------------------------------------------------------

const X402StockRepresentationV1Schema = z
  .object({
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    issuerId: z.string().min(1).max(40),
    issuerInstrumentKey: z.string().min(1).max(200),
    representationKind: z.string().min(1).max(60),
    /** `positive_supply`, `zero_supply` or `not_established`. A zero-supply
     * representation is a real contract with nothing outstanding, and it is
     * NOT the same fact as one we could not read. */
    supplyState: z.string().min(1).max(40),
    supplyDecimals: z.number().int().min(0).max(36).nullable(),
    /** Whether a reviewed router policy exists for this exact contract. */
    routePolicyEstablished: z.boolean(),
    /** Which reviewed routers answered at the measured size, and how. Empty
     * means nobody has measured THIS size — never that no route exists. */
    sources: z
      .array(z.object({ source: z.string().min(1).max(100), status: z.string().min(1).max(40) }).strict())
      .max(16),
    /** What the measured size came to in tokens, when something priced it. */
    exactTestedTokenAtomic: z.string().regex(/^\d+$/).nullable(),
    /** What that fetched. A price with a life, never carried as a size. */
    returnedCashAtomic: z.string().regex(/^\d+$/).nullable(),
    effectivePriceAtomic: z.string().regex(/^\d+$/).nullable(),
    premiumDiscountBps: z.string().regex(/^-?\d+$/).nullable(),
    observedAt: TimestampV1Schema.nullable(),
    expiresAt: TimestampV1Schema.nullable(),
    /** `live`, `history_only` or `never_measured` — about Miorail's coverage
     * of this contract, never about the contract. */
    liveness: z.string().min(1).max(40),
  })
  .strict();

export const X402StockRepresentationChoiceV1Schema = z
  .object({
    schemaVersion: z.literal('x402-stock-representation-choice/v1'),
    service: z.literal('stock_representation_choice'),
    answerSource: z.literal('stored_deterministic_evidence'),
    chainId: z.literal(8453),
    underlying: z
      .object({
        underlyingKey: z.string().min(1).max(200),
        isin: z.string().min(1).max(20).nullable(),
        assetClass: z.string().min(1).max(40).nullable(),
      })
      .strict(),
    /** The exact question these figures answer. A representation list without
     * a size is a catalogue; with one it is an answer. */
    question: z
      .object({
        direction: z.enum(['buy', 'sell']),
        requestedCashAtomic: z.string().regex(/^\d+$/),
        destination: z.literal('USDC'),
      })
      .strict(),
    representations: z.array(X402StockRepresentationV1Schema).max(24),
    /** Named because a ticker cannot select between these, and an agent that
     * picks by symbol picks by coincidence. */
    caveats: z.array(z.string().min(1).max(500)).min(1).max(16),
    missingEvidence: z.array(z.string().min(1).max(400)).max(24),
    generatedAt: TimestampV1Schema,
    payment: X402DeliveredPaymentV1Schema,
    requestHash: HashV1Schema,
    dataHash: HashV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dataHash !== hashX402IntelligenceDataV1(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataHash'], message: 'dataHash does not match the delivered representation choice' });
    }
  });
export type X402StockRepresentationChoiceV1 = z.infer<typeof X402StockRepresentationChoiceV1Schema>;

export const X402AddressIdentityCheckV1Schema = z
  .object({
    schemaVersion: z.literal('x402-address-identity-check/v1'),
    service: z.literal('address_identity_check'),
    answerSource: z.literal('stored_deterministic_evidence'),
    chainId: z.literal(8453),
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    /** `official`, `project_verified`, `indexed_launch`, `unknown_to_miorail`.
     * The last one is about OUR corpus and is never a verdict on the token. */
    standing: z.string().min(1).max(40),
    official: z
      .object({
        ticker: z.string().min(1).max(16),
        displayName: z.string().max(120).nullable(),
        issuer: z.string().min(1).max(80),
        listedIn: z.array(z.string().min(1).max(60)).max(8),
        sourceDiscrepancy: z.boolean(),
      })
      .strict()
      .nullable(),
    /**
     * A RESEMBLANCE, and it says so. Two strings matched and two addresses did
     * not: this names the official contract the resemblance points at, so a
     * buyer can compare addresses rather than trust a symbol.
     */
    lookalike: z
      .object({
        officialAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
        officialTicker: z.string().min(1).max(16),
        matchKind: z.string().min(1).max(40),
        matchedAlias: z.string().min(1).max(40),
        matchedValue: z.string().min(1).max(120),
        firstFlaggedAt: TimestampV1Schema,
      })
      .strict()
      .nullable(),
    /** Who put it on chain, when that is establishable. A bundler that relayed
     * a UserOperation is not a deployer, so a non-direct relation carries the
     * relation and no address. */
    origin: z
      .object({
        status: z.string().min(1).max(40),
        deployerAddress: z.string().regex(/^0x[0-9a-f]{40}$/).nullable(),
        relation: z.string().min(1).max(40).nullable(),
        readAt: TimestampV1Schema.nullable(),
      })
      .strict(),
    /** What Miorail established, and what it did not. The second list is the
     * point of buying this rather than guessing. */
    established: z.array(z.string().min(1).max(200)).max(24),
    unknown: z.array(z.string().min(1).max(200)).max(24),
    caveats: z.array(z.string().min(1).max(500)).min(1).max(16),
    generatedAt: TimestampV1Schema,
    payment: X402DeliveredPaymentV1Schema,
    requestHash: HashV1Schema,
    dataHash: HashV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dataHash !== hashX402IntelligenceDataV1(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataHash'], message: 'dataHash does not match the delivered identity check' });
    }
  });
export type X402AddressIdentityCheckV1 = z.infer<typeof X402AddressIdentityCheckV1Schema>;

export function x402IntelligencePaymentV1() {
  return {
    network: 'eip155:8453' as const,
    chainId: 8453 as const,
    asset: MIORAIL_X402_INTELLIGENCE_ASSET_V1,
    symbol: 'USDC' as const,
    decimals: 6 as const,
    amountAtomic: MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
    amountUsdc: MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1,
    status: 'settled_by_middleware' as const,
  };
}

/**
 * One hash over every delivered payload, whatever the service.
 *
 * The buyer's proof that what they were served is what they paid for, and it
 * is recomputable by them: drop `dataHash` and hash the rest under one domain
 * tag. Widened rather than duplicated per service — a second hash function
 * would be a second definition of "what was delivered".
 */
export type X402DeliverableV1 =
  | X402B20IntelligenceV1
  | X402EnhancedRouteProofV1
  | X402StockRepresentationChoiceV1
  | X402AddressIdentityCheckV1;

export function hashX402IntelligenceDataV1(
  value: X402DeliverableV1 | Omit<X402DeliverableV1, 'dataHash'>,
): HashV1 {
  const payload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'dataHash'),
  );
  return stableHashV1('x402-intelligence-delivery/v1', payload);
}
