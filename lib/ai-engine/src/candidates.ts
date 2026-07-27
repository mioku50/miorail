import {
  AiEvidenceV1Schema,
  AiRouteCandidateV1Schema,
  estimateAiCostUsdV1,
  compareUsdV1,
  hashAiEvidenceV1,
  hashAiRouteCandidateV1,
  type AiEvidenceV1,
  type AiModelCapabilitiesV1,
  type AiRouteCandidateV1,
  type AiRouteIntentV1,
} from '@mioagent/route-domain';
import { VENICE_PROVIDER_REF_V1, isAllowlistedVeniceModelV1 } from './pinned-config.js';
import type { VeniceCatalogueV1, VeniceObservedModelV1 } from './venice-gateway.js';

// ---------------------------------------------------------------------------
// T66A — observations → candidates.
//
// Eligibility is decided HERE and once. A model that cannot serve the intent
// is kept as an `ineligible` candidate carrying the reason, never dropped:
// "no model matched" and "eleven models matched but all cost too much" are
// different answers, and the second one is only visible if the discarded
// models survive to the Route Card.
//
// Entity ids are scoped to the RUN, never derived from the intent hash. Two
// runs of the same intent produce the same intent hash, and ids derived from
// it collided on the primary key in production (T65, commit e5d20f2).
// ---------------------------------------------------------------------------

export interface AiCandidateContextV1 {
  runId: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453 | 84532;
  intent: AiRouteIntentV1;
  allowlist: readonly string[];
  now: Date;
}

function candidateIdV1(runId: string, modelId: string): string {
  return `${runId}:candidate:${modelId}`;
}

function evidenceIdV1(runId: string, modelId: string, kind: string): string {
  return `${runId}:evidence:${kind}:${modelId}`;
}

function capabilitiesOfV1(model: VeniceObservedModelV1): AiModelCapabilitiesV1 {
  return {
    supportsToolCalling: model.supportsToolCalling,
    supportsResponseSchema: model.supportsResponseSchema,
    supportsReasoning: model.supportsReasoning,
    supportsWebSearch: model.supportsWebSearch,
    supportsVision: model.supportsVision,
    optimizedForCode: model.optimizedForCode,
    quantization: model.quantization,
  };
}

/**
 * Why one model cannot serve one intent, or null when it can.
 *
 * Order matters: the FIRST disqualifying fact is the one reported, and the
 * order runs from "structurally impossible" to "too expensive" so a user sees
 * the fundamental reason rather than a price complaint about a model that was
 * never going to work.
 *
 * A required capability the provider did NOT report is treated as missing. The
 * alternative — sending the prompt and finding out — spends money and privacy
 * to test a guess.
 */
export function aiIneligibleReasonV1(input: {
  model: VeniceObservedModelV1;
  intent: AiRouteIntentV1;
  allowlist: readonly string[];
  estimatedCostUsd: string | null;
}): AiRouteCandidateV1['ineligibleReason'] {
  const { model, intent } = input;
  if (!isAllowlistedVeniceModelV1(model.modelId, input.allowlist)) return 'not_allowlisted';
  if (model.offline) return 'offline';
  if (intent.privacyRequirement === 'private_only' && model.privacyMode !== 'private') {
    return 'privacy_mode_insufficient';
  }
  if (model.inputUsdPerMillion === null || model.outputUsdPerMillion === null) {
    return 'pricing_unavailable';
  }
  const context = model.contextTokens;
  if (context === null || context < intent.prompt.estimatedPromptTokens + intent.maxCompletionTokens) {
    return 'context_too_small';
  }
  if (intent.requiresToolCalling && model.supportsToolCalling !== true) return 'missing_tool_calling';
  if (intent.requiresResponseSchema && model.supportsResponseSchema !== true) {
    return 'missing_response_schema';
  }
  if (intent.requiresWebSearch && model.supportsWebSearch !== true) return 'missing_web_search';
  if (
    intent.maxSpendUsd !== null &&
    input.estimatedCostUsd !== null &&
    compareUsdV1(input.estimatedCostUsd, intent.maxSpendUsd) > 0
  ) {
    return 'over_spend_ceiling';
  }
  return null;
}

/**
 * Builds one candidate per observed model.
 *
 * Every candidate starts as `quoted` or `ineligible`. Nothing is `selected`
 * here — selection is the engine's decision (T66B), made from scored
 * dimensions, and a builder that pre-selected would make the score decorative.
 */
export function buildAiCandidatesV1(
  context: AiCandidateContextV1,
  catalogue: VeniceCatalogueV1,
): AiRouteCandidateV1[] {
  const nowIso = context.now.toISOString();
  const candidates: AiRouteCandidateV1[] = [];

  for (const model of catalogue.models) {
    const pricing = {
      inputUsdPerMillion: model.inputUsdPerMillion ?? '0',
      outputUsdPerMillion: model.outputUsdPerMillion ?? '0',
    };
    const priced = model.inputUsdPerMillion !== null && model.outputUsdPerMillion !== null;
    const estimatedCostUsd = priced
      ? estimateAiCostUsdV1({
          pricing,
          promptTokens: context.intent.prompt.estimatedPromptTokens,
          completionTokens: context.intent.maxCompletionTokens,
        })
      : null;

    const ineligibleReason = aiIneligibleReasonV1({
      model,
      intent: context.intent,
      allowlist: context.allowlist,
      estimatedCostUsd,
    });

    // The declared context is the ceiling for everything: a model whose stated
    // completion bound exceeds its own context would fail the contract's own
    // check, so the smaller of the two is what is recorded.
    const contextTokens = model.contextTokens ?? 1;
    const maxCompletionTokens = Math.min(model.maxCompletionTokens ?? contextTokens, contextTokens);

    const draft = {
      schemaVersion: 'ai-route-candidate/v1' as const,
      id: candidateIdV1(context.runId, model.modelId),
      tenantId: context.tenantId,
      walletAddress: context.walletAddress,
      chainId: context.chainId,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: (ineligibleReason === null ? 'quoted' : 'ineligible') as 'quoted' | 'ineligible',
      candidateHash: '0x0' as never,
      intentHash: context.intent.intentHash,
      provider: { ...VENICE_PROVIDER_REF_V1 },
      modelId: model.modelId,
      modelName: model.modelName,
      modelVersion: model.modelVersion,
      privacyMode: model.privacyMode,
      capabilities: capabilitiesOfV1(model),
      pricing,
      contextTokens,
      maxCompletionTokens,
      offline: model.offline,
      estimatedCostUsd: estimatedCostUsd ?? '0',
      ineligibleReason,
      observedAt: catalogue.observedAt,
    };

    const candidate = { ...draft, candidateHash: hashAiRouteCandidateV1(draft as AiRouteCandidateV1) };
    candidates.push(AiRouteCandidateV1Schema.parse(candidate));
  }

  // Deterministic order: cheapest first, then by model id. Two runs of the same
  // catalogue must produce the same card, or the route card hash is noise.
  return candidates.sort((left, right) => {
    const byCost = compareUsdV1(left.estimatedCostUsd, right.estimatedCostUsd);
    return byCost !== 0 ? byCost : left.modelId.localeCompare(right.modelId);
  });
}

/**
 * The evidence rows behind a set of candidates.
 *
 * One `model_catalogue` row per model, carrying what was read and the hashes
 * of the call that read it. There is no evidence kind here that could hold a
 * prompt: the catalogue call does not have one.
 */
export function buildAiEvidenceV1(
  context: AiCandidateContextV1,
  catalogue: VeniceCatalogueV1,
  candidates: readonly AiRouteCandidateV1[],
  retentionPolicy: string | null,
): AiEvidenceV1[] {
  const nowIso = context.now.toISOString();
  return candidates.map((candidate) => {
    const draft = {
      schemaVersion: 'ai-evidence/v1' as const,
      id: evidenceIdV1(context.runId, candidate.modelId, 'model_catalogue'),
      tenantId: context.tenantId,
      walletAddress: context.walletAddress,
      chainId: context.chainId,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: 'recorded' as const,
      evidenceHash: '0x0' as never,
      intentHash: context.intent.intentHash,
      candidateHash: candidate.candidateHash,
      provider: { ...VENICE_PROVIDER_REF_V1 },
      evidenceKind: 'model_catalogue' as const,
      modelId: candidate.modelId,
      privacyMode: candidate.privacyMode,
      retentionPolicy,
      contextTokens: candidate.contextTokens,
      inputUsdPerMillion: candidate.pricing.inputUsdPerMillion,
      outputUsdPerMillion: candidate.pricing.outputUsdPerMillion,
      observedAt: catalogue.observedAt,
      requestHash: catalogue.requestHash,
      responseHash: catalogue.responseHash,
      // The catalogue read costs nothing beyond the server's own key. Marking
      // it `paid` would misreport what this deployment spent.
      freeOrPaid: 'free' as const,
    };
    return AiEvidenceV1Schema.parse({ ...draft, evidenceHash: hashAiEvidenceV1(draft as AiEvidenceV1) });
  });
}
