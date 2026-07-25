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
} from '@mioagent/ui';
import type { RouteGraphModelV1 } from '@mioagent/ui';

// Structural mirrors of the route-card projection. The surface layer types the
// wire STRUCTURALLY (the same rule lib/ui follows) so a UI change never drags a
// contract package into the bundle.
export interface RoutePlanRouteV1 {
  candidateHash: string;
  provider: { displayName: string };
  expectedOutput: { amountDecimal: string; asset: { symbol: string } };
  minimumOutput: { amountDecimal: string };
  estimatedGas: { gasUnits: string; estimatedCostUsd: string | null };
  priceImpact: { percent: string };
  slippage: { percent: string };
  quoteAgeSeconds: number;
  callCount: number;
  approvalCount: number;
  pathScore: PathScoreLikeV1;
  evidence: unknown;
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
  providerFailures: readonly { adapterId: string; errorCode: string }[];
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

export function scoringVersionLabelV1(pathScore: PathScoreLikeV1 | null): string {
  return pathScore?.scoringVersion ? `${pathScore.scoringVersion} · weighted to your goal` : 'scoring unavailable';
}

function routeScorePercent(route: RoutePlanRouteV1): number | null {
  const scored = route.pathScore.dimensions.filter((dimension) => dimension.status === 'scored' && dimension.score !== null);
  if (scored.length === 0) return null;
  return Math.round(scored.reduce((total, dimension) => total + (dimension.score ?? 0), 0) / scored.length);
}

function routeWhyV1(route: RoutePlanRouteV1, recommended: boolean): string {
  const parts = [
    recommended ? 'Best net result for your goal' : 'Alternative route',
    `${route.callCount} call${route.callCount === 1 ? '' : 's'}, ${route.approvalCount} approval${route.approvalCount === 1 ? '' : 's'}`,
    `price impact ${route.priceImpact.percent}%`,
  ];
  return parts.join(' · ');
}

/**
 * Candidate rows. Provider failures from swap-adapters become VISIBLE rows —
 * the table always shows everything that was considered, including what could
 * not answer and why.
 */
export function candidatesFromProjectionV1(projection: RoutePlanProjectionV1): CandidateSourceV1[] {
  const recommendedHash = projection.recommendedRoute?.candidateHash ?? null;
  const quoted: CandidateSourceV1[] = projection.availableRoutes.map((route) => ({
    id: route.candidateHash,
    name: route.provider.displayName,
    output: route.expectedOutput.amountDecimal,
    net: route.minimumOutput.amountDecimal,
    scorePercent: routeScorePercent(route),
    why: routeWhyV1(route, route.candidateHash === recommendedHash),
    state: route.candidateHash === recommendedHash ? 'chosen' : 'available',
  }));

  const failed: CandidateSourceV1[] = projection.providerFailures.map((failure) => ({
    id: `failure:${failure.adapterId}:${failure.errorCode}`,
    name: failure.adapterId,
    output: null,
    net: null,
    scorePercent: null,
    why: '',
    state: failure.errorCode === 'policy_blocked' ? 'blocked' : 'unavailable',
    reason: consoleFailureCopyV1(failure.errorCode),
  }));

  return [...quoted, ...failed];
}

export function candidateRowsFromProjectionV1(projection: RoutePlanProjectionV1) {
  return deriveCandidateRowsV1(candidatesFromProjectionV1(projection));
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
  for (const failure of projection.providerFailures) {
    rows.push({
      name: failure.adapterId,
      kind: 'quote',
      freshness: null,
      cost: null,
      result: 'unavailable',
      reason: consoleFailureCopyV1(failure.errorCode),
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
  const missing = projection.providerFailures.map((failure) => ({ name: failure.adapterId, answered: false }));
  return adapterShortfallCopyV1([...answered, ...missing]);
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
      title: pool.name ?? pool.protocol ?? 'Pool',
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
