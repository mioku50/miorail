import {
  EvidenceSetV1Schema,
  SafetyKernelResultV1Schema,
  ZERO_HASH_V1,
  findLiquidityOverlapsV1,
  hashEvidenceSetV1,
  stableHashV1,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type ExecutionBlueprintV1,
  type RouteCandidateV1,
  type RouteIntentV1,
  type SafetyKernelResultV1,
  type SimulationStateV1,
} from '@mioagent/route-domain';
import { atomicToHumanDecimal } from '@mioagent/swap-adapters';
import { assembleExecutionBlueprintV1, blueprintIdV1, classifySwapCallV1 } from './blueprint.js';
import { buildTransactionReviewProjectionV1 } from './reviewProjection.js';
import { runSafetyKernel } from './safetyKernel.js';
import {
  blockedResultV1,
  preparedResultV1,
  refreshRequiredResultV1,
  unsupportedResultV1,
  type TransactionComposer,
  type TransactionComposerDependencies,
  type TransactionComposerPrepareInput,
  type TransactionPreparationResultV1,
} from './types.js';

const CANONICAL_USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/** Every binding failure below represents tampered/inconsistent input rather
 * than a legitimate business state — the caller (API route) converts these
 * into a fail-closed 500, never leaking the reason to the client. */
export class TransactionComposerBindingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function isSupportedPair(intent: RouteIntentV1): boolean {
  return (
    intent.chainId === 8453 &&
    intent.fromAsset?.symbol === 'USDC' &&
    intent.fromAsset.address?.toLowerCase() === CANONICAL_USDC_BASE &&
    (intent.toAsset?.symbol === 'ETH' || intent.toAsset?.symbol === 'WETH')
  );
}

function invalidCardSafetyResult(): SafetyKernelResultV1 {
  return SafetyKernelResultV1Schema.parse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict: 'blocked',
    checks: [
      {
        id: 'route_card_state',
        description: 'Route Card must be in a preparable state',
        status: 'failed',
        detail: 'Route Card status is invalid',
      },
    ],
    blockedReason: 'Route Card status is invalid',
  });
}

function buildFreshEvidenceSetV1(
  intent: RouteIntentV1,
  candidate: RouteCandidateV1,
  evidence: readonly EvidenceRecordV1[],
): EvidenceSetV1 {
  const sorted = [...evidence].sort((left, right) => left.evidenceHash.localeCompare(right.evidenceHash));
  const requiredEvidence = [...new Set(sorted.map((record) => record.evidenceType))].sort();
  const id = `evidence-set:${stableHashV1('transaction-composer-evidence-set-id/v1', {
    candidateHash: candidate.candidateHash,
    evidenceHashes: sorted.map((record) => record.evidenceHash),
  }).slice(2)}`;
  const draft: EvidenceSetV1 = {
    schemaVersion: 'evidence-set/v1',
    id,
    tenantId: intent.tenantId,
    walletAddress: intent.walletAddress,
    chainId: intent.chainId,
    createdAt: candidate.quoteObservedAt,
    updatedAt: candidate.quoteObservedAt,
    status: 'complete',
    intentHash: intent.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceSetHash: ZERO_HASH_V1,
    records: sorted,
    requiredEvidence,
    missingEvidence: [],
    sourceIndependence: candidate.trustMetadata.sourceIndependence,
    overlapGroups: findLiquidityOverlapsV1(sorted),
  };
  return EvidenceSetV1Schema.parse({ ...draft, evidenceSetHash: hashEvidenceSetV1(draft) });
}

/** T57: exported so approval.ts can mirror the exact same simulation-honesty
 * mapping when re-validating an already-persisted Blueprint at approve time. */
export function simulationHonesty(intent: RouteIntentV1): { acceptable: boolean; detail: string } {
  const acceptable = intent.verificationDepth === 'standard';
  return {
    acceptable,
    detail: acceptable
      ? 'No fork-simulation provider is configured; only static preflight and calldata checks ran.'
      : 'Enhanced/maximum verification depth requires simulation evidence that no provider currently supplies.',
  };
}

/**
 * T59: standalone extraction of the composer's idempotent-replay review path
 * (previously a private method) so a separate, paid endpoint (transaction
 * simulation) can re-derive the SAME honest review projection over an
 * ALREADY stored, immutable Blueprint — no re-quote/re-build network call,
 * only a fresh contract-security lookup and Safety Kernel re-run — while
 * overriding just the projected simulationState. Behavior for every existing
 * caller (DeterministicTransactionComposer.prepare's replay branch) is
 * unchanged: it calls this with simulationStateOverride left undefined,
 * which falls back to blueprint.simulationState exactly as before this
 * function existed.
 */
export async function reviewStoredBlueprintV1(
  deps: Pick<TransactionComposerDependencies, 'contractSecurity'>,
  input: Pick<TransactionComposerPrepareInput, 'routeRunId' | 'walletAddress'>,
  intent: RouteIntentV1,
  selected: RouteCandidateV1,
  blueprint: ExecutionBlueprintV1,
  now: Date,
  simulationStateOverride?: SimulationStateV1,
): Promise<TransactionPreparationResultV1> {
  const providerId = selected.provider.id as 'uniswap' | 'kyberswap';
  const usdcAsset = intent.fromAsset!;
  const routerCall = blueprint.calls.find((call) => call.callType === 'swap');
  const routerAddress = (routerCall?.to ?? selected.provider.id) as `0x${string}`;

  const simulation = simulationHonesty(intent);
  const contractSecurityAddresses = [usdcAsset.address].filter((value): value is `0x${string}` => Boolean(value));
  const contractSecurityResults = await deps.contractSecurity({
    chainId: intent.chainId,
    addresses: contractSecurityAddresses,
  });
  const contractSecurityProviderName = contractSecurityResults.some((entry) => entry.provider === 'goplus')
    ? 'goplus'
    : (contractSecurityResults[0]?.provider ?? 'none');

  const { result: safety, contractSecurity } = runSafetyKernel({
    provider: providerId,
    routerAddress,
    chainId: intent.chainId,
    walletAddress: input.walletAddress,
    intent,
    calls: blueprint.calls,
    quoteExpiry: blueprint.quoteExpiry,
    now,
    contractSecurityRequired: true,
    contractSecurityProvider: contractSecurityProviderName,
    contractSecurityResults,
    contractSecurityAddresses,
    simulationAcceptable: simulation.acceptable,
    simulationDetail: simulation.detail,
    intentHash: blueprint.intentHash,
    selectedCandidateHash: blueprint.selectedCandidateHash,
  });

  if (safety.verdict === 'blocked') {
    return blockedResultV1(input.routeRunId, safety);
  }

  const outputChange = blueprint.expectedAssetChanges.find((change) => change.direction === 'credit')!;
  const expectedOutput = {
    asset: outputChange.asset,
    amountAtomic: outputChange.amountAtomic,
    amountDecimal: atomicToHumanDecimal(outputChange.amountAtomic, outputChange.asset.decimals) ?? '0',
  };
  const minimumAtomic = outputChange.minimumAmountAtomic ?? outputChange.amountAtomic;
  const minimumOutput = {
    asset: outputChange.asset,
    amountAtomic: minimumAtomic,
    amountDecimal: atomicToHumanDecimal(minimumAtomic, outputChange.asset.decimals) ?? '0',
  };

  const review = buildTransactionReviewProjectionV1({
    routeRunId: input.routeRunId,
    provider: selected.provider,
    input: intent.amount,
    expectedOutput,
    minimumOutput,
    cardExpectedOutput: selected.expectedOutput,
    cardMinimumOutput: selected.minimumOutput,
    blueprint,
    safety,
    contractSecurity,
    simulationWarning: simulation.acceptable ? simulation.detail : null,
    simulationStateOverride,
  });

  return preparedResultV1({ routeRunId: input.routeRunId, blueprint, review });
}

export class DeterministicTransactionComposer implements TransactionComposer {
  constructor(private readonly deps: TransactionComposerDependencies) {}

  async prepare(input: TransactionComposerPrepareInput): Promise<TransactionPreparationResultV1> {
    const now = this.deps.now ? this.deps.now() : input.now;
    const { repository } = this.deps;

    // --- Binding validation (fail closed, no network calls) ------------------
    const run = await repository.getRouteRun(input.routeRunId, input.tenantId);
    if (!run) {
      throw new TransactionComposerBindingError('route_run_not_found', 'Route run does not exist for this tenant');
    }
    if (run.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
      throw new TransactionComposerBindingError('wallet_binding_mismatch', 'walletAddress does not match the route run');
    }
    if (run.chainId !== 8453) {
      throw new TransactionComposerBindingError('unsupported_chain', 'Route run is not on Base mainnet');
    }
    const intent = run.intent;

    const cards = await repository.listRouteCards(input.routeRunId, input.tenantId);
    const card = cards.find((entry) => entry.routeCardHash === input.routeCardHash);
    if (!card) {
      throw new TransactionComposerBindingError('route_card_not_found', 'Route Card hash was not found for this run');
    }
    if (card.intentHash !== run.intentHash) {
      throw new TransactionComposerBindingError(
        'route_card_intent_mismatch',
        'Route Card intent hash does not match the route run',
      );
    }

    const candidatePool: RouteCandidateV1[] = [card.recommendedCandidate, ...card.alternativeCandidates];
    const selected = candidatePool.find((entry) => entry.candidateHash === input.selectedCandidateHash);
    if (!selected) {
      throw new TransactionComposerBindingError(
        'candidate_not_in_card',
        'Selected candidate hash is not part of this Route Card',
      );
    }
    if (
      selected.inputAmount.asset.assetId !== intent.amount.asset.assetId ||
      selected.inputAmount.amountAtomic !== intent.amount.amountAtomic
    ) {
      throw new TransactionComposerBindingError(
        'candidate_intent_mismatch',
        'Selected candidate input does not match the stored intent',
      );
    }

    // --- Graceful business outcomes ------------------------------------------
    if (selected.provider.id !== 'uniswap' && selected.provider.id !== 'kyberswap') {
      return unsupportedResultV1(
        'unsupported_provider',
        `Provider ${selected.provider.id} is not supported for transaction preparation`,
      );
    }
    const providerId = selected.provider.id;

    if (!isSupportedPair(intent)) {
      return unsupportedResultV1('unsupported_pair', 'Only canonical Base USDC to ETH or WETH is supported');
    }

    if (card.status === 'invalid') {
      return blockedResultV1(input.routeRunId, invalidCardSafetyResult());
    }
    if (card.status === 'stale') {
      return refreshRequiredResultV1(input.routeRunId, 'card_expired', 'Route Card is stale and must be refreshed');
    }
    if (card.status !== 'ready' && card.status !== 'selected') {
      throw new TransactionComposerBindingError(
        'unsupported_card_status',
        `Route Card status ${card.status} is not preparable`,
      );
    }
    if (Date.parse(card.expiresAt) <= now.getTime()) {
      return refreshRequiredResultV1(input.routeRunId, 'card_expired', 'Route Card quote comparison has expired');
    }

    // --- Idempotent replay ----------------------------------------------------
    const blueprintId = blueprintIdV1({
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      routeRunId: input.routeRunId,
      routeCardHash: input.routeCardHash,
      selectedCandidateHash: input.selectedCandidateHash,
      requestId: input.requestId,
    });
    const existingBlueprints = await repository.listBlueprints(input.routeRunId, input.tenantId);
    const existing = existingBlueprints.find((stored) => stored.blueprint.id === blueprintId);
    if (existing) {
      if (Date.parse(existing.blueprint.quoteExpiry) <= now.getTime()) {
        return refreshRequiredResultV1(
          input.routeRunId,
          'blueprint_expired',
          'A previously prepared blueprint has expired and can never be reviewed again',
        );
      }
      return this.reviewStoredBlueprint(input, intent, selected, existing.blueprint, now);
    }

    // --- Fresh re-quote (decision 10) ------------------------------------------
    const quoteAdapter = this.deps.quoteAdapters.find((adapter) => adapter.id === providerId);
    if (!quoteAdapter) {
      throw new TransactionComposerBindingError(
        'quote_adapter_not_configured',
        `No quote adapter configured for ${providerId}`,
      );
    }
    const quoteResult = await quoteAdapter.quote({
      intent,
      walletAddress: input.walletAddress,
      requestId: input.requestId,
      now,
    });
    if (quoteResult.outcome !== 'quoted') {
      return refreshRequiredResultV1(
        input.routeRunId,
        'quote_expired',
        `Fresh ${providerId} quote is unavailable (${quoteResult.errorCode})`,
      );
    }
    const freshCandidate = quoteResult.candidate;
    if (freshCandidate.provider.id !== providerId) {
      return refreshRequiredResultV1(
        input.routeRunId,
        'quote_expired',
        'Fresh quote provider does not match the selected candidate',
      );
    }
    if (
      freshCandidate.inputAmount.asset.assetId !== intent.amount.asset.assetId ||
      freshCandidate.expectedOutput.asset.assetId !== intent.toAsset!.assetId
    ) {
      return refreshRequiredResultV1(
        input.routeRunId,
        'quote_expired',
        'Fresh quote assets do not match the stored intent',
      );
    }
    if (Date.parse(freshCandidate.quoteExpiresAt) <= now.getTime()) {
      return refreshRequiredResultV1(input.routeRunId, 'quote_expired', 'Fresh quote is already expired');
    }
    if (BigInt(freshCandidate.expectedOutput.amountAtomic) < BigInt(selected.minimumOutput.amountAtomic)) {
      return refreshRequiredResultV1(
        input.routeRunId,
        'fresh_output_below_minimum',
        'Fresh expected output is below the originally displayed minimum output',
      );
    }

    // --- Persist fresh candidate/evidence/evidence set (additive, immutable) --
    await repository.insertCandidate(input.routeRunId, freshCandidate);
    for (const evidence of quoteResult.evidence) {
      await repository.insertEvidence(input.routeRunId, freshCandidate.id, evidence);
    }
    const evidenceSet = buildFreshEvidenceSetV1(intent, freshCandidate, quoteResult.evidence);
    await repository.insertEvidenceSet(input.routeRunId, freshCandidate.id, evidenceSet);

    // --- Build exact unsigned calls --------------------------------------------
    const buildAdapter = this.deps.buildAdapters.find((adapter) => adapter.id === providerId);
    if (!buildAdapter) {
      throw new TransactionComposerBindingError(
        'build_adapter_not_configured',
        `No build adapter configured for ${providerId}`,
      );
    }
    const buildResult = await buildAdapter.build({
      intent,
      selectedCandidate: freshCandidate,
      walletAddress: input.walletAddress,
      now,
      requestId: input.requestId,
    });
    if (buildResult.outcome !== 'built') {
      return refreshRequiredResultV1(
        input.routeRunId,
        'quote_expired',
        `${providerId} could not prepare a fresh transaction (${buildResult.errorCode})`,
      );
    }
    if (Date.parse(buildResult.quoteExpiry) <= now.getTime()) {
      return refreshRequiredResultV1(input.routeRunId, 'quote_expired', 'Freshly built transaction quote is already expired');
    }
    // The build round trip has its OWN quote (the one the calldata was
    // generated from). Apply the same refresh rule to it: never review a
    // build whose expected output regressed below the originally displayed
    // minimum, even if the earlier quote-adapter re-quote looked fine.
    if (BigInt(buildResult.expectedOutput.amountAtomic) < BigInt(selected.minimumOutput.amountAtomic)) {
      return refreshRequiredResultV1(
        input.routeRunId,
        'fresh_output_below_minimum',
        'The build-time quote expected output is below the originally displayed minimum output',
      );
    }

    const usdcAsset = intent.fromAsset!;
    const calls = buildResult.calls.map((call, index) =>
      classifySwapCallV1({
        index,
        call,
        routerAddress: buildResult.routerAddress,
        usdcAsset,
        walletAddress: input.walletAddress,
      }),
    );

    // --- Safety Kernel ----------------------------------------------------------
    const simulation = simulationHonesty(intent);
    const simulationState: SimulationStateV1 = {
      status: 'unavailable',
      observedAt: null,
      blockNumber: null,
      requestHash: null,
      responseHash: null,
      errorCode: 'no_simulation_provider',
    };
    const contractSecurityAddresses = [usdcAsset.address].filter((value): value is `0x${string}` => Boolean(value));
    const contractSecurityResults = await this.deps.contractSecurity({
      chainId: intent.chainId,
      addresses: contractSecurityAddresses,
    });
    const contractSecurityProviderName = contractSecurityResults.some((entry) => entry.provider === 'goplus')
      ? 'goplus'
      : (contractSecurityResults[0]?.provider ?? 'none');

    const { result: safety, contractSecurity } = runSafetyKernel({
      provider: providerId,
      routerAddress: buildResult.routerAddress,
      chainId: intent.chainId,
      walletAddress: input.walletAddress,
      intent,
      calls,
      quoteExpiry: buildResult.quoteExpiry,
      now,
      contractSecurityRequired: true,
      contractSecurityProvider: contractSecurityProviderName,
      contractSecurityResults,
      contractSecurityAddresses,
      simulationAcceptable: simulation.acceptable,
      simulationDetail: simulation.detail,
      intentHash: intent.intentHash,
      selectedCandidateHash: freshCandidate.candidateHash,
    });

    if (safety.verdict === 'blocked') {
      return blockedResultV1(input.routeRunId, safety);
    }

    // --- Assemble + persist blueprint --------------------------------------------
    const blueprint = assembleExecutionBlueprintV1({
      id: blueprintId,
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      chainId: 8453,
      now,
      intentHash: intent.intentHash,
      selectedCandidateHash: freshCandidate.candidateHash,
      evidenceSetHash: evidenceSet.evidenceSetHash,
      quoteExpiry: buildResult.quoteExpiry,
      calls,
      inputAsset: usdcAsset,
      inputAmountAtomic: intent.amount.amountAtomic,
      outputAsset: intent.toAsset!,
      // Build-side outputs: derived from the SAME provider response that
      // produced the calls, so the reviewed numbers can never diverge from
      // the calldata. The quote-adapter fresh candidate remains the persisted
      // hash-linkage artifact (selectedCandidateHash/evidenceSetHash) only.
      outputExpectedAtomic: buildResult.expectedOutput.amountAtomic,
      outputMinimumAtomic: buildResult.minimumOutput.amountAtomic,
      simulationState,
    });
    await repository.insertBlueprint(input.routeRunId, blueprint);

    const review = buildTransactionReviewProjectionV1({
      routeRunId: input.routeRunId,
      provider: selected.provider,
      input: intent.amount,
      expectedOutput: buildResult.expectedOutput,
      minimumOutput: buildResult.minimumOutput,
      cardExpectedOutput: selected.expectedOutput,
      cardMinimumOutput: selected.minimumOutput,
      blueprint,
      safety,
      contractSecurity,
      simulationWarning: simulation.acceptable ? simulation.detail : null,
    });

    return preparedResultV1({ routeRunId: input.routeRunId, blueprint, review });
  }

  /** Idempotent replay: re-derives the review projection over the ALREADY
   * stored, immutable blueprint calls — no re-quote or re-build network call,
   * only a fresh contract-security lookup and Safety Kernel re-run. */
  private async reviewStoredBlueprint(
    input: TransactionComposerPrepareInput,
    intent: RouteIntentV1,
    selected: RouteCandidateV1,
    blueprint: ExecutionBlueprintV1,
    now: Date,
  ): Promise<TransactionPreparationResultV1> {
    return reviewStoredBlueprintV1(this.deps, input, intent, selected, blueprint, now);
  }
}

export function createTransactionComposer(deps: TransactionComposerDependencies): TransactionComposer {
  return new DeterministicTransactionComposer(deps);
}
