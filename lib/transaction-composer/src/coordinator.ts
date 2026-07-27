import {
  EvidenceSetV1Schema,
  SafetyKernelResultV1Schema,
  ZERO_HASH_V1,
  findLiquidityOverlapsV1,
  hashApprovedCallsV1,
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
import { routeFromCandidateV1 } from './adapters/aerodrome.js';
import { buildTransactionReviewProjectionV1 } from './reviewProjection.js';
import { runSafetyKernel, type RunSafetyKernelInput } from './safetyKernel.js';
import {
  blockedResultV1,
  preparedResultV1,
  refreshRequiredResultV1,
  unsupportedResultV1,
  type RefreshReasonV1,
  type SwapBuildProviderId,
  type TransactionComposer,
  type TransactionComposerDependencies,
  type TransactionComposerPrepareInput,
  type TransactionPreparationResultV1,
} from './types.js';

const CANONICAL_USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CANONICAL_WETH_BASE = '0x4200000000000000000000000000000000000006';

/** Providers this composer will prepare for unless the caller narrows it.
 * Aerodrome is absent on purpose: its execution is flag-gated, and a server
 * that has not turned the flag on answers `unsupported_provider` rather than
 * building a batch nobody enabled. */
export const DEFAULT_SUPPORTED_BUILD_PROVIDERS_V1: readonly SwapBuildProviderId[] = ['uniswap', 'kyberswap'];

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

/** One canonical Base asset, identified by address — or by being native ETH.
 * A symbol is a label anyone can reuse; the address is the asset. */
function canonicalAerodromeSideV1(asset: RouteIntentV1['fromAsset']): 'usdc' | 'weth' | 'eth' | null {
  if (!asset) return null;
  if (asset.kind === 'native') return 'eth';
  const address = asset.address?.toLowerCase();
  if (address === CANONICAL_USDC_BASE) return 'usdc';
  if (address === CANONICAL_WETH_BASE) return 'weth';
  return null;
}

/**
 * T67B.1: Aerodrome trades both directions between the canonical Base assets,
 * so it is not bound by the USDC-in-only rule the partner-built providers
 * inherited. ETH↔WETH is excluded: that is a wrap, and Aerodrome has no pool
 * for it.
 */
function isSupportedAerodromePair(intent: RouteIntentV1): boolean {
  if (intent.chainId !== 8453) return false;
  const from = canonicalAerodromeSideV1(intent.fromAsset);
  const to = canonicalAerodromeSideV1(intent.toAsset);
  if (!from || !to) return false;
  const poolToken = (side: 'usdc' | 'weth' | 'eth') => (side === 'usdc' ? 'usdc' : 'weth');
  return poolToken(from) !== poolToken(to);
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
 * T67B.1 — whether the simulation evidence is good enough to sign on.
 *
 * Aerodrome is the one provider whose calldata this server writes itself, so
 * it is the one provider where a fork simulation is a PRECONDITION rather than
 * a nicety: nothing upstream has already executed these bytes against real
 * state. `unavailable` is not a pass, and a revert is a refusal, not a
 * warning. The partner-built providers keep the T57 rule unchanged.
 */
export function simulationRequirementV1(
  provider: SwapBuildProviderId,
  intent: RouteIntentV1,
  simulationState: SimulationStateV1,
): { acceptable: boolean; detail: string } {
  if (provider !== 'aerodrome') return simulationHonesty(intent);
  if (simulationState.status === 'passed') {
    return { acceptable: true, detail: 'Simulated against Base mainnet state and every call succeeded.' };
  }
  if (simulationState.status === 'failed') {
    return {
      acceptable: false,
      detail: 'This swap reverts in simulation, so it cannot be signed.',
    };
  }
  return {
    acceptable: false,
    detail: `Aerodrome calldata is built by this server and must simulate before it can be signed (${
      simulationState.errorCode ?? 'simulation unavailable'
    }).`,
  };
}

/** No provider configured, and honest about it. */
export function unsimulatedStateV1(errorCode = 'no_simulation_provider'): SimulationStateV1 {
  return {
    status: 'unavailable',
    observedAt: null,
    blockNumber: null,
    requestHash: null,
    responseHash: null,
    errorCode,
  };
}

/**
 * T67B.1 — rebuilds the Aerodrome guard's inputs from ALREADY stored records.
 *
 * Prepare has the build adapter's own facts; replay and approve do not, and
 * they must not re-read the chain to invent them. Everything here comes from
 * the persisted candidate (which carries the reviewed route and its factory in
 * its liquidity source keys) and the immutable Blueprint (which carries the
 * reviewed floor). Nothing is derived from the calldata being checked.
 *
 * Returns an empty object for every other provider, and for an Aerodrome
 * record whose route cannot be recovered — which leaves the guard's facts
 * missing, and the Safety Kernel blocks on that.
 */
export function aerodromeKernelInputV1(
  providerId: SwapBuildProviderId,
  candidate: RouteCandidateV1,
  blueprint: ExecutionBlueprintV1,
): Pick<RunSafetyKernelInput, 'aerodrome' | 'reviewedMinimumOutputAtomic'> {
  if (providerId !== 'aerodrome') return {};
  const route = routeFromCandidateV1(candidate);
  if (!route) return {};
  const debit = blueprint.expectedAssetChanges.find((change) => change.direction === 'debit');
  const credit = blueprint.expectedAssetChanges.find((change) => change.direction === 'credit');
  if (!debit || !credit) return {};
  const inputIsNative = debit.asset.kind === 'native';
  return {
    aerodrome: {
      route,
      factory: route[0]!.factory,
      // Approve and replay never re-read the chain, and an allowance read
      // taken now would say nothing about the batch that was already built.
      observedAllowanceAtomic: null,
      inputIsNative,
      outputIsNative: credit.asset.kind === 'native',
      inputTokenAddress: inputIsNative ? null : (debit.asset.address?.toLowerCase() ?? null),
    },
    // The floor stored with the calls, which prepare already checked against
    // the Route Card the user looked at.
    reviewedMinimumOutputAtomic: credit.minimumAmountAtomic ?? credit.amountAtomic,
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
  const providerId = selected.provider.id as SwapBuildProviderId;
  const inputAsset = intent.fromAsset!;
  const routerCall = blueprint.calls.find((call) => call.callType === 'swap');
  const routerAddress = (routerCall?.to ?? selected.provider.id) as `0x${string}`;

  // Replay re-derives the review over ALREADY stored calls, so the simulation
  // is the one stored with them. Re-running it would produce a different
  // result for the same immutable bytes.
  const simulation = simulationRequirementV1(providerId, intent, blueprint.simulationState);
  const contractSecurityAddresses = [inputAsset.address].filter((value): value is `0x${string}` => Boolean(value));
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
    ...aerodromeKernelInputV1(providerId, selected, blueprint),
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
    const supportedProviders = this.deps.supportedProviders ?? DEFAULT_SUPPORTED_BUILD_PROVIDERS_V1;
    if (!supportedProviders.includes(selected.provider.id as SwapBuildProviderId)) {
      return unsupportedResultV1(
        'unsupported_provider',
        `Provider ${selected.provider.id} is not supported for transaction preparation`,
      );
    }
    const providerId = selected.provider.id as SwapBuildProviderId;

    const pairSupported =
      providerId === 'aerodrome' ? isSupportedAerodromePair(intent) : isSupportedPair(intent);
    if (!pairSupported) {
      return unsupportedResultV1(
        'unsupported_pair',
        providerId === 'aerodrome'
          ? 'Only canonical Base USDC, WETH and ETH pairs are supported'
          : 'Only canonical Base USDC to ETH or WETH is supported',
      );
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
      // T67B.1: the card candidate, so a locally-encoding adapter can hold the
      // reviewed route and the reviewed floor as constraints.
      reviewedCandidate: selected,
      walletAddress: input.walletAddress,
      now,
      requestId: input.requestId,
    });
    if (buildResult.outcome !== 'built') {
      // A moved route is not an expired quote. Saying so lets the client offer
      // a new comparison instead of a pointless retry of the same selection.
      const reason: RefreshReasonV1 =
        buildResult.errorCode === 'aerodrome_route_changed' ||
        buildResult.errorCode === 'aerodrome_factory_changed'
          ? 'route_changed'
          : 'quote_expired';
      return refreshRequiredResultV1(
        input.routeRunId,
        reason,
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

    const inputAsset = intent.fromAsset!;
    const calls = buildResult.calls.map((call, index) =>
      classifySwapCallV1({
        index,
        call,
        routerAddress: buildResult.routerAddress,
        inputAsset,
        walletAddress: input.walletAddress,
      }),
    );

    // --- Simulation ---------------------------------------------------------------
    // Only for the provider whose calldata this server wrote. The partner-built
    // providers keep the T57 behaviour byte for byte: no request, no charge,
    // and an honestly `unavailable` state.
    let simulationState: SimulationStateV1 = unsimulatedStateV1();
    if (providerId === 'aerodrome') {
      simulationState = this.deps.simulate
        ? await this.deps.simulate({
            chainId: 8453,
            walletAddress: input.walletAddress,
            blueprintId,
            callsHash: hashApprovedCallsV1(calls),
            calls,
          })
        : unsimulatedStateV1('no_simulation_provider');
    }

    // --- Safety Kernel ----------------------------------------------------------
    const simulation = simulationRequirementV1(providerId, intent, simulationState);
    const contractSecurityAddresses = [inputAsset.address].filter((value): value is `0x${string}` => Boolean(value));
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
      // The build adapter's own facts, and the floor from the Route Card the
      // user looked at — never the build's own minimum, which would only prove
      // the build agrees with itself.
      aerodrome: buildResult.aerodrome,
      reviewedMinimumOutputAtomic: selected.minimumOutput.amountAtomic,
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
      inputAsset,
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
