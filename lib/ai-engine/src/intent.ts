import { randomBytes } from 'node:crypto';
import {
  AiPromptCommitmentV1Schema,
  AiRouteIntentV1Schema,
  commitAiPromptV1,
  hashAiRouteIntentV1,
  type AiPrivacyRequirementV1,
  type AiRouteIntentV1,
  type AiTaskKindV1,
} from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T66C — goal text → intent.
//
// This is the boundary the whole family is built on. The prompt goes IN and
// only a commitment comes out. Nothing downstream of `resolveAiIntentV1` ever
// receives the text: the intent it returns cannot hold one, and the nonce that
// would open the commitment is returned separately, to the caller, once.
//
// The caller's obligation, stated here because it is the only place it can be:
// the nonce must reach the client and must NOT be written to storage or a log.
// A stored nonce beside a stored commitment reduces the commitment to a plain
// hash, which is guessable for a short prompt.
// ---------------------------------------------------------------------------

export interface AiPromptMessageV1 {
  role: 'user' | 'assistant';
  text: string;
}

export interface ResolveAiIntentInputV1 {
  runId: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453 | 84532;
  systemText: string | null;
  messages: readonly AiPromptMessageV1[];
  privacyRequirement: AiPrivacyRequirementV1;
  maxSpendUsd: string | null;
  maxCompletionTokens: number;
  preferredModelId: string | null;
  requiresToolCalling?: boolean;
  requiresResponseSchema?: boolean;
  requiresWebSearch?: boolean;
  taskKind?: AiTaskKindV1;
  executionRequested?: boolean;
  now: Date;
  /** Injectable for tests only. Production always uses crypto randomness. */
  nonce?: string;
}

export type AiIntentResolutionV1 =
  | {
      status: 'ready';
      intent: AiRouteIntentV1;
      /** Returned to the caller ONCE. Never persisted, never logged. */
      promptNonce: string;
    }
  | { status: 'needs_clarification' | 'unsupported'; reason: string };

/** Words that indicate what the user wants done. Checked before the generic
 * fallback so a specific task is not flattened into `general_reasoning`. */
const TASK_PATTERNS_V1: [AiTaskKindV1, RegExp][] = [
  ['code_generation', /\b(code|function|refactor|debug|typescript|python|sql)\b|(код|функци|отладк)/i],
  ['structured_extraction', /\b(extract|parse|json|schema|structured)\b|(извлеч|распарс|структур)/i],
  ['summarization', /\b(summari[sz]e|summary|tl;?dr|condense)\b|(суммир|кратк|резюм)/i],
  ['translation', /\b(translate|translation)\b|(перевед|перевод)/i],
  ['classification', /\b(classify|categori[sz]e|label|sentiment)\b|(классифиц|категор)/i],
];

/**
 * Guesses what kind of task this is, from the FIRST message only.
 *
 * A guess, and it only ever affects which capabilities are weighted — never
 * whether the prompt is sent, and never where. The worst outcome of a wrong
 * classification is a differently ranked model list.
 */
export function classifyAiTaskKindV1(text: string): AiTaskKindV1 {
  for (const [kind, pattern] of TASK_PATTERNS_V1) {
    if (pattern.test(text)) return kind;
  }
  return 'general_reasoning';
}

/**
 * Estimates prompt tokens from character count.
 *
 * Deliberately crude and deliberately HIGH: ~3 characters per token rather
 * than the ~4 English averages, because this number decides whether a model's
 * context is big enough and whether the cost clears the ceiling. Under-
 * estimating produces a request that gets truncated or costs more than the
 * user approved; over-estimating only rules out a model that would have fit.
 */
export function estimateAiPromptTokensV1(input: {
  systemText: string | null;
  messages: readonly AiPromptMessageV1[];
}): number {
  const chars =
    (input.systemText?.length ?? 0) +
    input.messages.reduce((total, message) => total + message.text.length, 0);
  // Per-message overhead: role markers and separators the provider adds.
  return Math.ceil(chars / 3) + input.messages.length * 4 + (input.systemText === null ? 0 : 4);
}

export const AI_MAX_PROMPT_CHARS_V1 = 500_000;

/**
 * Builds the intent, or refuses with a reason.
 *
 * Refusals happen BEFORE the commitment is computed, so a rejected request
 * leaves nothing behind at all.
 */
export function resolveAiIntentV1(input: ResolveAiIntentInputV1): AiIntentResolutionV1 {
  const messages = input.messages.filter((message) => message.text.trim().length > 0);
  if (messages.length === 0) {
    return { status: 'needs_clarification', reason: 'Describe the task you want the model to do.' };
  }
  const charCount =
    (input.systemText?.length ?? 0) + messages.reduce((total, message) => total + message.text.length, 0);
  if (charCount > AI_MAX_PROMPT_CHARS_V1) {
    return {
      status: 'unsupported',
      reason: `This request is ${charCount} characters. Miorail sends at most ${AI_MAX_PROMPT_CHARS_V1}.`,
    };
  }
  if (input.maxCompletionTokens <= 0) {
    return { status: 'needs_clarification', reason: 'Set how many tokens the answer may use.' };
  }

  const firstText = messages[0]?.text ?? '';
  const taskKind = input.taskKind ?? classifyAiTaskKindV1(firstText);
  // Structured extraction implies a schema requirement — the contract refuses
  // the combination otherwise, and inferring it here is what makes a plain
  // "extract the totals as JSON" goal work without a second question.
  const requiresResponseSchema =
    input.requiresResponseSchema ?? (taskKind === 'structured_extraction' ? true : false);

  const nonce = input.nonce ?? randomBytes(32).toString('hex');
  const commitment = commitAiPromptV1({
    nonce,
    systemText: input.systemText,
    messages: messages.map((message) => ({ role: message.role, text: message.text })),
  });

  const prompt = AiPromptCommitmentV1Schema.parse({
    schemaVersion: 'ai-prompt-commitment/v1',
    commitment,
    charCount,
    messageCount: messages.length,
    hasSystemMessage: input.systemText !== null,
    estimatedPromptTokens: estimateAiPromptTokensV1({ systemText: input.systemText, messages }),
  });

  const nowIso = input.now.toISOString();
  const base = {
    schemaVersion: 'ai-route-intent/v1' as const,
    id: `${input.runId}:intent`,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    // A missing ceiling keeps the intent a DRAFT rather than making it ready.
    // The contract refuses a ready intent without one, and the surface asks.
    status: (input.maxSpendUsd === null ? 'draft' : 'ready') as 'draft' | 'ready',
    intentHash: `0x${'0'.repeat(64)}`,
    goal: 'private_ai' as const,
    taskKind,
    prompt,
    privacyRequirement: input.privacyRequirement,
    requiresToolCalling: input.requiresToolCalling ?? false,
    requiresResponseSchema,
    requiresWebSearch: input.requiresWebSearch ?? false,
    maxSpendUsd: input.maxSpendUsd,
    maxCompletionTokens: input.maxCompletionTokens,
    preferredModelId: input.preferredModelId,
    executionRequested: input.executionRequested ?? false,
  } as AiRouteIntentV1;

  const intent = AiRouteIntentV1Schema.parse({ ...base, intentHash: hashAiRouteIntentV1(base) });
  return { status: 'ready', intent, promptNonce: nonce };
}

/**
 * Re-checks at execution time that the prompt about to be sent is the one that
 * was compared and reviewed.
 *
 * The server holds no prompt between the two calls, so the client re-submits
 * it with the nonce. If either was altered the commitment will not match, and
 * the request is refused rather than a different prompt being sent to a model
 * chosen for the original one.
 */
export function verifyAiPromptCommitmentV1(input: {
  commitment: string;
  nonce: string;
  systemText: string | null;
  messages: readonly AiPromptMessageV1[];
}): boolean {
  if (input.nonce.length < 32) return false;
  const recomputed = commitAiPromptV1({
    nonce: input.nonce,
    systemText: input.systemText,
    messages: input.messages.map((message) => ({ role: message.role, text: message.text })),
  });
  return recomputed === input.commitment;
}
