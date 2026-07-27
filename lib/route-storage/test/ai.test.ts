import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  AiInferenceProofV1Schema,
  AiPromptCommitmentV1Schema,
  AiRouteCardV1Schema,
  AiRouteIntentV1Schema,
  AI_RECOMMENDATION_COPY_V1,
  AI_SCORE_DIMENSIONS_V1,
  AI_SELECTION_POLICY_COPY_V1,
  canonicalJsonV1,
  commitAiPromptV1,
  hashAiInferenceProofV1,
  hashAiRouteCardV1,
  hashAiRouteCandidateV1,
  hashAiRouteIntentV1,
  hashAiScoreDimensionV1,
  type AiInferenceProofV1,
  type AiRouteCandidateV1,
  type AiRouteCardV1,
  type AiRouteIntentV1,
  type AiScoreDimensionV1,
} from '@mioagent/route-domain';
import {
  RouteStorageConflictError,
  aiIdempotencyKeyV1,
  createMemoryAiRouteStorageRepository,
} from '../src/index.js';

const WALLET = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const TENANT = 'eip155:8453:0x1111111111111111111111111111111111111111';
const NONCE = 'n'.repeat(64);
const SECRET = 'The board vote is 5-2 against.';
const NOW = '2026-07-27T10:00:00.000Z';

function intent(overrides: Partial<AiRouteIntentV1> = {}): AiRouteIntentV1 {
  const base = {
    schemaVersion: 'ai-route-intent/v1' as const,
    id: 'run-1:intent',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453 as const,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'ready' as const,
    intentHash: `0x${'0'.repeat(64)}`,
    goal: 'private_ai' as const,
    taskKind: 'general_reasoning' as const,
    prompt: AiPromptCommitmentV1Schema.parse({
      schemaVersion: 'ai-prompt-commitment/v1',
      commitment: commitAiPromptV1({
        nonce: NONCE,
        systemText: null,
        messages: [{ role: 'user', text: SECRET }],
      }),
      charCount: SECRET.length,
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

function candidate(intentHash: string, modelId = 'llama-3.3-70b'): AiRouteCandidateV1 {
  const base = {
    schemaVersion: 'ai-route-candidate/v1' as const,
    id: `run-1:candidate:${modelId}`,
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453 as const,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'selected' as const,
    candidateHash: `0x${'0'.repeat(64)}`,
    intentHash,
    provider: { id: 'venice', displayName: 'Venice', kind: 'data_provider' as const, operator: 'Venice AI' },
    modelId,
    modelName: 'Llama 3.3 70B',
    modelVersion: null,
    privacyMode: 'private' as const,
    capabilities: {
      supportsToolCalling: true,
      supportsResponseSchema: true,
      supportsReasoning: true,
      supportsWebSearch: true,
      supportsVision: false,
      optimizedForCode: false,
      quantization: null,
    },
    pricing: { inputUsdPerMillion: '0.7', outputUsdPerMillion: '2.8' },
    contextTokens: 65_536,
    maxCompletionTokens: 8_192,
    offline: false,
    estimatedCostUsd: '0.001',
    ineligibleReason: null,
    observedAt: NOW,
  } as AiRouteCandidateV1;
  return { ...base, candidateHash: hashAiRouteCandidateV1(base) };
}

function dimensions(intentHash: string, candidateHash: string): AiScoreDimensionV1[] {
  return AI_SCORE_DIMENSIONS_V1.map((dimension) => {
    const base = {
      schemaVersion: 'ai-score-dimension/v1' as const,
      id: `run-1:dimension:${dimension}`,
      tenantId: TENANT,
      walletAddress: WALLET,
      chainId: 8453 as const,
      createdAt: NOW,
      updatedAt: NOW,
      status: 'not_scored' as const,
      dimensionHash: `0x${'0'.repeat(64)}`,
      intentHash,
      candidateHash,
      dimension,
      score: null,
      notScoredReason: 'insufficient_evidence' as const,
      confidence: null,
      sources: [],
      freshness: null,
      scoringVersion: 'ai-scoring/v1',
      missingEvidence: [],
    } as unknown as AiScoreDimensionV1;
    return { ...base, dimensionHash: hashAiScoreDimensionV1(base) };
  });
}

function card(value: AiRouteIntentV1, overrides: Partial<AiRouteCardV1> = {}): AiRouteCardV1 {
  const selected = candidate(value.intentHash);
  const base = {
    schemaVersion: 'ai-route-card/v1' as const,
    id: 'run-1:card',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453 as const,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'ready' as const,
    routeCardHash: `0x${'0'.repeat(64)}`,
    intentHash: value.intentHash,
    recommendation: AI_RECOMMENDATION_COPY_V1,
    selectionPolicy: AI_SELECTION_POLICY_COPY_V1,
    taskKind: value.taskKind,
    selected,
    alternatives: [],
    dimensions: dimensions(value.intentHash, selected.candidateHash),
    evidenceHashes: [],
    evidenceGaps: [],
    dataSentSummary: '1 message, 29 characters go to Llama 3.3 70B on Venice.',
    retentionClaim: 'Prompts are not stored.',
    unsupportedCapabilities: [],
    maxSpendUsd: '0.05',
    estimatedCostUsd: '0.001',
    x402Metered: false,
    failureReason: null,
    expiresAt: '2026-07-27T10:02:00.000Z',
    ...overrides,
  } as AiRouteCardV1;
  return AiRouteCardV1Schema.parse({ ...base, routeCardHash: hashAiRouteCardV1(base) });
}

function proof(
  value: AiRouteIntentV1,
  built: AiRouteCardV1,
  overrides: Partial<AiInferenceProofV1> = {},
): AiInferenceProofV1 {
  const base = {
    schemaVersion: 'ai-inference-proof/v1' as const,
    id: 'run-1:proof',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453 as const,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'finalized' as const,
    proofHash: `0x${'0'.repeat(64)}`,
    intentHash: value.intentHash,
    routeCardHash: built.routeCardHash,
    candidateHash: built.selected?.candidateHash ?? `0x${'0'.repeat(64)}`,
    promptCommitment: value.prompt.commitment,
    provider: { id: 'venice', displayName: 'Venice', kind: 'data_provider' as const, operator: 'Venice AI' },
    modelId: 'llama-3.3-70b',
    modelVersion: null,
    privacyMode: 'private' as const,
    responseHash: `0x${'3'.repeat(64)}`,
    responseChars: 5,
    finishReason: 'stop' as const,
    schemaValidation: 'not_requested' as const,
    usage: {
      promptTokens: 12,
      completionTokens: 2,
      totalTokens: 14,
      actualCostUsd: '0.000014',
      latencyMs: 700,
    },
    x402Metered: false,
    estimatedCostUsd: '0.001',
    finalStatus: 'completed' as const,
    failureReason: null,
    observedAt: NOW,
    finalizedAt: NOW,
    ...overrides,
  } as AiInferenceProofV1;
  return AiInferenceProofV1Schema.parse({ ...base, proofHash: hashAiInferenceProofV1(base) });
}

async function seeded() {
  const repository = createMemoryAiRouteStorageRepository(() => new Date(NOW));
  const value = intent();
  const built = card(value);
  const run = await repository.createAiRouteRun(value, aiIdempotencyKeyV1({
    tenantId: TENANT,
    walletAddress: WALLET,
    requestId: 'req-1',
    promptCommitment: value.prompt.commitment,
  }));
  await repository.insertAiRouteCard({
    id: 'run-1:card',
    routeRunId: run.id,
    userId: TENANT,
    walletAddress: WALLET,
    intent: value,
    card: built,
  });
  return { repository, intent: value, card: built, run };
}

describe('nothing stored can hold the prompt', () => {
  test('the serialized run, card and proof contain no prompt text', async () => {
    const { repository, intent: value, card: built } = await seeded();
    const record = await repository.insertAiProof({
      id: 'run-1:proof',
      routeRunId: 'run-1:intent',
      routeCardId: 'run-1:card',
      userId: TENANT,
      walletAddress: WALLET,
      proof: proof(value, built),
    });
    const stored = await repository.getAiRouteCard('run-1:intent', TENANT);
    const serialized = canonicalJsonV1({ stored, record });
    assert.ok(!serialized.includes(SECRET));
    assert.ok(!serialized.includes('board vote'));
    assert.ok(!serialized.includes(NONCE), 'the nonce is never persisted');
  });
});

describe('one card per run, one proof per card', () => {
  test('a second card for the same run is a conflict', async () => {
    const { repository, intent: value, card: built } = await seeded();
    await assert.rejects(
      repository.insertAiRouteCard({
        id: 'run-1:card-again',
        routeRunId: 'run-1:intent',
        userId: TENANT,
        walletAddress: WALLET,
        intent: value,
        card: built,
      }),
      RouteStorageConflictError,
    );
  });

  test('re-submitting the SAME answer is idempotent', async () => {
    const { repository, intent: value, card: built } = await seeded();
    const input = {
      id: 'run-1:proof',
      routeRunId: 'run-1:intent',
      routeCardId: 'run-1:card',
      userId: TENANT,
      walletAddress: WALLET,
      proof: proof(value, built),
    };
    const first = await repository.insertAiProof(input);
    const second = await repository.insertAiProof(input);
    assert.equal(first.id, second.id);
    assert.equal(first.proof.proofHash, second.proof.proofHash);
  });

  test('a DIFFERENT answer for the same card is a conflict, not a second charge', async () => {
    const { repository, intent: value, card: built } = await seeded();
    await repository.insertAiProof({
      id: 'run-1:proof',
      routeRunId: 'run-1:intent',
      routeCardId: 'run-1:card',
      userId: TENANT,
      walletAddress: WALLET,
      proof: proof(value, built),
    });
    await assert.rejects(
      repository.insertAiProof({
        id: 'run-1:proof-2',
        routeRunId: 'run-1:intent',
        routeCardId: 'run-1:card',
        userId: TENANT,
        walletAddress: WALLET,
        proof: proof(value, built, { responseChars: 99, usage: {
          promptTokens: 12, completionTokens: 40, totalTokens: 52, actualCostUsd: '0.0002', latencyMs: 900,
        } }),
      }),
      RouteStorageConflictError,
    );
  });
});

describe('the fake refuses exactly what the migration refuses', () => {
  test('a card naming a run that does not exist is refused (the foreign key)', async () => {
    const repository = createMemoryAiRouteStorageRepository(() => new Date(NOW));
    const value = intent();
    await assert.rejects(
      repository.insertAiRouteCard({
        id: 'run-1:card',
        routeRunId: 'never-created',
        userId: TENANT,
        walletAddress: WALLET,
        intent: value,
        card: card(value),
      }),
      RouteStorageConflictError,
    );
  });

  test('a proof naming a card that does not exist is refused (the foreign key)', async () => {
    const { repository, intent: value, card: built } = await seeded();
    await assert.rejects(
      repository.insertAiProof({
        id: 'run-1:proof',
        routeRunId: 'run-1:intent',
        routeCardId: 'never-stored',
        userId: TENANT,
        walletAddress: WALLET,
        proof: proof(value, built),
      }),
      RouteStorageConflictError,
    );
  });

  test('a proof for a different card is refused', async () => {
    const { repository, intent: value, card: built } = await seeded();
    const other = card(value, { expiresAt: '2026-07-27T10:05:00.000Z' });
    await assert.rejects(
      repository.insertAiProof({
        id: 'run-1:proof',
        routeRunId: 'run-1:intent',
        routeCardId: 'run-1:card',
        userId: TENANT,
        walletAddress: WALLET,
        proof: proof(value, other),
      }),
      RouteStorageConflictError,
    );
  });

  test('a proof committing to a different prompt is refused', async () => {
    const { repository, intent: value, card: built } = await seeded();
    await assert.rejects(
      repository.insertAiProof({
        id: 'run-1:proof',
        routeRunId: 'run-1:intent',
        routeCardId: 'run-1:card',
        userId: TENANT,
        walletAddress: WALLET,
        proof: proof(value, built, { promptCommitment: `0x${'9'.repeat(64)}` }),
      }),
      RouteStorageConflictError,
    );
  });

  test('a card built for a different intent is refused', async () => {
    const repository = createMemoryAiRouteStorageRepository(() => new Date(NOW));
    const value = intent();
    const other = intent({ maxCompletionTokens: 256 });
    const run = await repository.createAiRouteRun(value, 'key-1');
    await assert.rejects(
      repository.insertAiRouteCard({
        id: 'run-1:card',
        routeRunId: run.id,
        userId: TENANT,
        walletAddress: WALLET,
        intent: value,
        card: card(other),
      }),
      RouteStorageConflictError,
    );
  });

  test('another tenant’s run reads as absent, never as forbidden data', async () => {
    const { repository } = await seeded();
    assert.equal(await repository.getAiRouteCard('run-1:intent', 'eip155:8453:0xdead'), null);
  });
});

describe('idempotency', () => {
  test('the key is built from the commitment, so two identical prompts stay separate runs', () => {
    const first = aiIdempotencyKeyV1({
      tenantId: TENANT,
      walletAddress: WALLET,
      requestId: 'req-1',
      promptCommitment: `0x${'a'.repeat(64)}`,
    });
    const second = aiIdempotencyKeyV1({
      tenantId: TENANT,
      walletAddress: WALLET,
      requestId: 'req-1',
      promptCommitment: `0x${'b'.repeat(64)}`,
    });
    assert.notEqual(first, second);
    assert.ok(!first.includes(SECRET));
  });

  test('replaying the same key returns the same run', async () => {
    const repository = createMemoryAiRouteStorageRepository(() => new Date(NOW));
    const value = intent();
    const first = await repository.createAiRouteRun(value, 'key-1');
    const second = await repository.createAiRouteRun(value, 'key-1');
    assert.equal(first.id, second.id);
  });

  test('the same key with different content is a conflict', async () => {
    const repository = createMemoryAiRouteStorageRepository(() => new Date(NOW));
    await repository.createAiRouteRun(intent(), 'key-1');
    await assert.rejects(
      repository.createAiRouteRun(intent({ maxCompletionTokens: 256 }), 'key-1'),
      RouteStorageConflictError,
    );
  });
});
