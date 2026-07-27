import {
  RouteCandidateV1Schema,
  RouteIntentV1Schema,
  ZERO_HASH_V1,
  stableHashV1,
  type RouteCandidateV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import {
  getEligibleSwapAdapters,
  type SwapAdapterFailure,
  type SwapRouteAdapter,
} from '@mioagent/swap-adapters';
import {
  SwapRouteEvaluationV1Schema,
  hashSwapRouteEvaluationV1,
  type ComparisonConfidenceV1,
  type SwapAdapterFailureV1,
  type SwapRouteEvaluationV1,
} from './contracts.js';
import { buildEvidenceSetV1, RouteEvidenceError } from './evidence.js';
import { findCrossCandidateOverlapsV1, hasIncompleteProvenanceV1 } from './overlap.js';
import {
  SCORE_CONFIDENCE_V1,
  SUPPORTED_OPTIMIZATION_MODES_V1,
  SWAP_ROUTE_CONFIDENCE_VERSION_V1,
} from './policy.js';
import { scoreRoutesV1, type ScoredRouteV1 } from './scoring.js';

export interface SwapRouteEvaluationInputV1 {
  intent: RouteIntentV1;
  walletAddress: `0x${string}`;
  requestId: string;
  now: Date;
  adapters?: SwapRouteAdapter[];
  repository?: RouteStorageRepository;
}

export interface SwapRouteEngine {
  evaluate(input: SwapRouteEvaluationInputV1): Promise<SwapRouteEvaluationV1>;
}

export class RouteEngineInputError extends Error {
  readonly code = 'ROUTE_ENGINE_INVALID_INPUT';
}

export class RouteEnginePersistenceError extends Error {
  readonly code = 'ROUTE_ENGINE_PERSISTENCE_FAILED';
  constructor(cause: unknown) {
    super('Route Engine persistence failed', { cause });
  }
}

export function routeEngineV1IdempotencyKey(intent: RouteIntentV1, requestId: string): string {
  return `route-engine:${stableHashV1('route-engine-request/v1', {
    tenantId: intent.tenantId,
    walletAddress: intent.walletAddress,
    requestId,
  }).slice(2)}`;
}

function validateCandidate(
  candidateInput: RouteCandidateV1,
  intent: RouteIntentV1,
  now: Date,
  expectedProvider: SwapRouteAdapter['id'],
): RouteCandidateV1 {
  const candidate = RouteCandidateV1Schema.parse(candidateInput);
  if (
    candidate.tenantId !== intent.tenantId ||
    candidate.walletAddress !== intent.walletAddress ||
    candidate.chainId !== intent.chainId ||
    candidate.intentHash !== intent.intentHash
  ) {
    throw new RouteEvidenceError('engine_invalid_candidate_linkage');
  }
  if (
    !intent.toAsset ||
    candidate.expectedOutput.asset.assetId !== intent.toAsset.assetId ||
    candidate.minimumOutput.asset.assetId !== intent.toAsset.assetId
  ) {
    throw new RouteEvidenceError('engine_invalid_candidate_output_asset');
  }
  if (
    candidate.provider.id !== expectedProvider ||
    candidate.routeType !== 'swap' ||
    candidate.inputAmount.asset.assetId !== intent.amount.asset.assetId ||
    candidate.inputAmount.amountAtomic !== intent.amount.amountAtomic
  ) {
    throw new RouteEvidenceError('engine_invalid_candidate_quote_binding');
  }
  if (Date.parse(candidate.quoteObservedAt) > now.getTime()) {
    throw new RouteEvidenceError('engine_future_quote_observation');
  }
  return candidate;
}

function failureFromThrown(provider: SwapRouteAdapter['id'], error: unknown): SwapAdapterFailureV1 {
  return {
    outcome: 'rejected',
    provider,
    errorCode:
      error instanceof RouteEvidenceError
        ? error.code
        : error instanceof Error && error.name === 'ZodError'
          ? 'engine_schema_validation_failed'
          : 'adapter_unhandled_exception',
    retryable: false,
  };
}

function sortedFailures(failures: readonly SwapAdapterFailure[]): SwapAdapterFailureV1[] {
  return failures
    .map((failure) => ({
      outcome: failure.outcome,
      provider: failure.provider,
      errorCode: failure.errorCode,
      retryable: failure.retryable,
    }))
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.errorCode.localeCompare(right.errorCode),
    );
}

function dimensionScore(route: ScoredRouteV1, name: string): number {
  return route.pathScore.dimensions.find((item) => item.dimension === name)?.score ?? -1;
}

function rankRoutes(
  mode: RouteIntentV1['optimizationMode'],
  routes: readonly ScoredRouteV1[],
): ScoredRouteV1[] | null {
  if (!SUPPORTED_OPTIMIZATION_MODES_V1.has(mode) || routes.length === 0) return null;
  if (mode === 'best_net_result') {
    if (routes.some((route) => route.netMetric.netOutputAtomic === null)) return null;
    return [...routes].sort((left, right) => {
      const leftNet = BigInt(left.netMetric.netOutputAtomic!);
      const rightNet = BigInt(right.netMetric.netOutputAtomic!);
      if (leftNet !== rightNet) return leftNet > rightNet ? -1 : 1;
      const freshness = dimensionScore(right, 'quote_freshness') - dimensionScore(left, 'quote_freshness');
      if (freshness !== 0) return freshness;
      const simplicity = dimensionScore(right, 'route_simplicity') - dimensionScore(left, 'route_simplicity');
      if (simplicity !== 0) return simplicity;
      return left.candidate.provider.id.localeCompare(right.candidate.provider.id) ||
        left.candidate.candidateHash.localeCompare(right.candidate.candidateHash);
    });
  }
  if (mode === 'lowest_fees') {
    if (routes.some((route) => route.netMetric.gasCostUsdMicros === null)) return null;
    return [...routes].sort((left, right) => {
      const leftGas = BigInt(left.netMetric.gasCostUsdMicros!);
      const rightGas = BigInt(right.netMetric.gasCostUsdMicros!);
      if (leftGas !== rightGas) return leftGas < rightGas ? -1 : 1;
      const leftOutput = BigInt(left.candidate.expectedOutput.amountAtomic);
      const rightOutput = BigInt(right.candidate.expectedOutput.amountAtomic);
      if (leftOutput !== rightOutput) return leftOutput > rightOutput ? -1 : 1;
      const freshness = dimensionScore(right, 'quote_freshness') - dimensionScore(left, 'quote_freshness');
      if (freshness !== 0) return freshness;
      return left.candidate.provider.id.localeCompare(right.candidate.provider.id) ||
        left.candidate.candidateHash.localeCompare(right.candidate.candidateHash);
    });
  }
  if (routes.some((route) => dimensionScore(route, 'route_simplicity') < 0)) return null;
  return [...routes].sort((left, right) => {
    if (left.candidate.approvalCount !== right.candidate.approvalCount) {
      return left.candidate.approvalCount - right.candidate.approvalCount;
    }
    if (left.candidate.callCount !== right.candidate.callCount) {
      return left.candidate.callCount - right.candidate.callCount;
    }
    const freshness = dimensionScore(right, 'quote_freshness') - dimensionScore(left, 'quote_freshness');
    if (freshness !== 0) return freshness;
    return left.candidate.provider.id.localeCompare(right.candidate.provider.id) ||
      left.candidate.candidateHash.localeCompare(right.candidate.candidateHash);
  });
}

function confidence(input: {
  routes: readonly ScoredRouteV1[];
  failureCount: number;
  overlapCount: number;
}): ComparisonConfidenceV1 {
  const reasons: string[] = [];
  let label: keyof typeof SCORE_CONFIDENCE_V1 = 'high';
  if (input.routes.length <= 1) reasons.push('single_candidate');
  if (input.failureCount > 0) reasons.push('provider_gap');
  if (input.routes.some((route) => route.evidenceSet.status !== 'complete')) reasons.push('partial_evidence');
  if (input.overlapCount > 0) reasons.push('overlapping_liquidity');
  if (
    hasIncompleteProvenanceV1(
      input.routes.map((route) => route.candidate),
      input.routes.map((route) => route.evidenceSet),
    )
  ) reasons.push('incomplete_provenance');
  if (reasons.some((reason) => ['single_candidate', 'provider_gap', 'partial_evidence'].includes(reason))) {
    label = 'low';
  } else if (reasons.length > 0) {
    label = 'medium';
  }
  return {
    policyVersion: SWAP_ROUTE_CONFIDENCE_VERSION_V1,
    ...SCORE_CONFIDENCE_V1[label],
    reasons: [...new Set(reasons)].sort(),
  };
}

async function persistEvaluation(
  repository: RouteStorageRepository,
  intent: RouteIntentV1,
  routes: readonly ScoredRouteV1[],
  requestId: string,
): Promise<void> {
  try {
    await repository.createRouteRun(intent, routeEngineV1IdempotencyKey(intent, requestId));
    for (const route of routes) {
      await repository.insertCandidate(intent.id, route.candidate);
      for (const evidence of route.evidenceSet.records) {
        await repository.insertEvidence(intent.id, route.candidate.id, evidence);
      }
      await repository.insertEvidenceSet(intent.id, route.candidate.id, route.evidenceSet);
      await repository.insertScoreSnapshot(intent.id, route.candidate.id, route.pathScore);
    }
  } catch (error) {
    throw new RouteEnginePersistenceError(error);
  }
}

export class DeterministicSwapRouteEngine implements SwapRouteEngine {
  async evaluate(input: SwapRouteEvaluationInputV1): Promise<SwapRouteEvaluationV1> {
    let intent: RouteIntentV1;
    try {
      intent = RouteIntentV1Schema.parse(input.intent);
    } catch (error) {
      throw new RouteEngineInputError(`Invalid route intent: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (input.walletAddress !== intent.walletAddress) {
      throw new RouteEngineInputError('walletAddress must exactly match intent.walletAddress');
    }
    if (!Number.isFinite(input.now.getTime())) throw new RouteEngineInputError('now must be a valid Date');
    if (input.requestId.trim().length === 0) throw new RouteEngineInputError('requestId must not be empty');

    const selection = getEligibleSwapAdapters(intent, input.adapters);
    const adapters = selection.adapters;
    const settled = await Promise.allSettled(
      adapters.map((adapter) =>
        adapter.quote({ intent, walletAddress: input.walletAddress, requestId: input.requestId, now: input.now }),
      ),
    );

    const failures: SwapAdapterFailure[] = [];
    const accepted: Array<{ candidate: RouteCandidateV1; evidenceSet: ReturnType<typeof buildEvidenceSetV1>['evidenceSet'] }> = [];
    for (const [index, result] of settled.entries()) {
      const adapter = adapters[index]!;
      if (result.status === 'rejected') {
        failures.push(failureFromThrown(adapter.id, result.reason));
        continue;
      }
      if (result.value.outcome !== 'quoted') {
        failures.push(result.value);
        continue;
      }
      try {
        const candidate = validateCandidate(result.value.candidate, intent, input.now, adapter.id);
        const { evidenceSet } = buildEvidenceSetV1({
          intent,
          candidate,
          providerEvidence: result.value.evidence,
          now: input.now,
        });
        accepted.push({ candidate, evidenceSet });
      } catch (error) {
        failures.push(failureFromThrown(adapter.id, error));
      }
    }

    const unique = new Map<string, (typeof accepted)[number]>();
    for (const item of accepted) if (!unique.has(item.candidate.candidateHash)) unique.set(item.candidate.candidateHash, item);
    const candidates = [...unique.values()].map((item) => item.candidate).sort((a, b) => a.candidateHash.localeCompare(b.candidateHash));
    const evidenceSets = candidates.map((candidate) => unique.get(candidate.candidateHash)!.evidenceSet);
    const routes = scoreRoutesV1({ intent, candidates, evidenceSets, now: input.now });
    const usable = routes.filter((route) => route.evidenceSet.status !== 'stale');
    const overlaps = findCrossCandidateOverlapsV1(candidates, evidenceSets);
    const adapterFailures = sortedFailures(failures);
    const ranked = rankRoutes(intent.optimizationMode, usable);

    let outcome: SwapRouteEvaluationV1['outcome'];
    let reason: SwapRouteEvaluationV1['reason'];
    let recommendedCandidateHash: SwapRouteEvaluationV1['recommendedCandidateHash'] = null;
    let alternatives: `0x${string}`[] = ranked?.map((route) => route.candidate.candidateHash) ?? candidates.map((candidate) => candidate.candidateHash);
    const invalidEvidence = adapterFailures.some((failure) => failure.errorCode.startsWith('engine_'));
    if (candidates.length === 0) {
      outcome = 'failed';
      reason = invalidEvidence ? 'invalid_evidence' : 'all_providers_failed';
    } else if (usable.length === 0) {
      outcome = 'failed';
      reason = 'all_quotes_expired';
    } else if (!SUPPORTED_OPTIMIZATION_MODES_V1.has(intent.optimizationMode)) {
      outcome = 'degraded';
      reason = 'unsupported_optimization_evidence';
    } else if (
      intent.protocolConstraint.mode === 'include_only' &&
      intent.protocolConstraint.protocols.length === 1 &&
      adapters.length === 1
    ) {
      outcome = 'constrained';
      reason = 'user_protocol_constraint';
      recommendedCandidateHash = ranked?.[0]?.candidate.candidateHash ?? null;
    } else if (adapters.length > 1 && usable.length === 1) {
      outcome = 'degraded';
      reason = 'single_provider_available';
    } else if (!ranked || ranked.length < 2) {
      outcome = 'degraded';
      reason = 'insufficient_rankable_candidates';
    } else {
      outcome = 'ready';
      reason = 'multiple_routes_compared';
      recommendedCandidateHash = ranked[0]!.candidate.candidateHash;
    }
    if (recommendedCandidateHash !== null) {
      alternatives = alternatives.filter((hash) => hash !== recommendedCandidateHash);
    }

    const draft: SwapRouteEvaluationV1 = {
      schemaVersion: 'swap-route-evaluation/v1',
      evaluationHash: ZERO_HASH_V1,
      intentHash: intent.intentHash,
      tenantId: intent.tenantId,
      walletAddress: intent.walletAddress,
      chainId: intent.chainId,
      evaluatedAt: input.now.toISOString(),
      outcome,
      reason,
      candidates,
      adapterFailures,
      evidenceSets: routes.map((route) => route.evidenceSet),
      pathScores: routes.map((route) => route.pathScore),
      netResultMetrics: routes.map((route) => route.netMetric),
      recommendedCandidateHash,
      alternativeCandidateHashes: alternatives,
      comparisonConfidence: confidence({ routes: usable, failureCount: adapterFailures.length, overlapCount: overlaps.length }),
      crossCandidateOverlaps: overlaps,
      optimizationMode: intent.optimizationMode,
    };
    const evaluation = SwapRouteEvaluationV1Schema.parse({
      ...draft,
      evaluationHash: hashSwapRouteEvaluationV1(draft),
    });
    if (input.repository && evaluation.outcome !== 'failed') {
      await persistEvaluation(input.repository, intent, usable, input.requestId);
    }
    return evaluation;
  }
}

export function createSwapRouteEngine(): SwapRouteEngine {
  return new DeterministicSwapRouteEngine();
}
