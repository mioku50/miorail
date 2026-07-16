import {
  ExecutionBlueprintV1Schema,
  SafetyKernelResultV1Schema,
  type ExecutionBlueprintV1,
  type HashV1,
  type RouteCandidateV1,
  type RouteIntentV1,
  type SafetyKernelResultV1,
  type TokenAmountV1,
} from '@mioagent/route-domain';
import { TransactionReviewProjectionV1Schema, type TransactionReviewProjectionV1 } from '@mioagent/route-card';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import type { SwapRouteAdapter } from '@mioagent/swap-adapters';
import type { ExecutionTokenSecurityResult } from '@mioagent/security';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Composer public contract
// ---------------------------------------------------------------------------

export interface TransactionComposerPrepareInput {
  tenantId: string;
  walletAddress: `0x${string}`;
  routeRunId: string;
  routeCardHash: HashV1;
  selectedCandidateHash: HashV1;
  requestId: string;
  now: Date;
}

export interface TransactionComposer {
  prepare(input: TransactionComposerPrepareInput): Promise<TransactionPreparationResultV1>;
}

// ---------------------------------------------------------------------------
// TransactionPreparationResultV1 — the 4-outcome discriminated union. `prepared`
// carries the persisted ExecutionBlueprintV1 plus its read-only review
// projection; `refresh_required`/`unsupported` carry only an honest reason;
// `blocked` carries the full SafetyKernelResultV1 so the caller can display
// exactly which check failed. No outcome ever carries a signed/broadcastable
// payload — every call in `blueprint.calls` is unsigned EIP-5792 calldata.
// ---------------------------------------------------------------------------

const RefreshReasonV1Schema = z.enum([
  'card_expired',
  'quote_expired',
  'blueprint_expired',
  'fresh_output_below_minimum',
]);
export type RefreshReasonV1 = z.infer<typeof RefreshReasonV1Schema>;

const UnsupportedReasonV1Schema = z.enum([
  'unsupported_pair',
  'unsupported_provider',
  'unsupported_card_state',
]);
export type UnsupportedReasonV1 = z.infer<typeof UnsupportedReasonV1Schema>;

export const TransactionPreparationResultV1Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('prepared'),
      routeRunId: z.string().min(1).max(200),
      blueprint: ExecutionBlueprintV1Schema,
      review: TransactionReviewProjectionV1Schema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('refresh_required'),
      routeRunId: z.string().min(1).max(200),
      reason: RefreshReasonV1Schema,
      detail: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('unsupported'),
      reason: UnsupportedReasonV1Schema,
      detail: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('blocked'),
      routeRunId: z.string().min(1).max(200),
      safety: SafetyKernelResultV1Schema,
    })
    .strict(),
]);
export type TransactionPreparationResultV1 = z.infer<typeof TransactionPreparationResultV1Schema>;

export function preparedResultV1(input: {
  routeRunId: string;
  blueprint: ExecutionBlueprintV1;
  review: TransactionReviewProjectionV1;
}): TransactionPreparationResultV1 {
  return { outcome: 'prepared', routeRunId: input.routeRunId, blueprint: input.blueprint, review: input.review };
}

export function refreshRequiredResultV1(
  routeRunId: string,
  reason: RefreshReasonV1,
  detail: string,
): TransactionPreparationResultV1 {
  return { outcome: 'refresh_required', routeRunId, reason, detail };
}

export function unsupportedResultV1(reason: UnsupportedReasonV1, detail: string): TransactionPreparationResultV1 {
  return { outcome: 'unsupported', reason, detail };
}

export function blockedResultV1(routeRunId: string, safety: SafetyKernelResultV1): TransactionPreparationResultV1 {
  return { outcome: 'blocked', routeRunId, safety };
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface ContractSecurityLookupInput {
  chainId: number;
  addresses: `0x${string}`[];
}

/** Injected so this package never imports @mioagent/data-providers directly. */
export type ContractSecurityLookup = (
  input: ContractSecurityLookupInput,
) => Promise<ExecutionTokenSecurityResult[]>;

export interface TransactionComposerDependencies {
  repository: RouteStorageRepository;
  buildAdapters: SwapBuildAdapter[];
  quoteAdapters: SwapRouteAdapter[];
  contractSecurity: ContractSecurityLookup;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// SwapBuildAdapter — turns a fresh, stored intent + fresh candidate into
// exact unsigned EIP-5792 calls for one provider. Registry selection is by
// selectedCandidate.provider.id only — never message-based detection.
// ---------------------------------------------------------------------------

export type SwapBuildProviderId = 'uniswap' | 'kyberswap';

export interface SwapBuildInput {
  intent: RouteIntentV1;
  selectedCandidate: RouteCandidateV1;
  walletAddress: `0x${string}`;
  now: Date;
  requestId: string;
}

export type SwapBuildFailureOutcome =
  | 'not_configured'
  | 'unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'invalid_response'
  | 'rejected'
  | 'router_mismatch'
  | 'expired';

export interface SwapBuildFailure {
  outcome: SwapBuildFailureOutcome;
  provider: SwapBuildProviderId;
  errorCode: string;
  retryable: boolean;
}

export interface SwapBuildCallV1 {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
}

export interface SwapBuildSuccess {
  outcome: 'built';
  provider: SwapBuildProviderId;
  routerAddress: `0x${string}`;
  calls: SwapBuildCallV1[];
  quoteExpiry: string;
  requestId: string;
  requestHash: HashV1;
  responseHash: HashV1;
  /**
   * Outputs sourced strictly from the SAME provider response that produced
   * the calls (Uniswap: the quote fed into /swap_5792; Kyber: the routeSummary
   * actually POSTed to route/build). The review projection and the blueprint's
   * expectedAssetChanges display these — never the separate quote-adapter
   * candidate's numbers, which come from a different round trip.
   */
  expectedOutput: TokenAmountV1;
  minimumOutput: TokenAmountV1;
}

export type SwapBuildResultV1 = SwapBuildSuccess | SwapBuildFailure;

export interface SwapBuildAdapter {
  readonly id: SwapBuildProviderId;
  build(input: SwapBuildInput): Promise<SwapBuildResultV1>;
}
