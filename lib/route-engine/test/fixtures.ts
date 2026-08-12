import {
  EvidenceRecordV1Schema,
  RouteCandidateV1Schema,
  RouteIntentV1Schema,
  ZERO_HASH_V1,
  hashEvidenceRecordV1,
  hashRouteCandidateV1,
  hashRouteIntentV1,
  stableHashV1,
  type AssetRefV1,
  type EvidenceRecordV1,
  type RouteCandidateV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import type {
  SwapAdapterFailure,
  SwapAdapterId,
  SwapAdapterResult,
  SwapRouteAdapter,
} from '@mioagent/swap-adapters';

export const NOW = new Date('2026-07-15T12:00:00.000Z');
export const OBSERVED = '2026-07-15T11:59:00.000Z';
export const EXPIRES = '2026-07-15T12:04:00.000Z';
export const WALLET = '0x1111111111111111111111111111111111111111' as const;

export const USDC: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  chainId: 8453,
  kind: 'erc20',
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  symbol: 'USDC',
  decimals: 6,
};
export const ETH: AssetRefV1 = {
  assetId: 'eip155:8453/native',
  chainId: 8453,
  kind: 'native',
  address: null,
  symbol: 'ETH',
  decimals: 18,
};
export const WETH: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x4200000000000000000000000000000000000006',
  chainId: 8453,
  kind: 'erc20',
  address: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  decimals: 18,
};

interface IntentOverrides {
  optimizationMode?: RouteIntentV1['optimizationMode'];
  verificationDepth?: RouteIntentV1['verificationDepth'];
  protocolConstraint?: RouteIntentV1['protocolConstraint'];
  fromAsset?: AssetRefV1;
  toAsset?: AssetRefV1;
}

export function makeIntent(overrides: IntentOverrides = {}): RouteIntentV1 {
  const fromAsset = overrides.fromAsset ?? USDC;
  const toAsset = overrides.toAsset ?? ETH;
  const amountAtomic = fromAsset.decimals === 6 ? '100000000' : '100000000000000000';
  const amountDecimal = fromAsset.decimals === 6 ? '100' : '0.1';
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id: `intent:${stableHashV1('route-engine-test-intent-id/v1', {
      from: fromAsset.assetId,
      to: toAsset.assetId,
      mode: overrides.optimizationMode ?? 'best_net_result',
      verification: overrides.verificationDepth ?? 'standard',
      constraint: overrides.protocolConstraint ?? { mode: 'any', protocols: [] },
    }).slice(2)}`,
    tenantId: 'tenant-t54',
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: OBSERVED,
    updatedAt: OBSERVED,
    status: 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'swap',
    fromAsset,
    toAsset,
    amount: { asset: fromAsset, amountAtomic, amountDecimal },
    optimizationMode: overrides.optimizationMode ?? 'best_net_result',
    verificationDepth: overrides.verificationDepth ?? 'standard',
    protocolConstraint: overrides.protocolConstraint ?? { mode: 'any', protocols: [] },
    slippageConstraint: { maxBps: 50, source: 'user' },
    executionRequested: false,
  };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

const providers = {
  uniswap: { id: 'uniswap', displayName: 'Uniswap', kind: 'dex', operator: 'Uniswap Labs' },
  kyberswap: { id: 'kyberswap', displayName: 'KyberSwap', kind: 'aggregator', operator: 'Kyber Network' },
  aerodrome: { id: 'aerodrome', displayName: 'Aerodrome', kind: 'dex', operator: 'Aerodrome Finance' },
  balancer: { id: 'balancer', displayName: 'Balancer', kind: 'dex', operator: 'Balancer' },
  hydrex: { id: 'hydrex', displayName: 'Hydrex', kind: 'dex', operator: 'Hydrex' },
  'o1-exchange': { id: 'o1-exchange', displayName: 'o1.exchange', kind: 'aggregator', operator: 'o1.exchange' },
} as const;

interface CandidateOverrides {
  outputAtomic?: string;
  gasUsd?: string | null;
  callCount?: number;
  approvalCount?: number;
  observedAt?: string;
  expiresAt?: string;
  poolAddress?: `0x${string}` | null;
  sourceKey?: string;
  riskFlags?: string[];
  sourceIndependence?: 'independent' | 'overlapping' | 'unknown';
}

export function makeCandidate(
  intent: RouteIntentV1,
  providerId: SwapAdapterId,
  overrides: CandidateOverrides = {},
): RouteCandidateV1 {
  const outputAtomic = overrides.outputAtomic ?? (intent.toAsset!.decimals === 6 ? '250000000' : providerId === 'uniswap' ? '40000000000000000' : '40500000000000000');
  const poolAddress = overrides.poolAddress === undefined ? '0x2222222222222222222222222222222222222222' : overrides.poolAddress;
  const sourceKey = overrides.sourceKey ?? (poolAddress ? `eip155:8453/uniswap-v3:${poolAddress}` : `eip155:8453/${providerId}:unknown`);
  const observedAt = overrides.observedAt ?? OBSERVED;
  const expiresAt = overrides.expiresAt ?? EXPIRES;
  const draft: RouteCandidateV1 = {
    schemaVersion: 'route-candidate/v1',
    id: `candidate:${providerId}:${stableHashV1('route-engine-test-candidate-id/v1', { intentHash: intent.intentHash, outputAtomic, gasUsd: overrides.gasUsd ?? '0.50', sourceKey, callCount: overrides.callCount ?? 2 }).slice(2)}`,
    tenantId: intent.tenantId,
    walletAddress: intent.walletAddress,
    chainId: intent.chainId,
    createdAt: observedAt,
    updatedAt: observedAt,
    status: 'quoted',
    intentHash: intent.intentHash,
    candidateHash: ZERO_HASH_V1,
    provider: providers[providerId],
    providerQuoteId: `quote-${providerId}`,
    routeType: 'swap',
    inputAmount: intent.amount,
    expectedOutput: { asset: intent.toAsset!, amountAtomic: outputAtomic, amountDecimal: intent.toAsset!.decimals === 6 ? String(Number(outputAtomic) / 1e6) : '0.04' },
    minimumOutput: { asset: intent.toAsset!, amountAtomic: (BigInt(outputAtomic) * 995n / 1000n).toString(), amountDecimal: intent.toAsset!.decimals === 6 ? String(Number(BigInt(outputAtomic) * 995n / 1000n) / 1e6) : '0.0398' },
    estimatedGas: {
      gasUnits: '180000',
      maxFeePerGasWei: '1500000000',
      estimatedCostNative: '0.00027',
      estimatedCostUsd: overrides.gasUsd === undefined ? '0.50' : overrides.gasUsd,
    },
    priceImpact: { bps: 10, percent: '0.1' },
    slippage: { bps: 50, percent: '0.5' },
    callCount: overrides.callCount ?? 2,
    approvalCount: overrides.approvalCount ?? 1,
    quoteObservedAt: observedAt,
    quoteExpiresAt: expiresAt,
    liquiditySources: [{
      sourceKey,
      chainId: 8453,
      protocol: 'uniswap-v3',
      poolAddress,
      assets: [intent.fromAsset!, intent.toAsset!],
      upstreamProvider: poolAddress ? 'uniswap-v3' : null,
    }],
    trustMetadata: {
      integrationKind: 'http_api',
      operator: providers[providerId].operator,
      verifiedIntegration: true,
      riskFlags: overrides.riskFlags ?? [],
      usesExternalAggregators: providerId === 'kyberswap',
      sourceIndependence: overrides.sourceIndependence ?? (poolAddress ? 'independent' : 'unknown'),
    },
  };
  return RouteCandidateV1Schema.parse({ ...draft, candidateHash: hashRouteCandidateV1(draft) });
}

export function makeQuoteEvidence(candidate: RouteCandidateV1): EvidenceRecordV1 {
  const draft: EvidenceRecordV1 = {
    schemaVersion: 'evidence-record/v1',
    id: `evidence:quote:${candidate.provider.id}:${candidate.candidateHash.slice(2)}`,
    tenantId: candidate.tenantId,
    walletAddress: candidate.walletAddress,
    chainId: candidate.chainId,
    createdAt: candidate.quoteObservedAt,
    updatedAt: candidate.quoteObservedAt,
    status: 'observed',
    intentHash: candidate.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceHash: ZERO_HASH_V1,
    evidenceType: 'quote',
    provider: candidate.provider,
    observedAt: candidate.quoteObservedAt,
    expiresAt: candidate.quoteExpiresAt,
    blockNumber: '33123456',
    requestHash: stableHashV1('route-engine-test-request/v1', { provider: candidate.provider.id }),
    responseHash: stableHashV1('route-engine-test-response/v1', { candidateHash: candidate.candidateHash }),
    assets: [candidate.inputAmount.asset, candidate.expectedOutput.asset],
    pools: candidate.liquiditySources.flatMap((source) => source.poolAddress ? [{ chainId: 8453 as const, address: source.poolAddress, protocol: source.protocol, feeBps: 5, assets: source.assets }] : []),
    liquiditySources: candidate.liquiditySources,
    freeOrPaid: 'free',
    cost: null,
    intelligenceChargeId: null,
    validationStatus: 'valid',
    validationErrors: [],
  };
  return EvidenceRecordV1Schema.parse({ ...draft, evidenceHash: hashEvidenceRecordV1(draft) });
}

export function rehashEvidence(record: EvidenceRecordV1, changes: Partial<EvidenceRecordV1>): EvidenceRecordV1 {
  const draft = { ...record, ...changes, evidenceHash: ZERO_HASH_V1 } as EvidenceRecordV1;
  return EvidenceRecordV1Schema.parse({ ...draft, evidenceHash: hashEvidenceRecordV1(draft) });
}

export function quotedAdapter(
  id: SwapAdapterId,
  candidate: RouteCandidateV1,
  evidence: EvidenceRecordV1[] = [makeQuoteEvidence(candidate)],
  delay = 0,
): SwapRouteAdapter {
  return {
    id,
    supports: () => true,
    quote: async () => {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return { outcome: 'quoted', candidate, evidence } satisfies SwapAdapterResult;
    },
  };
}

export function failingAdapter(id: SwapAdapterId, outcome: SwapAdapterFailure['outcome'] = 'unavailable'): SwapRouteAdapter {
  return {
    id,
    supports: () => true,
    quote: async () => ({ outcome, provider: id, errorCode: `${id}_fixture_failure`, retryable: true }),
  };
}
