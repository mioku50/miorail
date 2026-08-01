import type { EvidenceTypeV1, RouteIntentV1 } from '@mioagent/route-domain';

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
