import type { RoutePlanProjectionV1, RoutePlanRouteV1 } from '@mioagent/route-card/contracts';

export const ROUTE_SCORE_LABELS = {
  net_result: 'Net result',
  quote_freshness: 'Quote freshness',
  route_simplicity: 'Route simplicity',
  transaction_safety: 'Transaction safety',
} as const;

export type RoutePlanSurfaceState =
  | 'idle'
  | 'loading'
  | 'error'
  | 'clarification'
  | 'rejection'
  | 'evaluated';

export function routePlanSurfaceState(input: {
  isPending: boolean;
  isError: boolean;
  outcome?: 'needs_clarification' | 'rejected' | 'evaluated';
}): RoutePlanSurfaceState {
  if (input.isPending) return 'loading';
  if (input.isError) return 'error';
  if (input.outcome === 'needs_clarification') return 'clarification';
  if (input.outcome === 'rejected') return 'rejection';
  if (input.outcome === 'evaluated') return 'evaluated';
  return 'idle';
}

export function formatEvidenceType(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function isRoutePlanExpired(
  projection: Pick<RoutePlanProjectionV1, 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  return projection.expiresAt !== null && Date.parse(projection.expiresAt) <= now.getTime();
}

export function routePlanOutcomeCopy(
  projection: Pick<RoutePlanProjectionV1, 'outcome' | 'reason'>,
): { eyebrow: string; title: string; detail: string } {
  if (projection.outcome === 'ready') {
    return { eyebrow: '2 routes compared', title: 'A supported route stands out', detail: 'The recommendation is relative to your selected optimization mode and current evidence.' };
  }
  if (projection.outcome === 'constrained') {
    return { eyebrow: 'Provider constrained', title: 'Using your requested provider', detail: 'This route was not compared as the global best route.' };
  }
  if (projection.reason === 'single_provider_available') {
    return { eyebrow: 'Comparison degraded', title: 'Only one route is currently available', detail: 'No comparative recommendation was made.' };
  }
  if (projection.reason === 'unsupported_optimization_evidence') {
    return { eyebrow: 'Evidence incomplete', title: 'Routes found, ranking unavailable', detail: 'Miorail does not yet have enough evidence for this optimization mode.' };
  }
  return { eyebrow: 'Comparison unavailable', title: 'Routes could not be compared', detail: 'Review the provider notices and retry manually.' };
}

export function routeDisplayLabel(input: {
  projection: Pick<RoutePlanProjectionV1, 'outcome'>;
  route: RoutePlanRouteV1;
  expired: boolean;
}): string {
  if (input.expired) return 'Stale route';
  if (input.projection.outcome === 'ready') return 'Recommended route';
  if (input.projection.outcome === 'constrained') return 'Requested route';
  return 'Available route';
}

// T56: candidate selection + "Review transaction" gating. Pure presentational
// logic only — the server re-validates every binding, hash, and safety check
// independently; this only decides what the UI offers to click.

export interface SelectableSwapCandidateV1 {
  candidateHash: string;
  providerId: string;
  providerLabel: string;
  isRecommended: boolean;
}

export function selectableSwapCandidates(
  projection: Pick<RoutePlanProjectionV1, 'recommendedRoute' | 'alternatives'>,
): SelectableSwapCandidateV1[] {
  const candidates: SelectableSwapCandidateV1[] = [];
  if (projection.recommendedRoute) {
    candidates.push({
      candidateHash: projection.recommendedRoute.candidateHash,
      providerId: projection.recommendedRoute.provider.id,
      providerLabel: projection.recommendedRoute.provider.displayName,
      isRecommended: true,
    });
  }
  for (const alternative of projection.alternatives) {
    candidates.push({
      candidateHash: alternative.candidateHash,
      providerId: alternative.provider.id,
      providerLabel: alternative.provider.displayName,
      isRecommended: false,
    });
  }
  return candidates;
}

export function defaultSelectedCandidateHash(
  projection: Pick<RoutePlanProjectionV1, 'recommendedRoute' | 'alternatives'>,
): string | null {
  return projection.recommendedRoute?.candidateHash ?? projection.alternatives[0]?.candidateHash ?? null;
}

/**
 * Client-side gating only: the composer independently re-validates card
 * state, expiry, and every hash server-side and fails closed regardless of
 * what this returns. `ready`/`constrained` outcomes carry a recommended (or
 * requested) route the server can still prepare; `degraded`/`failed` never
 * do.
 */
export function canReviewTransaction(input: {
  projection: Pick<RoutePlanProjectionV1, 'outcome' | 'routeCardHash' | 'expiresAt'>;
  now?: Date;
}): boolean {
  const { projection, now = new Date() } = input;
  if (projection.routeCardHash === null) return false;
  if (projection.outcome !== 'ready' && projection.outcome !== 'constrained') return false;
  return !isRoutePlanExpired(projection, now);
}
