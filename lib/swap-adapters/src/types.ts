import type { EvidenceRecordV1, RouteCandidateV1, RouteIntentV1 } from '@mioagent/route-domain';

export type ReleasedSwapAdapterId = 'uniswap' | 'kyberswap' | 'aerodrome' | 'o1-exchange' | 'hydrex' | 'balancer';
// Kept as a branded string so the generic honest-placeholder adapter remains
// usable for future manifested providers without pretending Balancer is one.
export type ManifestedSwapAdapterId = never;
export type SwapAdapterId = ReleasedSwapAdapterId | ManifestedSwapAdapterId;

export type SwapAdapterFailureOutcome =
  | 'unsupported'
  | 'not_configured'
  | 'unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'invalid_response'
  | 'rejected'
  /**
   * The provider reached a verdict and declined to give one, on its own
   * trading policy.
   *
   * A fifth thing, and the only one that is about neither the token nor the
   * market. It is NOT `unavailable` (that is the market having no route), NOT
   * `unsupported` (that is our coverage stopping short), and NOT `rejected`
   * (that is us refusing an answer we did get). Collapsing it into any of the
   * three would put a venue's house rules on a different party's account.
   */
  | 'policy_refused';

export interface SwapAdapterQuoteInput {
  intent: RouteIntentV1;
  walletAddress: `0x${string}`;
  requestId: string;
  now: Date;
}

export interface SwapAdapterFailure {
  outcome: SwapAdapterFailureOutcome;
  provider: SwapAdapterId;
  errorCode: string;
  retryable: boolean;
}

export type SwapAdapterResult =
  | {
      outcome: 'quoted';
      candidate: RouteCandidateV1;
      evidence: EvidenceRecordV1[];
    }
  | SwapAdapterFailure;

export interface SwapRouteAdapter {
  readonly id: SwapAdapterId;
  supports(intent: RouteIntentV1): boolean;
  quote(input: SwapAdapterQuoteInput): Promise<SwapAdapterResult>;
}

export type SwapAdapterSelectionResult =
  | { outcome: 'selected'; adapters: SwapRouteAdapter[] }
  | {
      outcome: 'no_eligible_adapters';
      adapters: [];
      errorCode: 'no_eligible_swap_adapters';
    };
