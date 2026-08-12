import {
  EvidenceRecordV1Schema,
  RouteCandidateV1Schema,
  ZERO_HASH_V1,
  hashEvidenceRecordV1,
  hashRouteCandidateV1,
  stableHashV1,
  type EvidenceRecordV1,
  type GasEstimateV1,
  type HashV1,
  type ProviderRefV1,
  type RouteCandidateV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import {
  atomicToHumanDecimal,
  basisPointsToPercentage,
  minimumOutputAtomic,
} from './normalization.js';
import type { RouteProvenanceV1 } from './provenance.js';
import type { SwapAdapterId } from './types.js';

export const UNISWAP_PROVIDER_V1 = {
  id: 'uniswap',
  displayName: 'Uniswap',
  kind: 'dex',
  operator: 'Uniswap Labs',
} as const satisfies ProviderRefV1;

export const KYBERSWAP_PROVIDER_V1 = {
  id: 'kyberswap',
  displayName: 'KyberSwap',
  kind: 'aggregator',
  operator: 'Kyber Network',
} as const satisfies ProviderRefV1;

export interface BuildQuoteArtifactsInput {
  adapterId: SwapAdapterId;
  intent: RouteIntentV1;
  provider: ProviderRefV1;
  requestId: string;
  providerQuoteId: string | null;
  requestHash: HashV1;
  responseHash: HashV1;
  expectedOutputAtomic: string;
  providerMinimumOutputAtomic?: string | null;
  gas: GasEstimateV1;
  priceImpactBps: number | null;
  observedAt: string;
  expiresAt: string;
  blockNumber: string | null;
  provenance: RouteProvenanceV1;
  riskFlags: string[];
  usesExternalAggregators: boolean;
  sourceIndependence: 'independent' | 'overlapping' | 'unknown';
}

export function buildQuoteArtifacts(input: BuildQuoteArtifactsInput): {
  candidate: RouteCandidateV1;
  evidence: EvidenceRecordV1;
} {
  const fromAsset = input.intent.fromAsset;
  const toAsset = input.intent.toAsset;
  if (!fromAsset || !toAsset) throw new TypeError('Ready swap intent must contain both assets');

  const outputDecimal = atomicToHumanDecimal(input.expectedOutputAtomic, toAsset.decimals);
  const derivedMinimumAtomic = minimumOutputAtomic(
    input.expectedOutputAtomic,
    input.intent.slippageConstraint.maxBps,
  );
  if (
    input.providerMinimumOutputAtomic !== undefined &&
    input.providerMinimumOutputAtomic !== null &&
    BigInt(input.providerMinimumOutputAtomic) > BigInt(input.expectedOutputAtomic)
  ) {
    throw new TypeError('Provider minimum output exceeds expected output');
  }
  const minimumAtomic =
    input.providerMinimumOutputAtomic !== undefined &&
    input.providerMinimumOutputAtomic !== null &&
    BigInt(input.providerMinimumOutputAtomic) > BigInt(derivedMinimumAtomic)
      ? input.providerMinimumOutputAtomic
      : derivedMinimumAtomic;
  const minimumDecimal = atomicToHumanDecimal(minimumAtomic, toAsset.decimals);
  if (outputDecimal === null || minimumDecimal === null) {
    throw new TypeError('Provider output cannot be represented with the intent asset decimals');
  }

  const providerQuoteId = input.providerQuoteId?.slice(0, 300) || input.responseHash;
  const candidateId = `candidate:${input.adapterId}:${stableHashV1('swap-adapter/candidate-id/v1', {
    requestId: input.requestId,
    requestHash: input.requestHash,
    responseHash: input.responseHash,
  }).slice(2)}`;
  const callCount = fromAsset.kind === 'native' ? 1 : 2;
  const approvalCount = fromAsset.kind === 'native' ? 0 : 1;
  const candidateDraft: RouteCandidateV1 = {
    schemaVersion: 'route-candidate/v1',
    id: candidateId,
    tenantId: input.intent.tenantId,
    walletAddress: input.intent.walletAddress,
    chainId: 8453,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
    status: 'quoted',
    intentHash: input.intent.intentHash,
    candidateHash: ZERO_HASH_V1,
    provider: input.provider,
    providerQuoteId,
    routeType: 'swap',
    inputAmount: input.intent.amount,
    expectedOutput: {
      asset: toAsset,
      amountAtomic: input.expectedOutputAtomic,
      amountDecimal: outputDecimal,
    },
    minimumOutput: {
      asset: toAsset,
      amountAtomic: minimumAtomic,
      amountDecimal: minimumDecimal,
    },
    estimatedGas: input.gas,
    priceImpact:
      input.priceImpactBps === null
        ? null
        : {
            bps: input.priceImpactBps,
            percent: basisPointsToPercentage(input.priceImpactBps),
          },
    slippage: {
      bps: input.intent.slippageConstraint.maxBps,
      percent: basisPointsToPercentage(input.intent.slippageConstraint.maxBps),
    },
    callCount,
    approvalCount,
    quoteObservedAt: input.observedAt,
    quoteExpiresAt: input.expiresAt,
    liquiditySources: input.provenance.liquiditySources,
    trustMetadata: {
      integrationKind: 'http_api',
      operator: input.provider.operator,
      verifiedIntegration: true,
      riskFlags: [...new Set(input.riskFlags)].sort(),
      usesExternalAggregators: input.usesExternalAggregators,
      sourceIndependence: input.sourceIndependence,
    },
  };
  const candidate = RouteCandidateV1Schema.parse({
    ...candidateDraft,
    candidateHash: hashRouteCandidateV1(candidateDraft),
  });

  const evidenceDraft: EvidenceRecordV1 = {
    schemaVersion: 'evidence-record/v1',
    id: `evidence:${input.adapterId}:${stableHashV1('swap-adapter/evidence-id/v1', {
      candidateHash: candidate.candidateHash,
      responseHash: input.responseHash,
    }).slice(2)}`,
    tenantId: input.intent.tenantId,
    walletAddress: input.intent.walletAddress,
    chainId: 8453,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
    status: 'observed',
    intentHash: input.intent.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceHash: ZERO_HASH_V1,
    evidenceType: 'quote',
    provider: input.provider,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
    blockNumber: input.blockNumber,
    requestHash: input.requestHash,
    responseHash: input.responseHash,
    assets: [fromAsset, toAsset],
    pools: input.provenance.pools,
    liquiditySources: input.provenance.liquiditySources,
    freeOrPaid: 'free',
    cost: null,
    intelligenceChargeId: null,
    validationStatus: 'valid',
    validationErrors: [],
  };
  const evidence = EvidenceRecordV1Schema.parse({
    ...evidenceDraft,
    evidenceHash: hashEvidenceRecordV1(evidenceDraft),
  });
  return { candidate, evidence };
}
