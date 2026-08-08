import type { EvidenceTypeV1, RouteIntentV1 } from '@mioagent/route-domain';

/**
 * How far after `now` an observation may honestly sit.
 *
 * `now` is the evaluation's OWN start, captured before any network call. A
 * provider that reports its real observation time therefore reports a moment
 * AFTER it — the request had to happen first. That is fresher than the
 * snapshot, not from the future, and comparing the two directly was simply the
 * wrong reference.
 *
 * In production it cost the whole comparison. KyberSwap is the only adapter
 * that passes the provider's own timestamp through — the others fall back to
 * `input.now` and so could never trip it — and with the candidate phase taking
 * five to ten seconds, its quote was rejected on every run. Aerodrome cannot
 * be scored (it reports no USD gas), so losing KyberSwap left one rankable
 * route, which is not a comparison: no recommendation, no Route Card, and a
 * Review button with nothing behind it.
 *
 * A minute is far longer than any run and far shorter than what these guards
 * are for. They exist to catch a provider stamping a quote hours or days
 * ahead, which makes freshness meaningless — not to police the seconds an HTTP
 * round trip takes.
 *
 * One-sided by construction: a quote from the past still ages normally, and
 * nothing here extends an expiry. Four places share it — the candidate guard,
 * the evidence guard, and the quote and gas freshness filters — because a
 * quote that clears one and fails the next is the same dead end wearing a
 * different code.
 */
export const OBSERVATION_LOOKAHEAD_MS_V1 = 60_000;

export const SWAP_PATH_SCORE_VERSION_V1 = 'swap-path-score/v1' as const;
/** T67C.1 Part 2. v1 is frozen: it is recorded in every score snapshot already
 * persisted, and changing what that string means would rewrite the meaning of
 * history. v2 is a different policy, not a revision of v1. */
export const SWAP_PATH_SCORE_VERSION_V2 = 'swap-path-score/v2' as const;
export type SwapPathScoreVersionV1 =
  | typeof SWAP_PATH_SCORE_VERSION_V1
  | typeof SWAP_PATH_SCORE_VERSION_V2;
export const SWAP_ROUTE_CONFIDENCE_VERSION_V1 = 'swap-route-confidence/v1' as const;

export const SCORE_CONFIDENCE_V1 = {
  high: { label: 'high', value: 0.9 },
  medium: { label: 'medium', value: 0.7 },
  low: { label: 'low', value: 0.5 },
} as const;

export const REQUIRED_EVIDENCE_V1 = {
  standard: ['quote', 'gas'],
  enhanced: ['quote', 'gas', 'simulation', 'contract_risk'],
  maximum: [
    'quote',
    'gas',
    'simulation',
    'contract_risk',
    'token_risk',
    'provider_reliability',
    'mev_protection',
  ],
} as const satisfies Record<RouteIntentV1['verificationDepth'], readonly EvidenceTypeV1[]>;

export const SUPPORTED_OPTIMIZATION_MODES_V1 = new Set<RouteIntentV1['optimizationMode']>([
  'best_net_result',
  'lowest_fees',
  'simplest_route',
]);

/** Under v2 `lowest_risk` becomes rankable, because there is finally a measured
 * risk to rank on. `fastest_execution` joins it only when an eligible snapshot
 * carries a p90 confirmation time; `mev_protected` never does — reliability
 * history says nothing about MEV exposure, and letting it stand in would be a
 * safety claim built from an unrelated measurement. */
export const SUPPORTED_OPTIMIZATION_MODES_V2 = new Set<RouteIntentV1['optimizationMode']>([
  'best_net_result',
  'lowest_fees',
  'simplest_route',
  'lowest_risk',
  'fastest_execution',
]);

export const UNCERTAIN_EXECUTION_RISK_FLAGS_V1 = new Set([
  'call-count-uncertain',
  'call_count_uncertain',
  'uncertain-call-count',
  'uncertain_call_count',
  'approval-count-uncertain',
  'approval_count_uncertain',
  'uncertain-approval-count',
  'uncertain_approval_count',
  'execution-model-uncertain',
  'execution_model_uncertain',
]);
