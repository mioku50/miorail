import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  AiPromptCommitmentV1Schema,
  AiRouteCandidateV1Schema,
  AiRouteIntentV1Schema,
  aiDataSentSummaryV1,
  aiUnsupportedCapabilitiesV1,
  canonicalJsonV1,
  commitAiPromptV1,
  compareUsdV1,
  estimateAiCostUsdV1,
  hashAiRouteCandidateV1,
  hashAiRouteIntentV1,
  type AiPromptCommitmentV1,
  type AiRouteCandidateV1,
  type AiRouteIntentV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T66A — the four rules the Private AI contracts exist to hold.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const NONCE = 'a'.repeat(64);

function commitment(overrides: Partial<AiPromptCommitmentV1> = {}): AiPromptCommitmentV1 {
  return AiPromptCommitmentV1Schema.parse({
    schemaVersion: 'ai-prompt-commitment/v1',
    commitment: commitAiPromptV1({
      nonce: NONCE,
      systemText: null,
      messages: [{ role: 'user', text: 'Summarise this contract clause.' }],
    }),
    charCount: 31,
    messageCount: 1,
    hasSystemMessage: false,
    estimatedPromptTokens: 8,
    ...overrides,
  });
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
    taskKind: 'summarization' as const,
    prompt: commitment(),
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

function candidate(overrides: Partial<AiRouteCandidateV1> = {}): AiRouteCandidateV1 {
  const base = {
    schemaVersion: 'ai-route-candidate/v1' as const,
    id: 'run-1:candidate:llama',
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    chainId: 8453 as const,
    createdAt: '2026-07-27T10:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    status: 'quoted' as const,
    candidateHash: `0x${'0'.repeat(64)}`,
    intentHash: intent().intentHash,
    provider: { id: 'venice', displayName: 'Venice', kind: 'data_provider' as const, operator: 'Venice AI' },
    modelId: 'llama-3.3-70b',
    modelName: 'Llama 3.3 70B',
    modelVersion: null,
    privacyMode: 'private' as const,
    capabilities: {
      supportsToolCalling: true,
      supportsResponseSchema: true,
      supportsReasoning: false,
      supportsWebSearch: null,
      supportsVision: false,
      optimizedForCode: false,
      quantization: 'fp8',
    },
    pricing: { inputUsdPerMillion: '0.7', outputUsdPerMillion: '2.8' },
    contextTokens: 65_536,
    maxCompletionTokens: 8_192,
    offline: false,
    estimatedCostUsd: '0.001',
    ineligibleReason: null,
    observedAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  } as AiRouteCandidateV1;
  return AiRouteCandidateV1Schema.parse({ ...base, candidateHash: hashAiRouteCandidateV1(base) });
}

describe('rule 1 — the prompt is never in a contract', () => {
  test('no field of an intent can hold prompt text', () => {
    const value = intent();
    const serialized = canonicalJsonV1(value);
    assert.ok(!serialized.includes('Summarise this contract clause'));
    // And the schema refuses to carry one if a caller tries.
    assert.throws(() =>
      AiRouteIntentV1Schema.parse({ ...value, promptText: 'Summarise this contract clause.' }),
    );
  });

  test('a commitment is not openable without the nonce', () => {
    const secret = 'fire the CFO on Monday';
    const nonceA = randomBytes(32).toString('hex');
    const nonceB = randomBytes(32).toString('hex');
    const withA = commitAiPromptV1({ nonce: nonceA, systemText: null, messages: [{ role: 'user', text: secret }] });
    const withB = commitAiPromptV1({ nonce: nonceB, systemText: null, messages: [{ role: 'user', text: secret }] });
    // The same prompt under two nonces gives two commitments, so an attacker
    // holding only a stored commitment cannot confirm a guessed prompt.
    assert.notEqual(withA, withB);
    // And the holder of the nonce CAN reproduce it exactly.
    assert.equal(
      withA,
      commitAiPromptV1({ nonce: nonceA, systemText: null, messages: [{ role: 'user', text: secret }] }),
    );
  });

  test('a short nonce is refused rather than silently accepted', () => {
    assert.throws(
      () => commitAiPromptV1({ nonce: 'tooshort', systemText: null, messages: [{ role: 'user', text: 'x' }] }),
      /at least 32/,
    );
  });

  test('changing one message changes the commitment', () => {
    const one = commitAiPromptV1({ nonce: NONCE, systemText: null, messages: [{ role: 'user', text: 'a' }] });
    const two = commitAiPromptV1({ nonce: NONCE, systemText: null, messages: [{ role: 'user', text: 'b' }] });
    const withSystem = commitAiPromptV1({ nonce: NONCE, systemText: 's', messages: [{ role: 'user', text: 'a' }] });
    assert.notEqual(one, two);
    assert.notEqual(one, withSystem);
  });

  test('the data-sent summary describes the prompt without quoting it', () => {
    const summary = aiDataSentSummaryV1({
      prompt: commitment({ charCount: 31, messageCount: 1, hasSystemMessage: true }),
      modelName: 'Llama 3.3 70B',
      webSearch: false,
    });
    assert.ok(summary.includes('31 characters'));
    assert.ok(summary.includes('a system instruction'));
    assert.ok(summary.includes('Llama 3.3 70B'));
    assert.ok(!summary.includes('Summarise'));
    assert.ok(summary.includes('no wallet address'));
  });

  test('the summary says so when web search widens the audience', () => {
    const summary = aiDataSentSummaryV1({ prompt: commitment(), modelName: 'M', webSearch: true });
    assert.ok(summary.includes('search provider'));
    assert.ok(!summary.includes('Nothing else is attached'));
  });
});

describe('rule 2 — an estimate is never a receipt', () => {
  test('cost is exact at fractions of a cent', () => {
    const cost = estimateAiCostUsdV1({
      pricing: { inputUsdPerMillion: '0.7', outputUsdPerMillion: '2.8' },
      promptTokens: 1_000,
      completionTokens: 500,
    });
    // 0.7 * 1000/1e6 + 2.8 * 500/1e6 = 0.0007 + 0.0014
    assert.equal(cost, '0.0021');
  });

  test('a sub-cent rate does not round away', () => {
    const cost = estimateAiCostUsdV1({
      pricing: { inputUsdPerMillion: '0.0000001', outputUsdPerMillion: '0' },
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    assert.equal(cost, '0.0000001');
  });

  test('a zero-token request costs zero, not a rounding artefact', () => {
    assert.equal(
      estimateAiCostUsdV1({
        pricing: { inputUsdPerMillion: '15', outputUsdPerMillion: '60' },
        promptTokens: 0,
        completionTokens: 0,
      }),
      '0',
    );
  });

  test('USD comparison never goes through Number', () => {
    assert.equal(compareUsdV1('0.1', '0.10'), 0);
    assert.equal(compareUsdV1('0.0000001', '0.0000002'), -1);
    assert.equal(compareUsdV1('2', '1.999999999999'), 1);
  });
});

describe('rule 3 — an unreported capability is not a denied one', () => {
  test('null and false produce different words', () => {
    const words = aiUnsupportedCapabilitiesV1({
      supportsToolCalling: false,
      supportsResponseSchema: null,
      supportsReasoning: true,
      supportsWebSearch: null,
      supportsVision: false,
      optimizedForCode: true,
      quantization: 'fp8',
    });
    assert.ok(words.includes('no tool calling'));
    assert.ok(words.includes('structured output not stated'));
    assert.ok(words.includes('web search not stated'));
    assert.ok(words.includes('no image input'));
    assert.ok(words.includes('quantized: fp8'));
    // A capability the model HAS is not listed as a limitation.
    assert.ok(!words.some((word) => word.includes('reasoning')));
  });
});

describe('the contracts refuse states that would mislead', () => {
  test('a ready intent needs an explicit spend ceiling', () => {
    assert.throws(() => intent({ maxSpendUsd: null }), /spend ceiling/);
    // A draft may still be missing one — that is what draft means.
    assert.doesNotThrow(() => intent({ status: 'draft', maxSpendUsd: null }));
  });

  test('structured extraction cannot ask for a model without schema support', () => {
    assert.throws(
      () => intent({ taskKind: 'structured_extraction', requiresResponseSchema: false }),
      /response-schema/,
    );
  });

  test('an ineligible candidate must say why', () => {
    assert.throws(() => candidate({ status: 'ineligible', ineligibleReason: null }), /state why/);
  });

  test('an eligible candidate must not carry an ineligibility reason', () => {
    assert.throws(() => candidate({ status: 'quoted', ineligibleReason: 'offline' }), /Only an ineligible/);
  });

  test('an offline model cannot be selected', () => {
    assert.throws(() => candidate({ status: 'selected', offline: true }), /offline/);
  });

  test('a model cannot complete more tokens than its context holds', () => {
    assert.throws(() => candidate({ contextTokens: 1_000, maxCompletionTokens: 2_000 }), /context holds/);
  });

  test('a tampered candidate hash is rejected', () => {
    const value = candidate();
    assert.throws(() =>
      AiRouteCandidateV1Schema.parse({ ...value, estimatedCostUsd: '0.000001' }),
      /candidateHash/,
    );
  });

  test('lifecycle fields stay out of the content hash', () => {
    const value = candidate();
    const relabelled = { ...value, id: 'a-different-id', updatedAt: '2026-07-27T23:00:00.000Z' };
    assert.equal(hashAiRouteCandidateV1(relabelled), value.candidateHash);
  });
});
