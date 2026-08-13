import type { EvidenceRecordV1, RouteCandidateV1, RouteIntentV1 } from '@mioagent/route-domain';

export type ReleasedSwapAdapterId = 'uniswap' | 'kyberswap' | 'aerodrome' | 'o1-exchange' | 'hydrex';
export type ManifestedSwapAdapterId = 'balancer';
export type SwapAdapterId = ReleasedSwapAdapterId | ManifestedSwapAdapterId;

export type SwapAdapterFailureOutcome =
  | 'unsupported'
  | 'not_configured'
  | 'unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'invalid_response'
  | 'rejected';

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
