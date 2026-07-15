import type { SemanticConversationMessage } from '@mioagent/intent-core';
import type { RouteIntentV1 } from '@mioagent/route-domain';

export type IntentLocaleV1 = 'en' | 'ru';

export interface SwapIntentExtractionV2 {
  goal: 'swap' | 'unsupported' | 'ambiguous';
  amount: string | null;
  fromAsset: string | null;
  toAsset: string | null;
  chainId: number | null;
}

export type ClarificationCodeV1 =
  | 'amount_required'
  | 'exact_amount_required'
  | 'from_asset_required'
  | 'to_asset_required'
  | 'asset_pair_invalid'
  | 'asset_unknown'
  | 'chain_unsupported'
  | 'protocol_conflict'
  | 'slippage_invalid'
  | 'intent_ambiguous';

export type IntentIssueCodeV1 =
  | ClarificationCodeV1
  | 'approval_bypass_forbidden'
  | 'prompt_injection_detected'
  | 'server_signing_forbidden'
  | 'asset_address_unsafe'
  | 'conflicting_amounts'
  | 'conflicting_protocol_constraints'
  | 'unsupported_goal'
  | 'extractor_invalid'
  | 'extractor_field_ungrounded'
  | 'context_ambiguous';

export interface IntentIssueV1 {
  code: IntentIssueCodeV1;
  field: string;
  severity: 'clarification' | 'rejection';
  message: string;
}

export interface ClarificationV1 {
  code: ClarificationCodeV1;
  message: string;
  missingFields: string[];
  locale: IntentLocaleV1;
}

export interface PendingSwapIntentV2 {
  schemaVersion: 'pending-swap-intent/v2';
  tenantId: string;
  walletAddress: string;
  chainId: 8453;
  sourceRequestId: string;
  createdAt: string;
  expiresAt: string;
  amountDecimal: string | null;
  fromAssetSymbol: 'USDC' | 'ETH' | 'WETH' | null;
  toAssetSymbol: 'USDC' | 'ETH' | 'WETH' | null;
}

export interface IntentRuntimeContextV2 {
  tenantId: string;
  walletAddress: string;
  runtimeChainId: 8453;
  requestId: string;
  requestedAt: string;
  recentMessages?: SemanticConversationMessage[];
  pendingIntents?: PendingSwapIntentV2[];
}

export type IntentResolutionV2 =
  | {
      outcome: 'ready';
      routeIntent: RouteIntentV1;
      clarification: null;
      issues: [];
      pendingIntent: null;
    }
  | {
      outcome: 'needs_clarification';
      routeIntent: null;
      clarification: ClarificationV1;
      issues: IntentIssueV1[];
      pendingIntent: PendingSwapIntentV2 | null;
    }
  | {
      outcome: 'rejected';
      routeIntent: null;
      clarification: null;
      issues: IntentIssueV1[];
      pendingIntent: null;
    };
