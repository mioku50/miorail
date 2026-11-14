import {
  EvidenceSetV1Schema,
  PathScoreDimensionV1Schema,
  PathScoreV1Schema,
  RouteCardV1Schema,
  RouteIntentV1Schema,
  ZERO_HASH_V1,
  findLiquidityOverlapsV1,
  hashEvidenceSetV1,
  hashPathScoreDimensionV1,
  hashPathScoreV1,
  hashRouteCardV1,
  hashRouteIntentV1,
  stableHashV1,
  type AssetRefV1,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type PathScoreDimensionV1,
  type PathScoreDimensionNameV1,
  type PathScoreV1,
  type RouteCandidateV1,
  type RouteCardV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import { InMemoryRouteStorageRepository, type RouteStorageRepository } from '@mioagent/route-storage';
import {
  KYBERSWAP_PROVIDER_V1,
  UNISWAP_PROVIDER_V1,
  atomicToHumanDecimal,
  buildQuoteArtifacts,
  humanDecimalToAtomic,
} from '@mioagent/swap-adapters';
import type { ExecutionTokenSecurityResult } from '@mioagent/security';
import { encodeKyberSwapV1, KYBERSWAP_NATIVE_TOKEN_V1 } from '@mioagent/security/kyberRouterCalldata';
import { encodeUniswapExecuteV1, encodeUniswapV3PathV1, type UniswapCommandV1 } from '@mioagent/security/uniswapRouterCalldata';
import type { SwapAdapterId, SwapAdapterQuoteInput, SwapAdapterResult, SwapRouteAdapter } from '@mioagent/swap-adapters';
import type { SwapBuildAdapter, SwapBuildInput, SwapBuildProviderId, SwapBuildResultV1 } from '../src/types.js';

export const NOW = new Date('2026-07-16T12:00:00.000Z');
export const WALLET = '0x1111111111111111111111111111111111111111' as const;
export const TENANT = 'tenant-t56';
export const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;

export const USDC_BASE: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  chainId: 8453,
  kind: 'erc20',
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  symbol: 'USDC',
  decimals: 6,
};
export const ETH_BASE: AssetRefV1 = {
  assetId: 'eip155:8453/native',
  chainId: 8453,
  kind: 'native',
  address: null,
  symbol: 'ETH',
  decimals: 18,
};
export const WETH_BASE: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x4200000000000000000000000000000000000006',
  chainId: 8453,
  kind: 'erc20',
  address: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  decimals: 18,
};

export function makeIntent(
  overrides: Partial<{
    id: string;
    fromAsset: AssetRefV1;
    toAsset: AssetRefV1;
    verificationDepth: RouteIntentV1['verificationDepth'];
    amountDecimal: string;
    protocolConstraint: RouteIntentV1['protocolConstraint'];
    slippageBps: number;
    status: RouteIntentV1['status'];
  }> = {},
): RouteIntentV1 {
  const toAsset = overrides.toAsset ?? ETH_BASE;
  const fromAsset = overrides.fromAsset ?? USDC_BASE;
  const amountDecimal = overrides.amountDecimal ?? '100';
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id: overrides.id ?? 'intent-t56-fixture',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: '2026-07-16T11:59:00.000Z',
    updatedAt: '2026-07-16T11:59:00.000Z',
    status: overrides.status ?? 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'swap',
    fromAsset,
    toAsset,
    amount: {
      asset: fromAsset,
      amountAtomic: humanDecimalToAtomic(amountDecimal, fromAsset.decimals)!,
      amountDecimal,
    },
    optimizationMode: 'best_net_result',
    verificationDepth: overrides.verificationDepth ?? 'standard',
    protocolConstraint: overrides.protocolConstraint ?? { mode: 'any', protocols: [] },
    slippageConstraint: { maxBps: overrides.slippageBps ?? 50, source: 'user' },
    executionRequested: false,
  };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

export function makeCandidateAndEvidence(
  intent: RouteIntentV1,
  provider: 'uniswap' | 'kyberswap',
  overrides: Partial<{
    expectedOutputAtomic: string;
    providerMinimumOutputAtomic: string;
    expiresAt: string;
    requestId: string;
    providerOverride: { id: string; displayName: string; kind: 'aggregator' | 'dex' | 'protocol' | 'data_provider' | 'simulation' | 'internal'; operator: string };
  }> = {},
): { candidate: RouteCandidateV1; evidence: EvidenceRecordV1 } {
  const expectedOutputAtomic = overrides.expectedOutputAtomic ?? (provider === 'uniswap' ? '38000000000000000' : '38100000000000000');
  const providerMinimumOutputAtomic =
    overrides.providerMinimumOutputAtomic ?? ((BigInt(expectedOutputAtomic) * 995n) / 1000n).toString();
  const observedAt = NOW.toISOString();
  const expiresAt = overrides.expiresAt ?? new Date(NOW.getTime() + 5 * 60_000).toISOString();
  const requestId = overrides.requestId ?? `${provider}-request`;
  const requestHash = stableHashV1('fixture/request/v1', { provider, requestId });
  const responseHash = stableHashV1('fixture/response/v1', { provider, requestId, expectedOutputAtomic });
  const artifacts = buildQuoteArtifacts({
    adapterId: provider,
    intent,
    provider: overrides.providerOverride ?? (provider === 'uniswap' ? UNISWAP_PROVIDER_V1 : KYBERSWAP_PROVIDER_V1),
    requestId,
    providerQuoteId: `${provider}-quote-1`,
    requestHash,
    responseHash,
    expectedOutputAtomic,
    providerMinimumOutputAtomic,
    gas: { gasUnits: '190000', maxFeePerGasWei: '1500000000', estimatedCostNative: '0.000285', estimatedCostUsd: '0.71' },
    priceImpactBps: 10,
    observedAt,
    expiresAt,
    blockNumber: '33123456',
    provenance: { pools: [], liquiditySources: [] },
    riskFlags: [],
    usesExternalAggregators: provider === 'kyberswap',
    sourceIndependence: 'independent',
  });
  return artifacts;
}

function notScoredDimension(
  dimension: PathScoreDimensionNameV1,
  intent: RouteIntentV1,
  candidate: RouteCandidateV1,
  evidenceSet: EvidenceSetV1,
): PathScoreDimensionV1 {
  const draft: PathScoreDimensionV1 = {
    schemaVersion: 'path-score-dimension/v1',
    id: `dimension-${dimension}-${candidate.id}`,
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'not_scored',
    intentHash: intent.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceSetHash: evidenceSet.evidenceSetHash,
    dimensionHash: ZERO_HASH_V1,
    dimension,
    score: null,
    notScoredReason: 'not_requested',
    confidence: null,
    sources: [],
    freshness: null,
    scoringVersion: 't56-fixture/v1',
    missingEvidence: [],
  };
  return PathScoreDimensionV1Schema.parse({ ...draft, dimensionHash: hashPathScoreDimensionV1(draft) });
}

export function makeEvidenceSet(intent: RouteIntentV1, candidate: RouteCandidateV1, evidence: EvidenceRecordV1): EvidenceSetV1 {
  const draft: EvidenceSetV1 = {
    schemaVersion: 'evidence-set/v1',
    id: `evidence-set-${candidate.id}`,
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'complete',
    intentHash: intent.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceSetHash: ZERO_HASH_V1,
    records: [evidence],
    requiredEvidence: ['quote'],
    missingEvidence: [],
    sourceIndependence: candidate.trustMetadata.sourceIndependence,
    overlapGroups: findLiquidityOverlapsV1([evidence]),
  };
  return EvidenceSetV1Schema.parse({ ...draft, evidenceSetHash: hashEvidenceSetV1(draft) });
}

export function makePathScore(intent: RouteIntentV1, candidate: RouteCandidateV1, evidenceSet: EvidenceSetV1): PathScoreV1 {
  const dimensions = [
    notScoredDimension('net_result', intent, candidate, evidenceSet),
    notScoredDimension('quote_freshness', intent, candidate, evidenceSet),
    notScoredDimension('route_simplicity', intent, candidate, evidenceSet),
    notScoredDimension('transaction_safety', intent, candidate, evidenceSet),
  ];
  const draft: PathScoreV1 = {
    schemaVersion: 'path-score/v1',
    id: `path-score-${candidate.id}`,
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'not_scored',
    intentHash: intent.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceSetHash: evidenceSet.evidenceSetHash,
    pathScoreHash: ZERO_HASH_V1,
    scoringVersion: 't56-fixture/v1',
    dimensions,
  };
  return PathScoreV1Schema.parse({ ...draft, pathScoreHash: hashPathScoreV1(draft) });
}

export interface FixtureScenario {
  intent: RouteIntentV1;
  uniswap: { candidate: RouteCandidateV1; evidence: EvidenceRecordV1; evidenceSet: EvidenceSetV1 };
  kyberswap: { candidate: RouteCandidateV1; evidence: EvidenceRecordV1; evidenceSet: EvidenceSetV1 };
  pathScore: PathScoreV1;
  card: RouteCardV1;
}

export function buildScenario(
  overrides: Partial<{
    fromAsset: AssetRefV1;
    toAsset: AssetRefV1;
    amountDecimal: string;
    verificationDepth: RouteIntentV1['verificationDepth'];
    cardStatus: RouteCardV1['status'];
    cardCreatedAt: string;
    cardExpiresAt: string;
  }> = {},
): FixtureScenario {
  const intent = makeIntent({
    fromAsset: overrides.fromAsset,
    toAsset: overrides.toAsset,
    amountDecimal: overrides.amountDecimal,
    verificationDepth: overrides.verificationDepth,
  });
  const uniswapArtifacts = makeCandidateAndEvidence(intent, 'uniswap');
  const kyberArtifacts = makeCandidateAndEvidence(intent, 'kyberswap', { expectedOutputAtomic: '38050000000000000' });
  const uniswapEvidenceSet = makeEvidenceSet(intent, uniswapArtifacts.candidate, uniswapArtifacts.evidence);
  const kyberEvidenceSet = makeEvidenceSet(intent, kyberArtifacts.candidate, kyberArtifacts.evidence);
  const pathScore = makePathScore(intent, uniswapArtifacts.candidate, uniswapEvidenceSet);

  const cardDraft: RouteCardV1 = {
    schemaVersion: 'route-card/v1',
    id: 'route-card-t56-fixture',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: overrides.cardCreatedAt ?? NOW.toISOString(),
    updatedAt: overrides.cardCreatedAt ?? NOW.toISOString(),
    status: overrides.cardStatus ?? 'ready',
    intentHash: intent.intentHash,
    selectedCandidateHash: uniswapArtifacts.candidate.candidateHash,
    evidenceSetHash: uniswapEvidenceSet.evidenceSetHash,
    pathScoreHash: pathScore.pathScoreHash,
    routeCardHash: ZERO_HASH_V1,
    recommendedCandidate: uniswapArtifacts.candidate,
    alternativeCandidates: [kyberArtifacts.candidate],
    pathScore,
    evidenceSummary: {
      recordCount: 1,
      paidCostUsd: '0',
      missingEvidence: [],
      sourceIndependence: 'independent',
    },
    recommendationReason: 'Fixture: Uniswap recommended for T56 tests.',
    expiresAt: overrides.cardExpiresAt ?? new Date(NOW.getTime() + 5 * 60_000).toISOString(),
  };
  const card = RouteCardV1Schema.parse({ ...cardDraft, routeCardHash: hashRouteCardV1(cardDraft) });

  return {
    intent,
    uniswap: { ...uniswapArtifacts, evidenceSet: uniswapEvidenceSet },
    kyberswap: { ...kyberArtifacts, evidenceSet: kyberEvidenceSet },
    pathScore,
    card,
  };
}

export async function seedRepository(scenario: FixtureScenario): Promise<RouteStorageRepository> {
  const repository = new InMemoryRouteStorageRepository();
  await repository.createRouteRun(scenario.intent, 'idempotency-t56-fixture');
  await repository.insertCandidate(scenario.intent.id, scenario.uniswap.candidate);
  await repository.insertEvidence(scenario.intent.id, scenario.uniswap.candidate.id, scenario.uniswap.evidence);
  await repository.insertEvidenceSet(scenario.intent.id, scenario.uniswap.candidate.id, scenario.uniswap.evidenceSet);
  await repository.insertCandidate(scenario.intent.id, scenario.kyberswap.candidate);
  await repository.insertEvidence(scenario.intent.id, scenario.kyberswap.candidate.id, scenario.kyberswap.evidence);
  await repository.insertEvidenceSet(scenario.intent.id, scenario.kyberswap.candidate.id, scenario.kyberswap.evidenceSet);
  await repository.insertScoreSnapshot(scenario.intent.id, scenario.uniswap.candidate.id, scenario.pathScore);
  await repository.insertRouteCard(scenario.intent.id, scenario.card);
  return repository;
}

export function passingContractSecurity(): (input: {
  chainId: number;
  addresses: `0x${string}`[];
}) => Promise<ExecutionTokenSecurityResult[]> {
  return async (input) =>
    input.addresses.map((address) => ({ address, provider: 'goplus' as const, status: 'ok' as const, summary: 'clean' }));
}

export function failingContractSecurity(): (input: {
  chainId: number;
  addresses: `0x${string}`[];
}) => Promise<ExecutionTokenSecurityResult[]> {
  return async () => [];
}

export function stubQuoteAdapter(
  id: SwapAdapterId,
  handler: (input: SwapAdapterQuoteInput) => Promise<SwapAdapterResult> | SwapAdapterResult,
): SwapRouteAdapter {
  return { id, supports: () => true, quote: async (input) => handler(input) };
}

export function stubBuildAdapter(
  id: SwapBuildProviderId,
  handler: (input: SwapBuildInput) => Promise<SwapBuildResultV1> | SwapBuildResultV1,
): SwapBuildAdapter {
  return { id, build: async (input) => handler(input) };
}

export const USDC_ADDRESS = USDC_BASE.address as `0x${string}`;

export function tokenAmount(asset: AssetRefV1, amountAtomic: string) {
  return { asset, amountAtomic, amountDecimal: atomicToHumanDecimal(amountAtomic, asset.decimals)! };
}

/** Build-side outputs for stub build adapters: expected + slippage-bound minimum. */
export function buildSideOutputs(intent: RouteIntentV1, expectedAtomic: string) {
  const minimumAtomic = ((BigInt(expectedAtomic) * BigInt(10_000 - intent.slippageConstraint.maxBps)) / BigInt(10_000)).toString();
  return {
    expectedOutput: tokenAmount(intent.toAsset!, expectedAtomic),
    minimumOutput: tokenAmount(intent.toAsset!, minimumAtomic),
  };
}

export const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5' as const;
const MSG_SENDER = '0x0000000000000000000000000000000000000001';
const ROUTER_ITSELF = '0x0000000000000000000000000000000000000002';
/** A minimum no test's reviewed minimum reaches: the calldata guarantees at least what the review states. */
export const ROUTER_CALL_MINIMUM_ATOMIC = '1000000000000000000000000';

/**
 * The router call a provider builds for this swap, encoded as the router reads
 * it. Since 2026-11-14 the Safety Kernel decodes Uniswap's and KyberSwap's
 * calls (audit SW-1), so a placeholder selector is no longer a swap.
 */
export function routerCallDataV1(input: {
  router?: `0x${string}`;
  from?: AssetRefV1;
  to?: AssetRefV1;
  amountAtomic: string;
  wallet?: `0x${string}`;
  minimumAtomic?: string;
  deadlineSec?: number;
}): `0x${string}` {
  const router = (input.router ?? ROUTER).toLowerCase();
  const from = input.from ?? USDC_BASE, to = input.to ?? ETH_BASE;
  const amount = BigInt(input.amountAtomic), minimum = BigInt(input.minimumAtomic ?? ROUTER_CALL_MINIMUM_ATOMIC);
  const wallet = input.wallet ?? WALLET;
  // The Trading API names the wallet by the router's MSG_SENDER marker; a test that names a wallet gets it spelled out.
  const payee = input.wallet ?? MSG_SENDER;
  if (router === KYBER_ROUTER) {
    const side = (asset: AssetRefV1) => asset.kind === 'native' ? KYBERSWAP_NATIVE_TOKEN_V1 : asset.address!;
    return encodeKyberSwapV1({ srcToken: side(from), dstToken: side(to), dstReceiver: wallet, amount, minReturnAmount: minimum });
  }
  const weth = '0x4200000000000000000000000000000000000006';
  const token = (asset: AssetRefV1) => asset.kind === 'native' ? weth : asset.address!;
  const commands: UniswapCommandV1[] = [];
  if (from.kind === 'native') commands.push({ command: 'WRAP_ETH', recipient: ROUTER_ITSELF, amount });
  commands.push({ command: 'V3_SWAP_EXACT_IN', recipient: to.kind === 'native' ? ROUTER_ITSELF : payee, amountIn: amount,
    amountOutMin: to.kind === 'native' ? 0n : minimum, path: encodeUniswapV3PathV1([token(from), token(to)], [500]), payerIsUser: from.kind !== 'native' });
  if (to.kind === 'native') commands.push({ command: 'UNWRAP_WETH', recipient: payee, amount: minimum });
  return encodeUniswapExecuteV1(commands, BigInt(input.deadlineSec ?? Math.floor((NOW.getTime() + 5 * 60_000) / 1000)));
}

export function defaultBuiltCalls(input: { amountAtomic: string; router?: `0x${string}`; from?: AssetRefV1; to?: AssetRefV1 }) {
  const router = input.router ?? '0x6ff5693b99212da76ad316178a184ab56d299b43';
  return [
    {
      to: USDC_ADDRESS,
      value: '0',
      data: encodeApprove(router, BigInt(input.amountAtomic)),
    },
    { to: router, value: '0', data: routerCallDataV1({ router, amountAtomic: input.amountAtomic, from: input.from, to: input.to }) },
  ];
}

function encodeApprove(spender: `0x${string}`, amount: bigint): `0x${string}` {
  const selector = '0x095ea7b3';
  const spenderWord = spender.slice(2).toLowerCase().padStart(64, '0');
  const amountWord = amount.toString(16).padStart(64, '0');
  return `${selector}${spenderWord}${amountWord}` as `0x${string}`;
}
