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
