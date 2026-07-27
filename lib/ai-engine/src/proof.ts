import {
  AiInferenceProofV1Schema,
  deriveAiProofFinalStatusV1,
  hashAiInferenceProofV1,
  type AiFinishReasonV1,
  type AiInferenceProofV1,
  type AiRouteCandidateV1,
  type AiRouteCardV1,
  type AiRouteIntentV1,
  type AiSchemaValidationV1,
} from '@mioagent/route-domain';
import { VENICE_PROVIDER_REF_V1 } from './pinned-config.js';
import type { VeniceGatewayReasonV1, VeniceGatewayV1, VeniceInferenceResultV1 } from './venice-gateway.js';
import { verifyAiPromptCommitmentV1, type AiPromptMessageV1 } from './intent.js';

// ---------------------------------------------------------------------------
// T66D — execution and the AI Route Proof.
//
// The server calls ONE model: the one on the card. Not the cheapest available
// at call time, not a fallback when the first is busy. A model that cannot
// answer produces a failed proof, because silently substituting another model
// would break the only thing the review screen promised — that the user knows
// where their prompt is going.
//
// The proof carries no prompt and no completion. It carries the commitment
// (unopenable without the nonce, which was never stored), a metadata hash, and
// the numbers: tokens, cost, latency, finish reason, schema result. Enough to
// audit the transaction, not enough to read the conversation.
// ---------------------------------------------------------------------------

export type AiExecutionReasonV1 =
  | VeniceGatewayReasonV1
  | 'prompt_commitment_mismatch'
  | 'card_not_ready'
  | 'card_expired'
  | 'execution_disabled'
  | 'over_spend_ceiling';

export interface RunAiInferenceInputV1 {
  runId: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453 | 84532;
  intent: AiRouteIntentV1;
  card: AiRouteCardV1;
  /** Re-submitted by the client, verified against the commitment, sent once,
   * and never persisted by anything in this module. */
  systemText: string | null;
  messages: readonly AiPromptMessageV1[];
  promptNonce: string;
  allowlist: readonly string[];
  responseSchema: Record<string, unknown> | null;
  temperature: number | null;
  x402Metered: boolean;
  now: Date;
}

export interface AiExecutionOkV1 {
  ok: true;
  proof: AiInferenceProofV1;
  /** The answer, returned to exactly one caller and stored by none of them. */
  text: string;
}

export interface AiExecutionFailedV1 {
  ok: false;
  reason: AiExecutionReasonV1;
  /** A proof is still produced whenever a model was actually called — money
   * may have been spent, and an unrecorded charge is worse than a failure. */
  proof: AiInferenceProofV1 | null;
}

export type AiExecutionResultV1 = AiExecutionOkV1 | AiExecutionFailedV1;

const FAILURE_COPY_V1: Record<AiExecutionReasonV1, string> = {
  prompt_commitment_mismatch:
    'The request submitted for execution is not the one that was compared and reviewed.',
  card_not_ready: 'This Route Card did not select a model, so there is nothing to run.',
  card_expired: 'This Route Card has expired. Compare again for current prices.',
  execution_disabled: 'Private AI execution is off on this server.',
  over_spend_ceiling: 'The selected model now costs more than the authorized ceiling.',
  not_configured: 'No Venice key is configured on this server.',
  unauthorized: 'Miorail cannot reach Venice with the credentials it has.',
  not_found: 'Venice does not know that model.',
  rate_limited: 'Venice is rate limiting Miorail. Try again shortly.',
  payment_required: 'The Venice account has no remaining balance for this request.',
  provider_unavailable: 'Venice did not answer.',
  provider_timeout: 'Venice did not answer in time.',
  provider_invalid_response: 'Venice returned a response Miorail could not read.',
  model_not_allowlisted: 'The model on this card is not on the server’s allowlist.',
  model_offline: 'Venice reports that model as offline.',
  no_text_models: 'Venice returned no text models.',
  content_filtered: 'The model declined to answer this request.',
};

export function aiExecutionCopyV1(reason: AiExecutionReasonV1): string {
  return FAILURE_COPY_V1[reason] ?? 'Miorail could not run this request.';
}

/**
 * Validates the completion against the requested schema.
 *
 * Only checks that the answer PARSES as JSON when a schema was asked for. Full
 * schema validation belongs to the caller that owns the schema; what this
 * establishes is the honest minimum — a "structured" answer that is not even
 * JSON must not be recorded as having passed.
 */
export function validateAiResponseShapeV1(input: {
  text: string;
  responseSchema: Record<string, unknown> | null;
}): AiSchemaValidationV1 {
  if (input.responseSchema === null) return 'not_requested';
  try {
    JSON.parse(input.text);
    return 'passed';
  } catch {
    return 'failed';
  }
}

function buildProofV1(input: {
  run: RunAiInferenceInputV1;
  candidate: AiRouteCandidateV1;
  result: VeniceInferenceResultV1 | null;
  /** Whether the MODEL responded, which is not the same as whether text came
   * back. A content filter is an answer — the model was reached, it considered
   * the request, and it declined. Deriving this from `result !== null` filed
   * every refusal as a transport failure. */
  answered: boolean;
  finishReason: AiFinishReasonV1;
  schemaValidation: AiSchemaValidationV1;
  failureReason: string | null;
}): AiInferenceProofV1 {
  const nowIso = input.run.now.toISOString();
  const responseChars = input.result === null ? 0 : input.result.text.length;
  const finalStatus = deriveAiProofFinalStatusV1({
    answered: input.answered,
    finishReason: input.finishReason,
    schemaValidation: input.schemaValidation,
  });

  const draft = {
    schemaVersion: 'ai-inference-proof/v1' as const,
    id: `${input.run.runId}:proof`,
    tenantId: input.run.tenantId,
    walletAddress: input.run.walletAddress,
    chainId: input.run.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    // A proof is finalized the moment the provider answers or refuses: unlike
    // an NFT purchase there is nothing left to reconcile afterwards.
    status: (finalStatus === 'pending' ? 'open' : 'finalized') as 'open' | 'finalized',
    proofHash: '0x0' as never,
    intentHash: input.run.intent.intentHash,
    routeCardHash: input.run.card.routeCardHash,
    candidateHash: input.candidate.candidateHash,
    promptCommitment: input.run.intent.prompt.commitment,
    provider: { ...VENICE_PROVIDER_REF_V1 },
    modelId: input.candidate.modelId,
    modelVersion: input.candidate.modelVersion,
    privacyMode: input.candidate.privacyMode,
    responseHash: input.result?.responseHash ?? (`0x${'0'.repeat(64)}` as const),
    responseChars,
    finishReason: input.finishReason,
    schemaValidation: input.schemaValidation,
    usage: {
      promptTokens: input.result?.promptTokens ?? null,
      completionTokens: input.result?.completionTokens ?? null,
      totalTokens: input.result?.totalTokens ?? null,
      actualCostUsd: input.result?.actualCostUsd ?? null,
      latencyMs: input.result?.latencyMs ?? 0,
    },
    x402Metered: input.run.x402Metered,
    estimatedCostUsd: input.candidate.estimatedCostUsd,
    finalStatus,
    failureReason: input.failureReason,
    observedAt: input.result?.observedAt ?? nowIso,
    finalizedAt: finalStatus === 'pending' ? null : nowIso,
  };

  return AiInferenceProofV1Schema.parse({
    ...draft,
    proofHash: hashAiInferenceProofV1(draft as unknown as AiInferenceProofV1),
  });
}

/**
 * Runs the card's model, once.
 *
 * Every refusal before the network call leaves no proof, because nothing was
 * spent. Every failure after it leaves one, because something might have been.
 */
export async function runAiInferenceV1(
  deps: { gateway: VeniceGatewayV1 },
  input: RunAiInferenceInputV1,
): Promise<AiExecutionResultV1> {
  const candidate = input.card.selected;
  if (candidate === null || input.card.status === 'failed' || input.card.status === 'constrained') {
    return { ok: false, reason: 'card_not_ready', proof: null };
  }
  if (Date.parse(input.card.expiresAt) <= input.now.getTime()) {
    return { ok: false, reason: 'card_expired', proof: null };
  }
  // The prompt is checked against the commitment BEFORE the model is called.
  // Without this the review screen would describe one request and the server
  // would send another.
  const matches = verifyAiPromptCommitmentV1({
    commitment: input.intent.prompt.commitment,
    nonce: input.promptNonce,
    systemText: input.systemText,
    messages: input.messages,
  });
  if (!matches) return { ok: false, reason: 'prompt_commitment_mismatch', proof: null };

  if (
    input.intent.maxSpendUsd !== null &&
    Number(candidate.estimatedCostUsd) > Number(input.intent.maxSpendUsd)
  ) {
    return { ok: false, reason: 'over_spend_ceiling', proof: null };
  }

  const result = await deps.gateway.runInference({
    modelId: candidate.modelId,
    allowlist: input.allowlist,
    systemText: input.systemText,
    messages: input.messages,
    maxCompletionTokens: input.intent.maxCompletionTokens,
    temperature: input.temperature,
    responseSchema: input.responseSchema,
    webSearch: input.intent.requiresWebSearch,
    now: input.now,
  });

  if (!result.ok) {
    // A refusal by the model is a recorded outcome; a transport failure that
    // never reached it is not. `content_filtered` is the one reason here that
    // means the provider answered.
    const reached = result.reason === 'content_filtered';
    return {
      ok: false,
      reason: result.reason,
      proof: reached
        ? buildProofV1({
            run: input,
            candidate,
            result: null,
            answered: true,
            finishReason: 'content_filter',
            schemaValidation: 'not_requested',
            failureReason: aiExecutionCopyV1(result.reason),
          })
        : null,
    };
  }

  const schemaValidation = validateAiResponseShapeV1({
    text: result.value.text,
    responseSchema: input.responseSchema,
  });
  const proof = buildProofV1({
    run: input,
    candidate,
    result: result.value,
    answered: true,
    finishReason: result.value.finishReason,
    schemaValidation,
    failureReason:
      schemaValidation === 'failed' ? 'The answer was not valid JSON for the requested schema.' : null,
  });

  return { ok: true, proof, text: result.value.text };
}
