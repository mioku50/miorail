import {
  bindBaseMainnetChain,
  looksLikePromptInjection,
  requestsApprovalBypass,
} from '@mioagent/intent-core';
import {
  AddressV1Schema,
  RouteIntentV1Schema,
  TenantIdV1Schema,
  TimestampV1Schema,
  ZERO_HASH_V1,
  hashRouteIntentV1,
  stableHashV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import type { LlmProvider } from '@mioagent/llm';
import { extractSwapIntentV2 } from './extractor.js';
import {
  buildPendingSwapIntentV2,
  createClarificationV1,
  decimalToAtomicV1,
  detectIntentLocaleV1,
  groundSwapFieldsV2,
  namesTrustedAssetPairV1,
  sortIntentIssuesV1,
} from './normalization.js';
import type {
  ClarificationCodeV1,
  IntentIssueV1,
  IntentResolutionV2,
  IntentRuntimeContextV2,
  SwapIntentExtractionV2,
} from './types.js';

const SERVER_SIGNING_LANGUAGE =
  /\b(?:server|backend|agent)\b.{0,40}\b(?:sign|broadcast|submit)\b|\b(?:sign|broadcast|submit)\b.{0,40}\b(?:for me|without me|itself|this transaction|the transaction|this swap)\b|(?:сервер|агент).{0,40}(?:подпиш|отправ|опублику)|(?:подпиши|отправь).{0,40}(?:за меня|самостоятельно|без меня|эту транзакцию)/iu;
const UNSUPPORTED_CHAIN_LANGUAGE =
  /\b(?:ethereum mainnet|ethereum network|on ethereum|arbitrum|optimism|polygon|base sepolia|sepolia)\b|\bchain\s*(?:1|84532)\b|(?:сеть|сети)\s+(?:ethereum|arbitrum|optimism|polygon|sepolia)/iu;
const UNSUPPORTED_GOAL_LANGUAGE =
  /\b(?:send|lend|earn|yield|supply|borrow|repay|withdraw)\b|(?:отправ|доходност|заработ|внес|одолж|погас|вывед)/iu;
// "Переведи 0.1 USDC в ETH" is how a Russian speaker asks for a conversion, and
// "transfer" carries the same double meaning. These verbs name an unsupported
// goal only when the request does not name both sides of a swap pair; sending
// tokens to a recipient never does, and an untrusted address is refused before
// this point anyway.
const CONVERTIBLE_TRANSFER_LANGUAGE = /\btransfer\b|(?:перевед|перевес|перевод)/iu;
// ...and never when the sentence also names somewhere for the tokens to land.
const RECIPIENT_TARGET_LANGUAGE =
  /\b(?:wallet|address|recipient|friend|exchange|him|her|them)\b|(?:кошел|адрес|получател|друг|бирж|ему|ей|им)/iu;

const CLARIFICATION_CODES = new Set<ClarificationCodeV1>([
  'amount_required',
  'exact_amount_required',
  'from_asset_required',
  'to_asset_required',
  'asset_pair_invalid',
  'asset_unknown',
  'chain_unsupported',
  'protocol_conflict',
  'slippage_invalid',
  'intent_ambiguous',
]);

function issue(
  code: IntentIssueV1['code'],
  field: string,
  severity: IntentIssueV1['severity'],
  message: string,
): IntentIssueV1 {
  return { code, field, severity, message };
}

function validateRuntimeContext(context: IntentRuntimeContextV2): {
  walletAddress: `0x${string}` | null;
  requestedAt: string | null;
  issues: IntentIssueV1[];
} {
  const issues: IntentIssueV1[] = [];
  const tenant = TenantIdV1Schema.safeParse(context.tenantId);
  const wallet = AddressV1Schema.safeParse(context.walletAddress);
  const requestedAt = TimestampV1Schema.safeParse(context.requestedAt);
  if (
    !tenant.success ||
    !wallet.success ||
    !requestedAt.success ||
    typeof context.requestId !== 'string' ||
    !context.requestId.trim()
  ) {
    issues.push(
      issue(
        'extractor_invalid',
        'context',
        'rejection',
        'Authenticated intent context is incomplete or malformed',
      ),
    );
  }
  if (context.runtimeChainId !== 8453) {
    issues.push(
      issue(
        'chain_unsupported',
        'context.runtimeChainId',
        'rejection',
        'Authenticated runtime must be bound to Base mainnet',
      ),
    );
  }
  return {
    walletAddress: wallet.success ? wallet.data : null,
    requestedAt: requestedAt.success ? requestedAt.data : null,
    issues,
  };
}

function safetyIssues(message: string, extraction: SwapIntentExtractionV2 | null): IntentIssueV1[] {
  const issues: IntentIssueV1[] = [];
  const chain = bindBaseMainnetChain(extraction?.chainId ?? null, 8453);
  if (looksLikePromptInjection(message)) {
    issues.push(
      issue(
        'prompt_injection_detected',
        'message',
        'rejection',
        'Prompt injection attempts cannot become financial intents',
      ),
    );
  }
  if (requestsApprovalBypass(message)) {
    issues.push(
      issue(
        'approval_bypass_forbidden',
        'message',
        'rejection',
        'Base Account approval cannot be bypassed',
      ),
    );
  }
  if (SERVER_SIGNING_LANGUAGE.test(message)) {
    issues.push(
      issue(
        'server_signing_forbidden',
        'message',
        'rejection',
        'The server cannot sign or broadcast wallet transactions',
      ),
    );
  }
  if (UNSUPPORTED_CHAIN_LANGUAGE.test(message) || (extraction !== null && !chain.supported)) {
    issues.push(
      issue(
        'chain_unsupported',
        'chainId',
        'rejection',
        'Swap Intent V2 supports Base mainnet only',
      ),
    );
  }
  const transferIsNotConversion =
    CONVERTIBLE_TRANSFER_LANGUAGE.test(message) &&
    (!namesTrustedAssetPairV1(message) || RECIPIENT_TARGET_LANGUAGE.test(message));
  if (
    extraction?.goal === 'unsupported' ||
    UNSUPPORTED_GOAL_LANGUAGE.test(message) ||
    transferIsNotConversion
  ) {
    issues.push(
      issue(
        'unsupported_goal',
        'goal',
        'rejection',
        'T52 supports only the Swap V1 financial goal',
      ),
    );
  }
  if (!extraction) {
    issues.push(
      issue(
        'extractor_invalid',
        'extraction',
        'rejection',
        'Strict extractor output is malformed or contains unknown keys',
      ),
    );
  } else if (extraction.goal === 'ambiguous') {
    issues.push(
      issue(
        'intent_ambiguous',
        'goal',
        'clarification',
        'The extracted financial goal is ambiguous',
      ),
    );
  }
  return issues;
}

function missingFieldIssues(input: {
  amountDecimal: string | null;
  fromAsset: RouteIntentV1['fromAsset'];
  toAsset: RouteIntentV1['toAsset'];
}): IntentIssueV1[] {
  const issues: IntentIssueV1[] = [];
  if (!input.amountDecimal) {
    issues.push(
      issue('amount_required', 'amount', 'clarification', 'An exact swap amount is required'),
    );
  }
  if (!input.fromAsset) {
    issues.push(
      issue(
        'from_asset_required',
        'fromAsset',
        'clarification',
        'A trusted Base source asset is required',
      ),
    );
  }
  if (!input.toAsset) {
    issues.push(
      issue(
        'to_asset_required',
        'toAsset',
        'clarification',
        'A trusted Base destination asset is required',
      ),
    );
  }
  if (input.fromAsset && input.toAsset && input.fromAsset.assetId === input.toAsset.assetId) {
    issues.push(
      issue(
        'asset_pair_invalid',
        'toAsset',
        'clarification',
        'Swap source and destination assets must differ',
      ),
    );
  }
  return issues;
}

function clarificationCode(issues: IntentIssueV1[]): ClarificationCodeV1 {
  const direct = issues.find(
    (item) =>
      item.severity === 'clarification' &&
      CLARIFICATION_CODES.has(item.code as ClarificationCodeV1),
  );
  if (direct) return direct.code as ClarificationCodeV1;
  return 'intent_ambiguous';
}

function missingFields(issues: IntentIssueV1[]): string[] {
  const preferredOrder = [
    'amount',
    'fromAsset',
    'toAsset',
    'chainId',
    'protocolConstraint',
    'slippageConstraint',
    'optimizationMode',
    'goal',
  ];
  const fields = new Set(
    issues.filter((item) => item.severity === 'clarification').map((item) => item.field),
  );
  return [...fields].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left);
    const rightIndex = preferredOrder.indexOf(right);
    return (
      (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex) ||
      left.localeCompare(right)
    );
  });
}

export function resolveSwapIntentV2(input: {
  message: string;
  context: IntentRuntimeContextV2;
  extraction: SwapIntentExtractionV2 | null;
}): IntentResolutionV2 {
  const locale = detectIntentLocaleV1(input.message);
  const runtime = validateRuntimeContext(input.context);
  const initialIssues = sortIntentIssuesV1([
    ...runtime.issues,
    ...safetyIssues(input.message, input.extraction),
  ]);
  if (initialIssues.some((item) => item.severity === 'rejection')) {
    return {
      outcome: 'rejected',
      routeIntent: null,
      clarification: null,
      issues: initialIssues,
      pendingIntent: null,
    };
  }
  if (!input.extraction || !runtime.walletAddress || !runtime.requestedAt) {
    return {
      outcome: 'rejected',
      routeIntent: null,
      clarification: null,
      issues: initialIssues,
      pendingIntent: null,
    };
  }

  const fields = groundSwapFieldsV2({
    message: input.message,
    extraction: input.extraction,
    context: input.context,
    walletAddress: runtime.walletAddress,
  });
  const issues = sortIntentIssuesV1([
    ...initialIssues,
    ...fields.issues,
    ...missingFieldIssues(fields),
  ]);
  if (issues.some((item) => item.severity === 'rejection')) {
    return {
      outcome: 'rejected',
      routeIntent: null,
      clarification: null,
      issues,
      pendingIntent: null,
    };
  }

  const amountAtomic =
    fields.amountDecimal && fields.fromAsset
      ? decimalToAtomicV1(fields.amountDecimal, fields.fromAsset.decimals)
      : null;
  if (fields.amountDecimal && fields.fromAsset && amountAtomic === null) {
    issues.push(
      issue(
        'exact_amount_required',
        'amount',
        'clarification',
        'Amount precision exceeds the source asset decimals',
      ),
    );
  }
  const sortedIssues = sortIntentIssuesV1(issues);
  if (
    sortedIssues.length > 0 ||
    !amountAtomic ||
    !fields.amountDecimal ||
    !fields.fromAsset ||
    !fields.toAsset
  ) {
    const code = clarificationCode(sortedIssues);
    return {
      outcome: 'needs_clarification',
      routeIntent: null,
      clarification: createClarificationV1(code, missingFields(sortedIssues), locale),
      issues: sortedIssues,
      pendingIntent: buildPendingSwapIntentV2({
        context: input.context,
        walletAddress: runtime.walletAddress,
        fields,
      }),
    };
  }

  const requestHash = stableHashV1('intent-engine-request/v2', {
    tenantId: input.context.tenantId,
    walletAddress: runtime.walletAddress,
    requestId: input.context.requestId,
    message: input.message.trim(),
  });
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id: `route-intent-v2:${requestHash.slice(2)}`,
    tenantId: input.context.tenantId,
    walletAddress: runtime.walletAddress,
    chainId: 8453,
    createdAt: runtime.requestedAt,
    updatedAt: runtime.requestedAt,
    status: 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'swap',
    fromAsset: fields.fromAsset,
    toAsset: fields.toAsset,
    amount: {
      asset: fields.fromAsset,
      amountAtomic,
      amountDecimal: fields.amountDecimal,
    },
    optimizationMode: fields.optimizationMode,
    verificationDepth: fields.verificationDepth,
    protocolConstraint: fields.protocolConstraint,
    slippageConstraint: fields.slippageConstraint,
    executionRequested: fields.executionRequested,
  };
  const routeIntent = RouteIntentV1Schema.parse({
    ...draft,
    intentHash: hashRouteIntentV1(draft),
  });
  return {
    outcome: 'ready',
    routeIntent,
    clarification: null,
    issues: [],
    pendingIntent: null,
  };
}

export async function resolveSwapIntentWithLlmV2(input: {
  llm: LlmProvider;
  message: string;
  context: IntentRuntimeContextV2;
}): Promise<IntentResolutionV2> {
  const extraction = await extractSwapIntentV2(input);
  return resolveSwapIntentV2({
    message: input.message,
    context: input.context,
    extraction,
  });
}
