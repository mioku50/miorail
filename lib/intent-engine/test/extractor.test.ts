import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmProvider, LlmRequest, LlmResponse } from '@mioagent/llm';
import { parseSwapIntentExtractionV2, resolveSwapIntentWithLlmV2 } from '../src/index.js';
import { swapExtraction, testContext } from './fixtures.js';

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
