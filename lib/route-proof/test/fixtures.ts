import {
  ExecutionBlueprintV1Schema,
  EvidenceRecordV1Schema,
  EvidenceSetV1Schema,
  RouteCandidateV1Schema,
  RouteIntentV1Schema,
  RouteProofV1Schema,
  ZERO_HASH_V1,
  findLiquidityOverlapsV1,
  hashApprovedCallsV1,
  hashEvidenceRecordV1,
  hashEvidenceSetV1,
  hashExecutionBlueprintV1,
  hashRouteCandidateV1,
  hashRouteIntentV1,
  hashRouteProofV1,
  nextRouteProofEventV1,
  stableHashV1,
  type AssetRefV1,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type ExecutionBlueprintV1,
  type ExecutionCallV1,
  type RouteCandidateV1,
  type RouteIntentV1,
  type RouteProofEventV1,
  type RouteProofV1,
  type TransactionReceiptV1,
} from '@mioagent/route-domain';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';
import type { BaseReceiptReader, VerifiedReceiptLogV1, VerifiedReceiptSourceV1 } from '../src/receipts.js';
import { CANONICAL_BASE_USDC, CANONICAL_BASE_WETH, ERC20_TRANSFER_TOPIC0 } from '../src/constants.js';

export const NOW = new Date('2026-07-18T12:00:00.000Z');
export const WALLET = '0x1111111111111111111111111111111111111111' as const;
export const TENANT = 'tenant-t58-fixture';
export const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;
export const POOL = '0x2222222222222222222222222222222222222222' as const;

export const USDC_BASE: AssetRefV1 = {
  assetId: `eip155:8453/erc20:${CANONICAL_BASE_USDC}`,
  chainId: 8453,
  kind: 'erc20',
  address: CANONICAL_BASE_USDC,
  symbol: 'USDC',
  decimals: 6,
};
export const WETH_BASE: AssetRefV1 = {
  assetId: `eip155:8453/erc20:${CANONICAL_BASE_WETH}`,
  chainId: 8453,
  kind: 'erc20',
  address: CANONICAL_BASE_WETH,
  symbol: 'WETH',
  decimals: 18,
};
export const ETH_BASE: AssetRefV1 = {
  assetId: 'eip155:8453/native',
  chainId: 8453,
  kind: 'native',
  address: null,
  symbol: 'ETH',
  decimals: 18,
};
export const ARBITRARY_TOKEN: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x9999999999999999999999999999999999999999',
  chainId: 8453,
  kind: 'erc20',
  address: '0x9999999999999999999999999999999999999999',
  symbol: 'ARB',
  decimals: 18,
};

/** Deterministic Route Proof id from a blueprint id — mirrors
 * transaction-composer's `routeProofIdV1` (kept independent on purpose; see
 * src/reconciler.ts for the rationale). */
export function fixtureRouteProofIdV1(blueprintId: string): string {
  return `route-proof:${stableHashV1('route-proof-id/v1', { blueprintId }).slice(2)}`;
}

export function buildIntent(
  overrides: { id?: string; toAsset?: AssetRefV1; amountAtomic?: string } = {},
): RouteIntentV1 {
  const toAsset = overrides.toAsset ?? WETH_BASE;
  const amountAtomic = overrides.amountAtomic ?? '100000000';
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id: overrides.id ?? 'intent-t58-fixture',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'swap',
    fromAsset: USDC_BASE,
    toAsset,
    amount: { asset: USDC_BASE, amountAtomic, amountDecimal: '100' },
    optimizationMode: 'best_net_result',
    verificationDepth: 'standard',
    protocolConstraint: { mode: 'any', protocols: [] },
    slippageConstraint: { maxBps: 50, source: 'user' },
    executionRequested: false,
  };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

export function buildCandidate(intent: RouteIntentV1, overrides: { outputExpectedAtomic?: string; outputMinimumAtomic?: string } = {}): RouteCandidateV1 {
  const outputExpectedAtomic = overrides.outputExpectedAtomic ?? '38000000000000000';
  const outputMinimumAtomic = overrides.outputMinimumAtomic ?? '37810000000000000';
  const draft: RouteCandidateV1 = {
    schemaVersion: 'route-candidate/v1',
    id: 'candidate-t58-fixture',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'selected',
    intentHash: intent.intentHash,
    candidateHash: ZERO_HASH_V1,
    provider: { id: 'uniswap', displayName: 'Uniswap', kind: 'dex', operator: 'Uniswap Labs' },
    providerQuoteId: 'uni-quote-t58-fixture',
    routeType: 'swap',
    inputAmount: intent.amount,
    expectedOutput: { asset: intent.toAsset!, amountAtomic: outputExpectedAtomic, amountDecimal: '0.038' },
    minimumOutput: { asset: intent.toAsset!, amountAtomic: outputMinimumAtomic, amountDecimal: '0.03781' },
    priceImpact: { bps: 8, percent: '0.08' },
    slippage: { bps: 50, percent: '0.5' },
    estimatedGas: { gasUnits: '190000', maxFeePerGasWei: '1500000000', estimatedCostNative: '0.000285', estimatedCostUsd: '0.71' },
    callCount: 2,
    approvalCount: 1,
    quoteObservedAt: NOW.toISOString(),
    quoteExpiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    liquiditySources: [
      {
        sourceKey: `eip155:8453/uniswap-v3:${POOL}`,
        chainId: 8453,
        protocol: 'uniswap-v3',
        poolAddress: POOL,
        assets: [USDC_BASE, intent.toAsset!],
        upstreamProvider: 'uniswap-v3',
      },
    ],
    trustMetadata: {
      integrationKind: 'http_api',
      operator: 'Uniswap Labs',
      verifiedIntegration: true,
      riskFlags: [],
      usesExternalAggregators: false,
      sourceIndependence: 'independent',
    },
  };
  return RouteCandidateV1Schema.parse({ ...draft, candidateHash: hashRouteCandidateV1(draft) });
}

export function buildEvidence(intent: RouteIntentV1, candidate: RouteCandidateV1): EvidenceRecordV1 {
  const draft: EvidenceRecordV1 = {
    schemaVersion: 'evidence-record/v1',
    id: 'evidence-t58-fixture',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'observed',
    intentHash: intent.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceHash: ZERO_HASH_V1,
    evidenceType: 'quote',
    provider: { id: 'uniswap', displayName: 'Uniswap', kind: 'dex', operator: 'Uniswap Labs' },
    observedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    blockNumber: '33123456',
    requestHash: stableHashV1('fixture/request/v1', { id: 'evidence-t58-fixture' }),
    responseHash: stableHashV1('fixture/response/v1', { id: 'evidence-t58-fixture' }),
    assets: [USDC_BASE, intent.toAsset!],
    pools: [],
    liquiditySources: [],
    freeOrPaid: 'free',
    cost: null,
    intelligenceChargeId: null,
    validationStatus: 'valid',
    validationErrors: [],
  };
  return EvidenceRecordV1Schema.parse({ ...draft, evidenceHash: hashEvidenceRecordV1(draft) });
}

export function buildEvidenceSet(intent: RouteIntentV1, candidate: RouteCandidateV1, evidence: EvidenceRecordV1): EvidenceSetV1 {
  const draft: EvidenceSetV1 = {
    schemaVersion: 'evidence-set/v1',
    id: 'evidence-set-t58-fixture',
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

export function buildApprovedBlueprint(input: {
  intent: RouteIntentV1;
  candidate: RouteCandidateV1;
  evidenceSet: EvidenceSetV1;
  id?: string;
}): ExecutionBlueprintV1 {
  const { intent, candidate, evidenceSet } = input;
  const id = input.id ?? 'blueprint-t58-fixture';
  const calls: ExecutionCallV1[] = [
    {
      index: 0,
      callType: 'approval',
      to: USDC_BASE.address as `0x${string}`,
      valueWei: '0',
      data: '0x095ea7b3',
      asset: USDC_BASE,
      amountAtomic: intent.amount.amountAtomic,
      recipient: null,
      spender: ROUTER,
    },
    {
      index: 1,
      callType: 'swap',
      to: ROUTER,
      valueWei: '0',
      data: '0x12345678',
      asset: null,
      amountAtomic: null,
      recipient: null,
      spender: null,
    },
  ];
  const callsHash = hashApprovedCallsV1(calls);
  const draft: ExecutionBlueprintV1 = {
    schemaVersion: 'execution-blueprint/v1',
    goal: 'swap',
    id,
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'approved',
    intentHash: intent.intentHash,
    selectedCandidateHash: candidate.candidateHash,
    evidenceSetHash: evidenceSet.evidenceSetHash,
    blueprintHash: ZERO_HASH_V1,
    callsHash,
    approvedCallsHash: callsHash,
    quoteExpiry: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    calls,
    expectedAssetChanges: [
      {
        asset: USDC_BASE,
        direction: 'debit',
        amountAtomic: intent.amount.amountAtomic,
        minimumAmountAtomic: intent.amount.amountAtomic,
        maximumAmountAtomic: intent.amount.amountAtomic,
      },
      {
        asset: candidate.expectedOutput.asset,
        direction: 'credit',
        amountAtomic: candidate.expectedOutput.amountAtomic,
        minimumAmountAtomic: candidate.minimumOutput.amountAtomic,
        maximumAmountAtomic: null,
      },
    ],
    requiredApprovals: [
      {
        asset: USDC_BASE,
        spender: ROUTER,
        amountAtomic: intent.amount.amountAtomic,
        approvalKind: 'exact',
        state: 'satisfied',
      },
    ],
    simulationState: {
      status: 'unavailable',
      observedAt: null,
      blockNumber: null,
      requestHash: null,
      responseHash: null,
      errorCode: 'no_simulation_provider',
    },
    atomicRequired: true,
  };
  return ExecutionBlueprintV1Schema.parse({ ...draft, blueprintHash: hashExecutionBlueprintV1(draft) });
}

export function buildPendingProof(
  blueprint: ExecutionBlueprintV1,
  overrides: { transactionHashes?: `0x${string}`[]; receipts?: TransactionReceiptV1[] } = {},
): RouteProofV1 {
  const outputChange = blueprint.expectedAssetChanges.find((change) => change.direction === 'credit')!;
  const transactionHashes = overrides.transactionHashes ?? [];
  const receipts: TransactionReceiptV1[] =
    overrides.receipts ??
    transactionHashes.map((hash) => ({ transactionHash: hash, status: 'unknown' as const, blockNumber: null, gasUsed: null }));
  const draft: RouteProofV1 = {
    schemaVersion: 'route-proof/v1',
    id: fixtureRouteProofIdV1(blueprint.id),
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'pending',
    intentHash: blueprint.intentHash,
    selectedCandidateHash: blueprint.selectedCandidateHash,
    evidenceSetHash: blueprint.evidenceSetHash,
    blueprintHash: blueprint.blueprintHash,
    approvedCallsHash: blueprint.approvedCallsHash!,
    proofHash: ZERO_HASH_V1,
    approvedCalls: blueprint.calls,
    expectedResult: {
      assetChanges: blueprint.expectedAssetChanges,
      outputAmountAtomic: outputChange.amountAtomic,
      outputAsset: outputChange.asset,
    },
    actualResult: null,
    estimatedGas: { gasUnits: '190000', maxFeePerGasWei: '1500000000', estimatedCostNative: '0.000285', estimatedCostUsd: '0.71' },
    actualGas: null,
    deviation: { outputBps: null, gasCostUsd: null, withinTolerance: null },
    transactionHashes,
    receipts,
    finalStatus: 'pending',
    reconciliationState: 'pending',
  };
  return RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });
}

export interface SeededRouteProofFixture {
  repository: RouteStorageRepository;
  intent: RouteIntentV1;
  candidate: RouteCandidateV1;
  evidence: EvidenceRecordV1;
  evidenceSet: EvidenceSetV1;
  blueprint: ExecutionBlueprintV1;
  proof: RouteProofV1;
  events: RouteProofEventV1[];
}

/** Seeds an InMemoryRouteStorageRepository with a full, hash-linked, already
 * APPROVED blueprint and a PENDING Route Proof — the exact state T57 leaves
 * behind right before T58's reconciliation takes over. */
export async function seedRouteProofFixture(
  overrides: {
    toAsset?: AssetRefV1;
    outputExpectedAtomic?: string;
    outputMinimumAtomic?: string;
    transactionHashes?: `0x${string}`[];
    receipts?: TransactionReceiptV1[];
    blueprintId?: string;
  } = {},
): Promise<SeededRouteProofFixture> {
  const intent = buildIntent({ toAsset: overrides.toAsset });
  const candidate = buildCandidate(intent, {
    outputExpectedAtomic: overrides.outputExpectedAtomic,
    outputMinimumAtomic: overrides.outputMinimumAtomic,
  });
  const evidence = buildEvidence(intent, candidate);
  const evidenceSet = buildEvidenceSet(intent, candidate, evidence);
  const blueprint = buildApprovedBlueprint({ intent, candidate, evidenceSet, id: overrides.blueprintId });
  const proof = buildPendingProof(blueprint, {
    transactionHashes: overrides.transactionHashes,
    receipts: overrides.receipts,
  });

  const repository = new InMemoryRouteStorageRepository();
  await repository.createRouteRun(intent, `${intent.id}:idempotency`);
  await repository.insertCandidate(intent.id, candidate);
  await repository.insertEvidence(intent.id, candidate.id, evidence);
  await repository.insertEvidenceSet(intent.id, candidate.id, evidenceSet);
  await repository.insertBlueprint(intent.id, blueprint);
  await repository.upsertProofProjection(intent.id, proof);

  const events: RouteProofEventV1[] = [];
  const approvedEvent = nextRouteProofEventV1({
    proof,
    existingEvents: events,
    eventType: 'calls_approved',
    payload: { blueprintId: blueprint.id, blueprintHash: blueprint.blueprintHash, approvedCallsHash: blueprint.approvedCallsHash },
    now: NOW,
  })!;
  await repository.appendProofEvent(proof.id, approvedEvent);
  events.push(approvedEvent);

  if (overrides.transactionHashes && overrides.transactionHashes.length > 0) {
    const submittedEvent = nextRouteProofEventV1({
      proof,
      existingEvents: events,
      eventType: 'submitted',
      payload: { batchId: 'batch-t58-fixture', status: 'submitted' },
      now: NOW,
    })!;
    await repository.appendProofEvent(proof.id, submittedEvent);
    events.push(submittedEvent);

    const receiptObservedEvent = nextRouteProofEventV1({
      proof,
      existingEvents: events,
      eventType: 'receipt_observed',
      payload: { batchId: 'batch-t58-fixture', transactionHashes: overrides.transactionHashes, receiptsRaw: [] },
      now: NOW,
    })!;
    await repository.appendProofEvent(proof.id, receiptObservedEvent);
    events.push(receiptObservedEvent);
  }

  return { repository, intent, candidate, evidence, evidenceSet, blueprint, proof, events };
}

function padAddressTopic(address: `0x${string}`): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`;
}

/** Builds a well-formed ERC-20 Transfer log for use in a
 * VerifiedReceiptSourceV1's `logs`. */
export function transferLog(token: `0x${string}`, from: `0x${string}`, to: `0x${string}`, value: bigint): VerifiedReceiptLogV1 {
  return {
    address: token.toLowerCase(),
    topics: [ERC20_TRANSFER_TOPIC0, padAddressTopic(from), padAddressTopic(to)],
    data: `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`,
  };
}

/** A verified success receipt for a swap: USDC leaves the wallet (to the
 * router), WETH arrives at the wallet (from the pool). */
export function successSwapReceiptSource(input: {
  transactionHash: `0x${string}`;
  usdcAmountAtomic: string;
  wethAmountAtomic: string;
  blockNumber?: bigint;
  gasUsed?: bigint;
  effectiveGasPriceWei?: bigint | null;
}): VerifiedReceiptSourceV1 {
  return {
    transactionHash: input.transactionHash,
    status: 'success',
    blockNumber: input.blockNumber ?? BigInt(33123499),
    gasUsed: input.gasUsed ?? BigInt(185000),
    effectiveGasPriceWei: input.effectiveGasPriceWei === undefined ? BigInt(1200000000) : input.effectiveGasPriceWei,
    logs: [
      transferLog(CANONICAL_BASE_USDC as `0x${string}`, WALLET, ROUTER, BigInt(input.usdcAmountAtomic)),
      transferLog(CANONICAL_BASE_WETH as `0x${string}`, POOL, WALLET, BigInt(input.wethAmountAtomic)),
    ],
  };
}

export function revertedReceiptSource(input: {
  transactionHash: `0x${string}`;
  blockNumber?: bigint;
  gasUsed?: bigint;
  effectiveGasPriceWei?: bigint | null;
}): VerifiedReceiptSourceV1 {
  return {
    transactionHash: input.transactionHash,
    status: 'reverted',
    blockNumber: input.blockNumber ?? BigInt(33123500),
    gasUsed: input.gasUsed ?? BigInt(45000),
    effectiveGasPriceWei: input.effectiveGasPriceWei === undefined ? BigInt(1200000000) : input.effectiveGasPriceWei,
    logs: [],
  };
}

/** In-memory mock BaseReceiptReader: hash -> source (or null = unavailable). */
export function mockReceiptReader(
  sources: Record<string, VerifiedReceiptSourceV1 | null>,
): BaseReceiptReader & { calls: `0x${string}`[] } {
  const calls: `0x${string}`[] = [];
  return {
    calls,
    async getTransactionReceipt(hash) {
      calls.push(hash);
      return Object.prototype.hasOwnProperty.call(sources, hash) ? sources[hash]! : null;
    },
  };
}

export const TX_HASH_1 = `0x${'ab'.repeat(32)}` as const;
export const TX_HASH_2 = `0x${'cd'.repeat(32)}` as const;
