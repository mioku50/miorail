import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FallbackLlmProvider,
  LlmChainExhaustedError,
  LlmProviderChainV1,
  NON_FAILOVER_STATUSES_V1,
  shouldFallOverV1,
  type NamedLlmProviderV1,
} from './fallback.js';
import { LlmHttpError } from './openai.js';
import type { LlmProvider, LlmRequest, LlmResponse } from './types.js';

function answering(content: string): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      return { message: { role: 'assistant', content } };
    },
  };
}

function failing(error: unknown): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      throw error;
    },
  };
}

const REQUEST: LlmRequest = { messages: [{ role: 'user', content: 'hello' }] };

test('a healthy primary is never charged twice — the fallback is not called', async () => {
  const primary = answering('from primary');
  const fallback = answering('from fallback');
  const chain = new FallbackLlmProvider(
    { label: 'primary.example', provider: primary },
    { label: 'fallback.example', provider: fallback },
  );

  const response = await chain.generate(REQUEST);
  assert.equal(response.message.content, 'from primary');
  assert.equal(fallback.calls.length, 0);
});

test('an exhausted quota falls over — this is the case the chain exists for', async () => {
  // The reported failure: a free tier ran out of credits a week earlier and
  // every route comparison had been answering 500 since.
  for (const status of [401, 402, 429, 500, 503]) {
    const fallback = answering('from fallback');
    const chain = new FallbackLlmProvider(
      { label: 'primary.example', provider: failing(new LlmHttpError(status, 'out of credits')) },
      { label: 'fallback.example', provider: fallback },
    );
    const response = await chain.generate(REQUEST);
    assert.equal(response.message.content, 'from fallback', `status ${status} must fall over`);
  }
});

test('a timeout or dropped socket falls over', async () => {
  const fallback = answering('from fallback');
  const chain = new FallbackLlmProvider(
    { label: 'primary.example', provider: failing(new Error('fetch failed')) },
    { label: 'fallback.example', provider: fallback },
  );
  assert.equal((await chain.generate(REQUEST)).message.content, 'from fallback');
});

test('a malformed request is NOT retried against the fallback', async () => {
  // Falling over here would spend a second quota, double the latency the user
  // waits, and then report the fallback's error for a defect in the caller.
  for (const status of NON_FAILOVER_STATUSES_V1) {
    const fallback = answering('from fallback');
    const chain = new FallbackLlmProvider(
      { label: 'primary.example', provider: failing(new LlmHttpError(status, 'bad request')) },
      { label: 'fallback.example', provider: fallback },
    );
    await assert.rejects(() => chain.generate(REQUEST), new RegExp(`OpenAI API error \\(${status}\\)`));
    assert.equal(fallback.calls.length, 0, `status ${status} must not reach the fallback`);
  }
});

test('when both fail the error names both, not just the last one', async () => {
  const chain = new FallbackLlmProvider(
    { label: 'primary.example', provider: failing(new LlmHttpError(402, 'insufficient credits')) },
    { label: 'fallback.example', provider: failing(new LlmHttpError(429, 'rate limited')) },
  );

  await assert.rejects(
    () => chain.generate(REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof LlmChainExhaustedError);
      // Without the primary's name in here, an operator investigates the
      // fallback for an outage that started at the primary.
      assert.match(error.message, /primary\.example.*insufficient credits/);
      assert.match(error.message, /fallback\.example.*rate limited/);
      assert.ok(error.primaryError instanceof LlmHttpError);
      assert.ok(error.fallbackError instanceof LlmHttpError);
      return true;
    },
  );
});

test('the fallover is announced with hosts and a reason', async () => {
  const events: Array<{ from: string; to: string; reason: string }> = [];
  const chain = new FallbackLlmProvider(
    { label: 'primary.example', provider: failing(new LlmHttpError(402, 'insufficient credits')) },
    { label: 'fallback.example', provider: answering('ok') },
    { onFallover: (event) => events.push(event) },
  );

  await chain.generate(REQUEST);
  assert.deepEqual(events.map((event) => [event.from, event.to]), [['primary.example', 'fallback.example']]);
  assert.match(events[0]!.reason, /insufficient credits/);
});

test('the fallback receives the request unchanged', async () => {
  const fallback = answering('ok');
  const chain = new FallbackLlmProvider(
    { label: 'primary.example', provider: failing(new LlmHttpError(500, 'down')) },
    { label: 'fallback.example', provider: fallback },
  );
  const request: LlmRequest = {
    messages: [{ role: 'user', content: 'compare routes' }],
    temperature: 0,
    tools: [{ type: 'function', function: { name: 'quote', description: 'q', parameters: {} } }],
  };
  await chain.generate(request);
  assert.deepEqual(fallback.calls[0], request);
});

test('shouldFallOverV1 treats a non-HTTP failure as the provider\'s fault', () => {
  assert.equal(shouldFallOverV1(new Error('ECONNRESET')), true);
  assert.equal(shouldFallOverV1(new LlmHttpError(404, 'no such model')), true);
  assert.equal(shouldFallOverV1(new LlmHttpError(400, 'bad')), false);
});

test('a three-link chain tries each in order and stops at the first that answers', async () => {
  const tried: string[] = [];
  const failing = (label: string): NamedLlmProviderV1 => ({
    label,
    provider: {
      generate: async () => {
        tried.push(label);
        throw new LlmHttpError(429, 'rate limited');
      },
    },
  });
  const answering: NamedLlmProviderV1 = {
    label: 'third',
    provider: {
      generate: async () => {
        tried.push('third');
        return { message: { role: 'assistant', content: 'ok' } };
      },
    },
  };
  const chain = new LlmProviderChainV1([failing('first'), failing('second'), answering]);
  const response = await chain.generate({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(response.message.content, 'ok');
  assert.deepEqual(tried, ['first', 'second', 'third']);
});

test('an exhausted three-link chain names every provider that failed', async () => {
  const failing = (label: string, status: number): NamedLlmProviderV1 => ({
    label,
    provider: {
      generate: async () => {
        throw new LlmHttpError(status, `${label} is unwell`);
      },
    },
  });
  const chain = new LlmProviderChainV1([
    failing('primary.example', 429),
    failing('openrouter.ai', 402),
    failing('agentrouter.org', 401),
  ]);
  await assert.rejects(
    () => chain.generate({ messages: [{ role: 'user', content: 'hi' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmChainExhaustedError);
      assert.equal(error.failures.length, 3);
      // All three, because "agentrouter returned 401" alone sends the operator
      // to investigate the link that was never the primary.
      for (const host of ['primary.example', 'openrouter.ai', 'agentrouter.org']) {
        assert.match(error.message, new RegExp(host));
      }
      return true;
    },
  );
});

test('a malformed request stops the chain at the first link, not the last', async () => {
  // A 400 means the REQUEST is wrong. Trying two more providers would triple
  // the latency, spend two more quotas, and then blame the last one.
  let calls = 0;
  const link = (label: string): NamedLlmProviderV1 => ({
    label,
    provider: {
      generate: async () => {
        calls += 1;
        throw new LlmHttpError(400, 'bad request');
      },
    },
  });
  const chain = new LlmProviderChainV1([link('first'), link('second'), link('third')]);
  await assert.rejects(() => chain.generate({ messages: [] }), /400/);
  assert.equal(calls, 1);
});
