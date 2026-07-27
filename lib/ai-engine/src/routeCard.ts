import {
  AI_RECOMMENDATION_COPY_V1,
  AI_SCORE_DIMENSIONS_V1,
  AI_SELECTION_POLICY_COPY_V1,
  AiRouteCardV1Schema,
  AiScoreDimensionV1Schema,
  ZERO_HASH_V1,
  aiDataSentSummaryV1,
  aiUnsupportedCapabilitiesV1,
  hashAiRouteCardV1,
  hashAiScoreDimensionV1,
  type AiEvidenceKindV1,
  type AiEvidenceV1,
  type AiRouteCandidateV1,
  type AiRouteCardV1,
  type AiScoreDimensionV1,
} from '@mioagent/route-domain';
import {
  AI_SCORING_VERSION_V1,
  scoreAiCandidateV1,
  selectAiCandidateV1,
  type AiScoringContextV1,
} from './scoring.js';

// ---------------------------------------------------------------------------
// T66B — the AI Route Card.
//
// The card's status is DERIVED from what the run actually established, not
// asserted by the caller:
//
//   ready       a model was selected from a fresh catalogue, inside the ceiling
//   degraded    a model was selected but something behind it is stale or absent
//   constrained models were found and none of them can serve this request
//   failed      nothing was found at all
//
// `constrained` and `failed` are kept apart on purpose. "Venice lists eleven
// models and every one of them costs more than your ceiling" and "we could not
// read the catalogue" send a user to completely different next steps, and a
// single "no route" state would have collapsed them.
// ---------------------------------------------------------------------------

export interface AiRouteCardInputV1 {
  scoring: AiScoringContextV1;
  candidates: readonly AiRouteCandidateV1[];
  evidence: readonly AiEvidenceV1[];
  /** The retention claim published for the selected model, or null. */
  retentionClaim: string | null;
  /** Whether this deployment bills the inference call through x402. */
  x402Metered: boolean;
  /** How long this card may be acted on. */
  ttlMs: number;
}

export interface AiRouteCardResultV1 {
  card: AiRouteCardV1;
  /** Dimensions for the SELECTED model, already on the card, returned so a
   * caller can persist them without re-deriving and risking a different hash. */
  dimensions: AiScoreDimensionV1[];
}

/** Evidence kinds this run never obtained. Stated on the card so a user can
 * see what the comparison did not know. */
export function aiEvidenceGapsV1(
  evidence: readonly AiEvidenceV1[],
  retentionClaim: string | null,
): AiEvidenceKindV1[] {
  const present = new Set(evidence.map((row) => row.evidenceKind));
  const gaps: AiEvidenceKindV1[] = [];
  if (!present.has('model_catalogue')) gaps.push('model_catalogue');
  // A retention claim is what makes "private" more than a label, so its
  // absence is a named gap rather than a blank field.
  if (retentionClaim === null) gaps.push('privacy_policy');
  // Latency has no source in V1 and this is where that is admitted. It is the
  // same fact the latency dimension reports, said once more where a user
  // reading only the card's gaps will see it.
  gaps.push('availability');
  return gaps;
}

/**
 * Builds the card.
 *
 * The selected model's dimensions are computed ONCE and reused for both the
 * selection ordering and the card, so the card can never display a score that
 * differs from the one that chose the model.
 */
export function buildAiRouteCardV1(input: AiRouteCardInputV1): AiRouteCardResultV1 {
  const { scoring } = input;
  const nowIso = scoring.now.toISOString();
  const scoreCache = new Map<string, AiScoreDimensionV1[]>();
  const scoreOf = (candidate: AiRouteCandidateV1): AiScoreDimensionV1[] => {
    const cached = scoreCache.get(candidate.candidateHash);
    if (cached) return cached;
    const scored = scoreAiCandidateV1(scoring, candidate);
    scoreCache.set(candidate.candidateHash, scored);
    return scored;
  };

  const chosen = selectAiCandidateV1(input.candidates, scoring.intent, scoreOf);
  const selected: AiRouteCandidateV1 | null =
    chosen === null ? null : { ...chosen, status: 'selected', updatedAt: nowIso };
  // The dimensions must describe the candidate as it appears on the card. The
  // status change above is a lifecycle field and therefore hash-neutral, so
  // the cached scores still refer to this exact candidate.
  const dimensions = chosen === null ? [] : scoreOf(chosen);

  const alternatives = input.candidates.filter(
    (candidate) => candidate.candidateHash !== chosen?.candidateHash,
  );

  const observedAtMs = Date.parse(scoring.catalogueObservedAt);
  const stale =
    !Number.isFinite(observedAtMs) || scoring.now.getTime() - observedAtMs > scoring.catalogueTtlMs;
  const evidenceGaps = aiEvidenceGapsV1(input.evidence, input.retentionClaim);

  let status: AiRouteCardV1['status'];
  let failureReason: string | null = null;
  if (input.candidates.length === 0) {
    status = 'failed';
    failureReason = 'Venice returned no text models this deployment is allowed to use.';
  } else if (selected === null) {
    // Every model was found and every model was refused. The card says so, and
    // the alternatives carry the individual reasons.
    status = 'constrained';
  } else if (stale || input.retentionClaim === null) {
    status = 'degraded';
  } else {
    status = 'ready';
  }

  // A selected model that exceeds the ceiling cannot ride on a `ready` card —
  // the contract refuses it, and quietly downgrading to `degraded` would hide
  // a real problem, so this is a failure with its reason stated.
  if (
    selected !== null &&
    scoring.intent.maxSpendUsd !== null &&
    status !== 'constrained' &&
    Number(selected.estimatedCostUsd) > Number(scoring.intent.maxSpendUsd)
  ) {
    status = 'failed';
    failureReason = 'The cheapest usable model still costs more than the authorized ceiling.';
  }

  const draft = {
    schemaVersion: 'ai-route-card/v1' as const,
    id: `${scoring.runId}:card`,
    tenantId: scoring.tenantId,
    walletAddress: scoring.walletAddress,
    chainId: scoring.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status,
    routeCardHash: '0x0' as never,
    intentHash: scoring.intent.intentHash,
    recommendation: AI_RECOMMENDATION_COPY_V1,
    selectionPolicy: AI_SELECTION_POLICY_COPY_V1,
    taskKind: scoring.intent.taskKind,
    selected: status === 'failed' && failureReason !== null && selected === null ? null : selected,
    alternatives: alternatives.slice(0, 50),
    // A card with no model still carries seven dimensions so no surface has to
    // special-case an empty comparison — but every one of them is `not_scored`.
    // Scoring a model that was not chosen would put real-looking numbers next
    // to a card that recommends nothing.
    dimensions: dimensions.length === 7 ? dimensions : unscoredAiDimensionsV1(scoring),
    evidenceHashes: input.evidence.map((row) => row.evidenceHash),
    evidenceGaps,
    dataSentSummary: aiDataSentSummaryV1({
      prompt: scoring.intent.prompt,
      modelName: selected?.modelName ?? 'the selected model',
      webSearch: scoring.intent.requiresWebSearch,
    }),
    retentionClaim: input.retentionClaim,
    unsupportedCapabilities: selected === null ? [] : aiUnsupportedCapabilitiesV1(selected.capabilities),
    maxSpendUsd: scoring.intent.maxSpendUsd ?? '0',
    estimatedCostUsd: selected?.estimatedCostUsd ?? null,
    x402Metered: input.x402Metered,
    failureReason,
    expiresAt: new Date(scoring.now.getTime() + input.ttlMs).toISOString(),
  };

  const card = AiRouteCardV1Schema.parse({
    ...draft,
    routeCardHash: hashAiRouteCardV1(draft as unknown as AiRouteCardV1),
  });
  return { card, dimensions: card.dimensions };
}

/**
 * The seven dimensions of a card that selected nothing.
 *
 * All `not_scored`, all citing no evidence, all bound to the zero hash rather
 * than to some model that happened to be in the list. An earlier version of
 * this scored a stand-in candidate to fill the shape, which put a real
 * `availability: 100` and a real `context_capacity` next to a card that
 * recommends no model at all — numbers describing something the user was never
 * offered.
 */
export function unscoredAiDimensionsV1(scoring: AiScoringContextV1): AiScoreDimensionV1[] {
  const nowIso = scoring.now.toISOString();
  return AI_SCORE_DIMENSIONS_V1.map((dimension) => {
    const draft = {
      schemaVersion: 'ai-score-dimension/v1' as const,
      id: `${scoring.runId}:dimension:none:${dimension}`,
      tenantId: scoring.tenantId,
      walletAddress: scoring.walletAddress,
      chainId: scoring.chainId,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: 'not_scored' as const,
      dimensionHash: '0x0' as never,
      intentHash: scoring.intent.intentHash,
      candidateHash: ZERO_HASH_V1,
      dimension,
      score: null,
      notScoredReason: 'insufficient_evidence' as const,
      confidence: null,
      sources: [],
      freshness: null,
      scoringVersion: AI_SCORING_VERSION_V1,
      missingEvidence: ['model_capabilities' as const],
    };
    return AiScoreDimensionV1Schema.parse({
      ...draft,
      dimensionHash: hashAiScoreDimensionV1(draft as unknown as AiScoreDimensionV1),
    });
  });
}
