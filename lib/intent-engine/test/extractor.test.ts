import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmProvider, LlmRequest, LlmResponse } from '@mioagent/llm';
import { parseSwapIntentExtractionV2, resolveSwapIntentWithLlmV2 } from '../src/index.js';
import { TEST_TENANT, TEST_TIME, TEST_WALLET, swapExtraction, testContext } from './fixtures.js';

class StrictLlmDouble implements LlmProvider {
  request?: LlmRequest;

  constructor(private readonly content: string) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.request = request;
    return { message: { role: 'assistant', content: this.content } };
  }
}

test('strict extractor accepts only the exact JSON object shape', () => {
  const valid = swapExtraction();
  assert.deepEqual(parseSwapIntentExtractionV2(JSON.stringify(valid)), valid);
  assert.equal(parseSwapIntentExtractionV2(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``), null);
  assert.equal(parseSwapIntentExtractionV2('{broken'), null);
  assert.equal(parseSwapIntentExtractionV2(JSON.stringify({ ...valid, execute: true })), null);
  assert.equal(parseSwapIntentExtractionV2(JSON.stringify({ ...valid, chainId: -1 })), null);
});

test('LLM wrapper uses temperature zero, no tools, and strict parse before resolution', async () => {
  const llm = new StrictLlmDouble(JSON.stringify(swapExtraction()));
  const result = await resolveSwapIntentWithLlmV2({
    llm,
    message: 'Swap 100 USDC to ETH.',
    context: testContext(),
  });
  assert.equal(result.outcome, 'ready');
  assert.equal(llm.request?.temperature, 0);
  assert.equal(llm.request?.tools, undefined);
  assert.match(llm.request?.messages[1]?.content ?? '', /<untrusted_conversation>/);
});

test('unknown output keys and malformed LLM JSON fail closed', async () => {
  for (const content of [JSON.stringify({ ...swapExtraction(), broadcast: true }), 'not-json']) {
    const result = await resolveSwapIntentWithLlmV2({
      llm: new StrictLlmDouble(content),
      message: 'Swap 100 USDC to ETH.',
      context: testContext(),
    });
    assert.equal(result.outcome, 'rejected');
    assert.deepEqual(
      result.issues.map((item) => item.code),
      ['extractor_invalid'],
    );
  }
});

test('the extractor is told WHICH fields a stored goal is missing, never their values', async () => {
  // Production found this: a bare "ETH" answering "which token should be
  // received?" reached the extractor with no context at all, came back as an
  // ambiguous goal, and ended a continuation the resolver could have finished.
  const llm = new StrictLlmDouble(
    JSON.stringify({ goal: 'swap', amount: null, fromAsset: null, toAsset: 'ETH', chainId: 8453 }),
  );
  const pending = {
    schemaVersion: 'pending-swap-intent/v2' as const,
    tenantId: TEST_TENANT,
    walletAddress: TEST_WALLET,
    chainId: 8453 as const,
    sourceRequestId: 'first-turn',
    createdAt: TEST_TIME,
    expiresAt: new Date(Date.parse(TEST_TIME) + 600_000).toISOString(),
    amountDecimal: '100',
    fromAssetSymbol: 'USDC' as const,
    toAssetSymbol: null,
    optimizationMode: null,
    verificationDepth: null,
    protocolConstraint: null,
    slippageMaxBps: 100,
    executionRequested: true,
  };
  const result = await resolveSwapIntentWithLlmV2({
    llm,
    message: 'ETH',
    context: testContext({
      requestId: 'second-turn',
      requestedAt: '2026-07-15T12:01:00.000Z',
      pendingIntents: [pending],
    }),
  });
  const prompt = llm.request?.messages[1]?.content ?? '';
  assert.match(prompt, /<awaiting_fields>toAsset<\/awaiting_fields>/);
  // Names only. The amount and the source asset are in the stored goal and must
  // not reach a prompt that is forbidden from copying financial fields.
  assert.equal(prompt.includes('100'), false);
  assert.equal(prompt.includes('USDC'), false);
  assert.equal(result.outcome, 'ready', JSON.stringify(result));
});

test('with nothing pending the prompt carries no awaiting_fields block at all', async () => {
  const llm = new StrictLlmDouble(JSON.stringify(swapExtraction()));
  await resolveSwapIntentWithLlmV2({
    llm,
    message: 'Swap 100 USDC to ETH.',
    context: testContext(),
  });
  assert.equal((llm.request?.messages[1]?.content ?? '').includes('awaiting_fields'), false);
});

class SequenceLlmDouble implements LlmProvider {
  calls = 0;

  constructor(private readonly replies: string[]) {}

  async generate(): Promise<LlmResponse> {
    const content = this.replies[this.calls] ?? '';
    this.calls += 1;
    return { message: { role: 'assistant', content } };
  }
}

test('a single malformed answer is retried, because it kills the goal outright', () => {
  // Measured: the same request twelve times through qwen/qwen3.7-flash gave
  // eleven clean extractions and one the strict parser refused — and a refusal
  // is `extractor_invalid`, a REJECTION. One goal in twelve was dying on a
  // formatting slip.
  const llm = new SequenceLlmDouble([
    `\`\`\`json\n${JSON.stringify(swapExtraction())}\n\`\`\``,
    JSON.stringify(swapExtraction()),
  ]);
  return resolveSwapIntentWithLlmV2({
    llm,
    message: 'Swap 100 USDC to ETH.',
    context: testContext(),
  }).then((result) => {
    assert.equal(result.outcome, 'ready', JSON.stringify(result));
    assert.equal(llm.calls, 2);
  });
});

test('two malformed answers still fail closed, and stop at two', async () => {
  // A second wrong answer is a disagreement about the request, not a slip.
  const llm = new SequenceLlmDouble(['not-json', 'still not json', JSON.stringify(swapExtraction())]);
  const result = await resolveSwapIntentWithLlmV2({
    llm,
    message: 'Swap 100 USDC to ETH.',
    context: testContext(),
  });
  assert.equal(result.outcome, 'rejected');
  assert.ok(result.issues.some((item) => item.code === 'extractor_invalid'));
  assert.equal(llm.calls, 2);
});

test('a well-formed answer is never asked twice', async () => {
  const llm = new SequenceLlmDouble([JSON.stringify(swapExtraction())]);
  const result = await resolveSwapIntentWithLlmV2({
    llm,
    message: 'Swap 100 USDC to ETH.',
    context: testContext(),
  });
  assert.equal(result.outcome, 'ready');
  assert.equal(llm.calls, 1);
});
