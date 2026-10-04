import test from 'node:test';
import assert from 'node:assert';

import { LlmHttpError, LlmTimeoutError, OpenAiCompatibleClient } from './openai.js';

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (body: unknown) =>
  new OpenAiCompatibleClient({
    baseUrl: 'https://gateway.example',
    apiKey: 'k'.repeat(24),
    defaultModel: 'deepseek-v4-flash',
    fetchImpl: async () => respond(body),
  });

test('a reasoning model that ran out of budget is a failure, not an empty reply', async (t) => {
  await t.test('empty content beside reasoning refuses', async () => {
    // Measured against deepseek-v4-flash on 2026-08-25: at max_tokens 300 the
    // content came back empty with 1,222 characters of reasoning and
    // finish_reason "length". Returning '' would hand the caller a silent
    // non-answer that the verifier then rejects as a bad narration.
    await assert.rejects(
      client({
        choices: [
          {
            finish_reason: 'length',
            message: { role: 'assistant', content: '', reasoning_content: 'thinking'.repeat(20) },
          },
        ],
      }).generate({ messages: [{ role: 'user', content: 'hi' }] }),
      /returned no content after 160 characters of reasoning \(finish_reason: length\)/,
    );
  });

  await t.test('content beside reasoning is a normal answer', async () => {
    const response = await client({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'AAPLc round trip costs 0.10%.', reasoning_content: 'x' },
        },
      ],
    }).generate({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.message.content, 'AAPLc round trip costs 0.10%.');
  });

  await t.test('an empty content with tool calls is the documented shape', async () => {
    const response = await client({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'deciding',
            tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
        },
      ],
    }).generate({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.message.tool_calls?.length, 1);
  });

  await t.test('an empty content with no reasoning is left alone', async () => {
    const response = await client({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
    }).generate({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.message.content, '');
  });
});

test('a request ends when its budget does, and says so', async () => {
  // The fetch only ever ends by its signal, as a stalled upstream does.
  const stalled = new OpenAiCompatibleClient({
    baseUrl: 'https://gateway.example',
    apiKey: 'k'.repeat(24),
    defaultModel: 'deepseek-v4-flash',
    fetchImpl: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }),
  });
  // AbortSignal.timeout does not hold the event loop open; a real request's
  // socket does, and this fake has none.
  const keepAlive = setInterval(() => undefined, 1_000);
  const started = Date.now();
  try {
    await assert.rejects(
      stalled.generate({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 40 }),
      (error: unknown) => error instanceof LlmTimeoutError && error.timeoutMs === 40 && /No answer within 40 ms/.test(error.message),
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - started < 2_000);
});

test('gateway body fields go first, so they cannot replace the request', async () => {
  let sent: Record<string, unknown> = {};
  const routed = new OpenAiCompatibleClient({
    baseUrl: 'https://openrouter.ai/api',
    apiKey: 'k'.repeat(24),
    defaultModel: 'deepseek/deepseek-v4-flash',
    body: { provider: { ignore: ['OpenInference'] }, model: 'someone-else', messages: [] },
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return respond({ provider: 'StreamLake', choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    },
  });
  const response = await routed.generate({ messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(sent.provider, { ignore: ['OpenInference'] });
  assert.equal(sent.model, 'deepseek/deepseek-v4-flash');
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'hi' }]);
  // The upstream OpenRouter names, kept for measurements.
  assert.equal(response.upstream, 'StreamLake');
});

test('a 429 with a zero allowance is told apart from a busy minute', async () => {
  const answering429 = (headers: Record<string, string>) =>
    new OpenAiCompatibleClient({
      baseUrl: 'https://api.mistral.ai',
      apiKey: 'k'.repeat(24),
      defaultModel: 'mistral-small-2603',
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: 'Rate limit exceeded', code: '1300' }), { status: 429, headers }),
    });
  // Mistral's answer to a valid key from 2026-09-29.
  await assert.rejects(
    answering429({ 'x-ratelimit-limit-req-minute': '0', 'x-ratelimit-remaining-req-minute': '0' }).generate({
      messages: [{ role: 'user', content: 'hi' }],
    }),
    (error: unknown) => error instanceof LlmHttpError && error.status === 429 && error.zeroAllowance,
  );
  await assert.rejects(
    answering429({ 'x-ratelimit-limit-req-minute': '50', 'x-ratelimit-remaining-req-minute': '0' }).generate({
      messages: [{ role: 'user', content: 'hi' }],
    }),
    (error: unknown) => error instanceof LlmHttpError && error.status === 429 && !error.zeroAllowance,
  );
});
