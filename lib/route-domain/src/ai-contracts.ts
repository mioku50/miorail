import { z } from 'zod';
import { financialContentV1, stableHashV1, type HashV1 } from './hashing.js';
import {
  DecimalAmountV1Schema,
  HashV1Schema,
  ProviderRefV1Schema,
  TimestampV1Schema,
  financialEntityFieldsV1,
  validateFinancialChronologyV1,
} from './primitives.js';
import {
  EvidenceSourceLinkV1Schema,
  ScoreConfidenceV1Schema,
  ScoreFreshnessV1Schema,
} from './score-contracts.js';

// ---------------------------------------------------------------------------
// T66 — Private AI contract family (Venice).
//
// The fifth deliberately separate family. Venice is NOT registered as a general
// "ask an AI" tool: an inference request is a route with its own intent,
// candidates, evidence, score, review, execution and proof, exactly like a
// swap, an earn position, a gift card or an NFT.
//
// Four rules give this file its shape.
//
//   1. THE PROMPT IS NEVER IN THIS FILE. There is no field anywhere below that
//      can hold prompt text, and no hash is taken over prompt text directly.
//      What is carried is a COMMITMENT (see AiPromptCommitmentV1) — and the
//      value needed to open it is returned to the caller once and never
//      persisted, so a stored proof cannot be brute-forced back into the
//      prompt. A plain `sha256(prompt)` would be recoverable by guessing for
//      any short prompt, which is exactly the privacy claim this family must
//      not make falsely.
//
//   2. COST IS QUOTED PER MILLION TOKENS AND SPENT PER TOKEN. The candidate
//      carries the provider's posted rate; the proof carries what was actually
//      billed. They are separate fields on purpose — an estimate that later
//      pretends to be a receipt is the failure mode here.
//
//   3. A CAPABILITY IS EITHER REPORTED OR UNKNOWN. `supportsToolCalling: null`
//      means the provider did not say. It never collapses to `false`, because
//      "this model cannot do tools" and "we did not ask" send a user to
//      different decisions.
//
//   4. NO OVERALL SCORE, AND NO INVENTED DIMENSION. Seven dimensions stand
//      alone. `latency` is `not_scored` until this deployment has measured
//      runs of its own — a provider does not publish latency, and a number
//      made up from model size would read as a measurement.
// ---------------------------------------------------------------------------

function addHashIssue(ctx: z.RefinementCtx, path: string, label: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: `${label} does not match the canonical V1 financial payload`,
  });
}

/** USD amounts here are fractions of a cent. A 6-decimal string keeps
 * per-token arithmetic exact without Number rounding. */
export const UsdAmountV1Schema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/, 'Expected an unsigned USD decimal string');

/** Venice model ids are provider-controlled strings. Constrained by shape so a
 * model id can never become a path traversal or a second URL segment. */
export const AiModelIdV1Schema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Expected a plain model identifier');

// --- Prompt commitment ------------------------------------------------------

/**
 * The ONLY representation of a prompt this family stores.
 *
 * `commitment = H(nonce, promptText, systemText)` where `nonce` is 32 random
 * bytes generated per request. The nonce is handed back to the caller ONCE and
 * is never written to storage, a log, or a proof — so a commitment on its own
 * is not openable, including for a one-word prompt. A caller who kept the
 * nonce can prove after the fact exactly what was sent.
 *
 * `charCount` and `messageCount` are carried because a user is entitled to see
 * how much text is about to leave their machine. They are shape, not content.
 */
const AiPromptCommitmentV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('ai-prompt-commitment/v1'),
    commitment: HashV1Schema,
    charCount: z.number().int().min(0).max(10_000_000),
    messageCount: z.number().int().min(1).max(1_000),
    /** True when a system message is part of the request. The text itself is
     * inside the commitment and nowhere else. */
    hasSystemMessage: z.boolean(),
    /** Rough token estimate, for cost. Explicitly an estimate: the proof
     * carries the provider's counted tokens instead. */
    estimatedPromptTokens: z.number().int().min(0).max(100_000_000),
  })
  .strict();

export type AiPromptCommitmentV1 = z.infer<typeof AiPromptCommitmentV1ObjectSchema>;
export const AiPromptCommitmentV1Schema = AiPromptCommitmentV1ObjectSchema;

/**
 * Computes a prompt commitment.
 *
 * The caller supplies the nonce and is responsible for keeping it if they want
 * to be able to open the commitment later. Nothing in this repository persists
 * it.
 */
export function commitAiPromptV1(input: {
  nonce: string;
  systemText: string | null;
  messages: readonly { role: string; text: string }[];
}): HashV1 {
  if (input.nonce.length < 32) {
    throw new TypeError('A prompt commitment needs at least 32 characters of nonce');
  }
  return stableHashV1('ai-prompt-commitment/v1', {
    nonce: input.nonce,
    systemText: input.systemText,
    messages: input.messages.map((message) => ({ role: message.role, text: message.text })),
  });
}

// --- Intent -----------------------------------------------------------------

/**
 * What the user is trying to get out of a model. Drives capability matching —
 * a `structured_extraction` task needs response-schema support, and a model
 * without it is REFUSED rather than quietly asked anyway.
 */
export const AiTaskKindV1Schema = z.enum([
  'general_reasoning',
  'code_generation',
  'structured_extraction',
  'summarization',
  'translation',
  'classification',
]);
export type AiTaskKindV1 = z.infer<typeof AiTaskKindV1Schema>;

/** How private the user requires this call to be. `private` refuses any model
 * the provider does not mark private — it is a filter, not a preference. */
export const AiPrivacyRequirementV1Schema = z.enum(['private_only', 'prefer_private', 'any']);
export type AiPrivacyRequirementV1 = z.infer<typeof AiPrivacyRequirementV1Schema>;

const AiRouteIntentV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'ai-route-intent/v1',
      z.enum(['draft', 'ready', 'needs_clarification', 'unsupported']),
    ),
    intentHash: HashV1Schema,
    goal: z.literal('private_ai'),
    taskKind: AiTaskKindV1Schema,
    prompt: AiPromptCommitmentV1Schema,
    privacyRequirement: AiPrivacyRequirementV1Schema,
    /** Hard requirements. A model that cannot do one of these is not a
     * candidate — it is not "lower scoring". */
    requiresToolCalling: z.boolean(),
    requiresResponseSchema: z.boolean(),
    requiresWebSearch: z.boolean(),
    /** The ceiling the user authorized for this ONE call, in USD. Null forces
     * the surface to ask before anything is prepared: an inference request
     * with no cost ceiling is never assumed, for the same reason an NFT
     * purchase with no spend ceiling is not. */
    maxSpendUsd: UsdAmountV1Schema.nullable(),
    /** Upper bound on generated tokens. Bounds the bill AND the wait. */
    maxCompletionTokens: z.number().int().min(1).max(1_000_000),
    /** A model the user pinned by hand. Still checked against the allowlist —
     * naming a model does not admit it. */
    preferredModelId: AiModelIdV1Schema.nullable(),
    executionRequested: z.boolean(),
  })
  .strict();

export type AiRouteIntentV1 = z.infer<typeof AiRouteIntentV1ObjectSchema>;

export function hashAiRouteIntentV1(value: AiRouteIntentV1): HashV1 {
  return stableHashV1('ai-route-intent/v1', financialContentV1(value, ['intentHash']));
}

export const AiRouteIntentV1Schema = AiRouteIntentV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.intentHash !== hashAiRouteIntentV1(value)) addHashIssue(ctx, 'intentHash', 'intentHash');
  if (value.status === 'ready' && value.maxSpendUsd === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxSpendUsd'],
      message: 'A ready AI intent requires an explicit spend ceiling',
    });
  }
  // A structured-extraction task without schema support is a contradiction the
  // intent itself should not be able to express.
  if (value.taskKind === 'structured_extraction' && !value.requiresResponseSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requiresResponseSchema'],
      message: 'Structured extraction requires response-schema support',
    });
  }
});

// --- Model candidate --------------------------------------------------------

/**
 * The provider's own privacy claim for one model.
 *
 * `private` and `anonymized` are Venice's two published values. `unknown` is
 * what a model gets when the provider did not say — it is NEVER upgraded to
 * `anonymized` by assumption, because the whole point of this family is that
 * the privacy claim is evidence rather than branding.
 */
export const AiPrivacyModeV1Schema = z.enum(['private', 'anonymized', 'unknown']);
export type AiPrivacyModeV1 = z.infer<typeof AiPrivacyModeV1Schema>;

/**
 * Capabilities as REPORTED. Every field is nullable and null means "the
 * provider did not state this", which is a different answer from `false`.
 */
const AiModelCapabilitiesV1Schema = z
  .object({
    supportsToolCalling: z.boolean().nullable(),
    supportsResponseSchema: z.boolean().nullable(),
    supportsReasoning: z.boolean().nullable(),
    supportsWebSearch: z.boolean().nullable(),
    supportsVision: z.boolean().nullable(),
    optimizedForCode: z.boolean().nullable(),
    /** Weight quantization, when stated. Carried because it is the honest
     * answer to "is this the full model?" */
    quantization: z.string().min(1).max(60).nullable(),
  })
  .strict();
export type AiModelCapabilitiesV1 = z.infer<typeof AiModelCapabilitiesV1Schema>;

/** Posted rates, per MILLION tokens, as the provider publishes them. */
const AiModelPricingV1Schema = z
  .object({
    inputUsdPerMillion: UsdAmountV1Schema,
    outputUsdPerMillion: UsdAmountV1Schema,
  })
  .strict();
export type AiModelPricingV1 = z.infer<typeof AiModelPricingV1Schema>;

const AiRouteCandidateV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'ai-route-candidate/v1',
      z.enum(['quoted', 'selected', 'ineligible', 'rejected']),
    ),
    candidateHash: HashV1Schema,
    intentHash: HashV1Schema,
    provider: ProviderRefV1Schema,
    modelId: AiModelIdV1Schema,
    modelName: z.string().min(1).max(200),
    /** Provider-declared version/build, when there is one. Recorded so a proof
     * can name what actually answered rather than only which id was asked. */
    modelVersion: z.string().min(1).max(120).nullable(),
    privacyMode: AiPrivacyModeV1Schema,
    capabilities: AiModelCapabilitiesV1Schema,
    pricing: AiModelPricingV1Schema,
    contextTokens: z.number().int().min(1).max(100_000_000),
    maxCompletionTokens: z.number().int().min(1).max(100_000_000),
    /** The provider says this model is currently down. An offline model is
     * never `selected`. */
    offline: z.boolean(),
    /** Estimated cost of THIS request at the posted rate. An estimate, and
     * named as one everywhere it is shown. */
    estimatedCostUsd: UsdAmountV1Schema,
    /** Why this model cannot serve the intent. Non-null ⟺ status is
     * `ineligible`, so a filtered model always carries its reason. */
    ineligibleReason: z
      .enum([
        'not_allowlisted',
        'offline',
        'privacy_mode_insufficient',
        'context_too_small',
        'missing_tool_calling',
        'missing_response_schema',
        'missing_web_search',
        'over_spend_ceiling',
        'pricing_unavailable',
      ])
      .nullable(),
    observedAt: TimestampV1Schema,
  })
  .strict();

export type AiRouteCandidateV1 = z.infer<typeof AiRouteCandidateV1ObjectSchema>;

export function hashAiRouteCandidateV1(value: AiRouteCandidateV1): HashV1 {
  return stableHashV1('ai-route-candidate/v1', financialContentV1(value, ['candidateHash']));
}

export const AiRouteCandidateV1Schema = AiRouteCandidateV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.candidateHash !== hashAiRouteCandidateV1(value)) {
    addHashIssue(ctx, 'candidateHash', 'candidateHash');
  }
  if (value.status === 'ineligible' && value.ineligibleReason === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ineligibleReason'],
      message: 'An ineligible model must state why it cannot serve this request',
    });
  }
  if (value.status !== 'ineligible' && value.ineligibleReason !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ineligibleReason'],
      message: 'Only an ineligible model carries an ineligibility reason',
    });
  }
  if (value.status === 'selected' && value.offline) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['offline'],
      message: 'An offline model cannot be selected',
    });
  }
  if (value.maxCompletionTokens > value.contextTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxCompletionTokens'],
      message: 'A model cannot complete more tokens than its context holds',
    });
  }
});

/**
 * Cost of one request at posted rates, in USD, as an exact decimal string.
 *
 * Integer arithmetic in the smallest unit the rates express, so a
 * fraction-of-a-cent rate does not disappear into floating point. Rates are per
 * million tokens; the result is per request.
 */
export function estimateAiCostUsdV1(input: {
  pricing: AiModelPricingV1;
  promptTokens: number;
  completionTokens: number;
}): string {
  const scale = 1_000_000_000_000n; // 12 decimal places, matching UsdAmountV1.
  const toScaled = (decimal: string): bigint => {
    const [whole, fraction = ''] = decimal.split('.');
    const padded = (fraction + '000000000000').slice(0, 12);
    return BigInt(whole) * scale + BigInt(padded);
  };
  const total =
    (toScaled(input.pricing.inputUsdPerMillion) * BigInt(Math.max(0, Math.trunc(input.promptTokens))) +
      toScaled(input.pricing.outputUsdPerMillion) * BigInt(Math.max(0, Math.trunc(input.completionTokens)))) /
    1_000_000n;
  const whole = total / scale;
  const fraction = (total % scale).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** Unsigned decimal comparison that never goes through Number. */
export function compareUsdV1(left: string, right: string): number {
  const scale = (decimal: string): bigint => {
    const [whole, fraction = ''] = decimal.split('.');
    return BigInt(whole) * 1_000_000_000_000n + BigInt((fraction + '000000000000').slice(0, 12));
  };
  const a = scale(left);
  const b = scale(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

// --- Evidence ---------------------------------------------------------------

export const AiEvidenceKindV1Schema = z.enum([
  'model_catalogue',
  'model_pricing',
  'model_capabilities',
  'privacy_policy',
  'availability',
  'inference_response',
]);
export type AiEvidenceKindV1 = z.infer<typeof AiEvidenceKindV1Schema>;

/**
 * One recorded observation about a model.
 *
 * `requestHash` and `responseHash` are hashes of the CATALOGUE call, not of a
 * prompt. This record type is structurally incapable of carrying prompt or
 * completion text: there is no field for it, and the two hashes it does carry
 * are over provider metadata that is safe to store and show.
 */
const AiEvidenceV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('ai-evidence/v1', z.enum(['recorded', 'stale', 'rejected'])),
    evidenceHash: HashV1Schema,
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema.nullable(),
    provider: ProviderRefV1Schema,
    evidenceKind: AiEvidenceKindV1Schema,
    modelId: AiModelIdV1Schema,
    privacyMode: AiPrivacyModeV1Schema.nullable(),
    /** The provider's stated retention policy for this model, verbatim and
     * bounded. Null when the provider published none — which is itself the
     * answer the Route Card shows. */
    retentionPolicy: z.string().min(1).max(400).nullable(),
    contextTokens: z.number().int().min(1).max(100_000_000).nullable(),
    inputUsdPerMillion: UsdAmountV1Schema.nullable(),
    outputUsdPerMillion: UsdAmountV1Schema.nullable(),
    observedAt: TimestampV1Schema,
    requestHash: HashV1Schema,
    responseHash: HashV1Schema,
    freeOrPaid: z.enum(['free', 'paid']),
  })
  .strict();

export type AiEvidenceV1 = z.infer<typeof AiEvidenceV1ObjectSchema>;

export function hashAiEvidenceV1(value: AiEvidenceV1): HashV1 {
  return stableHashV1('ai-evidence/v1', financialContentV1(value, ['evidenceHash']));
}

export const AiEvidenceV1Schema = AiEvidenceV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.evidenceHash !== hashAiEvidenceV1(value)) addHashIssue(ctx, 'evidenceHash', 'evidenceHash');
});

// --- Scoring ----------------------------------------------------------------

export const AiScoreDimensionNameV1Schema = z.enum([
  'task_fit',
  'privacy_mode',
  'cost',
  'latency',
  'context_capacity',
  'structured_output',
  'availability',
]);
export type AiScoreDimensionNameV1 = z.infer<typeof AiScoreDimensionNameV1Schema>;

export const AI_SCORE_DIMENSIONS_V1: readonly AiScoreDimensionNameV1[] = [
  'task_fit',
  'privacy_mode',
  'cost',
  'latency',
  'context_capacity',
  'structured_output',
  'availability',
];

const AiScoreDimensionV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('ai-score-dimension/v1', z.enum(['scored', 'not_scored'])),
    dimensionHash: HashV1Schema,
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    dimension: AiScoreDimensionNameV1Schema,
    score: z.number().int().min(0).max(100).nullable(),
    notScoredReason: z
      .enum([
        'not_requested',
        'insufficient_evidence',
        'stale_evidence',
        'no_approved_source',
        'no_measured_runs',
        'scoring_error',
      ])
      .nullable(),
    confidence: ScoreConfidenceV1Schema.nullable(),
    sources: z.array(EvidenceSourceLinkV1Schema),
    freshness: ScoreFreshnessV1Schema.nullable(),
    scoringVersion: z.string().min(1).max(120),
    missingEvidence: z.array(AiEvidenceKindV1Schema),
  })
  .strict();

export type AiScoreDimensionV1 = z.infer<typeof AiScoreDimensionV1ObjectSchema>;

export function hashAiScoreDimensionV1(value: AiScoreDimensionV1): HashV1 {
  return stableHashV1('ai-score-dimension/v1', financialContentV1(value, ['dimensionHash']));
}

export const AiScoreDimensionV1Schema = AiScoreDimensionV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.dimensionHash !== hashAiScoreDimensionV1(value)) {
    addHashIssue(ctx, 'dimensionHash', 'dimensionHash');
  }
  if (value.status === 'not_scored') {
    if (value.score !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['score'], message: 'Not scored dimensions must use score=null' });
    }
    if (value.confidence !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confidence'], message: 'Not scored dimensions must use confidence=null' });
    }
    if (value.sources.length !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'Not scored dimensions must not claim evidence sources' });
    }
    if (value.notScoredReason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notScoredReason'], message: 'Not scored dimensions require an explicit reason' });
    }
  } else if (value.score === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['score'], message: 'A scored dimension requires a score' });
  }
});

// --- Route Card -------------------------------------------------------------

/** The ONLY recommendation string this family may make. Venice's catalogue is
 * one provider's catalogue, and the card must not imply a cross-provider
 * comparison it did not run. */
export const AI_RECOMMENDATION_COPY_V1 = 'Best Venice model for this task under your privacy and cost limits';

/**
 * How the selected model was chosen, in the card's own words.
 *
 * A fixed sentence rather than a number. There is no overall score in this
 * family, so the card states the ORDER it applied — a weighted average would
 * read as an objective measurement of things that were never measured
 * together.
 */
export const AI_SELECTION_POLICY_COPY_V1 =
  'Chosen by: eligibility first, then stated privacy mode, then task fit, then lowest cost, then largest context.';

const AiRouteCardV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'ai-route-card/v1',
      z.enum(['ready', 'constrained', 'degraded', 'failed']),
    ),
    routeCardHash: HashV1Schema,
    intentHash: HashV1Schema,
    recommendation: z.literal(AI_RECOMMENDATION_COPY_V1),
    /** The ordering that produced `selected`, stated rather than implied. */
    selectionPolicy: z.literal(AI_SELECTION_POLICY_COPY_V1),
    taskKind: AiTaskKindV1Schema,
    /** The model this card recommends. Null on a card that could not choose. */
    selected: AiRouteCandidateV1Schema.nullable(),
    /** Everything else that was considered, eligible or not. A rejected model
     * stays on the card WITH its reason — a comparison that hides what it
     * discarded is not a comparison. */
    alternatives: z.array(AiRouteCandidateV1Schema).max(50),
    /** Seven dimensions for the selected model. Deliberately no overall score. */
    dimensions: z.array(AiScoreDimensionV1Schema).length(7),
    evidenceHashes: z.array(HashV1Schema),
    evidenceGaps: z.array(AiEvidenceKindV1Schema),
    /** Exactly what leaves the user's machine, in plain words, computed from
     * the intent rather than written by hand per surface. */
    dataSentSummary: z.string().min(1).max(400),
    /** The provider's retention claim for the selected model, or null when it
     * published none. Null renders as "not stated", never as "not retained". */
    retentionClaim: z.string().min(1).max(400).nullable(),
    /** Capabilities the selected model does NOT have, so the card states its
     * limits rather than only its strengths. */
    unsupportedCapabilities: z.array(z.string().min(1).max(80)).max(20),
    maxSpendUsd: UsdAmountV1Schema,
    estimatedCostUsd: UsdAmountV1Schema.nullable(),
    /** Whether this deployment bills the call through x402. False means the
     * server's own Venice key pays for it. */
    x402Metered: z.boolean(),
    failureReason: z.string().min(1).max(200).nullable(),
    expiresAt: TimestampV1Schema,
  })
  .strict();

export type AiRouteCardV1 = z.infer<typeof AiRouteCardV1ObjectSchema>;

export function hashAiRouteCardV1(value: AiRouteCardV1): HashV1 {
  const content = financialContentV1(value, [
    'routeCardHash',
    'selected',
    'alternatives',
    'dimensions',
  ]);
  return stableHashV1('ai-route-card/v1', {
    ...content,
    selectedHash: value.selected?.candidateHash ?? null,
    alternativeHashes: value.alternatives.map((candidate) => candidate.candidateHash),
    dimensionHashes: value.dimensions.map((dimension) => dimension.dimensionHash),
  });
}

export const AiRouteCardV1Schema = AiRouteCardV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.routeCardHash !== hashAiRouteCardV1(value)) addHashIssue(ctx, 'routeCardHash', 'routeCardHash');
  const names = value.dimensions.map((dimension) => dimension.dimension);
  for (const required of AI_SCORE_DIMENSIONS_V1) {
    if (!names.includes(required)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions'],
        message: `Missing score dimension: ${required}`,
      });
    }
  }
  if (value.status === 'ready') {
    if (value.selected === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selected'], message: 'A ready card requires a model' });
    } else {
      if (value.selected.status !== 'selected') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selected', 'status'],
          message: 'The model on a ready card must be the selected candidate',
        });
      }
      if (compareUsdV1(value.selected.estimatedCostUsd, value.maxSpendUsd) > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selected', 'estimatedCostUsd'],
          message: 'A ready card cannot cost more than the authorized ceiling',
        });
      }
    }
  }
  // The selected model must not also appear among the alternatives, or the
  // card would count it twice and a surface could render it as its own rival.
  if (value.selected !== null) {
    const duplicate = value.alternatives.some(
      (candidate) => candidate.candidateHash === value.selected?.candidateHash,
    );
    if (duplicate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['alternatives'],
        message: 'The selected model must not be repeated among the alternatives',
      });
    }
  }
  if (value.status === 'failed' && value.failureReason === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failureReason'], message: 'A failed card must state why' });
  }
});

// --- Inference proof --------------------------------------------------------

/**
 * Why the model stopped.
 *
 * `length` is kept distinct from `stop` because a truncated answer is a
 * DIFFERENT product than a complete one, and a proof that called both
 * "completed" would hide the fact that the user paid for a cut-off response.
 */
export const AiFinishReasonV1Schema = z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'unknown']);
export type AiFinishReasonV1 = z.infer<typeof AiFinishReasonV1Schema>;

/** The outcome of validating the completion against the requested schema.
 * `not_requested` when the intent asked for no schema — which is not the same
 * as passing. */
export const AiSchemaValidationV1Schema = z.enum(['not_requested', 'passed', 'failed']);
export type AiSchemaValidationV1 = z.infer<typeof AiSchemaValidationV1Schema>;

export const AiProofFinalStatusV1Schema = z.enum([
  'pending',
  'completed',
  'truncated',
  'refused',
  'failed',
]);
export type AiProofFinalStatusV1 = z.infer<typeof AiProofFinalStatusV1Schema>;

/**
 * What was actually spent and counted, from the provider's own response.
 *
 * Separate from the candidate's `estimatedCostUsd` on purpose. An estimate
 * that later gets displayed as a receipt is the failure this family's cost
 * story is built to avoid — so the estimate lives on the card and the charge
 * lives here, and a surface showing both shows both.
 */
const AiUsageV1Schema = z
  .object({
    promptTokens: z.number().int().min(0).max(100_000_000).nullable(),
    completionTokens: z.number().int().min(0).max(100_000_000).nullable(),
    totalTokens: z.number().int().min(0).max(100_000_000).nullable(),
    /** What the provider says it charged. Null is NOT zero — it means the
     * provider did not report a cost, and the surface must say so. */
    actualCostUsd: UsdAmountV1Schema.nullable(),
    latencyMs: z.number().int().min(0).max(86_400_000),
  })
  .strict();
export type AiUsageV1 = z.infer<typeof AiUsageV1Schema>;

/**
 * Derives the final status from what was observed.
 *
 * Re-derived by the schema below, so no caller, migration or surface can
 * record "completed" for an answer that was truncated or refused.
 */
export function deriveAiProofFinalStatusV1(input: {
  answered: boolean;
  finishReason: AiFinishReasonV1;
  schemaValidation: AiSchemaValidationV1;
}): AiProofFinalStatusV1 {
  if (!input.answered) return 'failed';
  if (input.finishReason === 'content_filter') return 'refused';
  if (input.finishReason === 'length') return 'truncated';
  // A schema the answer failed is not a completed request: the caller asked
  // for a shape and did not get it, whatever the model thought it was doing.
  if (input.schemaValidation === 'failed') return 'failed';
  if (input.finishReason === 'unknown') return 'pending';
  return 'completed';
}

const AiInferenceProofV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('ai-inference-proof/v1', z.enum(['open', 'finalized'])),
    proofHash: HashV1Schema,
    intentHash: HashV1Schema,
    routeCardHash: HashV1Schema,
    candidateHash: HashV1Schema,
    /** The commitment from the intent, carried forward. Opening it needs the
     * nonce, which this record does not have and never will — the proof states
     * WHICH request was served without stating what it said. */
    promptCommitment: HashV1Schema,
    provider: ProviderRefV1Schema,
    modelId: AiModelIdV1Schema,
    modelVersion: z.string().min(1).max(120).nullable(),
    privacyMode: AiPrivacyModeV1Schema,
    /** Over response METADATA only. There is deliberately no hash of the
     * completion text: one would let anyone holding this proof confirm a
     * guessed answer. */
    responseHash: HashV1Schema,
    /** Length of the answer. Shape, not content. */
    responseChars: z.number().int().min(0).max(100_000_000),
    finishReason: AiFinishReasonV1Schema,
    schemaValidation: AiSchemaValidationV1Schema,
    usage: AiUsageV1Schema,
    /** True when the call was billed through x402 rather than the server key. */
    x402Metered: z.boolean(),
    /** The estimate this run was approved against, kept beside the charge so
     * the two can be compared without a second lookup. */
    estimatedCostUsd: UsdAmountV1Schema,
    finalStatus: AiProofFinalStatusV1Schema,
    failureReason: z.string().min(1).max(300).nullable(),
    observedAt: TimestampV1Schema,
    finalizedAt: TimestampV1Schema.nullable(),
  })
  .strict();

export type AiInferenceProofV1 = z.infer<typeof AiInferenceProofV1ObjectSchema>;

export function hashAiInferenceProofV1(value: AiInferenceProofV1): HashV1 {
  return stableHashV1('ai-inference-proof/v1', financialContentV1(value, ['proofHash']));
}

export const AiInferenceProofV1Schema = AiInferenceProofV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.proofHash !== hashAiInferenceProofV1(value)) addHashIssue(ctx, 'proofHash', 'proofHash');
  const derived = deriveAiProofFinalStatusV1({
    answered: value.finalStatus !== 'failed' || value.responseChars > 0,
    finishReason: value.finishReason,
    schemaValidation: value.schemaValidation,
  });
  // `failed` is reachable from two directions — a transport failure with no
  // answer at all, and an answer that failed its schema — so it is accepted
  // whenever the derivation also says failed, and checked strictly otherwise.
  if (value.finalStatus !== derived && !(value.finalStatus === 'failed' && value.responseChars === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['finalStatus'],
      message: `finalStatus must be the derived ${derived}, not ${value.finalStatus}`,
    });
  }
  if (value.status === 'finalized' && value.finalizedAt === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['finalizedAt'], message: 'A finalized proof needs its time' });
  }
  if (value.finalStatus === 'failed' && value.failureReason === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failureReason'], message: 'A failed proof must state why' });
  }
  if (value.finalStatus === 'pending' && value.status === 'finalized') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'A pending inference is not finalized',
    });
  }
});

/** The sentence a Proof screen leads with. Fixed strings, so a truncated or
 * refused answer is never described as a completed one. */
export const AI_PROOF_HEADLINE_V1: Record<AiProofFinalStatusV1, string> = {
  pending: 'The model has not finished answering.',
  completed: 'Answer received and verified against this request.',
  truncated: 'The answer was cut off at the token limit you set.',
  refused: 'The model declined to answer this request.',
  failed: 'This request did not produce a usable answer.',
};

// --- Shared display helpers -------------------------------------------------

/** Words for one privacy mode. Fixed sentences, so no surface invents a
 * stronger claim than the provider actually made. */
export const AI_PRIVACY_MODE_COPY_V1: Record<AiPrivacyModeV1, string> = {
  private: 'Venice states this model runs in private mode and does not retain the request.',
  anonymized: 'Venice states this model receives the request without account identity attached.',
  unknown: 'Venice published no privacy mode for this model.',
};

/** Names the capabilities a model was reported NOT to have, plus the ones it
 * never reported at all. Both belong on the card: a user deciding whether to
 * send private text needs to know which limits are stated and which are just
 * unknown. */
export function aiUnsupportedCapabilitiesV1(capabilities: AiModelCapabilitiesV1): string[] {
  const labels: [keyof AiModelCapabilitiesV1, string][] = [
    ['supportsToolCalling', 'tool calling'],
    ['supportsResponseSchema', 'structured output'],
    ['supportsReasoning', 'reasoning traces'],
    ['supportsWebSearch', 'web search'],
    ['supportsVision', 'image input'],
  ];
  const out: string[] = [];
  for (const [key, label] of labels) {
    const value = capabilities[key];
    if (value === false) out.push(`no ${label}`);
    else if (value === null) out.push(`${label} not stated`);
  }
  if (capabilities.quantization !== null) out.push(`quantized: ${capabilities.quantization}`);
  return out;
}

/**
 * The plain-words statement of what leaves the machine.
 *
 * Built from the commitment's shape — never from the prompt — so this sentence
 * cannot leak the text it describes even if a surface logs it.
 */
export function aiDataSentSummaryV1(input: {
  prompt: AiPromptCommitmentV1;
  modelName: string;
  webSearch: boolean;
}): string {
  const parts = [
    `${input.prompt.messageCount} message${input.prompt.messageCount === 1 ? '' : 's'}`,
    `${input.prompt.charCount} characters`,
  ];
  if (input.prompt.hasSystemMessage) parts.push('a system instruction');
  const tail = input.webSearch
    ? ' Web search is enabled, so parts of the request also reach a search provider.'
    : ' Nothing else is attached: no wallet address, no account identity, no chat history.';
  return `${parts.join(', ')} go to ${input.modelName} on Venice.${tail}`;
}
