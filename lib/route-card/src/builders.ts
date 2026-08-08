import {
  RouteCardV1Schema,
  ZERO_HASH_V1,
  hashRouteCardV1,
  stableHashV1,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type EvidenceTypeV1,
  type RouteCardV1,
  type RouteCandidateV1,
} from '@mioagent/route-domain';
import {
  SwapRouteEvaluationV1Schema,
  type SwapRouteEvaluationV1,
} from '@mioagent/route-engine';
import {
  RoutePlanProjectionV1Schema,
  hashRoutePlanProjectionV1,
  type RoutePlanEvidenceSummaryV1,
  type RoutePlanProjectionV1,
  type RoutePlanRouteV1,
  ProviderHistoryProjectionV1Schema,
  type ProviderHistoryProjectionV1,
} from './contracts.js';
import type { ProviderReliabilityAssessmentV1 } from '@mioagent/route-outcomes';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decimalParts(value: string): { value: bigint; scale: number } {
  const [whole, fraction = ''] = value.split('.');
  return { value: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function decimalString(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const padded = value.toString().padStart(scale + 1, '0');
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function sumUsd(records: readonly EvidenceRecordV1[]): string {
  const values = records.flatMap((record) => {
    const value = record.freeOrPaid === 'paid' ? record.cost?.usdValue : null;
    return value === null || value === undefined ? [] : [decimalParts(value)];
  });
  const scale = values.reduce((maximum, item) => Math.max(maximum, item.scale), 0);
  const total = values.reduce(
    (sum, item) => sum + item.value * 10n ** BigInt(scale - item.scale),
    0n,
  );
  return decimalString(total, scale);
}

function recommendationReason(
  evaluation: SwapRouteEvaluationV1,
  candidate: RouteCandidateV1,
): string {
  if (evaluation.outcome === 'constrained') {
    return `Using ${candidate.provider.displayName} because you explicitly requested it. This was not compared as the global best route.`;
  }
  const reasons: Record<SwapRouteEvaluationV1['optimizationMode'], string> = {
    best_net_result: 'the highest supported net result',
    lowest_fees: 'the lowest comparable estimated network fee',
    simplest_route: 'the fewest documented approvals and calls',
    lowest_risk: 'the requested risk objective',
    fastest_execution: 'the requested execution-speed objective',
    mev_protected: 'the requested MEV-protection objective',
  };
  return `${candidate.provider.displayName} is recommended after comparing multiple routes for ${reasons[evaluation.optimizationMode]}.`;
}

function selectedArtifacts(evaluation: SwapRouteEvaluationV1) {
  if (!evaluation.recommendedCandidateHash) return null;
  const candidate = evaluation.candidates.find(
    (item) => item.candidateHash === evaluation.recommendedCandidateHash,
  );
  const pathScore = evaluation.pathScores.find(
    (item) => item.candidateHash === evaluation.recommendedCandidateHash,
  );
  const evidenceSet = evaluation.evidenceSets.find(
    (item) => item.candidateHash === evaluation.recommendedCandidateHash,
  );
  return candidate && pathScore && evidenceSet ? { candidate, pathScore, evidenceSet } : null;
}

export function buildRouteCardV1(input: SwapRouteEvaluationV1): RouteCardV1 | null {
  const evaluation = SwapRouteEvaluationV1Schema.parse(input);
  if (!['ready', 'constrained'].includes(evaluation.outcome)) return null;
  if (
    (evaluation.outcome === 'ready' &&
      (evaluation.reason !== 'multiple_routes_compared' || evaluation.candidates.length < 2)) ||
    (evaluation.outcome === 'constrained' && evaluation.reason !== 'user_protocol_constraint')
  ) return null;
  const selected = selectedArtifacts(evaluation);
  if (!selected) return null;
  const candidates = new Map(
    evaluation.candidates.map((candidate) => [candidate.candidateHash, candidate]),
  );
  const alternatives = evaluation.alternativeCandidateHashes.map((hash) => candidates.get(hash));
  if (alternatives.some((candidate) => !candidate)) return null;
  const displayed = [selected.candidate, ...(alternatives as RouteCandidateV1[])];
  const expiresAt = displayed
    .map((candidate) => candidate.quoteExpiresAt)
    .sort(compareStrings)[0];
  if (!expiresAt) return null;

  const draft: RouteCardV1 = {
    schemaVersion: 'route-card/v1',
    id: `route-card:${stableHashV1('route-card-projection-id/v1', {
      evaluationHash: evaluation.evaluationHash,
      selectedCandidateHash: selected.candidate.candidateHash,
    }).slice(2)}`,
    tenantId: evaluation.tenantId,
    walletAddress: evaluation.walletAddress,
    chainId: evaluation.chainId,
    createdAt: evaluation.evaluatedAt,
    updatedAt: evaluation.evaluatedAt,
    status: 'ready',
    intentHash: evaluation.intentHash,
    selectedCandidateHash: selected.candidate.candidateHash,
    evidenceSetHash: selected.evidenceSet.evidenceSetHash,
    pathScoreHash: selected.pathScore.pathScoreHash,
    routeCardHash: ZERO_HASH_V1,
    recommendedCandidate: selected.candidate,
    alternativeCandidates: alternatives as RouteCandidateV1[],
    pathScore: selected.pathScore,
    evidenceSummary: {
      recordCount: selected.evidenceSet.records.length,
      paidCostUsd: sumUsd(selected.evidenceSet.records),
      missingEvidence: selected.evidenceSet.missingEvidence,
      sourceIndependence: selected.evidenceSet.sourceIndependence,
    },
    recommendationReason: recommendationReason(evaluation, selected.candidate),
    expiresAt,
  };
  return RouteCardV1Schema.parse({ ...draft, routeCardHash: hashRouteCardV1(draft) });
}

function evidenceSummary(sets: readonly EvidenceSetV1[]): RoutePlanEvidenceSummaryV1 {
  const records = sets.flatMap((set) => set.records);
  const missingEvidence = [...new Set(sets.flatMap((set) => set.missingEvidence))].sort(
    compareStrings,
  ) as EvidenceTypeV1[];
  const evidenceTypes = [...new Set(records.map((record) => record.evidenceType))].sort(
    compareStrings,
  ) as EvidenceTypeV1[];
  const statuses = new Set(sets.map((set) => set.status));
  const status: RoutePlanEvidenceSummaryV1['status'] = sets.length === 0
    ? 'invalid'
    : statuses.has('invalid')
    ? 'invalid'
    : statuses.has('stale')
      ? 'stale'
      : statuses.has('partial')
        ? 'partial'
        : 'complete';
  const independence = new Set(sets.map((set) => set.sourceIndependence));
  const sourceIndependence: RoutePlanEvidenceSummaryV1['sourceIndependence'] =
    sets.length === 0
      ? 'unknown'
      : independence.has('overlapping')
      ? 'overlapping'
      : independence.has('unknown')
        ? 'unknown'
        : 'independent';
  return {
    recordCount: records.length,
    freeEvidenceCount: records.filter((record) => record.freeOrPaid === 'free').length,
    paidEvidenceCount: records.filter((record) => record.freeOrPaid === 'paid').length,
    paidCostUsd: sumUsd(records),
    missingEvidence,
    evidenceTypes,
    status,
    sourceIndependence,
  };
}

function routeProjection(
  evaluation: SwapRouteEvaluationV1,
  candidate: RouteCandidateV1,
  history?: ReadonlyMap<string, ProviderReliabilityAssessmentV1>,
): RoutePlanRouteV1 | null {
  const pathScore = evaluation.pathScores.find(
    (score) => score.candidateHash === candidate.candidateHash,
  );
  const evidenceSet = evaluation.evidenceSets.find(
    (set) => set.candidateHash === candidate.candidateHash,
  );
  if (!pathScore || !evidenceSet) return null;
  const metric = evaluation.netResultMetrics.find(
    (entry) => entry.candidateHash === candidate.candidateHash,
  );
  // Present exactly when the evaluation ran under v2 — the metric carries the
  // calibration fields only then, so a v1 projection stays byte-identical.
  const calibrated = metric?.calibrationApplied !== undefined;
  return {
    candidateHash: candidate.candidateHash,
    provider: candidate.provider,
    expectedOutput: candidate.expectedOutput,
    minimumOutput: candidate.minimumOutput,
    estimatedGas: candidate.estimatedGas,
    priceImpact: candidate.priceImpact,
    slippage: candidate.slippage,
    quoteObservedAt: candidate.quoteObservedAt,
    quoteExpiresAt: candidate.quoteExpiresAt,
    // Clamped, like every other age in the codebase. `evaluatedAt` is the
    // run's own start; a provider that stamps its real observation time stamps
    // a moment after it, because the request had to happen first. That is age
    // zero, not a negative age — and the contract declares this field
    // nonnegative, so an unclamped subtraction does not produce a small
    // oddity, it fails the whole projection with
    // `route_plan_evaluation_failed` after the comparison already succeeded.
    quoteAgeSeconds: Math.max(
      0,
      Math.floor((Date.parse(evaluation.evaluatedAt) - Date.parse(candidate.quoteObservedAt)) / 1_000),
    ),
    callCount: candidate.callCount,
    approvalCount: candidate.approvalCount,
    pathScore,
    evidence: evidenceSummary([evidenceSet]),
    ...(calibrated
      ? {
          providerHistory: providerHistoryFromMetricV1(metric!, history?.get(candidate.candidateHash)),
          rawNetResult: metric!.netOutputAtomic,
          historyAdjustedNetResult: metric!.historyAdjustedNetOutputAtomic ?? metric!.netOutputAtomic,
          calibrationApplied: metric!.calibrationApplied === true,
        }
      : {}),
  };
}

/**
 * The history block for one candidate.
 *
 * Every statistic is null unless an eligible snapshot supplied it. Nulls here
 * are the honest shape: rendering 0% shortfall for a provider nobody has
 * measured would be the most flattering possible lie about it.
 */
function providerHistoryFromMetricV1(
  metric: SwapRouteEvaluationV1['netResultMetrics'][number],
  assessment: ProviderReliabilityAssessmentV1 | undefined,
): ProviderHistoryProjectionV1 {
  const snapshot = assessment?.status === 'eligible' ? assessment.snapshot : null;
  return ProviderHistoryProjectionV1Schema.parse({
    status: snapshot ? 'eligible' : 'not_scored',
    scope: snapshot?.scope ?? null,
    notScoredReason: snapshot ? null : (assessment?.notScoredReason ?? 'no_verified_history'),
    sampleSize: assessment?.observedSamples ?? 0,
    requiredSampleSize: assessment?.requiredSamples ?? 10,
    uniqueWalletCount: snapshot?.uniqueWalletCount ?? null,
    completedCount: snapshot?.completedCount ?? null,
    failedCount: snapshot?.failedCount ?? null,
    partialFailureCount: snapshot?.partialFailureCount ?? null,
    successRateBps: snapshot?.successRateBps ?? null,
    medianAdverseShortfallBps: snapshot?.medianAdverseShortfallBps ?? null,
    p90AdverseShortfallBps: snapshot?.p90AdverseShortfallBps ?? null,
    floorBreachRateBps: snapshot?.floorBreachRateBps ?? null,
    medianGasErrorBps: snapshot?.medianGasErrorBps ?? null,
    p90ConfirmationMs: snapshot?.p90ConfirmationMs ?? null,
    // Pinned from the METRIC, not from the assessment: the metric is what the
    // ranking actually used, and the card must name that snapshot even if a
    // newer one has since been sealed.
    cutoffAt: metric.reliabilityCutoffAt ?? null,
    snapshotHash: metric.reliabilitySnapshotHash ?? null,
    aggregationVersion: snapshot?.aggregationVersion ?? null,
  });
}

function goalSummary(evaluation: SwapRouteEvaluationV1): string {
  const candidate = evaluation.candidates[0];
  if (!candidate) return 'Swap route comparison on Base';
  return `Swap ${candidate.inputAmount.amountDecimal} ${candidate.inputAmount.asset.symbol} to ${candidate.expectedOutput.asset.symbol}`;
}

export function buildRoutePlanProjectionV1(
  input: SwapRouteEvaluationV1,
  options: {
    routeCard?: RouteCardV1 | null;
    routeRunId?: string | null;
    /** T67C.1 Part 2, keyed by candidate hash. Supplied only when the
     * comparison ran under swap-path-score/v2. */
    providerHistory?: ReadonlyMap<string, ProviderReliabilityAssessmentV1>;
  } = {},
): RoutePlanProjectionV1 {
  const evaluation = SwapRouteEvaluationV1Schema.parse(input);
  const routeCardInput = options.routeCard === undefined ? buildRouteCardV1(evaluation) : options.routeCard;
  const routeCard = routeCardInput === null || routeCardInput === undefined
    ? null
    : RouteCardV1Schema.parse(routeCardInput);
  if (
    routeCard &&
    (routeCard.intentHash !== evaluation.intentHash ||
      routeCard.selectedCandidateHash !== evaluation.recommendedCandidateHash)
  ) {
    throw new TypeError('Route Card must belong to the projected evaluation');
  }
  const availableRoutes = evaluation.candidates.flatMap((candidate) => {
    const projected = routeProjection(evaluation, candidate, options.providerHistory);
    return projected ? [projected] : [];
  });
  const byHash = new Map(availableRoutes.map((route) => [route.candidateHash, route]));
  const recommendedRoute = evaluation.recommendedCandidateHash
    ? (byHash.get(evaluation.recommendedCandidateHash) ?? null)
    : null;
  const alternatives = evaluation.alternativeCandidateHashes.flatMap((hash) => {
    const route = byHash.get(hash);
    return route ? [route] : [];
  });
  const expiresAt = availableRoutes.map((route) => route.quoteExpiresAt).sort(compareStrings)[0] ?? null;
  const allSets = evaluation.evidenceSets;
  const draft: RoutePlanProjectionV1 = {
    schemaVersion: 'route-plan-projection/v1',
    projectionHash: ZERO_HASH_V1,
    evaluationHash: evaluation.evaluationHash,
    routeCardHash: routeCard?.routeCardHash ?? null,
    routeRunId: options.routeRunId ?? null,
    outcome: evaluation.outcome,
    reason: evaluation.reason,
    goalSummary: goalSummary(evaluation),
    optimizationMode: evaluation.optimizationMode,
    recommendedRoute,
    availableRoutes,
    alternatives,
    pathScore: recommendedRoute?.pathScore ?? null,
    comparisonConfidence: evaluation.comparisonConfidence,
    evidenceSummary: evidenceSummary(allSets),
    crossCandidateOverlaps: evaluation.crossCandidateOverlaps,
    providerFailures: evaluation.adapterFailures,
    expiresAt,
    readOnly: true,
    // Named only under v2, so the UI can swap "weighted to your goal" for the
    // deterministic-scoring line without guessing which policy produced a card.
    ...(recommendedRoute?.calibrationApplied === undefined
      ? {}
      : { scoringVersion: recommendedRoute.pathScore.scoringVersion }),
  };
  return RoutePlanProjectionV1Schema.parse({
    ...draft,
    projectionHash: hashRoutePlanProjectionV1(draft),
  });
}
