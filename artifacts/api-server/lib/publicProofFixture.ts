import {
  RouteProofV1Schema,
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashRouteProofV1,
  nextRouteProofEventV1,
  type ExecutionCallV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// A real RouteProofV1 plus its hash-chained events, for tests.
//
// Built through the SAME schemas and hash functions production uses, so a
// fixture cannot be a shape that production could never produce. That matters
// here more than usual: these tests are about whether a third party can
// recompute the hashes, and a hand-written proof with a made-up `proofHash`
// would let every one of them pass while the real thing was broken.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';

function hash(seed: string): `0x${string}` {
  return `0x${seed.repeat(64).slice(0, 64)}` as `0x${string}`;
}

export interface RouteProofFixtureV1 {
  proof: RouteProofV1;
  events: RouteProofEventV1[];
}

export function routeProofFixtureV1(input: {
  tenantId: string;
  walletAddress: string;
  finalStatus?: RouteProofV1['finalStatus'];
  now?: Date;
}): RouteProofFixtureV1 {
  const now = input.now ?? new Date('2026-07-27T11:00:00.000Z');
  const nowIso = now.toISOString();
  const finalStatus = input.finalStatus ?? 'completed';
  const txHash = hash('1');
  // `completed` requires success receipts and `partial_failure` requires a
  // mixture — the schema enforces both, so the fixture obeys them rather than
  // working around them.
  const receipts: RouteProofV1['receipts'] =
    finalStatus === 'pending'
      ? []
      : finalStatus === 'partial_failure'
        ? [
            { transactionHash: txHash, status: 'success', blockNumber: '49000000', gasUsed: '120000' },
            { transactionHash: hash('2'), status: 'reverted', blockNumber: '49000000', gasUsed: '80000' },
          ]
        : finalStatus === 'completed'
          ? [{ transactionHash: txHash, status: 'success', blockNumber: '49000000', gasUsed: '120000' }]
          : [{ transactionHash: txHash, status: 'reverted', blockNumber: '49000000', gasUsed: '80000' }];

  const asset = {
    assetId: `eip155:8453/erc20:${WETH}`,
    chainId: 8453 as const,
    kind: 'erc20' as const,
    address: WETH as `0x${string}`,
    symbol: 'WETH',
    decimals: 18,
  };
  // The schema checks that approvedCallsHash is the hash OF the calls, so the
  // fixture derives it rather than inventing one.
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
    id: 'route-proof:fixture',
    tenantId: input.tenantId,
    walletAddress: input.walletAddress as `0x${string}`,
    chainId: 8453,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: finalStatus,
    intentHash: hash('a'),
    selectedCandidateHash: hash('b'),
    evidenceSetHash: hash('c'),
    blueprintHash: hash('d'),
    approvedCallsHash: hashApprovedCallsV1(approvedCalls),
    proofHash: ZERO_HASH_V1,
    approvedCalls,
    expectedResult: {
      assetChanges: [
        {
          asset,
          direction: 'credit',
          amountAtomic: '1000000000000000000',
          minimumAmountAtomic: '990000000000000000',
          maximumAmountAtomic: null,
        },
      ],
      outputAmountAtomic: '1000000000000000000',
      outputAsset: asset,
    },
    // A settled proof must carry what actually happened. The schema refuses a
    // `completed` proof with no actual result, which is exactly the guarantee
    // a public bundle depends on.
    actualResult:
      finalStatus === 'pending'
        ? null
        : {
            assetChanges: [
              {
                asset,
                direction: 'credit',
                amountAtomic: '999000000000000000',
                minimumAmountAtomic: null,
                maximumAmountAtomic: null,
              },
            ],
            outputAmountAtomic: '999000000000000000',
            outputAsset: asset,
          },
    estimatedGas: {
      gasUnits: '200000',
      maxFeePerGasWei: '1000000',
      estimatedCostNative: '200000000000',
      estimatedCostUsd: '0.01',
    },
    actualGas:
      finalStatus === 'pending'
        ? null
        : {
            gasUnits: '198000',
            maxFeePerGasWei: '1000000',
            estimatedCostNative: '198000000000',
            estimatedCostUsd: '0.0099',
          },
    deviation:
      finalStatus === 'pending'
        ? { outputBps: null, gasCostUsd: null, withinTolerance: null }
        : { outputBps: -10, gasCostUsd: '-0.0001', withinTolerance: true },
    transactionHashes: receipts.map((receipt) => receipt.transactionHash),
    receipts,
    finalStatus,
    reconciliationState: finalStatus === 'pending' ? 'pending' : 'matched',
  };
  const proof = RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });

  const events: RouteProofEventV1[] = [];
  for (const [eventType, payload] of [
    ['blueprint_created', { blueprintId: 'blueprint-1' }],
    ['calls_approved', { approvedCallsHash: proof.approvedCallsHash }],
    ['submitted', { batchId: 'batch-1', status: 'submitted' }],
  ] as const) {
    const event = nextRouteProofEventV1({
      proof,
      existingEvents: events,
      eventType,
      payload,
      now,
    });
    if (event) events.push(event);
  }
  return { proof, events };
}
