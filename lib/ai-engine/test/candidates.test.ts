import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  AiPromptCommitmentV1Schema,
  AiRouteIntentV1Schema,
  canonicalJsonV1,
  commitAiPromptV1,
  hashAiRouteIntentV1,
  type AiRouteIntentV1,
} from '@mioagent/route-domain';
import {
  aiIneligibleReasonV1,
  buildAiCandidatesV1,
  buildAiEvidenceV1,
  type AiCandidateContextV1,
  type VeniceCatalogueV1,
  type VeniceObservedModelV1,
} from '../src/index.js';

const WALLET = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const NONCE = 'n'.repeat(64);
const SECRET_PROMPT = 'Draft the acquisition memo for Project Harbour.';

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
    supportsReasoning: false,
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
      commitment: commitAiPromptV1({
        nonce: NONCE,
        systemText: null,
        messages: [{ role: 'user', text: SECRET_PROMPT }],
      }),
      charCount: SECRET_PROMPT.length,
      messageCount: 1,
      hasSystemMessage: false,
      estimatedPromptTokens: 12,
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

function context(overrides: Partial<AiCandidateContextV1> = {}): AiCandidateContextV1 {
  return {
    runId: 'run-1',
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    chainId: 8453,
    intent: intent(),
    allowlist: ['llama-3.3-70b'],
    now: new Date('2026-07-27T10:00:00.000Z'),
    ...overrides,
  };
}

function catalogue(models: VeniceObservedModelV1[]): VeniceCatalogueV1 {
  return {
    models,
    requestHash: `0x${'1'.repeat(64)}`,
    responseHash: `0x${'2'.repeat(64)}`,
    observedAt: '2026-07-27T10:00:00.000Z',
  };
}

describe('eligibility names the first disqualifying fact', () => {
  const cases: [string, Partial<VeniceObservedModelV1>, Partial<AiRouteIntentV1>, string][] = [
    ['an unlisted model', { modelId: 'other-model' }, {}, 'not_allowlisted'],
    ['an offline model', { offline: true }, {}, 'offline'],
    ['an anonymized model under private_only', { privacyMode: 'anonymized' }, {}, 'privacy_mode_insufficient'],
    ['an unknown privacy mode under private_only', { privacyMode: 'unknown' }, {}, 'privacy_mode_insufficient'],
    ['a model with no published price', { inputUsdPerMillion: null }, {}, 'pricing_unavailable'],
    ['a context that cannot hold the request', { contextTokens: 100 }, {}, 'context_too_small'],
    ['no tool calling', { supportsToolCalling: false }, { requiresToolCalling: true }, 'missing_tool_calling'],
    ['unreported tool calling', { supportsToolCalling: null }, { requiresToolCalling: true }, 'missing_tool_calling'],
    [
      'unreported schema support',
      { supportsResponseSchema: null },
      { requiresResponseSchema: true },
      'missing_response_schema',
    ],
    ['no web search', { supportsWebSearch: false }, { requiresWebSearch: true }, 'missing_web_search'],
    [
      'a model over the ceiling',
      { inputUsdPerMillion: '9000', outputUsdPerMillion: '9000' },
      {},
      'over_spend_ceiling',
    ],
  ];

  for (const [label, modelOverrides, intentOverrides, expected] of cases) {
    test(label, () => {
      const candidates = buildAiCandidatesV1(
        context({ intent: intent(intentOverrides) }),
        catalogue([model(modelOverrides)]),
      );
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]?.status, 'ineligible');
      assert.equal(candidates[0]?.ineligibleReason, expected);
    });
  }

  test('a model that clears every check is quoted with no reason', () => {
    const candidates = buildAiCandidatesV1(context(), catalogue([model()]));
    assert.equal(candidates[0]?.status, 'quoted');
    assert.equal(candidates[0]?.ineligibleReason, null);
  });

  test('prefer_private admits an anonymized model, private_only does not', () => {
    const anonymized = model({ privacyMode: 'anonymized' });
    assert.equal(
      aiIneligibleReasonV1({
        model: anonymized,
        intent: intent({ privacyRequirement: 'prefer_private' }),
        allowlist: ['llama-3.3-70b'],
        estimatedCostUsd: '0.001',
      }),
      null,
    );
    assert.equal(
      aiIneligibleReasonV1({
        model: anonymized,
        intent: intent({ privacyRequirement: 'private_only' }),
        allowlist: ['llama-3.3-70b'],
        estimatedCostUsd: '0.001',
      }),
      'privacy_mode_insufficient',
    );
  });
});

describe('discarded models stay on the run', () => {
  test('an ineligible model is kept with its reason, not filtered away', () => {
    const candidates = buildAiCandidatesV1(
      context({ allowlist: ['llama-3.3-70b', 'expensive-model'] }),
      catalogue([
        model(),
        model({ modelId: 'expensive-model', inputUsdPerMillion: '9000', outputUsdPerMillion: '9000' }),
      ]),
    );
    assert.equal(candidates.length, 2, 'both models survive to the card');
    const expensive = candidates.find((entry) => entry.modelId === 'expensive-model');
    assert.equal(expensive?.status, 'ineligible');
    assert.equal(expensive?.ineligibleReason, 'over_spend_ceiling');
  });

  test('nothing is selected by the builder — selection is the engine’s job', () => {
    const candidates = buildAiCandidatesV1(context(), catalogue([model()]));
    assert.ok(candidates.every((entry) => entry.status !== 'selected'));
  });

  test('order is deterministic: cheapest first, then by id', () => {
    const models = [
      model({ modelId: 'zzz-cheap', inputUsdPerMillion: '0.1', outputUsdPerMillion: '0.1' }),
      model({ modelId: 'aaa-dear', inputUsdPerMillion: '5', outputUsdPerMillion: '5' }),
      model({ modelId: 'bbb-cheap', inputUsdPerMillion: '0.1', outputUsdPerMillion: '0.1' }),
    ];
    const allowlist = ['zzz-cheap', 'aaa-dear', 'bbb-cheap'];
    const first = buildAiCandidatesV1(context({ allowlist }), catalogue(models));
    const reordered = buildAiCandidatesV1(context({ allowlist }), catalogue([...models].reverse()));
    assert.deepEqual(
      first.map((entry) => entry.modelId),
      ['bbb-cheap', 'zzz-cheap', 'aaa-dear'],
    );
    assert.deepEqual(
      first.map((entry) => entry.candidateHash),
      reordered.map((entry) => entry.candidateHash),
    );
  });
});

describe('ids are scoped to the run', () => {
  test('two runs of the same intent produce different entity ids', () => {
    const runOne = buildAiCandidatesV1(context({ runId: 'run-1' }), catalogue([model()]));
    const runTwo = buildAiCandidatesV1(context({ runId: 'run-2' }), catalogue([model()]));
    assert.notEqual(runOne[0]?.id, runTwo[0]?.id);
    // The CONTENT hash is identical — it is the primary key that must differ,
    // not the finding. This is the T65 collision that reached production.
    assert.equal(runOne[0]?.candidateHash, runTwo[0]?.candidateHash);

    const evidenceOne = buildAiEvidenceV1(context({ runId: 'run-1' }), catalogue([model()]), runOne, null);
    const evidenceTwo = buildAiEvidenceV1(context({ runId: 'run-2' }), catalogue([model()]), runTwo, null);
    assert.notEqual(evidenceOne[0]?.id, evidenceTwo[0]?.id);
  });
});

describe('no candidate or evidence row can carry the prompt', () => {
  test('the serialized run contains no prompt text', () => {
    const ctx = context();
    const candidates = buildAiCandidatesV1(ctx, catalogue([model()]));
    const evidence = buildAiEvidenceV1(ctx, catalogue([model()]), candidates, 'Not retained.');
    const serialized = canonicalJsonV1({ candidates, evidence });
    assert.ok(!serialized.includes(SECRET_PROMPT));
    assert.ok(!serialized.includes('Harbour'));
    assert.ok(!serialized.includes(NONCE), 'the nonce must not be persisted either');
  });

  test('evidence records the retention claim verbatim, or null when there is none', () => {
    const ctx = context();
    const candidates = buildAiCandidatesV1(ctx, catalogue([model()]));
    const stated = buildAiEvidenceV1(ctx, catalogue([model()]), candidates, 'Prompts are not stored.');
    const unstated = buildAiEvidenceV1(ctx, catalogue([model()]), candidates, null);
    assert.equal(stated[0]?.retentionPolicy, 'Prompts are not stored.');
    assert.equal(unstated[0]?.retentionPolicy, null);
  });

  test('the catalogue read is recorded as free, not as a paid call', () => {
    const ctx = context();
    const candidates = buildAiCandidatesV1(ctx, catalogue([model()]));
    const evidence = buildAiEvidenceV1(ctx, catalogue([model()]), candidates, null);
    assert.equal(evidence[0]?.freeOrPaid, 'free');
    assert.equal(evidence[0]?.evidenceKind, 'model_catalogue');
  });
});
