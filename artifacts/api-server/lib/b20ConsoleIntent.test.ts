import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { LlmProvider } from '@mioagent/llm';

import { parseB20SemanticIntentV1, resolveB20ConsolePlanV1 } from './b20ConsoleIntent.js';

function providerV1(content: string, onCall?: () => void): LlmProvider {
  return {
    async generate() {
      onCall?.();
      return { message: { role: 'assistant', content } };
    },
  };
}

describe('the semantic classifier has a closed, data-only output', () => {
  test('parses only the exact two-key shape', () => {
    assert.deepEqual(parseB20SemanticIntentV1('{"intent":"find_two_sided","confidence":0.91}'), {
      intent: 'find_two_sided',
      confidence: 0.91,
    });
    assert.equal(
      parseB20SemanticIntentV1('{"intent":"find_two_sided","confidence":0.91,"tool":"sql"}'),
      null,
    );
  });

  test('rejects unknown intents and invalid confidence', () => {
    assert.equal(parseB20SemanticIntentV1('{"intent":"buy_token","confidence":1}'), null);
    assert.equal(parseB20SemanticIntentV1('{"intent":"find_two_sided","confidence":2}'), null);
    assert.equal(parseB20SemanticIntentV1('{"intent":"find_two_sided","confidence":80}'), null);
  });
});

describe('free language is mapped back through the bounded TypeScript planner', () => {
  test('an unfamiliar English paraphrase reaches bought-not-sellable', async () => {
    const resolved = await resolveB20ConsolePlanV1({
      question: 'Surface assets where acquisition worked but disposal could not be established',
      scope: 'explore',
      provider: providerV1('{"intent":"find_bought_not_sellable","confidence":0.94}'),
    });
    assert.equal(resolved.source, 'semantic_classifier');
    assert.equal(resolved.plan.intent, 'find_bought_not_sellable');
    assert.deepEqual(resolved.plan.steps.map((step) => step.tool), ['summary', 'list']);
  });

  test('an unfamiliar Russian paraphrase reaches missing evidence', async () => {
    const resolved = await resolveB20ConsolePlanV1({
      question: 'Где вывод пока слабее из-за того, чего Миорейл ещё не смог установить?',
      scope: 'explore',
      provider: providerV1('{"intent":"find_needs_evidence","confidence":0.88}'),
    });
    assert.equal(resolved.plan.intent, 'find_needs_evidence');
    assert.deepEqual(resolved.plan.steps.map((step) => step.tool), ['summary', 'list']);
  });

  test('classifier failure is explicit and reads nothing, never universe counts', async () => {
    const resolved = await resolveB20ConsolePlanV1({
      question: 'Tell me the thing I have in mind',
      scope: 'explore',
      provider: providerV1('not json'),
    });
    assert.equal(resolved.source, 'explicit_fallback');
    assert.equal(resolved.plan.intent, 'unsupported');
    assert.deepEqual(resolved.plan.steps, []);
    assert.match(resolved.plan.refusal ?? '', /without guessing/);
  });

  test('an address never goes to a model', async () => {
    let calls = 0;
    const address = '0xb20000000000000000000047f57bc93d7f130101';
    const resolved = await resolveB20ConsolePlanV1({
      question: `Could you take a proper look at ${address}?`,
      scope: 'explore',
      provider: providerV1('{"intent":"unsupported","confidence":1}', () => calls += 1),
    });
    assert.equal(calls, 0);
    assert.equal(resolved.plan.intent, 'compare_tokens');
    assert.equal(resolved.plan.steps[0]?.tool, 'cards');
  });

  test('known phrases and safety refusals do not pay for classification', async () => {
    let calls = 0;
    const provider = providerV1('{"intent":"universe_counts","confidence":1}', () => calls += 1);
    const known = await resolveB20ConsolePlanV1({
      question: 'Which B20 tokens were bought but a sale could not be priced?',
      scope: 'explore',
      provider,
    });
    const refused = await resolveB20ConsolePlanV1({
      question: 'Which token will moon?',
      scope: 'explore',
      provider,
    });
    const unsupportedEvidenceClaim = await resolveB20ConsolePlanV1({
      question: 'Which B20 projects have no product?',
      scope: 'investigate',
      provider,
    });
    assert.equal(calls, 0);
    assert.equal(known.plan.intent, 'find_bought_not_sellable');
    assert.equal(refused.plan.intent, 'unsupported');
    assert.match(unsupportedEvidenceClaim.plan.refusal ?? '', /cannot answer which projects lack/);
  });
});
