import {
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashEvidenceRecordV1,
  hashEvidenceSetV1,
  hashExecutionBlueprintV1,
  hashIntelligenceChargeV1,
  hashPathScoreDimensionV1,
  hashPathScoreV1,
  hashRouteCandidateV1,
  hashRouteCardV1,
  hashRouteIntentV1,
  hashRouteProofEventPayloadV1,
  hashRouteProofEventV1,
  hashRouteProofV1,
  stableHashV1,
  EvidenceRecordV1Schema,
  EvidenceSetV1Schema,
  ExecutionBlueprintV1Schema,
  IntelligenceChargeV1Schema,
  PathScoreDimensionV1Schema,
  PathScoreV1Schema,
  RouteCandidateV1Schema,
  RouteCardV1Schema,
  RouteIntentV1Schema,
  RouteProofEventV1Schema,
  RouteProofV1Schema,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type ExecutionCallV1,
  type ExecutionBlueprintV1,
  type IntelligenceChargeV1,
  type AssetRefV1,
  type LiquiditySourceRefV1,
  type PathScoreDimensionV1,
  type PathScoreDimensionNameV1,
  type PathScoreV1,
  type RouteCandidateV1,
  type RouteCardV1,
  type RouteIntentV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from '../src/index.js';

export const FIXTURE_TIME = '2026-07-15T09:00:00.000Z';
export const FIXTURE_UPDATED_TIME = '2026-07-15T09:00:01.000Z';
export const FIXTURE_QUOTE_EXPIRY = '2026-07-15T09:05:00.000Z';
export const FIXTURE_WALLET = '0x1111111111111111111111111111111111111111';
export const FIXTURE_TENANT = 'tenant-fixture';

export const ETH_BASE = {
  assetId: 'eip155:8453/native',
  chainId: 8453,
  kind: 'native',
  address: null,
  symbol: 'ETH',
  decimals: 18,
} satisfies AssetRefV1;

export const USDC_BASE = {
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  chainId: 8453,
  kind: 'erc20',
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  symbol: 'USDC',
  decimals: 6,
} satisfies AssetRefV1;

export const SHARED_WETH_USDC_POOL = {
  sourceKey: 'eip155:8453/uniswap-v3:0x2222222222222222222222222222222222222222',
  chainId: 8453,
  protocol: 'uniswap-v3',
  poolAddress: '0x2222222222222222222222222222222222222222',
  assets: [ETH_BASE, USDC_BASE],
  upstreamProvider: 'uniswap-v3',
} satisfies LiquiditySourceRefV1;

export const UNISWAP_PROVIDER = {
  id: 'uniswap',
  displayName: 'Uniswap',
  kind: 'dex',
  operator: 'Uniswap Labs',
} as const;

export const KYBERSWAP_PROVIDER = {
  id: 'kyberswap',
  displayName: 'KyberSwap',
  kind: 'aggregator',
  operator: 'Kyber Network',
} as const;

export const INTERNAL_SAFETY_PROVIDER = {
  id: 'miorail-safety',
  displayName: 'Miorail Safety Kernel',
  kind: 'internal',
  operator: 'Miorail',
} as const;

function fixtureHash(label: string) {
  return stableHashV1('fixture/v1', { label });
}

function withIntentHash(draft: RouteIntentV1): RouteIntentV1 {
  const value = { ...draft, intentHash: hashRouteIntentV1(draft) };
  return RouteIntentV1Schema.parse(value);
}

export const validSwapIntentFixture = withIntentHash({
  schemaVersion: 'route-intent/v1',
  id: 'intent-swap-eth-usdc',
  tenantId: FIXTURE_TENANT,
  walletAddress: FIXTURE_WALLET,
  chainId: 8453,
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_UPDATED_TIME,
  status: 'ready',
  intentHash: ZERO_HASH_V1,
  goal: 'swap',
  fromAsset: ETH_BASE,
  toAsset: USDC_BASE,
  amount: {
    asset: ETH_BASE,
    amountAtomic: '500000000000000000',
    amountDecimal: '0.5',
  },
  optimizationMode: 'best_net_result',
  verificationDepth: 'enhanced',
  protocolConstraint: { mode: 'any', protocols: [] },
  slippageConstraint: { maxBps: 50, source: 'user' },
  executionRequested: false,
});

function withCandidateHash(draft: RouteCandidateV1): RouteCandidateV1 {
  const value = { ...draft, candidateHash: hashRouteCandidateV1(draft) };
  return RouteCandidateV1Schema.parse(value);
}

const candidateBase: Omit<
  RouteCandidateV1,
  | 'id'
  | 'provider'
  | 'providerQuoteId'
  | 'expectedOutput'
  | 'minimumOutput'
  | 'estimatedGas'
  | 'trustMetadata'
> = {
  schemaVersion: 'route-candidate/v1',
  tenantId: FIXTURE_TENANT,
  walletAddress: FIXTURE_WALLET,
  chainId: 8453,
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_UPDATED_TIME,
  status: 'quoted',
  intentHash: validSwapIntentFixture.intentHash,
  candidateHash: ZERO_HASH_V1,
  routeType: 'swap',
  inputAmount: validSwapIntentFixture.amount,
  priceImpact: { bps: 8, percent: '0.08' },
  slippage: { bps: 50, percent: '0.5' },
  callCount: 2,
  approvalCount: 0,
  quoteObservedAt: FIXTURE_TIME,
  quoteExpiresAt: FIXTURE_QUOTE_EXPIRY,
  liquiditySources: [SHARED_WETH_USDC_POOL],
};

export const validUniswapCandidateFixture = withCandidateHash({
  ...candidateBase,
  id: 'candidate-uniswap',
  provider: UNISWAP_PROVIDER,
  providerQuoteId: 'uni-quote-fixture-1',
  expectedOutput: {
    asset: USDC_BASE,
    amountAtomic: '1250000000',
    amountDecimal: '1250',
  },
  minimumOutput: {
    asset: USDC_BASE,
    amountAtomic: '1243750000',
    amountDecimal: '1243.75',
  },
  estimatedGas: {
    gasUnits: '190000',
    maxFeePerGasWei: '1500000000',
    estimatedCostNative: '0.000285',
    estimatedCostUsd: '0.71',
  },
  trustMetadata: {
    integrationKind: 'http_api',
    operator: 'Uniswap Labs',
    verifiedIntegration: true,
    riskFlags: [],
    usesExternalAggregators: false,
    sourceIndependence: 'independent',
  },
});

export const validKyberSwapCandidateFixture = withCandidateHash({
  ...candidateBase,
  id: 'candidate-kyberswap',
  provider: KYBERSWAP_PROVIDER,
  providerQuoteId: 'kyber-quote-fixture-1',
  expectedOutput: {
    asset: USDC_BASE,
    amountAtomic: '1252000000',
    amountDecimal: '1252',
  },
  minimumOutput: {
    asset: USDC_BASE,
    amountAtomic: '1245740000',
    amountDecimal: '1245.74',
  },
  estimatedGas: {
    gasUnits: '210000',
    maxFeePerGasWei: '1500000000',
    estimatedCostNative: '0.000315',
    estimatedCostUsd: '0.79',
  },
  trustMetadata: {
    integrationKind: 'http_api',
    operator: 'Kyber Network',
    verifiedIntegration: true,
    riskFlags: ['aggregated-route'],
    usesExternalAggregators: true,
    sourceIndependence: 'overlapping',
  },
});

interface EvidenceFixtureInput {
  id: string;
  candidate: RouteCandidateV1;
  evidenceType: EvidenceRecordV1['evidenceType'];
  provider: EvidenceRecordV1['provider'];
  assets?: EvidenceRecordV1['assets'];
  pools?: EvidenceRecordV1['pools'];
  liquiditySources?: EvidenceRecordV1['liquiditySources'];
  status?: EvidenceRecordV1['status'];
  validationStatus?: EvidenceRecordV1['validationStatus'];
  observedAt?: string;
  expiresAt?: string | null;
  validationErrors?: string[];
}

function evidenceFixture(input: EvidenceFixtureInput): EvidenceRecordV1 {
  const draft: EvidenceRecordV1 = {
    schemaVersion: 'evidence-record/v1',
    id: input.id,
    tenantId: FIXTURE_TENANT,
    walletAddress: FIXTURE_WALLET,
    chainId: 8453,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_UPDATED_TIME,
    status: input.status ?? 'observed',
    intentHash: validSwapIntentFixture.intentHash,
    candidateHash: input.candidate.candidateHash,
    evidenceHash: ZERO_HASH_V1,
    evidenceType: input.evidenceType,
    provider: input.provider,
    observedAt: input.observedAt ?? FIXTURE_TIME,
    expiresAt: input.expiresAt === undefined ? FIXTURE_QUOTE_EXPIRY : input.expiresAt,
    blockNumber: '33123456',
    requestHash: fixtureHash(`${input.id}:request`),
    responseHash: fixtureHash(`${input.id}:response`),
    assets: input.assets ?? [ETH_BASE, USDC_BASE],
    pools: input.pools ?? [],
    liquiditySources: input.liquiditySources ?? [],
    freeOrPaid: 'free',
    cost: null,
    intelligenceChargeId: null,
    validationStatus: input.validationStatus ?? 'valid',
    validationErrors: input.validationErrors ?? [],
  };
  const value = { ...draft, evidenceHash: hashEvidenceRecordV1(draft) };
  return EvidenceRecordV1Schema.parse(value);
}

export const uniswapLiquidityEvidenceFixture = evidenceFixture({
  id: 'evidence-uniswap-liquidity',
  candidate: validUniswapCandidateFixture,
  evidenceType: 'liquidity',
  provider: UNISWAP_PROVIDER,
  liquiditySources: [SHARED_WETH_USDC_POOL],
  pools: [
    {
      chainId: 8453,
      address: SHARED_WETH_USDC_POOL.poolAddress,
      protocol: 'uniswap-v3',
      feeBps: 5,
      assets: [ETH_BASE, USDC_BASE],
    },
  ],
});

export const kyberSwapLiquidityEvidenceFixture = evidenceFixture({
  id: 'evidence-kyberswap-liquidity',
  candidate: validKyberSwapCandidateFixture,
  evidenceType: 'liquidity',
  provider: KYBERSWAP_PROVIDER,
  liquiditySources: [SHARED_WETH_USDC_POOL],
  pools: [
    {
      chainId: 8453,
      address: SHARED_WETH_USDC_POOL.poolAddress,
      protocol: 'uniswap-v3',
      feeBps: 5,
      assets: [ETH_BASE, USDC_BASE],
    },
  ],
});

export const overlappingLiquidityProvenanceFixture = [
  uniswapLiquidityEvidenceFixture,
  kyberSwapLiquidityEvidenceFixture,
] as const;

export const staleEvidenceFixture = evidenceFixture({
  id: 'evidence-stale-kyberswap-quote',
  candidate: validKyberSwapCandidateFixture,
  evidenceType: 'quote',
  provider: KYBERSWAP_PROVIDER,
  status: 'expired',
  validationStatus: 'stale',
  observedAt: '2026-07-15T08:00:00.000Z',
  expiresAt: '2026-07-15T08:05:00.000Z',
  validationErrors: ['quote_expired'],
  liquiditySources: [SHARED_WETH_USDC_POOL],
});

const uniswapQuoteEvidenceFixture = evidenceFixture({
  id: 'evidence-uniswap-quote',
  candidate: validUniswapCandidateFixture,
  evidenceType: 'quote',
  provider: UNISWAP_PROVIDER,
  liquiditySources: [SHARED_WETH_USDC_POOL],
});

const uniswapGasEvidenceFixture = evidenceFixture({
  id: 'evidence-uniswap-gas',
  candidate: validUniswapCandidateFixture,
  evidenceType: 'gas',
  provider: UNISWAP_PROVIDER,
});

const safetyRiskEvidenceFixture = evidenceFixture({
  id: 'evidence-safety-contract-risk',
  candidate: validUniswapCandidateFixture,
  evidenceType: 'contract_risk',
  provider: INTERNAL_SAFETY_PROVIDER,
});

const simulationEvidenceFixture = evidenceFixture({
  id: 'evidence-safety-simulation',
  candidate: validUniswapCandidateFixture,
  evidenceType: 'simulation',
  provider: INTERNAL_SAFETY_PROVIDER,
});

function evidenceSetFixture(
  id: string,
  records: EvidenceRecordV1[],
  requiredEvidence: EvidenceSetV1['requiredEvidence'],
  missingEvidence: EvidenceSetV1['missingEvidence'],
  status: EvidenceSetV1['status'],
): EvidenceSetV1 {
  const sortedRecords = [...records].sort((left, right) =>
    left.evidenceHash.localeCompare(right.evidenceHash),
  );
  const draft: EvidenceSetV1 = {
    schemaVersion: 'evidence-set/v1',
    id,
    tenantId: FIXTURE_TENANT,
    walletAddress: FIXTURE_WALLET,
    chainId: 8453,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_UPDATED_TIME,
    status,
    intentHash: validSwapIntentFixture.intentHash,
    candidateHash: validUniswapCandidateFixture.candidateHash,
    evidenceSetHash: ZERO_HASH_V1,
    records: sortedRecords,
    requiredEvidence,
    missingEvidence,
    sourceIndependence: 'unknown',
    overlapGroups: [],
  };
  const value = { ...draft, evidenceSetHash: hashEvidenceSetV1(draft) };
  return EvidenceSetV1Schema.parse(value);
}

export const missingSafetyEvidenceSetFixture = evidenceSetFixture(
  'evidence-set-missing-safety',
  [uniswapQuoteEvidenceFixture, uniswapLiquidityEvidenceFixture, uniswapGasEvidenceFixture],
  ['quote', 'liquidity', 'gas', 'contract_risk', 'simulation'],
  ['contract_risk', 'simulation'],
  'partial',
);

export const completeEvidenceSetFixture = evidenceSetFixture(
  'evidence-set-complete',
  [
    uniswapQuoteEvidenceFixture,
    uniswapLiquidityEvidenceFixture,
    uniswapGasEvidenceFixture,
    safetyRiskEvidenceFixture,
    simulationEvidenceFixture,
  ],
  ['quote', 'liquidity', 'gas', 'contract_risk', 'simulation'],
  [],
  'complete',
);

function scoreDimensionFixture(
  dimension: PathScoreDimensionNameV1,
  evidenceSet: EvidenceSetV1,
  missingEvidence: PathScoreDimensionV1['missingEvidence'] = [],
  notScoredReason: NonNullable<PathScoreDimensionV1['notScoredReason']> = 'not_requested',
): PathScoreDimensionV1 {
  const draft: PathScoreDimensionV1 = {
    schemaVersion: 'path-score-dimension/v1',
    id: `dimension-${dimension}-${evidenceSet.id}`,
    tenantId: FIXTURE_TENANT,
    walletAddress: FIXTURE_WALLET,
    chainId: 8453,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_UPDATED_TIME,
    status: 'not_scored',
    intentHash: validSwapIntentFixture.intentHash,
    candidateHash: validUniswapCandidateFixture.candidateHash,
    evidenceSetHash: evidenceSet.evidenceSetHash,
    dimensionHash: ZERO_HASH_V1,
    dimension,
    score: null,
    notScoredReason,
    confidence: null,
    sources: [],
    freshness: null,
    scoringVersion: 'path-score/v1-fixture',
    missingEvidence,
  };
  const value = { ...draft, dimensionHash: hashPathScoreDimensionV1(draft) };
  return PathScoreDimensionV1Schema.parse(value);
}

export const notScoredSafetyDimensionFixture = scoreDimensionFixture(
  'transaction_safety',
  missingSafetyEvidenceSetFixture,
  ['contract_risk', 'simulation'],
  'insufficient_evidence',
);

const notScoredDimensions = [
  scoreDimensionFixture('net_result', missingSafetyEvidenceSetFixture),
  scoreDimensionFixture('quote_freshness', missingSafetyEvidenceSetFixture),
  scoreDimensionFixture('route_simplicity', missingSafetyEvidenceSetFixture),
  notScoredSafetyDimensionFixture,
];

function withPathScoreHash(draft: PathScoreV1): PathScoreV1 {
  const value = { ...draft, pathScoreHash: hashPathScoreV1(draft) };
  return PathScoreV1Schema.parse(value);
}

export const pathScoreWithNotScoredFixture = withPathScoreHash({
  schemaVersion: 'path-score/v1',
  id: 'path-score-uniswap-not-scored',
  tenantId: FIXTURE_TENANT,
  walletAddress: FIXTURE_WALLET,
  chainId: 8453,
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_UPDATED_TIME,
  status: 'not_scored',
  intentHash: validSwapIntentFixture.intentHash,
  candidateHash: validUniswapCandidateFixture.candidateHash,
  evidenceSetHash: missingSafetyEvidenceSetFixture.evidenceSetHash,
  pathScoreHash: ZERO_HASH_V1,
  scoringVersion: 'path-score/v1-fixture',
  dimensions: notScoredDimensions,
});

function withRouteCardHash(draft: RouteCardV1): RouteCardV1 {
  const value = { ...draft, routeCardHash: hashRouteCardV1(draft) };
  return RouteCardV1Schema.parse(value);
}

export const validRouteCardFixture = withRouteCardHash({
  schemaVersion: 'route-card/v1',
  id: 'route-card-uniswap',
  tenantId: FIXTURE_TENANT,
  walletAddress: FIXTURE_WALLET,
  chainId: 8453,
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_UPDATED_TIME,
  status: 'ready',
  intentHash: validSwapIntentFixture.intentHash,
  selectedCandidateHash: validUniswapCandidateFixture.candidateHash,
  evidenceSetHash: missingSafetyEvidenceSetFixture.evidenceSetHash,
  pathScoreHash: pathScoreWithNotScoredFixture.pathScoreHash,
  routeCardHash: ZERO_HASH_V1,
  recommendedCandidate: validUniswapCandidateFixture,
  alternativeCandidates: [validKyberSwapCandidateFixture],
  pathScore: pathScoreWithNotScoredFixture,
  evidenceSummary: {
    recordCount: missingSafetyEvidenceSetFixture.records.length,
    paidCostUsd: '0',
    missingEvidence: ['contract_risk', 'simulation'],
    sourceIndependence: 'overlapping',
  },
  recommendationReason:
    'Fixture only: transaction safety is explicitly Not scored, so this card is not executable.',
  expiresAt: FIXTURE_QUOTE_EXPIRY,
});

export const MOCK_EXECUTION_CALLS: ExecutionCallV1[] = [
  {
    index: 0,
    callType: 'deposit',
    to: '0x4200000000000000000000000000000000000006',
    valueWei: '500000000000000000',
    data: '0xd0e30db0',
    asset: ETH_BASE,
    amountAtomic: '500000000000000000',
    recipient: FIXTURE_WALLET,
    spender: null,
  },
  {
    index: 1,
    callType: 'swap',
    to: '0x3333333333333333333333333333333333333333',
    valueWei: '0',
    data: '0x1234',
    asset: ETH_BASE,
    amountAtomic: '500000000000000000',
    recipient: FIXTURE_WALLET,
    spender: null,
  },
];

function withBlueprintHash(draft: ExecutionBlueprintV1): ExecutionBlueprintV1 {
  const value = { ...draft, blueprintHash: hashExecutionBlueprintV1(draft) };
  return ExecutionBlueprintV1Schema.parse(value);
}

export const validBlueprintFixture = withBlueprintHash({
  schemaVersion: 'execution-blueprint/v1',
  goal: 'swap',
  id: 'blueprint-uniswap-fixture',
  tenantId: FIXTURE_TENANT,
  walletAddress: FIXTURE_WALLET,
  chainId: 8453,
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_UPDATED_TIME,
  status: 'ready_for_review',
  intentHash: validSwapIntentFixture.intentHash,
  selectedCandidateHash: validUniswapCandidateFixture.candidateHash,
  evidenceSetHash: completeEvidenceSetFixture.evidenceSetHash,
  blueprintHash: ZERO_HASH_V1,
  callsHash: hashApprovedCallsV1(MOCK_EXECUTION_CALLS),
  approvedCallsHash: null,
  quoteExpiry: FIXTURE_QUOTE_EXPIRY,
  calls: [...MOCK_EXECUTION_CALLS],
  expectedAssetChanges: [
    {
      asset: ETH_BASE,
      direction: 'debit',
      amountAtomic: '500000000000000000',
      minimumAmountAtomic: null,
      maximumAmountAtomic: '500000000000000000',
    },
    {
      asset: USDC_BASE,
      direction: 'credit',
      amountAtomic: '1250000000',
      minimumAmountAtomic: '1243750000',
      maximumAmountAtomic: null,
    },
  ],
  requiredApprovals: [],
  simulationState: {
    status: 'passed',
    observedAt: FIXTURE_TIME,
    blockNumber: '33123456',
    requestHash: fixtureHash('blueprint-simulation-request'),
    responseHash: fixtureHash('blueprint-simulation-response'),
    errorCode: null,
  },
  atomicRequired: true,
});

const EXPECTED_RESULT: RouteProofV1['expectedResult'] = {
  assetChanges: validBlueprintFixture.expectedAssetChanges,
  outputAmountAtomic: '1250000000',
  outputAsset: USDC_BASE,
};

const ACTUAL_RESULT: NonNullable<RouteProofV1['actualResult']> = {
  assetChanges: [
    {
      asset: ETH_BASE,
      direction: 'debit',
      amountAtomic: '500000000000000000',
      minimumAmountAtomic: null,
      maximumAmountAtomic: '500000000000000000',
    },
    {
      asset: USDC_BASE,
      direction: 'credit',
      amountAtomic: '1249000000',
      minimumAmountAtomic: '1243750000',
      maximumAmountAtomic: null,
    },
  ],
  outputAmountAtomic: '1249000000',
  outputAsset: USDC_BASE,
};

function routeProofFixture(
  id: string,
  status: RouteProofV1['status'],
  transactionHashes: RouteProofV1['transactionHashes'],
  receipts: RouteProofV1['receipts'],
  reconciliationState: RouteProofV1['reconciliationState'],
): RouteProofV1 {
  const approvedCalls = [...MOCK_EXECUTION_CALLS];
  const draft: RouteProofV1 = {
    schemaVersion: 'route-proof/v1',
    id,
    tenantId: FIXTURE_TENANT,
    walletAddress: FIXTURE_WALLET,
    chainId: 8453,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_UPDATED_TIME,
    status,
    intentHash: validSwapIntentFixture.intentHash,
    selectedCandidateHash: validUniswapCandidateFixture.candidateHash,
    evidenceSetHash: completeEvidenceSetFixture.evidenceSetHash,
    blueprintHash: validBlueprintFixture.blueprintHash,
    approvedCallsHash: hashApprovedCallsV1(approvedCalls),
    proofHash: ZERO_HASH_V1,
    approvedCalls,
    expectedResult: EXPECTED_RESULT,
    actualResult: ACTUAL_RESULT,
    estimatedGas: validUniswapCandidateFixture.estimatedGas,
    actualGas: {
      gasUnits: '188500',
      maxFeePerGasWei: '1400000000',
      estimatedCostNative: '0.0002639',
      estimatedCostUsd: '0.66',
    },
    deviation: {
      outputBps: -8,
      gasCostUsd: '-0.05',
      withinTolerance: status === 'completed',
    },
    transactionHashes,
    receipts,
    finalStatus: status,
    reconciliationState,
  };
  const value = { ...draft, proofHash: hashRouteProofV1(draft) };
  return RouteProofV1Schema.parse(value);
}

const COMPLETED_TX_HASH = fixtureHash('completed-transaction');
const PARTIAL_TX_HASH_ONE = fixtureHash('partial-transaction-one');
const PARTIAL_TX_HASH_TWO = fixtureHash('partial-transaction-two');

export const completedRouteProofFixture = routeProofFixture(
  'route-proof-completed',
  'completed',
  [COMPLETED_TX_HASH],
  [
    {
      transactionHash: COMPLETED_TX_HASH,
      status: 'success',
      blockNumber: '33123460',
      gasUsed: '188500',
    },
  ],
  'matched',
);

export const partialFailureRouteProofFixture = routeProofFixture(
  'route-proof-partial-failure',
  'partial_failure',
  [PARTIAL_TX_HASH_ONE, PARTIAL_TX_HASH_TWO],
  [
    {
      transactionHash: PARTIAL_TX_HASH_ONE,
      status: 'success',
      blockNumber: '33123461',
      gasUsed: '50000',
    },
    {
      transactionHash: PARTIAL_TX_HASH_TWO,
      status: 'reverted',
      blockNumber: '33123462',
      gasUsed: '138500',
    },
  ],
  'partial',
);

function routeProofEventFixture(
  id: string,
  eventIndex: number,
  eventType: RouteProofEventV1['eventType'],
  previousEventHash: RouteProofEventV1['previousEventHash'],
  payload: RouteProofEventV1['payload'],
): RouteProofEventV1 {
  const payloadHash = hashRouteProofEventPayloadV1(payload);
  const draft: RouteProofEventV1 = {
    schemaVersion: 'route-proof-event/v1',
    id,
    tenantId: FIXTURE_TENANT,
    walletAddress: FIXTURE_WALLET,
    chainId: 8453,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_UPDATED_TIME,
    status: 'recorded',
    intentHash: validSwapIntentFixture.intentHash,
    candidateHash: validUniswapCandidateFixture.candidateHash,
    evidenceSetHash: completeEvidenceSetFixture.evidenceSetHash,
    blueprintHash: validBlueprintFixture.blueprintHash,
    approvedCallsHash: completedRouteProofFixture.approvedCallsHash,
    routeProofId: completedRouteProofFixture.id,
    eventIndex,
    eventType,
    previousEventHash,
    payload,
    payloadHash,
    eventHash: ZERO_HASH_V1,
  };
  const value = { ...draft, eventHash: hashRouteProofEventV1(draft) };
  return RouteProofEventV1Schema.parse(value);
}

const firstRouteProofEvent = routeProofEventFixture(
  'route-proof-event-0',
  0,
  'blueprint_created',
  null,
  { blueprintHash: validBlueprintFixture.blueprintHash },
);

const secondRouteProofEvent = routeProofEventFixture(
  'route-proof-event-1',
  1,
  'completed',
  firstRouteProofEvent.eventHash,
  { proofHash: completedRouteProofFixture.proofHash, transactionHash: COMPLETED_TX_HASH },
);

export const routeProofEventHistoryFixture = [firstRouteProofEvent, secondRouteProofEvent] as const;

function withIntelligenceChargeHash(draft: IntelligenceChargeV1): IntelligenceChargeV1 {
  const value = { ...draft, chargeHash: hashIntelligenceChargeV1(draft) };
  return IntelligenceChargeV1Schema.parse(value);
}

export const settledIntelligenceChargeFixture = withIntelligenceChargeHash({
  schemaVersion: 'intelligence-charge/v1',
  id: 'intelligence-charge-fixture',
  tenantId: FIXTURE_TENANT,
  walletAddress: FIXTURE_WALLET,
  chainId: 8453,
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_UPDATED_TIME,
  status: 'settled',
  intentHash: validSwapIntentFixture.intentHash,
  candidateHash: validUniswapCandidateFixture.candidateHash,
  evidenceSetHash: completeEvidenceSetFixture.evidenceSetHash,
  evidenceHash: safetyRiskEvidenceFixture.evidenceHash,
  chargeHash: ZERO_HASH_V1,
  provider: INTERNAL_SAFETY_PROVIDER,
  service: 'mock-contract-risk-report',
  category: 'risk',
  evidenceType: 'contract_risk',
  fundingMode: 'spend_permission',
  spendPermissionId: 'permission-fixture',
  intelligenceBudgetId: 'budget-fixture',
  reservationId: 'reservation-fixture',
  quotedCost: {
    asset: USDC_BASE,
    amountAtomic: '10000',
    amountDecimal: '0.01',
    usdValue: '0.01',
  },
  maxAuthorizedCost: {
    asset: USDC_BASE,
    amountAtomic: '20000',
    amountDecimal: '0.02',
    usdValue: '0.02',
  },
  chargedCost: {
    asset: USDC_BASE,
    amountAtomic: '10000',
    amountDecimal: '0.01',
    usdValue: '0.01',
  },
  paymentState: 'settled',
  serviceState: 'delivered',
  x402ReceiptHash: fixtureHash('x402-receipt'),
  serviceResponseHash: fixtureHash('intelligence-service-response'),
  idempotencyKey: 't50-intelligence-fixture-1',
});

export const routeDomainFixtures = {
  validSwapIntent: validSwapIntentFixture,
  validUniswapCandidate: validUniswapCandidateFixture,
  validKyberSwapCandidate: validKyberSwapCandidateFixture,
  overlappingLiquidityProvenance: overlappingLiquidityProvenanceFixture,
  staleEvidence: staleEvidenceFixture,
  missingSafetyEvidence: missingSafetyEvidenceSetFixture,
  notScored: notScoredSafetyDimensionFixture,
  validBlueprint: validBlueprintFixture,
  completedRouteProof: completedRouteProofFixture,
  partialFailureRouteProof: partialFailureRouteProofFixture,
} as const;
