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
import {
  createSwapRouteEngine,
  type SwapRouteEvaluationV1,
} from '@mioagent/route-engine';

export const NOW = new Date('2026-07-15T12:00:00.000Z');
export const WALLET = '0x1111111111111111111111111111111111111111' as const;
const ETH: AssetRefV1 = {
  assetId: 'eip155:8453/native', chainId: 8453, kind: 'native', address: null, symbol: 'ETH', decimals: 18,
};
const USDC: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  chainId: 8453, kind: 'erc20', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6,
};
const PROVIDERS = {
  uniswap: { id: 'uniswap', displayName: 'Uniswap', kind: 'dex', operator: 'Uniswap Labs' },
  kyberswap: { id: 'kyberswap', displayName: 'KyberSwap', kind: 'aggregator', operator: 'Kyber Network' },
} as const;

export function routeCardIntentFixture(
  constrained = false,
  optimizationMode: RouteIntentV1['optimizationMode'] = 'best_net_result',
): RouteIntentV1 {
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1', id: constrained ? 'intent-card-constrained' : 'intent-card-ready',
    tenantId: 'tenant-card', walletAddress: WALLET, chainId: 8453,
    createdAt: '2026-07-15T11:59:00.000Z', updatedAt: '2026-07-15T11:59:00.000Z', status: 'ready',
    intentHash: ZERO_HASH_V1, goal: 'swap', fromAsset: ETH, toAsset: USDC,
    amount: { asset: ETH, amountAtomic: '100000000000000000', amountDecimal: '0.1' },
    optimizationMode, verificationDepth: 'standard',
    protocolConstraint: constrained ? { mode: 'include_only', protocols: ['uniswap'] } : { mode: 'any', protocols: [] },
    slippageConstraint: { maxBps: 50, source: 'user' }, executionRequested: false,
  };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

export function routeCardCandidateFixture(routeIntent: RouteIntentV1, provider: 'uniswap' | 'kyberswap', expiresAt: string): RouteCandidateV1 {
  const output = provider === 'uniswap' ? '250000000' : '251000000';
  const pool = provider === 'uniswap' ? '0x2222222222222222222222222222222222222222' : '0x3333333333333333333333333333333333333333';
  const draft: RouteCandidateV1 = {
    schemaVersion: 'route-candidate/v1', id: `candidate-card-${provider}`, tenantId: routeIntent.tenantId,
    walletAddress: WALLET, chainId: 8453, createdAt: '2026-07-15T11:59:00.000Z', updatedAt: '2026-07-15T11:59:00.000Z',
    status: 'quoted', intentHash: routeIntent.intentHash, candidateHash: ZERO_HASH_V1,
    provider: PROVIDERS[provider], providerQuoteId: `quote-card-${provider}`, routeType: 'swap', inputAmount: routeIntent.amount,
    expectedOutput: { asset: USDC, amountAtomic: output, amountDecimal: provider === 'uniswap' ? '250' : '251' },
    minimumOutput: { asset: USDC, amountAtomic: (BigInt(output) * 995n / 1000n).toString(), amountDecimal: provider === 'uniswap' ? '248.75' : '249.745' },
    estimatedGas: { gasUnits: '180000', maxFeePerGasWei: '1500000000', estimatedCostNative: '0.00027', estimatedCostUsd: '0.50' },
    priceImpact: { bps: 10, percent: '0.1' }, slippage: { bps: 50, percent: '0.5' }, callCount: 1, approvalCount: 0,
    quoteObservedAt: '2026-07-15T11:59:00.000Z', quoteExpiresAt: expiresAt,
    liquiditySources: [{ sourceKey: `eip155:8453/uniswap-v3:${pool}`, chainId: 8453, protocol: 'uniswap-v3', poolAddress: pool, assets: [ETH, USDC], upstreamProvider: 'uniswap-v3' }],
    trustMetadata: { integrationKind: 'http_api', operator: PROVIDERS[provider].operator, verifiedIntegration: true, riskFlags: [], usesExternalAggregators: provider === 'kyberswap', sourceIndependence: 'independent' },
  };
  return RouteCandidateV1Schema.parse({ ...draft, candidateHash: hashRouteCandidateV1(draft) });
}

function quoteEvidence(value: RouteCandidateV1): EvidenceRecordV1 {
  const source = value.liquiditySources[0]!;
  const draft: EvidenceRecordV1 = {
    schemaVersion: 'evidence-record/v1', id: `evidence-card-${value.provider.id}`, tenantId: value.tenantId,
    walletAddress: WALLET, chainId: 8453, createdAt: value.quoteObservedAt, updatedAt: value.quoteObservedAt,
    status: 'observed', intentHash: value.intentHash, candidateHash: value.candidateHash, evidenceHash: ZERO_HASH_V1,
    evidenceType: 'quote', provider: value.provider, observedAt: value.quoteObservedAt, expiresAt: value.quoteExpiresAt,
    blockNumber: '33123456', requestHash: stableHashV1('route-card-test-request/v1', { provider: value.provider.id }),
    responseHash: stableHashV1('route-card-test-response/v1', { candidateHash: value.candidateHash }),
    assets: [value.inputAmount.asset, value.expectedOutput.asset],
    pools: [{ chainId: 8453, address: source.poolAddress!, protocol: source.protocol, feeBps: 5, assets: source.assets }],
    liquiditySources: value.liquiditySources, freeOrPaid: 'free', cost: null, intelligenceChargeId: null,
    validationStatus: 'valid', validationErrors: [],
  };
  return EvidenceRecordV1Schema.parse({ ...draft, evidenceHash: hashEvidenceRecordV1(draft) });
}

export function routeCardQuotedAdapterFixture(id: 'uniswap' | 'kyberswap', value: RouteCandidateV1) {
  return { id, supports: () => true, quote: async () => ({ outcome: 'quoted' as const, candidate: value, evidence: [quoteEvidence(value)] }) };
}

export function routeCardFailedAdapterFixture(id: 'uniswap' | 'kyberswap') {
  return { id, supports: () => true, quote: async () => ({ outcome: 'unavailable' as const, provider: id, errorCode: `${id}_unavailable`, retryable: false }) };
}

export async function readyEvaluation(): Promise<SwapRouteEvaluationV1> {
  const routeIntent = routeCardIntentFixture();
  const uniswap = routeCardCandidateFixture(routeIntent, 'uniswap', '2026-07-15T12:03:00.000Z');
  const kyber = routeCardCandidateFixture(routeIntent, 'kyberswap', '2026-07-15T12:04:00.000Z');
  return createSwapRouteEngine().evaluate({ intent: routeIntent, walletAddress: WALLET, requestId: 'route-card-ready', now: NOW, adapters: [routeCardQuotedAdapterFixture('uniswap', uniswap), routeCardQuotedAdapterFixture('kyberswap', kyber)] });
}

export async function constrainedEvaluation(): Promise<SwapRouteEvaluationV1> {
  const routeIntent = routeCardIntentFixture(true);
  const uniswap = routeCardCandidateFixture(routeIntent, 'uniswap', '2026-07-15T12:03:00.000Z');
  return createSwapRouteEngine().evaluate({ intent: routeIntent, walletAddress: WALLET, requestId: 'route-card-constrained', now: NOW, adapters: [routeCardQuotedAdapterFixture('uniswap', uniswap), routeCardFailedAdapterFixture('kyberswap')] });
}

export async function degradedEvaluation(): Promise<SwapRouteEvaluationV1> {
  const routeIntent = routeCardIntentFixture();
  const uniswap = routeCardCandidateFixture(routeIntent, 'uniswap', '2026-07-15T12:03:00.000Z');
  return createSwapRouteEngine().evaluate({ intent: routeIntent, walletAddress: WALLET, requestId: 'route-card-degraded', now: NOW, adapters: [routeCardQuotedAdapterFixture('uniswap', uniswap), routeCardFailedAdapterFixture('kyberswap')] });
}

export async function failedEvaluation(): Promise<SwapRouteEvaluationV1> {
  const routeIntent = routeCardIntentFixture();
  return createSwapRouteEngine().evaluate({ intent: routeIntent, walletAddress: WALLET, requestId: 'route-card-failed', now: NOW, adapters: [routeCardFailedAdapterFixture('uniswap'), routeCardFailedAdapterFixture('kyberswap')] });
}

export async function unsupportedOptimizationEvaluation(): Promise<SwapRouteEvaluationV1> {
  const routeIntent = routeCardIntentFixture(false, 'lowest_risk');
  const uniswap = routeCardCandidateFixture(routeIntent, 'uniswap', '2026-07-15T12:03:00.000Z');
  const kyber = routeCardCandidateFixture(routeIntent, 'kyberswap', '2026-07-15T12:04:00.000Z');
  return createSwapRouteEngine().evaluate({
    intent: routeIntent,
    walletAddress: WALLET,
    requestId: 'route-card-unsupported-optimization',
    now: NOW,
    adapters: [routeCardQuotedAdapterFixture('uniswap', uniswap), routeCardQuotedAdapterFixture('kyberswap', kyber)],
  });
}
