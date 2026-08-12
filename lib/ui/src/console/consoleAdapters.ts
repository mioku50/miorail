import {
  CONSOLE_COPY_V1,
  adapterShortfallCopyV1,
  consoleFailureCopyV1,
  deriveCandidateRowsV1,
  deriveEvidenceRowsV1,
  deriveScoreRowsV1,
  quoteFreshnessV1,
  type CandidateSourceV1,
  type EvidenceSourceRowV1,
  type ScoreDimensionSourceV1,
  type SimulationSourceV1,
} from './consoleState';
import {
  comparisonClaimV1,
  providerFailureViewsV1,
  swapProviderDisplayNameV1,
  type ComparisonClaimViewV1,
  type ProviderFailureViewV1,
} from './providerDiagnostics';
import type { RouteGraphModelV1 } from './ConsoleCharts';

// Structural mirrors of the route-card projection. The surface layer types the
// wire STRUCTURALLY (the same rule lib/ui follows) so a UI change never drags a
// contract package into the bundle.
export interface RoutePlanRouteV1 {
  candidateHash: string;
  provider: { displayName: string };
  // `address` is on the wire (AssetRefV1) and was simply not mirrored here.
  // It is null for the chain's native asset, which is why B20 inspection has a
  // "nothing to inspect" branch rather than treating null as an error.
  expectedOutput: { amountDecimal: string; asset: { symbol: string; address: string | null } };
  minimumOutput: { amountDecimal: string };
  estimatedGas: { gasUnits: string; estimatedCostUsd: string | null };
  priceImpact: { percent: string };
  slippage: { percent: string };
  quoteAgeSeconds: number;
  callCount: number;
  approvalCount: number;
  pathScore: PathScoreLikeV1;
  evidence: unknown;
  // T67C.1 Part 2. Optional, mirroring the projection: a v1 card carries none
  // of these, and the history block simply does not render for it.
  providerHistory?: {
    status: 'eligible' | 'not_scored';
    scope: 'personal' | 'network' | null;
    notScoredReason: string | null;
    sampleSize: number;
    requiredSampleSize: number;
    uniqueWalletCount: number | null;
    completedCount: number | null;
    failedCount: number | null;
    partialFailureCount: number | null;
    successRateBps: number | null;
    medianAdverseShortfallBps: number | null;
    p90AdverseShortfallBps: number | null;
    floorBreachRateBps: number | null;
    medianGasErrorBps: number | null;
    p90ConfirmationMs: number | null;
    cutoffAt: string | null;
    snapshotHash: string | null;
    aggregationVersion: string | null;
  };
  rawNetResult?: string | null;
  historyAdjustedNetResult?: string | null;
  calibrationApplied?: boolean;
}

export interface RoutePlanProjectionV1 {
  outcome: 'ready' | 'constrained' | 'degraded' | 'failed';
  goalSummary: string;
  optimizationMode: string;
  routeCardHash: string | null;
  routeRunId: string | null;
  recommendedRoute: RoutePlanRouteV1 | null;
  availableRoutes: readonly RoutePlanRouteV1[];
  pathScore: PathScoreLikeV1 | null;
  evidenceSummary: unknown;
  // T67E §3: the wire shape, which is `SwapAdapterFailureV1` and has always
  // been `{ outcome, provider, errorCode, retryable }`. This was typed with an
  // `adapterId` field that does not exist on it, so every consumer below read
  // `undefined` and rendered it.
  providerFailures: readonly {
    provider: string;
    errorCode: string;
    outcome?: string;
    retryable?: boolean;
  }[];
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Wire → console view model. Everything here reads from modules that already
// exist (route-card projection, route-engine scoring, swap-adapters failures,
// transaction-composer blueprint, the simulation adapter); NOTHING is invented
// on the front end. Where a source is missing, the mapping produces a visible
// row with a reason rather than an omission.
// ---------------------------------------------------------------------------

export const ROUTE_SCORE_LABELS_V1: Record<string, string> = {
  net_result: 'Net result',
  quote_freshness: 'Quote freshness',
  route_simplicity: 'Route simplicity',
  transaction_safety: 'Transaction safety',
};

/** MEV protection has no approved source yet. It is listed EXPLICITLY as an
 * unscored dimension — a missing axis would read as "not relevant", and a 0
 * would read as "scored badly". Both would be lies. */
export const MEV_DIMENSION_V1: ScoreDimensionSourceV1 = {
  key: 'mev_protection',
  label: 'MEV protection',
  score: null,
  confidence: null,
  notScoredReason: CONSOLE_COPY_V1.notScored,
};

export interface PathScoreLikeV1 {
  scoringVersion?: string;
  dimensions: readonly {
    dimension: string;
    status: string;
    score: number | null;
    notScoredReason: string | null;
    confidence: { label: string } | null;
    freshness: { ageSeconds: number } | null;
    sources: readonly unknown[];
  }[];
}

export function scoreDimensionsFromPathScoreV1(pathScore: PathScoreLikeV1 | null): ScoreDimensionSourceV1[] {
  const rows: ScoreDimensionSourceV1[] = (pathScore?.dimensions ?? []).map((dimension) => ({
    key: dimension.dimension,
    label: ROUTE_SCORE_LABELS_V1[dimension.dimension] ?? dimension.dimension,
    score: dimension.status === 'scored' ? dimension.score : null,
    confidence:
      dimension.status === 'scored'
        ? [
            dimension.sources.length > 0 ? `${dimension.sources.length} source${dimension.sources.length === 1 ? '' : 's'}` : null,
            dimension.freshness ? `${dimension.freshness.ageSeconds}s old` : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'scored'
        : null,
    notScoredReason:
      dimension.status === 'scored' ? null : dimension.notScoredReason ? consoleFailureCopyV1(dimension.notScoredReason) : CONSOLE_COPY_V1.notScored,
  }));
  return [...rows, MEV_DIMENSION_V1];
}

/**
 * T67C.1 Part 2 §7.
 *
 * v2 drops "weighted to your goal". Nothing in v2 is weighted: the ranking is
 * one comparison on one figure, or a lexicographic order over separate
 * measurements. Saying "weighted" would describe a blend the code deliberately
 * refuses to perform, and would suggest hidden coefficients a user might
 * reasonably ask to see.
 *
 * v1 cards keep the old line, because that IS what v1 did.
 */
export function scoringVersionLabelV1(pathScore: PathScoreLikeV1 | null): string {
  if (!pathScore?.scoringVersion) return 'scoring unavailable';
  if (pathScore.scoringVersion === 'swap-path-score/v2') {
    return 'Deterministic scoring · swap-path-score/v2';
  }
  return `${pathScore.scoringVersion} · weighted to your goal`;
}

// --- provider history -------------------------------------------------------

export interface ProviderHistoryViewV1 {
  providerName: string;
  headline: string;
  /** Label/value pairs. Separate measurements, never combined: a success rate,
   * a median shortfall and a p90 confirmation time answer different questions
   * in different units. */
  rows: Array<{ label: string; value: string }>;
  /** The quote as offered, and what history says to expect from it. */
  quotedResult: string | null;
  historyAdjustedResult: string | null;
  /** Shown verbatim when there is no calibration, so the absence is stated
   * rather than left as a blank. */
  uncalibratedNote: string | null;
}

export const PROVIDER_HISTORY_UNCALIBRATED_NOTE_V1 =
  'Ranking uses the current quote without historical calibration.';

function bps(value: number | null): string {
  return value === null ? '—' : `${value} bps`;
}

/**
 * The Provider history block for one candidate, or null when the comparison ran
 * under v1 and there is nothing to say.
 *
 * There is no composite figure here and nowhere to put one. A single
 * "reliability" number would be the one thing a reader remembers and the one
 * thing that tells them least.
 */
export function providerHistoryViewV1(route: RoutePlanRouteV1): ProviderHistoryViewV1 | null {
  const history = route.providerHistory;
  if (!history) return null;
  const eligible = history.status === 'eligible';
  const scopeLabel = history.scope === 'personal' ? 'Personal history' : 'Network history';

  const rows: Array<{ label: string; value: string }> = eligible
    ? [
        {
          label: 'Completed',
          value:
            history.completedCount === null
              ? '—'
              : `${history.completedCount} / ${history.sampleSize}`,
        },
        { label: 'Median shortfall', value: bps(history.medianAdverseShortfallBps) },
        { label: 'P90 shortfall', value: bps(history.p90AdverseShortfallBps) },
        {
          label: 'Floor breaches',
          value:
            history.floorBreachRateBps === null
              ? '—'
              : history.floorBreachRateBps === 0
                ? '0'
                : `${history.floorBreachRateBps} bps of routes`,
        },
        ...(history.p90ConfirmationMs === null
          ? []
          : [{ label: 'P90 confirmation', value: `${Math.round(history.p90ConfirmationMs / 100) / 10}s` }]),
        { label: 'Cutoff', value: history.cutoffAt ?? '—' },
      ]
    : [
        {
          label: 'Verified routes',
          value: `${history.sampleSize} · ${history.requiredSampleSize} required for personal calibration`,
        },
      ];

  return {
    providerName: route.provider.displayName,
    headline: eligible
      ? `${scopeLabel} · ${history.sampleSize} verified route${history.sampleSize === 1 ? '' : 's'}`
      : 'Provider history · Not scored',
    rows,
    quotedResult: route.rawNetResult ?? null,
    historyAdjustedResult: route.calibrationApplied ? (route.historyAdjustedNetResult ?? null) : null,
    uncalibratedNote: route.calibrationApplied ? null : PROVIDER_HISTORY_UNCALIBRATED_NOTE_V1,
  };
}

/** Every candidate's history block, in projection order. Both surfaces call
 * this, so the web console and the miniapp cannot show different numbers for
 * the same run. */
export function providerHistoryViewsV1(projection: RoutePlanProjectionV1): ProviderHistoryViewV1[] {
  return projection.availableRoutes.flatMap((route) => {
    const view = providerHistoryViewV1(route);
    return view ? [view] : [];
  });
}

/**
 * The averaged Route Score, kept for v1 cards only.
 *
 * Under v2 it returns null and the column stays empty. Averaging four
 * dimensions that measure different things produces a number with no unit and
 * no defensible interpretation, and once history is in the comparison a single
 * percentage is exactly the summary a user would trust instead of the figures
 * that actually decided the ranking.
 */
function routeScorePercent(route: RoutePlanRouteV1): number | null {
  if (route.pathScore.scoringVersion === 'swap-path-score/v2') return null;
  const scored = route.pathScore.dimensions.filter((dimension) => dimension.status === 'scored' && dimension.score !== null);
  if (scored.length === 0) return null;
  return Math.round(scored.reduce((total, dimension) => total + (dimension.score ?? 0), 0) / scored.length);
}

/**
 * The "why" cell.
 *
 * T67E §3.4: the superlative is conditional on there being something to be
 * superlative ABOUT. With one quotable candidate, "Best net result for your
 * goal" is a claim over a set of one — true as arithmetic, and read by every
 * user as "the alternatives were checked and lost".
 */
function routeWhyV1(route: RoutePlanRouteV1, recommended: boolean, comparative: boolean): string {
  const parts = [
    recommended
      ? comparative
        ? 'Best net result for your goal'
        : 'Only route that produced a quote'
      : 'Alternative route',
    `${route.callCount} call${route.callCount === 1 ? '' : 's'}, ${route.approvalCount} approval${route.approvalCount === 1 ? '' : 's'}`,
    route.priceImpact ? `price impact ${route.priceImpact.percent}%` : 'price impact not provided',
  ];
  return parts.join(' · ');
}

/** Display names of the providers that produced a quote on this run. */
export function answeredProviderNamesV1(projection: RoutePlanProjectionV1): string[] {
  return projection.availableRoutes.map((route) => route.provider.displayName);
}

/** Every provider failure as a typed, user-readable view. */
export function providerFailuresFromProjectionV1(projection: RoutePlanProjectionV1): ProviderFailureViewV1[] {
  return providerFailureViewsV1(projection.providerFailures, answeredProviderNamesV1(projection));
}

/** Whether this run may present a comparative recommendation at all. */
export function comparisonClaimFromProjectionV1(projection: RoutePlanProjectionV1): ComparisonClaimViewV1 {
  return comparisonClaimV1(projection.availableRoutes.length);
}

/**
 * Candidate rows. Provider failures from swap-adapters become VISIBLE rows —
 * the table always shows everything that was considered, including what could
 * not answer and why.
 *
 * `registeredProviders` closes the third gap: an adapter that was never asked
 * (a protocol constraint excluded it, or the run ended before it was reached)
 * appeared in NEITHER list and so vanished from a table headed "everything
 * considered". Passing the registered set in keeps the row, marked unavailable
 * with the honest reason that it was not part of this run.
 */
export function candidatesFromProjectionV1(
  projection: RoutePlanProjectionV1,
  registeredProviders: readonly string[] = [],
): CandidateSourceV1[] {
  const recommendedHash = projection.recommendedRoute?.candidateHash ?? null;
  const comparative = comparisonClaimFromProjectionV1(projection).claim === 'comparative';
  const quoted: CandidateSourceV1[] = projection.availableRoutes.map((route) => ({
    id: route.candidateHash,
    name: route.provider.displayName,
    output: route.expectedOutput.amountDecimal,
    net: route.minimumOutput.amountDecimal,
    scorePercent: routeScorePercent(route),
    why: routeWhyV1(route, route.candidateHash === recommendedHash, comparative),
    state: route.candidateHash === recommendedHash ? 'chosen' : 'available',
  }));

  const failures = providerFailuresFromProjectionV1(projection);
  const failed: CandidateSourceV1[] = failures.map((failure) => ({
    id: `failure:${failure.providerId}:${failure.reason}`,
    name: failure.providerName,
    output: null,
    net: null,
    scorePercent: null,
    why: '',
    state: failure.reason === 'provider_not_configured' ? 'blocked' : 'unavailable',
    reason: failure.message,
  }));

  const accounted = new Set([
    ...quoted.map((row) => row.name.toLowerCase()),
    ...failures.map((failure) => failure.providerName.toLowerCase()),
    ...failures.map((failure) => failure.providerId.toLowerCase()),
  ]);
  const silent: CandidateSourceV1[] = registeredProviders
    .filter((provider) => !accounted.has(provider.toLowerCase()))
    .map((provider) => ({
      id: `not-asked:${provider}`,
      name: swapProviderDisplayNameV1(provider),
      output: null,
      net: null,
      scorePercent: null,
      why: '',
      state: 'unavailable' as const,
      // No cause is invented. The run simply did not include it, and saying so
      // beats both silence and a guessed error.
      reason: 'Not part of this comparison — it was not asked for a quote.',
    }));

  return [...quoted, ...failed, ...silent];
}

/**
 * T67E §3.4 — the candidate table, as a diagnostics view.
 *
 * One row per registered swap adapter, always. What it says about each one:
 * whether it quoted, why it did not, and how old its answer is. A provider that
 * failed keeps its row with a reason instead of vanishing, and a provider that
 * was never asked says so rather than borrowing another one's error.
 */
export interface ProviderDiagnosticRowV1 {
  provider: string;
  result: 'quoted' | 'unavailable' | 'not asked';
  /** Short phrase for the Reason column. */
  reason: string;
  /** The full sentence: what happened, what still works, what to do. */
  detail: string | null;
  /** Quote age for an answer, '—' for anything else. Never a fabricated 0s. */
  age: string;
  output: string | null;
  retryable: boolean;
}

export function providerDiagnosticRowsV1(
  projection: RoutePlanProjectionV1,
  registeredProviders: readonly string[] = [],
): ProviderDiagnosticRowV1[] {
  const quoted: ProviderDiagnosticRowV1[] = projection.availableRoutes.map((route) => ({
    provider: route.provider.displayName,
    result: 'quoted',
    reason: '—',
    detail: null,
    age: `${route.quoteAgeSeconds}s`,
    output: `${route.expectedOutput.amountDecimal} ${route.expectedOutput.asset.symbol}`,
    retryable: false,
  }));

  const failures = providerFailuresFromProjectionV1(projection);
  const failed: ProviderDiagnosticRowV1[] = failures.map((failure) => ({
    provider: failure.providerName,
    result: 'unavailable',
    reason: failure.reasonLabel,
    detail: failure.message,
    // No age: nothing was measured, and "0s" would read as an instant answer.
    age: '—',
    output: null,
    retryable: failure.retryable,
  }));

  const accounted = new Set(
    [...quoted, ...failed]
      .map((row) => row.provider.toLowerCase())
      .concat(failures.map((failure) => failure.providerId.toLowerCase())),
  );
  const silent: ProviderDiagnosticRowV1[] = registeredProviders
    .filter((provider) => !accounted.has(provider.toLowerCase()))
    .map((provider) => ({
      provider: swapProviderDisplayNameV1(provider),
      result: 'not asked',
      reason: 'not part of this run',
      detail: 'This adapter was not asked for a quote on this comparison.',
      age: '—',
      output: null,
      retryable: false,
    }));

  return [...quoted, ...failed, ...silent];
}

export function candidateRowsFromProjectionV1(
  projection: RoutePlanProjectionV1,
  registeredProviders: readonly string[] = [],
) {
  return deriveCandidateRowsV1(candidatesFromProjectionV1(projection, registeredProviders));
}

/** Sources table / evidence stream, straight from the projection's evidence
 * summary plus the failures. Cost is always stated — free or a price. */
export function evidenceSourcesFromProjectionV1(projection: RoutePlanProjectionV1): EvidenceSourceRowV1[] {
  const summary = projection.evidenceSummary as unknown as {
    records?: readonly { provider?: { displayName?: string }; evidenceType?: string; ageSeconds?: number; freeOrPaid?: string; costUsdc?: string | null }[];
    paidCount?: number;
    freeCount?: number;
  };
  const rows: EvidenceSourceRowV1[] = (summary.records ?? []).map((record) => ({
    name: record.provider?.displayName ?? 'source',
    kind: record.evidenceType ?? 'evidence',
    freshness: record.ageSeconds !== undefined ? `${record.ageSeconds}s` : null,
    cost: record.freeOrPaid === 'paid' ? (record.costUsdc ? `$${record.costUsdc}` : 'paid') : 'free',
    result: 'ok',
  }));
  for (const failure of providerFailuresFromProjectionV1(projection)) {
    rows.push({
      name: failure.providerName,
      kind: 'quote',
      freshness: null,
      cost: null,
      result: 'unavailable',
      // The short label here, not the full sentence: this cell sits in a dense
      // table. The sentence belongs to the diagnostics panel.
      reason: failure.reasonLabel,
    });
  }
  // MEV has no approved source — the row stays, with the reason.
  rows.push({ name: 'MEV feed', kind: 'mev', freshness: null, cost: null, result: 'unavailable', reason: 'no source' });
  return rows;
}

export function evidenceRowsFromProjectionV1(projection: RoutePlanProjectionV1) {
  return deriveEvidenceRowsV1(evidenceSourcesFromProjectionV1(projection));
}

export function shortfallNoticeFromProjectionV1(projection: RoutePlanProjectionV1): string | null {
  const answered = projection.availableRoutes.map((route) => ({ name: route.provider.displayName, answered: true }));
  const missing = providerFailuresFromProjectionV1(projection).map((failure) => ({
    name: failure.providerName,
    answered: false,
  }));
  return adapterShortfallCopyV1([...answered, ...missing]);
}

/**
 * T67B.1: an Aerodrome hop names its curve in the protocol field, because the
 * pair alone does not identify the pool — Aerodrome runs a stable and a
 * volatile pool for the same two tokens and they price completely differently.
 * Rendered as words rather than as the raw slug; every other protocol is
 * passed through untouched.
 */
export function poolProtocolLabelV1(protocol: string | undefined): string | undefined {
  if (protocol === 'aerodrome-stable') return 'Aerodrome · stable pool';
  if (protocol === 'aerodrome-volatile') return 'Aerodrome · volatile pool';
  return protocol;
}

/** Route graph from the recommended route's evidence. When the provider gave
 * no pool breakdown the graph is omitted WITH a reason — never faked. */
export function routeGraphFromRouteV1(
  route: RoutePlanRouteV1 | null,
  input: { amountLabel: string; walletLabel: string },
): RouteGraphModelV1 | null {
  if (!route) return null;
  const pools = (route.evidence as unknown as { liquiditySources?: readonly { name?: string; protocol?: string; sharePercent?: string; depthUsd?: string }[] })
    .liquiditySources ?? [];
  if (pools.length === 0) return null;
  return {
    input: { id: 'in', title: input.amountLabel, subtitle: 'your wallet', kind: 'input' },
    pools: pools.slice(0, 2).map((pool, index) => ({
      id: `${pool.name ?? pool.protocol ?? 'pool'}-${index}`,
      title: pool.name ?? poolProtocolLabelV1(pool.protocol) ?? 'Pool',
      subtitle: [pool.sharePercent ? `${pool.sharePercent}%` : null, pool.depthUsd ? `$${pool.depthUsd} depth` : null].filter(Boolean).join(' · ') || 'share not reported',
      kind: index === 0 ? 'pool-a' : 'pool-b',
    })),
    output: {
      id: 'out',
      title: `${route.expectedOutput.amountDecimal} ${route.expectedOutput.asset.symbol}`,
      subtitle: 'back to your wallet',
      kind: 'output',
    },
    description: `Route path: ${input.amountLabel} through ${pools.length} pool${pools.length === 1 ? '' : 's'} into ${route.expectedOutput.amountDecimal} ${route.expectedOutput.asset.symbol}`,
  };
}

export function quoteFreshnessFromRouteV1(route: RoutePlanRouteV1 | null) {
  return quoteFreshnessV1(route ? route.quoteAgeSeconds : null);
}

/** Simulation, from the T63 adapter's response when present. Until it answers
 * the Review screen shows an honest "not available" — never a green tick. */
export function simulationSourceFromResponseV1(response: unknown): SimulationSourceV1 | null {
  if (!response || typeof response !== 'object') return null;
  const value = response as {
    outcome?: string;
    reason?: string;
    simulation?: { status?: string; blockNumber?: string | null; observedAt?: string | null };
    evidence?: { provider?: { displayName?: string }; gasUsed?: string | null };
  };
  if (value.outcome === 'simulated' || value.outcome === 'cached' || value.outcome === 'charged') {
    const status = value.simulation?.status;
    return {
      status: status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'unavailable',
      provider: value.evidence?.provider?.displayName ?? null,
      blockNumber: value.simulation?.blockNumber ?? null,
      ageSeconds: value.simulation?.observedAt ? Math.max(0, Math.round((Date.now() - Date.parse(value.simulation.observedAt)) / 1000)) : null,
      gasUsed: value.evidence?.gasUsed ?? null,
    };
  }
  if (value.outcome) {
    return { status: 'unavailable', provider: null, blockNumber: null, ageSeconds: null, gasUsed: null, reason: value.reason ?? value.outcome };
  }
  return null;
}

export function scoreRowsFromProjectionV1(projection: RoutePlanProjectionV1 | null) {
  return deriveScoreRowsV1(scoreDimensionsFromPathScoreV1((projection?.pathScore ?? null) as PathScoreLikeV1 | null));
}
