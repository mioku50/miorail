import {
  AiScoreDimensionV1Schema,
  AI_SCORE_DIMENSIONS_V1,
  compareUsdV1,
  hashAiScoreDimensionV1,
  type AiEvidenceV1,
  type AiRouteCandidateV1,
  type AiRouteIntentV1,
  type AiScoreDimensionNameV1,
  type AiScoreDimensionV1,
  type AiTaskKindV1,
} from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T66B — the seven dimensions.
//
// Each one is computed independently and each one may refuse to answer. A
// dimension with no source is `not_scored` WITH a reason; it never falls back
// to a middling number, and there is no overall score to hide it in.
//
// `latency` is the clearest case: Venice publishes none, and this deployment
// has no measured runs of its own yet. A latency score derived from parameter
// count would look like a measurement and would be a guess, so the dimension
// answers `no_measured_runs` until real timings exist to answer with.
// ---------------------------------------------------------------------------

export const AI_SCORING_VERSION_V1 = 'ai-scoring/v1';

export interface AiScoringContextV1 {
  runId: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453 | 84532;
  intent: AiRouteIntentV1;
  evidence: readonly AiEvidenceV1[];
  /** When the catalogue behind these candidates was read. */
  catalogueObservedAt: string;
  /** Older than this and catalogue-derived dimensions refuse to score. */
  catalogueTtlMs: number;
  now: Date;
}

type Verdict =
  | { scored: true; score: number; confidence: number }
  | { scored: false; reason: AiScoreDimensionV1['notScoredReason'] };

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function confidenceLabel(value: number): 'low' | 'medium' | 'high' {
  if (value >= 0.75) return 'high';
  if (value >= 0.4) return 'medium';
  return 'low';
}

/**
 * How well a model's reported capabilities suit the task.
 *
 * The signals that matter differ per task, so each task names its own. When
 * every signal it cares about is null the dimension refuses — "the provider
 * did not say whether this model is good at code" is not 50/100.
 */
export function aiTaskFitVerdictV1(input: {
  taskKind: AiTaskKindV1;
  candidate: AiRouteCandidateV1;
}): Verdict {
  const { capabilities, contextTokens } = input.candidate;
  switch (input.taskKind) {
    case 'code_generation': {
      if (capabilities.optimizedForCode === null) return { scored: false, reason: 'insufficient_evidence' };
      return capabilities.optimizedForCode
        ? { scored: true, score: 100, confidence: 0.8 }
        : { scored: true, score: 55, confidence: 0.6 };
    }
    case 'structured_extraction': {
      if (capabilities.supportsResponseSchema === null) {
        return { scored: false, reason: 'insufficient_evidence' };
      }
      return capabilities.supportsResponseSchema
        ? { scored: true, score: 100, confidence: 0.85 }
        : { scored: true, score: 20, confidence: 0.85 };
    }
    case 'general_reasoning': {
      if (capabilities.supportsReasoning === null) return { scored: false, reason: 'insufficient_evidence' };
      return capabilities.supportsReasoning
        ? { scored: true, score: 100, confidence: 0.7 }
        : { scored: true, score: 65, confidence: 0.55 };
    }
    // Summarization, translation and classification are bounded by how much
    // text the model can hold, which IS reported. A large context is a real
    // signal for these tasks in a way it is not for reasoning quality.
    case 'summarization':
    case 'translation':
    case 'classification': {
      if (contextTokens >= 128_000) return { scored: true, score: 95, confidence: 0.6 };
      if (contextTokens >= 32_000) return { scored: true, score: 80, confidence: 0.6 };
      if (contextTokens >= 8_000) return { scored: true, score: 60, confidence: 0.6 };
      return { scored: true, score: 35, confidence: 0.6 };
    }
  }
}

/**
 * Privacy, from the provider's own published mode.
 *
 * `unknown` does NOT score zero. A zero would rank an unlabelled model against
 * labelled ones as though the absence of a claim were a measured weakness; it
 * is a gap in evidence, and that is what the dimension reports.
 */
export function aiPrivacyVerdictV1(candidate: AiRouteCandidateV1): Verdict {
  if (candidate.privacyMode === 'private') return { scored: true, score: 100, confidence: 0.8 };
  if (candidate.privacyMode === 'anonymized') return { scored: true, score: 55, confidence: 0.8 };
  return { scored: false, reason: 'insufficient_evidence' };
}

/** Cost against the ceiling the user authorized. Cheaper is better, and a
 * request at exactly the ceiling scores zero rather than being rejected here —
 * eligibility already decided whether it may run at all. */
export function aiCostVerdictV1(input: {
  candidate: AiRouteCandidateV1;
  maxSpendUsd: string | null;
}): Verdict {
  if (input.candidate.ineligibleReason === 'pricing_unavailable') {
    return { scored: false, reason: 'insufficient_evidence' };
  }
  if (input.maxSpendUsd === null) return { scored: false, reason: 'not_requested' };
  const ceiling = Number(input.maxSpendUsd);
  const cost = Number(input.candidate.estimatedCostUsd);
  if (!Number.isFinite(ceiling) || !Number.isFinite(cost) || ceiling <= 0) {
    return { scored: false, reason: 'scoring_error' };
  }
  return { scored: true, score: clamp((1 - cost / ceiling) * 100), confidence: 0.9 };
}

/**
 * Latency.
 *
 * Always `no_measured_runs`. Venice does not publish a latency figure, and
 * nothing in this deployment has timed these models yet. When T66D has
 * recorded real completions this becomes a measurement over them — until
 * then the dimension says it has nothing rather than inventing a proxy.
 */
export function aiLatencyVerdictV1(): Verdict {
  return { scored: false, reason: 'no_measured_runs' };
}

/** Headroom between what the request needs and what the model holds. */
export function aiContextVerdictV1(input: {
  candidate: AiRouteCandidateV1;
  requiredTokens: number;
}): Verdict {
  if (input.requiredTokens <= 0) return { scored: false, reason: 'insufficient_evidence' };
  const ratio = input.candidate.contextTokens / input.requiredTokens;
  if (ratio < 1) return { scored: true, score: 0, confidence: 0.9 };
  // 1x fits exactly, 8x or more is comfortable. Linear between.
  return { scored: true, score: clamp(((Math.min(ratio, 8) - 1) / 7) * 100), confidence: 0.9 };
}

/** Structured output and tool calling, together — they are the same question
 * for a caller wiring a model into a program. */
export function aiStructuredOutputVerdictV1(candidate: AiRouteCandidateV1): Verdict {
  const { supportsResponseSchema, supportsToolCalling } = candidate.capabilities;
  if (supportsResponseSchema === null && supportsToolCalling === null) {
    return { scored: false, reason: 'insufficient_evidence' };
  }
  const schema = supportsResponseSchema === true ? 60 : 0;
  const tools = supportsToolCalling === true ? 40 : 0;
  // Confidence drops when only one of the two was reported: the score is real
  // but it is answering half the question.
  const bothKnown = supportsResponseSchema !== null && supportsToolCalling !== null;
  return { scored: true, score: schema + tools, confidence: bothKnown ? 0.85 : 0.5 };
}

/** Availability, which is only meaningful while the catalogue is fresh. A
 * stale reading cannot say whether a model is up right now. */
export function aiAvailabilityVerdictV1(input: {
  candidate: AiRouteCandidateV1;
  ageMs: number;
  ttlMs: number;
}): Verdict {
  if (input.ageMs > input.ttlMs) return { scored: false, reason: 'stale_evidence' };
  if (input.candidate.offline) return { scored: true, score: 0, confidence: 0.9 };
  // Confidence decays across the TTL: a reading taken a moment ago says more
  // about "now" than one taken just inside the window.
  const freshness = 1 - Math.min(1, Math.max(0, input.ageMs) / Math.max(1, input.ttlMs));
  return { scored: true, score: 100, confidence: 0.5 + 0.4 * freshness };
}

function verdictFor(
  dimension: AiScoreDimensionNameV1,
  context: AiScoringContextV1,
  candidate: AiRouteCandidateV1,
  ageMs: number,
): Verdict {
  switch (dimension) {
    case 'task_fit':
      return aiTaskFitVerdictV1({ taskKind: context.intent.taskKind, candidate });
    case 'privacy_mode':
      return aiPrivacyVerdictV1(candidate);
    case 'cost':
      return aiCostVerdictV1({ candidate, maxSpendUsd: context.intent.maxSpendUsd });
    case 'latency':
      return aiLatencyVerdictV1();
    case 'context_capacity':
      return aiContextVerdictV1({
        candidate,
        requiredTokens:
          context.intent.prompt.estimatedPromptTokens + context.intent.maxCompletionTokens,
      });
    case 'structured_output':
      return aiStructuredOutputVerdictV1(candidate);
    case 'availability':
      return aiAvailabilityVerdictV1({ candidate, ageMs, ttlMs: context.catalogueTtlMs });
  }
}

/**
 * All seven dimensions for one candidate.
 *
 * A scored dimension links the evidence rows it used. A `not_scored` one links
 * none — the contract enforces that, because a dimension that could not answer
 * must not appear to have consulted sources.
 */
export function scoreAiCandidateV1(
  context: AiScoringContextV1,
  candidate: AiRouteCandidateV1,
): AiScoreDimensionV1[] {
  const nowIso = context.now.toISOString();
  const observedAtMs = Date.parse(context.catalogueObservedAt);
  const ageMs = Number.isFinite(observedAtMs)
    ? Math.max(0, context.now.getTime() - observedAtMs)
    : Number.POSITIVE_INFINITY;

  const sources = context.evidence
    .filter((row) => row.candidateHash === candidate.candidateHash)
    .map((row) => ({ evidenceId: row.id, evidenceHash: row.evidenceHash, providerId: row.provider.id }));

  return AI_SCORE_DIMENSIONS_V1.map((dimension) => {
    const verdict = verdictFor(dimension, context, candidate, ageMs);
    const draft = {
      schemaVersion: 'ai-score-dimension/v1' as const,
      id: `${context.runId}:dimension:${candidate.modelId}:${dimension}`,
      tenantId: context.tenantId,
      walletAddress: context.walletAddress,
      chainId: context.chainId,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: (verdict.scored ? 'scored' : 'not_scored') as 'scored' | 'not_scored',
      dimensionHash: '0x0' as never,
      intentHash: context.intent.intentHash,
      candidateHash: candidate.candidateHash,
      dimension,
      score: verdict.scored ? verdict.score : null,
      notScoredReason: verdict.scored ? null : verdict.reason,
      confidence: verdict.scored
        ? { value: verdict.confidence, label: confidenceLabel(verdict.confidence) }
        : null,
      sources: verdict.scored ? sources : [],
      freshness: Number.isFinite(ageMs)
        ? {
            observedAt: context.catalogueObservedAt,
            expiresAt: new Date(observedAtMs + context.catalogueTtlMs).toISOString(),
            ageSeconds: Math.floor(ageMs / 1000),
            state: (ageMs > context.catalogueTtlMs ? 'stale' : 'fresh') as 'stale' | 'fresh',
          }
        : null,
      scoringVersion: AI_SCORING_VERSION_V1,
      missingEvidence: verdict.scored ? [] : (['model_capabilities'] as const).slice(0, 1),
    };
    return AiScoreDimensionV1Schema.parse({
      ...draft,
      dimensionHash: hashAiScoreDimensionV1(draft as unknown as AiScoreDimensionV1),
    });
  });
}

/**
 * The selection, applied in the order the Route Card states.
 *
 * Deliberately lexicographic rather than weighted. Every step is a fact a user
 * can check on the card, and none of them is a coefficient nobody can audit.
 * Returns null when nothing is eligible — a card with no model is a real
 * answer, and the alternatives explain it.
 */
export function selectAiCandidateV1(
  candidates: readonly AiRouteCandidateV1[],
  intent: AiRouteIntentV1,
  scoreOf: (candidate: AiRouteCandidateV1) => readonly AiScoreDimensionV1[],
): AiRouteCandidateV1 | null {
  const eligible = candidates.filter((candidate) => candidate.ineligibleReason === null);
  if (eligible.length === 0) return null;

  // An explicitly named model wins outright, provided it survived eligibility.
  // Naming a model is a decision; the comparison exists to inform it, not to
  // overrule it.
  if (intent.preferredModelId !== null) {
    const preferred = eligible.find((candidate) => candidate.modelId === intent.preferredModelId);
    if (preferred) return preferred;
  }

  const privacyRank = (candidate: AiRouteCandidateV1): number =>
    candidate.privacyMode === 'private' ? 0 : candidate.privacyMode === 'anonymized' ? 1 : 2;
  const taskFit = (candidate: AiRouteCandidateV1): number => {
    const dimension = scoreOf(candidate).find((entry) => entry.dimension === 'task_fit');
    // An unscored task fit sorts BELOW every scored one rather than above: an
    // unknown must not win a comparison against a measured competitor.
    return dimension?.score ?? -1;
  };

  return [...eligible].sort((left, right) => {
    const byPrivacy = privacyRank(left) - privacyRank(right);
    if (byPrivacy !== 0) return byPrivacy;
    const byFit = taskFit(right) - taskFit(left);
    if (byFit !== 0) return byFit;
    const byCost = compareUsdV1(left.estimatedCostUsd, right.estimatedCostUsd);
    if (byCost !== 0) return byCost;
    const byContext = right.contextTokens - left.contextTokens;
    if (byContext !== 0) return byContext;
    return left.modelId.localeCompare(right.modelId);
  })[0] as AiRouteCandidateV1;
}
