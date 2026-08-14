import { z } from 'zod';

import { stableHashV1, type HashV1 } from './hashing.js';
import { HashV1Schema, TimestampV1Schema } from './primitives.js';
import { PublicProofVerificationResultV1Schema, PublicRouteProofBundleV1Schema } from './public-proof-contracts.js';

export const MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1 = '1000' as const;
export const MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1 = '0.001' as const;
export const MIORAIL_X402_INTELLIGENCE_ASSET_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

export const X402_INTELLIGENCE_SERVICES_V1 = [
  'b20_exit_analysis',
  'b20_liquidity_evidence',
  'enhanced_route_proof',
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
      .length(3),
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

export function hashX402IntelligenceDataV1(
  value: Omit<X402B20IntelligenceV1, 'dataHash'> | Omit<X402EnhancedRouteProofV1, 'dataHash'> | X402B20IntelligenceV1 | X402EnhancedRouteProofV1,
): HashV1 {
  const payload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'dataHash'),
  );
  return stableHashV1('x402-intelligence-delivery/v1', payload);
}
