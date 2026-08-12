import { z } from 'zod';
import { financialContentV1, stableHashV1, type HashV1 } from './hashing.js';
import {
  AssetRefV1Schema,
  AtomicAmountV1Schema,
  BaseChainIdV1Schema,
  GasEstimateV1Schema,
  HashV1Schema,
  LiquiditySourceRefV1Schema,
  MoneyV1Schema,
  PercentageV1Schema,
  PoolRefV1Schema,
  ProviderRefV1Schema,
  TimestampV1Schema,
  TokenAmountV1Schema,
  financialEntityFieldsV1,
  validateFinancialChronologyV1,
} from './primitives.js';

function addHashIssue(ctx: z.RefinementCtx, path: string, label: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: `${label} does not match the canonical V1 financial payload`,
  });
}

export const OptimizationModeV1Schema = z.enum([
  'best_net_result',
  'lowest_risk',
  'lowest_fees',
  'simplest_route',
  'fastest_execution',
  'mev_protected',
]);

export const VerificationDepthV1Schema = z.enum(['standard', 'enhanced', 'maximum']);

export const ProtocolConstraintV1Schema = z
  .object({
    mode: z.enum(['any', 'include_only', 'exclude']),
    protocols: z.array(z.string().min(1).max(100)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === 'any' && value.protocols.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protocols'],
        message: 'protocols must be empty when protocol constraint mode is any',
      });
    }
    if (value.mode !== 'any' && value.protocols.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protocols'],
        message: 'protocols must not be empty for a constrained mode',
      });
    }
  });

export const SlippageConstraintV1Schema = z
  .object({
    maxBps: z.number().int().min(0).max(10_000),
    source: z.enum(['user', 'default', 'policy']),
  })
  .strict();

const RouteIntentV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'route-intent/v1',
      z.enum(['draft', 'ready', 'needs_clarification', 'rejected']),
    ),
    intentHash: HashV1Schema,
    goal: z.enum(['swap', 'earn', 'send', 'token_action']),
    fromAsset: AssetRefV1Schema.nullable(),
    toAsset: AssetRefV1Schema.nullable(),
    amount: TokenAmountV1Schema,
    optimizationMode: OptimizationModeV1Schema,
    verificationDepth: VerificationDepthV1Schema,
    protocolConstraint: ProtocolConstraintV1Schema,
    slippageConstraint: SlippageConstraintV1Schema,
    executionRequested: z.boolean(),
  })
  .strict();

export type RouteIntentV1 = z.infer<typeof RouteIntentV1ObjectSchema>;

export function hashRouteIntentV1(value: RouteIntentV1): HashV1 {
  return stableHashV1('route-intent/v1', financialContentV1(value, ['intentHash']));
}

export const RouteIntentV1Schema = RouteIntentV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.intentHash !== hashRouteIntentV1(value)) addHashIssue(ctx, 'intentHash', 'intentHash');
  if (value.amount.asset.chainId !== value.chainId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amount', 'asset', 'chainId'],
      message: 'Amount asset chain must match intent chain',
    });
  }
  if (value.goal === 'swap') {
    if (!value.fromAsset || !value.toAsset) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['goal'],
        message: 'Swap intent requires fromAsset and toAsset',
      });
      return;
    }
    if (value.fromAsset.chainId !== value.chainId || value.toAsset.chainId !== value.chainId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chainId'],
        message: 'Swap assets must match intent chain',
      });
    }
    if (value.fromAsset.assetId === value.toAsset.assetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toAsset'],
        message: 'Swap assets must be different',
      });
    }
    if (value.amount.asset.assetId !== value.fromAsset.assetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount', 'asset'],
        message: 'Swap amount asset must match fromAsset',
      });
    }
  }
});

export const TrustMetadataV1Schema = z
  .object({
    integrationKind: z.enum(['base_mcp', 'http_api', 'onchain_read', 'internal']),
    operator: z.string().min(1).max(200),
    verifiedIntegration: z.boolean(),
    riskFlags: z.array(z.string().min(1).max(120)),
    usesExternalAggregators: z.boolean(),
    sourceIndependence: z.enum(['independent', 'overlapping', 'unknown']),
  })
  .strict();

const RouteCandidateV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'route-candidate/v1',
      z.enum(['quoted', 'selected', 'expired', 'invalid', 'rejected']),
    ),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    provider: ProviderRefV1Schema,
    providerQuoteId: z.string().min(1).max(300),
    routeType: z.enum(['swap', 'earn', 'send', 'token_action']),
    inputAmount: TokenAmountV1Schema,
    expectedOutput: TokenAmountV1Schema,
    minimumOutput: TokenAmountV1Schema,
    estimatedGas: GasEstimateV1Schema,
    // Some aggregators return a bounded minimum without a market/reference
    // price. Null is the only honest value in that case; zero would claim an
    // observation that never happened.
    priceImpact: PercentageV1Schema.nullable(),
    slippage: PercentageV1Schema,
    callCount: z.number().int().min(0).max(100),
    approvalCount: z.number().int().min(0).max(100),
    quoteObservedAt: TimestampV1Schema,
    quoteExpiresAt: TimestampV1Schema,
    liquiditySources: z.array(LiquiditySourceRefV1Schema),
    trustMetadata: TrustMetadataV1Schema,
  })
  .strict();

export type RouteCandidateV1 = z.infer<typeof RouteCandidateV1ObjectSchema>;

export function hashRouteCandidateV1(value: RouteCandidateV1): HashV1 {
  return stableHashV1('route-candidate/v1', financialContentV1(value, ['candidateHash']));
}

export const RouteCandidateV1Schema = RouteCandidateV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.candidateHash !== hashRouteCandidateV1(value))
    addHashIssue(ctx, 'candidateHash', 'candidateHash');
  if (Date.parse(value.quoteExpiresAt) <= Date.parse(value.quoteObservedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['quoteExpiresAt'],
      message: 'quoteExpiresAt must be later than quoteObservedAt',
    });
  }
  for (const [path, amount] of [
    ['inputAmount', value.inputAmount],
    ['expectedOutput', value.expectedOutput],
    ['minimumOutput', value.minimumOutput],
  ] as const) {
    if (amount.asset.chainId !== value.chainId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, 'asset', 'chainId'],
        message: 'Candidate assets must match candidate chain',
      });
    }
  }
  if (value.expectedOutput.asset.assetId !== value.minimumOutput.asset.assetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minimumOutput', 'asset'],
      message: 'minimumOutput asset must match expectedOutput asset',
    });
  }
  if (BigInt(value.minimumOutput.amountAtomic) > BigInt(value.expectedOutput.amountAtomic)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minimumOutput', 'amountAtomic'],
      message: 'minimumOutput must not exceed expectedOutput',
    });
  }
});

export const EvidenceTypeV1Schema = z.enum([
  'quote',
  'liquidity',
  'contract_risk',
  'token_risk',
  'simulation',
  'gas',
  'provider_reliability',
  'mev_protection',
]);
export type EvidenceTypeV1 = z.infer<typeof EvidenceTypeV1Schema>;

export const EvidenceValidationStatusV1Schema = z.enum([
  'valid',
  'stale',
  'invalid',
  'unavailable',
]);

const EvidenceRecordV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'evidence-record/v1',
      z.enum(['observed', 'expired', 'rejected', 'unavailable']),
    ),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceHash: HashV1Schema,
    evidenceType: EvidenceTypeV1Schema,
    provider: ProviderRefV1Schema,
    observedAt: TimestampV1Schema,
    expiresAt: TimestampV1Schema.nullable(),
    blockNumber: AtomicAmountV1Schema.nullable(),
    requestHash: HashV1Schema,
    responseHash: HashV1Schema,
    assets: z.array(AssetRefV1Schema),
    pools: z.array(PoolRefV1Schema),
    liquiditySources: z.array(LiquiditySourceRefV1Schema),
    freeOrPaid: z.enum(['free', 'paid']),
    cost: MoneyV1Schema.nullable(),
    intelligenceChargeId: z.string().min(1).max(200).nullable(),
    validationStatus: EvidenceValidationStatusV1Schema,
    validationErrors: z.array(z.string().min(1).max(300)),
  })
  .strict();

export type EvidenceRecordV1 = z.infer<typeof EvidenceRecordV1ObjectSchema>;

export function hashEvidenceRecordV1(value: EvidenceRecordV1): HashV1 {
  return stableHashV1('evidence-record/v1', financialContentV1(value, ['evidenceHash']));
}

export const EvidenceRecordV1Schema = EvidenceRecordV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.evidenceHash !== hashEvidenceRecordV1(value))
    addHashIssue(ctx, 'evidenceHash', 'evidenceHash');
  if (value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Evidence expiresAt must be later than observedAt',
    });
  }
  if (value.freeOrPaid === 'free' && (value.cost !== null || value.intelligenceChargeId !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cost'],
      message: 'Free evidence must not have a cost or intelligence charge',
    });
  }
  if (value.freeOrPaid === 'paid' && (!value.cost || !value.intelligenceChargeId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cost'],
      message: 'Paid evidence requires cost and intelligenceChargeId',
    });
  }
  if (value.validationStatus === 'stale' && value.status !== 'expired') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'Stale evidence must use expired status',
    });
  }
  value.assets.forEach((asset, index) => {
    if (asset.chainId !== value.chainId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assets', index, 'chainId'],
        message: 'Evidence asset must match evidence chain',
      });
    }
  });
  value.pools.forEach((pool, index) => {
    if (
      pool.chainId !== value.chainId ||
      pool.assets.some((asset) => asset.chainId !== value.chainId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pools', index, 'chainId'],
        message: 'Evidence pool and pool assets must match evidence chain',
      });
    }
  });
  value.liquiditySources.forEach((source, index) => {
    if (
      source.chainId !== value.chainId ||
      source.assets.some((asset) => asset.chainId !== value.chainId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['liquiditySources', index, 'chainId'],
        message: 'Liquidity provenance must match evidence chain',
      });
    }
  });
  if (value.cost && value.cost.asset.chainId !== value.chainId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cost', 'asset', 'chainId'],
      message: 'Evidence cost asset must match evidence chain',
    });
  }
});

export interface LiquidityOverlapV1 {
  sourceKey: string;
  evidenceIds: string[];
  providerIds: string[];
}

export function findLiquidityOverlapsV1(
  records: readonly EvidenceRecordV1[],
): LiquidityOverlapV1[] {
  const bySource = new Map<string, { evidenceIds: Set<string>; providerIds: Set<string> }>();
  for (const record of records) {
    for (const source of record.liquiditySources) {
      const current = bySource.get(source.sourceKey) ?? {
        evidenceIds: new Set<string>(),
        providerIds: new Set<string>(),
      };
      current.evidenceIds.add(record.id);
      current.providerIds.add(record.provider.id);
      bySource.set(source.sourceKey, current);
    }
  }
  return [...bySource.entries()]
    .filter(([, value]) => value.providerIds.size > 1)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([sourceKey, value]) => ({
      sourceKey,
      evidenceIds: [...value.evidenceIds].sort(),
      providerIds: [...value.providerIds].sort(),
    }));
}

const LiquidityOverlapV1Schema = z
  .object({
    sourceKey: z.string().min(1).max(300),
    evidenceIds: z.array(z.string().min(1).max(200)).min(2),
    providerIds: z.array(z.string().min(1).max(100)).min(2),
  })
  .strict();

const EvidenceSetV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'evidence-set/v1',
      z.enum(['collecting', 'complete', 'partial', 'stale', 'invalid']),
    ),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    records: z.array(EvidenceRecordV1Schema),
    requiredEvidence: z.array(EvidenceTypeV1Schema),
    missingEvidence: z.array(EvidenceTypeV1Schema),
    sourceIndependence: z.enum(['independent', 'overlapping', 'unknown']),
    overlapGroups: z.array(LiquidityOverlapV1Schema),
  })
  .strict();

export type EvidenceSetV1 = z.infer<typeof EvidenceSetV1ObjectSchema>;

export function hashEvidenceSetV1(value: EvidenceSetV1): HashV1 {
  const content = financialContentV1(value, ['evidenceSetHash', 'records']);
  return stableHashV1('evidence-set/v1', {
    ...content,
    evidenceHashes: value.records.map((record) => record.evidenceHash),
  });
}

export const EvidenceSetV1Schema = EvidenceSetV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.evidenceSetHash !== hashEvidenceSetV1(value))
    addHashIssue(ctx, 'evidenceSetHash', 'evidenceSetHash');
  const sortedHashes = value.records.map((record) => record.evidenceHash).sort();
  if (new Set(sortedHashes).size !== sortedHashes.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['records'],
      message: 'Evidence Set record hashes must be unique',
    });
  }
  if (value.records.some((record, index) => record.evidenceHash !== sortedHashes[index])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['records'],
      message: 'Evidence records must be sorted by evidenceHash',
    });
  }
  for (const [index, record] of value.records.entries()) {
    if (
      record.intentHash !== value.intentHash ||
      record.candidateHash !== value.candidateHash ||
      record.tenantId !== value.tenantId ||
      record.walletAddress !== value.walletAddress ||
      record.chainId !== value.chainId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['records', index],
        message: 'Evidence record linkage must match its Evidence Set',
      });
    }
  }
  const expectedOverlaps = findLiquidityOverlapsV1(value.records);
  if (JSON.stringify(value.overlapGroups) !== JSON.stringify(expectedOverlaps)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['overlapGroups'],
      message: 'overlapGroups must match shared liquidity provenance',
    });
  }
  if (expectedOverlaps.length > 0 && value.sourceIndependence !== 'overlapping') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceIndependence'],
      message: 'Shared liquidity sources must be marked overlapping',
    });
  }
  const missing = new Set(value.missingEvidence);
  const required = new Set(value.requiredEvidence);
  if (missing.size !== value.missingEvidence.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['missingEvidence'],
      message: 'missingEvidence values must be unique',
    });
  }
  if (required.size !== value.requiredEvidence.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requiredEvidence'],
      message: 'requiredEvidence values must be unique',
    });
  }
  for (const evidenceType of missing) {
    if (!required.has(evidenceType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['missingEvidence'],
        message: 'missingEvidence must be a subset of requiredEvidence',
      });
    }
  }
  if (value.status === 'complete' && missing.size > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'Complete Evidence Set cannot have missing evidence',
    });
  }
  if (value.status === 'partial' && missing.size === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'Partial Evidence Set requires missing evidence',
    });
  }
});

export const BaseRouteDomainSchemasV1 = {
  RouteIntentV1Schema,
  RouteCandidateV1Schema,
  EvidenceRecordV1Schema,
  EvidenceSetV1Schema,
  BaseChainIdV1Schema,
} as const;
