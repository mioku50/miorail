import {
  RouteCandidateV1Schema,
  RouteProofV1Schema,
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashRouteCandidateV1,
  hashRouteProofV1,
  nextRouteProofEventV1,
  type ExecutionCallV1,
  type RouteCandidateV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from '@mioagent/route-domain';

// Fixtures built through the SAME schemas and hash functions production uses.
// A hand-written proof with an invented hash would let every test here pass
// while the real derivation was broken.

export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const WETH = '0x4200000000000000000000000000000000000006';

export const USDC_ASSET = {
  assetId: `eip155:8453/erc20:${USDC}`,
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: USDC as `0x${string}`,
  symbol: 'USDC',
  decimals: 6,
};

export const WETH_ASSET = {
  assetId: `eip155:8453/erc20:${WETH}`,
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: WETH as `0x${string}`,
  symbol: 'WETH',
  decimals: 18,
};

export function hash(seed: string): `0x${string}` {
  return `0x${seed.repeat(64).slice(0, 64)}` as `0x${string}`;
}

export const WALLET_A = '0x1111111111111111111111111111111111111111' as `0x${string}`;
export const WALLET_B = '0x2222222222222222222222222222222222222222' as `0x${string}`;
export const WALLET_C = '0x3333333333333333333333333333333333333333' as `0x${string}`;

export interface CandidateFixtureInputV1 {
  tenantId?: string;
  walletAddress?: `0x${string}`;
  providerId?: string;
  expectedOutputAtomic?: string;
  minimumOutputAtomic?: string;
  /** Aerodrome-through-Uniswap style provenance. Never a second outcome. */
  liquidityProtocol?: string;
  routeType?: RouteCandidateV1['routeType'];
  now?: Date;
}

export function candidateFixtureV1(input: CandidateFixtureInputV1 = {}): RouteCandidateV1 {
  const now = input.now ?? new Date('2026-07-27T11:00:00.000Z');
  const nowIso = now.toISOString();
  const providerId = input.providerId ?? 'kyberswap';
  const draft: RouteCandidateV1 = {
    schemaVersion: 'route-candidate/v1',
    id: `route-candidate:${providerId}`,
    tenantId: input.tenantId ?? 'tenant-1',
    walletAddress: input.walletAddress ?? WALLET_A,
    chainId: 8453,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'quoted',
    intentHash: hash('a'),
    candidateHash: ZERO_HASH_V1,
    provider: {
      id: providerId,
      displayName: providerId,
      kind: providerId === 'kyberswap' ? 'aggregator' : 'dex',
      operator: providerId,
    },
    providerQuoteId: `quote-${providerId}`,
    routeType: input.routeType ?? 'swap',
    inputAmount: { asset: USDC_ASSET, amountAtomic: '100000000', amountDecimal: '100' },
    expectedOutput: {
      asset: WETH_ASSET,
      amountAtomic: input.expectedOutputAtomic ?? '1000000000000000000',
      amountDecimal: '1',
    },
    minimumOutput: {
      asset: WETH_ASSET,
      amountAtomic: input.minimumOutputAtomic ?? '990000000000000000',
      amountDecimal: '0.99',
    },
    estimatedGas: {
      gasUnits: '200000',
      maxFeePerGasWei: '1000000',
      estimatedCostNative: '200000000000',
      estimatedCostUsd: '0.01',
    },
    priceImpact: { bps: 10, percent: '0.1' },
    slippage: { bps: 50, percent: '0.5' },
    callCount: 2,
    approvalCount: 1,
    quoteObservedAt: nowIso,
    quoteExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    liquiditySources: [
      {
        sourceKey: `${input.liquidityProtocol ?? providerId}:pool-1`,
        chainId: 8453,
        protocol: input.liquidityProtocol ?? providerId,
        poolAddress: null,
        assets: [USDC_ASSET, WETH_ASSET],
        upstreamProvider: input.liquidityProtocol ?? null,
      },
    ],
    trustMetadata: {
      integrationKind: 'http_api',
      operator: providerId,
      verifiedIntegration: true,
      riskFlags: [],
      usesExternalAggregators: providerId === 'kyberswap',
      sourceIndependence: 'independent',
    },
  };
  return RouteCandidateV1Schema.parse({ ...draft, candidateHash: hashRouteCandidateV1(draft) });
}

export interface ProofFixtureInputV1 {
  tenantId?: string;
  walletAddress?: `0x${string}`;
  finalStatus?: RouteProofV1['finalStatus'];
  candidateHash?: `0x${string}`;
  actualOutputAtomic?: string | null;
  proofId?: string;
  now?: Date;
  submittedAt?: Date;
  /** A terminal proof with nothing the reconciler verified. Only reachable for
   * `failed`, which the schema does not require receipts for. */
  noReceipts?: boolean;
}

export function proofFixtureV1(input: ProofFixtureInputV1 = {}): {
  proof: RouteProofV1;
  events: RouteProofEventV1[];
} {
  const now = input.now ?? new Date('2026-07-27T11:00:00.000Z');
  const nowIso = now.toISOString();
  const finalStatus = input.finalStatus ?? 'completed';
  const txHash = hash('1');
  const receipts: RouteProofV1['receipts'] = input.noReceipts
    ? []
    : finalStatus === 'pending' || finalStatus === 'cancelled'
      ? []
      : finalStatus === 'partial_failure'
        ? [
            { transactionHash: txHash, status: 'success', blockNumber: '49000000', gasUsed: '120000' },
            { transactionHash: hash('2'), status: 'reverted', blockNumber: '49000000', gasUsed: '80000' },
          ]
        : finalStatus === 'completed'
          ? [{ transactionHash: txHash, status: 'success', blockNumber: '49000000', gasUsed: '120000' }]
          : [{ transactionHash: txHash, status: 'reverted', blockNumber: '49000000', gasUsed: '80000' }];

  const settled = finalStatus === 'completed' || finalStatus === 'partial_failure';
  const actualOutputAtomic =
    input.actualOutputAtomic === undefined ? '999000000000000000' : input.actualOutputAtomic;

  const approvedCalls: ExecutionCallV1[] = [
    {
      index: 0,
      callType: 'transfer',
      to: USDC as `0x${string}`,
      valueWei: '0',
      data: '0xa9059cbb',
      asset: null,
      amountAtomic: null,
      recipient: null,
      spender: null,
    },
  ];
  const draft: RouteProofV1 = {
    schemaVersion: 'route-proof/v1',
    id: input.proofId ?? 'route-proof:fixture',
    tenantId: input.tenantId ?? 'tenant-1',
    walletAddress: input.walletAddress ?? WALLET_A,
    chainId: 8453,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: finalStatus,
    intentHash: hash('a'),
    selectedCandidateHash: input.candidateHash ?? hash('b'),
    evidenceSetHash: hash('c'),
    blueprintHash: hash('d'),
    approvedCallsHash: hashApprovedCallsV1(approvedCalls),
    proofHash: ZERO_HASH_V1,
    approvedCalls,
    expectedResult: {
      assetChanges: [
        {
          asset: WETH_ASSET,
          direction: 'credit',
          amountAtomic: '1000000000000000000',
          minimumAmountAtomic: '990000000000000000',
          maximumAmountAtomic: null,
        },
      ],
      outputAmountAtomic: '1000000000000000000',
      outputAsset: WETH_ASSET,
    },
    actualResult:
      settled && actualOutputAtomic !== null
        ? {
            assetChanges: [
              {
                asset: WETH_ASSET,
                direction: 'credit',
                amountAtomic: actualOutputAtomic,
                minimumAmountAtomic: null,
                maximumAmountAtomic: null,
              },
            ],
            outputAmountAtomic: actualOutputAtomic,
            outputAsset: WETH_ASSET,
          }
        : settled
          ? { assetChanges: [], outputAmountAtomic: null, outputAsset: null }
          : null,
    estimatedGas: {
      gasUnits: '200000',
      maxFeePerGasWei: '1000000',
      estimatedCostNative: '200000000000',
      estimatedCostUsd: '0.01',
    },
    actualGas: settled
      ? { gasUnits: '198000', maxFeePerGasWei: '1000000', estimatedCostNative: '198000000000', estimatedCostUsd: '0.0099' }
      : null,
    deviation: settled
      ? { outputBps: -10, gasCostUsd: '-0.0001', withinTolerance: true }
      : { outputBps: null, gasCostUsd: null, withinTolerance: null },
    transactionHashes: receipts.map((receipt) => receipt.transactionHash),
    receipts,
    finalStatus,
    reconciliationState:
      finalStatus === 'completed'
        ? 'matched'
        : finalStatus === 'partial_failure'
          ? 'partial'
          : finalStatus === 'failed'
            ? 'failed'
            : finalStatus === 'reconciliation_required'
              ? 'manual_review'
              : 'pending',
  };
  const proof = RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });

  const events: RouteProofEventV1[] = [];
  const push = (
    eventType: RouteProofEventV1['eventType'],
    payload: Record<string, unknown>,
    at: Date,
  ): void => {
    const event = nextRouteProofEventV1({ proof, existingEvents: events, eventType, payload, now: at });
    if (event) events.push(event);
  };
  const submittedAt = input.submittedAt ?? new Date(now.getTime() - 9_000);
  push('blueprint_created', { blueprintId: 'blueprint-1' }, new Date(submittedAt.getTime() - 1_000));
  push('calls_approved', { approvedCallsHash: proof.approvedCallsHash }, submittedAt);
  push('submitted', { batchId: 'batch-1', status: 'submitted' }, submittedAt);
  if (finalStatus === 'completed' || finalStatus === 'partial_failure') {
    push(finalStatus, { finalStatus }, now);
  }
  return { proof, events };
}
