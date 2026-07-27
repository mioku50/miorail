import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  AI_SCORE_DIMENSIONS_V1,
  AiPromptCommitmentV1Schema,
  AiRouteIntentV1Schema,
  commitAiPromptV1,
  hashAiRouteIntentV1,
  type AiRouteIntentV1,
  type AiScoreDimensionNameV1,
} from '@mioagent/route-domain';
import {
  buildAiCandidatesV1,
  buildAiEvidenceV1,
  buildAiRouteCardV1,
  compareAiRoutesV1,
  scoreAiCandidateV1,
  selectAiCandidateV1,
  type AiCandidateContextV1,
  type VeniceCatalogueV1,
  type VeniceGatewayV1,
  type VeniceObservedModelV1,
} from '../src/index.js';

const WALLET = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const NONCE = 'n'.repeat(64);
const NOW = new Date('2026-07-27T10:00:00.000Z');

function model(overrides: Partial<VeniceObservedModelV1> = {}): VeniceObservedModelV1 {
  return {
    modelId: 'llama-3.3-70b',
    modelName: 'Llama 3.3 70B',
    modelVersion: null,
    description: null,
    privacyMode: 'private',
    offline: false,
    contextTokens: 65_536,
    maxCompletionTokens: 8_192,
    inputUsdPerMillion: '0.7',
    outputUsdPerMillion: '2.8',
    supportsToolCalling: true,
    supportsResponseSchema: true,
    supportsReasoning: true,
    supportsWebSearch: true,
    supportsVision: false,
    optimizedForCode: false,
    quantization: null,
    traits: [],
    ...overrides,
  };
}

function intent(overrides: Partial<AiRouteIntentV1> = {}): AiRouteIntentV1 {
  const base = {
    schemaVersion: 'ai-route-intent/v1' as const,
    id: 'run-1:intent',
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    chainId: 8453 as const,
    createdAt: '2026-07-27T10:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    status: 'ready' as const,
    intentHash: `0x${'0'.repeat(64)}`,
    goal: 'private_ai' as const,
    taskKind: 'general_reasoning' as const,
    prompt: AiPromptCommitmentV1Schema.parse({
      schemaVersion: 'ai-prompt-commitment/v1',
      commitment: commitAiPromptV1({ nonce: NONCE, systemText: null, messages: [{ role: 'user', text: 'q' }] }),
      charCount: 1,
      messageCount: 1,
      hasSystemMessage: false,
      estimatedPromptTokens: 100,
    }),
    privacyRequirement: 'private_only' as const,
    requiresToolCalling: false,
    requiresResponseSchema: false,
    requiresWebSearch: false,
    maxSpendUsd: '0.05',
    maxCompletionTokens: 512,
    preferredModelId: null,
    executionRequested: false,
    ...overrides,
  } as AiRouteIntentV1;
  return AiRouteIntentV1Schema.parse({ ...base, intentHash: hashAiRouteIntentV1(base) });
}

function catalogue(models: VeniceObservedModelV1[], observedAt = NOW.toISOString()): VeniceCatalogueV1 {
  return {
    models,
    requestHash: `0x${'1'.repeat(64)}`,
    responseHash: `0x${'2'.repeat(64)}`,
    observedAt,
  };
}

function candidateContext(overrides: Partial<AiCandidateContextV1> = {}): AiCandidateContextV1 {
  return {
    runId: 'run-1',
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    chainId: 8453,
    intent: intent(),
    allowlist: ['llama-3.3-70b'],
    now: NOW,
    ...overrides,
  };
}

function scoreOne(input: {
  models?: VeniceObservedModelV1[];
  intentOverrides?: Partial<AiRouteIntentV1>;
  observedAt?: string;
  catalogueTtlMs?: number;
}) {
  const value = intent(input.intentOverrides);
  const ctx = candidateContext({ intent: value });
  const cat = catalogue(input.models ?? [model()], input.observedAt);
  const candidates = buildAiCandidatesV1(ctx, cat);
  const evidence = buildAiEvidenceV1(ctx, cat, candidates, 'Prompts are not stored.');
  const dimensions = scoreAiCandidateV1(
    {
      ...ctx,
      evidence,
      catalogueObservedAt: cat.observedAt,
      catalogueTtlMs: input.catalogueTtlMs ?? 300_000,
    },
    candidates[0] as never,
  );
  const byName = (name: AiScoreDimensionNameV1) => dimensions.find((entry) => entry.dimension === name);
  return { candidates, evidence, dimensions, byName };
}

describe('every dimension is answered, and missing data says so', () => {
  test('all seven dimensions are always present', () => {
    const { dimensions } = scoreOne({});
    assert.deepEqual(
      dimensions.map((entry) => entry.dimension),
      [...AI_SCORE_DIMENSIONS_V1],
    );
  });

  test('latency is not_scored because nothing has measured it', () => {
    const { byName } = scoreOne({});
    const latency = byName('latency');
    assert.equal(latency?.status, 'not_scored');
    assert.equal(latency?.score, null);
    assert.equal(latency?.notScoredReason, 'no_measured_runs');
    assert.equal(latency?.confidence, null);
    assert.deepEqual(latency?.sources, [], 'an unanswered dimension cites no evidence');
  });

  test('an unpublished privacy mode is not_scored, never zero', () => {
    const { byName } = scoreOne({
      models: [model({ privacyMode: 'unknown' })],
      intentOverrides: { privacyRequirement: 'any' },
    });
    const privacy = byName('privacy_mode');
    assert.equal(privacy?.status, 'not_scored');
    assert.equal(privacy?.score, null);
    assert.equal(privacy?.notScoredReason, 'insufficient_evidence');
  });

  test('private scores above anonymized, and both are scored', () => {
    const priv = scoreOne({ models: [model({ privacyMode: 'private' })] }).byName('privacy_mode');
    const anon = scoreOne({
      models: [model({ privacyMode: 'anonymized' })],
      intentOverrides: { privacyRequirement: 'prefer_private' },
    }).byName('privacy_mode');
    assert.equal(priv?.score, 100);
    assert.equal(anon?.score, 55);
  });

  test('an unreported code capability leaves task fit unscored', () => {
    const { byName } = scoreOne({
      models: [model({ optimizedForCode: null })],
      intentOverrides: { taskKind: 'code_generation' },
    });
    const fit = byName('task_fit');
    assert.equal(fit?.status, 'not_scored');
    assert.equal(fit?.notScoredReason, 'insufficient_evidence');
  });

  test('a reported code capability is scored either way', () => {
    const yes = scoreOne({
      models: [model({ optimizedForCode: true })],
      intentOverrides: { taskKind: 'code_generation' },
    }).byName('task_fit');
    const no = scoreOne({
      models: [model({ optimizedForCode: false })],
      intentOverrides: { taskKind: 'code_generation' },
    }).byName('task_fit');
    assert.equal(yes?.score, 100);
    assert.equal(no?.score, 55);
  });

  test('structured output refuses only when NEITHER signal was reported', () => {
    const neither = scoreOne({
      models: [model({ supportsResponseSchema: null, supportsToolCalling: null })],
    }).byName('structured_output');
    assert.equal(neither?.status, 'not_scored');

    const half = scoreOne({
      models: [model({ supportsResponseSchema: true, supportsToolCalling: null })],
    }).byName('structured_output');
    assert.equal(half?.status, 'scored');
    assert.equal(half?.score, 60);
    // Half an answer is a real score with visibly lower confidence.
    assert.equal(half?.confidence?.label, 'medium');
  });

  test('availability refuses on a stale catalogue rather than guessing', () => {
    const stale = scoreOne({
      observedAt: new Date(NOW.getTime() - 600_000).toISOString(),
      catalogueTtlMs: 300_000,
    }).byName('availability');
    assert.equal(stale?.status, 'not_scored');
    assert.equal(stale?.notScoredReason, 'stale_evidence');
    assert.equal(stale?.freshness?.state, 'stale');
  });

  test('availability confidence decays across the TTL', () => {
    const fresh = scoreOne({ observedAt: NOW.toISOString() }).byName('availability');
    const older = scoreOne({
      observedAt: new Date(NOW.getTime() - 250_000).toISOString(),
    }).byName('availability');
    assert.ok((fresh?.confidence?.value ?? 0) > (older?.confidence?.value ?? 0));
    assert.equal(fresh?.score, 100);
  });

  test('cost is measured against the ceiling the user set', () => {
    const cheap = scoreOne({ intentOverrides: { maxSpendUsd: '1' } }).byName('cost');
    const tight = scoreOne({ intentOverrides: { maxSpendUsd: '0.002' } }).byName('cost');
    assert.ok((cheap?.score ?? 0) > (tight?.score ?? 100));
    assert.equal(cheap?.status, 'scored');
  });

  test('context capacity scores zero when the request does not fit', () => {
    // 400 tokens of context against 100 prompt + 512 completion.
    const { byName } = scoreOne({ models: [model({ contextTokens: 400, maxCompletionTokens: 400 })] });
    assert.equal(byName('context_capacity')?.score, 0);
  });

  test('a scored dimension cites the evidence it used', () => {
    const { byName, evidence } = scoreOne({});
    const cost = byName('cost');
    assert.equal(cost?.status, 'scored');
    assert.equal(cost?.sources.length, 1);
    assert.equal(cost?.sources[0]?.evidenceHash, evidence[0]?.evidenceHash);
    assert.equal(cost?.sources[0]?.providerId, 'venice');
  });
});

describe('selection follows the stated order and nothing else', () => {
  function select(models: VeniceObservedModelV1[], overrides: Partial<AiRouteIntentV1> = {}) {
    const value = intent(overrides);
    const ctx = candidateContext({
      intent: value,
      allowlist: models.map((entry) => entry.modelId),
    });
    const cat = catalogue(models);
    const candidates = buildAiCandidatesV1(ctx, cat);
    const evidence = buildAiEvidenceV1(ctx, cat, candidates, null);
    const scoring = {
      ...ctx,
      evidence,
      catalogueObservedAt: cat.observedAt,
      catalogueTtlMs: 300_000,
    };
    return selectAiCandidateV1(candidates, value, (candidate) => scoreAiCandidateV1(scoring, candidate));
  }

  test('privacy outranks price', () => {
    const chosen = select(
      [
        model({ modelId: 'cheap-anon', privacyMode: 'anonymized', inputUsdPerMillion: '0.01', outputUsdPerMillion: '0.01' }),
        model({ modelId: 'dear-private', privacyMode: 'private', inputUsdPerMillion: '5', outputUsdPerMillion: '5' }),
      ],
      { privacyRequirement: 'prefer_private' },
    );
    assert.equal(chosen?.modelId, 'dear-private');
  });

  test('price breaks a tie between equal privacy and equal fit', () => {
    const chosen = select([
      model({ modelId: 'a-dear', inputUsdPerMillion: '5', outputUsdPerMillion: '5' }),
      model({ modelId: 'b-cheap', inputUsdPerMillion: '0.1', outputUsdPerMillion: '0.1' }),
    ]);
    assert.equal(chosen?.modelId, 'b-cheap');
  });

  test('an unscored task fit never outranks a scored one', () => {
    const chosen = select(
      [
        model({ modelId: 'unknown-fit', optimizedForCode: null, inputUsdPerMillion: '0.01', outputUsdPerMillion: '0.01' }),
        model({ modelId: 'known-fit', optimizedForCode: true, inputUsdPerMillion: '5', outputUsdPerMillion: '5' }),
      ],
      { taskKind: 'code_generation' },
    );
    assert.equal(chosen?.modelId, 'known-fit');
  });

  test('a user-named model wins outright once it is eligible', () => {
    const chosen = select(
      [
        model({ modelId: 'cheap-one', inputUsdPerMillion: '0.01', outputUsdPerMillion: '0.01' }),
        model({ modelId: 'named-one', inputUsdPerMillion: '5', outputUsdPerMillion: '5' }),
      ],
      { preferredModelId: 'named-one' },
    );
    assert.equal(chosen?.modelId, 'named-one');
  });

  test('naming an INELIGIBLE model does not admit it', () => {
    const chosen = select(
      [
        model({ modelId: 'cheap-one' }),
        model({ modelId: 'named-one', offline: true }),
      ],
      { preferredModelId: 'named-one' },
    );
    assert.equal(chosen?.modelId, 'cheap-one');
  });

  test('nothing eligible selects nothing', () => {
    assert.equal(select([model({ offline: true })]), null);
  });
});

describe('the card states what the run established', () => {
  function card(input: {
    models: VeniceObservedModelV1[];
    intentOverrides?: Partial<AiRouteIntentV1>;
    retentionClaim?: string | null;
    observedAt?: string;
  }) {
    const value = intent(input.intentOverrides);
    const ctx = candidateContext({
      intent: value,
      allowlist: input.models.map((entry) => entry.modelId),
    });
    const cat = catalogue(input.models, input.observedAt);
    const candidates = buildAiCandidatesV1(ctx, cat);
    const evidence = buildAiEvidenceV1(ctx, cat, candidates, input.retentionClaim ?? 'Prompts are not stored.');
    return buildAiRouteCardV1({
      scoring: { ...ctx, evidence, catalogueObservedAt: cat.observedAt, catalogueTtlMs: 300_000 },
      candidates,
      evidence,
      retentionClaim: input.retentionClaim === undefined ? 'Prompts are not stored.' : input.retentionClaim,
      x402Metered: false,
      ttlMs: 120_000,
    });
  }

  test('a good run is ready and names the model', () => {
    const { card: built } = card({ models: [model()] });
    assert.equal(built.status, 'ready');
    assert.equal(built.selected?.modelId, 'llama-3.3-70b');
    assert.equal(built.selected?.status, 'selected');
    assert.equal(built.dimensions.length, 7);
  });

  test('models found but all refused is constrained, not failed', () => {
    const { card: built } = card({ models: [model({ offline: true })] });
    assert.equal(built.status, 'constrained');
    assert.equal(built.selected, null);
    // The refused model stays on the card WITH its reason.
    assert.equal(built.alternatives.length, 1);
    assert.equal(built.alternatives[0]?.ineligibleReason, 'offline');
    // And it still answers all seven questions.
    assert.equal(built.dimensions.length, 7);
    assert.ok(built.dimensions.every((entry) => entry.status === 'not_scored'));
  });

  test('nothing found at all is failed with a reason', () => {
    const { card: built } = card({ models: [] });
    assert.equal(built.status, 'failed');
    assert.ok(built.failureReason);
    assert.equal(built.selected, null);
  });

  test('an unstated retention claim degrades the card rather than passing silently', () => {
    const { card: built } = card({ models: [model()], retentionClaim: null });
    assert.equal(built.status, 'degraded');
    assert.equal(built.retentionClaim, null);
    assert.ok(built.evidenceGaps.includes('privacy_policy'));
  });

  test('a stale catalogue degrades the card', () => {
    const { card: built } = card({
      models: [model()],
      observedAt: new Date(NOW.getTime() - 600_000).toISOString(),
    });
    assert.equal(built.status, 'degraded');
  });

  test('the card states its own selection rule', () => {
    const { card: built } = card({ models: [model()] });
    assert.ok(built.selectionPolicy.includes('eligibility first'));
    assert.ok(built.recommendation.includes('Venice'));
  });

  test('the selected model is not repeated among its own alternatives', () => {
    const { card: built } = card({ models: [model(), model({ modelId: 'other-model' })] });
    assert.ok(built.selected);
    assert.ok(
      !built.alternatives.some((entry) => entry.candidateHash === built.selected?.candidateHash),
    );
  });

  test('the card names what the model cannot do', () => {
    const { card: built } = card({
      models: [model({ supportsVision: false, supportsWebSearch: null, quantization: 'fp8' })],
    });
    assert.ok(built.unsupportedCapabilities.includes('no image input'));
    assert.ok(built.unsupportedCapabilities.includes('web search not stated'));
    assert.ok(built.unsupportedCapabilities.includes('quantized: fp8'));
  });

  test('the card says what leaves the machine without quoting it', () => {
    const { card: built } = card({ models: [model()] });
    assert.ok(built.dataSentSummary.includes('Llama 3.3 70B'));
    assert.ok(built.dataSentSummary.includes('1 message'));
  });

  test('two identical runs produce the same card hash', () => {
    const first = card({ models: [model(), model({ modelId: 'other-model' })] });
    const second = card({ models: [model({ modelId: 'other-model' }), model()] });
    assert.equal(first.card.routeCardHash, second.card.routeCardHash);
  });
});

describe('the coordinator', () => {
  function gateway(catalogueResult: VeniceCatalogueV1 | { reason: string }): VeniceGatewayV1 {
    return {
      async readTextModels() {
        if ('reason' in catalogueResult) {
          return { ok: false, reason: catalogueResult.reason as never };
        }
        return { ok: true, value: catalogueResult };
      },
      async runInference() {
        throw new Error('comparison must never call inference');
      },
    };
  }

  const base = {
    runId: 'run-1',
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    chainId: 8453 as const,
    intent: intent(),
    retentionClaim: 'Prompts are not stored.',
    x402Metered: false,
    now: NOW,
  };

  test('an empty allowlist stops before the catalogue is even read', async () => {
    let called = false;
    const result = await compareAiRoutesV1(
      {
        gateway: {
          async readTextModels() {
            called = true;
            return { ok: false, reason: 'no_text_models' };
          },
          async runInference() {
            throw new Error('unreachable');
          },
        },
      },
      { ...base, allowlist: [] },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'no_allowlisted_models');
    assert.equal(called, false);
  });

  test('comparison never calls inference', async () => {
    const result = await compareAiRoutesV1(
      { gateway: gateway(catalogue([model()])) },
      { ...base, allowlist: ['llama-3.3-70b'] },
    );
    assert.ok(result.ok);
    assert.equal(result.selected.modelId, 'llama-3.3-70b');
  });

  test('a provider failure produces a reason and no card', async () => {
    const result = await compareAiRoutesV1(
      { gateway: gateway({ reason: 'provider_timeout' }) },
      { ...base, allowlist: ['llama-3.3-70b'] },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'provider_timeout');
    assert.equal(result.ok === false && result.card, null);
  });

  test('all models refused returns the explaining card, not an empty failure', async () => {
    const result = await compareAiRoutesV1(
      { gateway: gateway(catalogue([model({ offline: true })])) },
      { ...base, allowlist: ['llama-3.3-70b'] },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.card, 'the card explains what was considered');
    assert.equal(result.card.status, 'constrained');
    assert.equal(result.card.alternatives[0]?.ineligibleReason, 'offline');
  });
});
