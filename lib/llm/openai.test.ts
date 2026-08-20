import test from 'node:test';
import assert from 'node:assert';
import { OpenAiCompatibleClient } from './src/openai.js';

test('OpenAiCompatibleClient generates correctly', async (_t) => {
  const originalFetch = global.fetch;

  // Mock global.fetch
  global.fetch = (async (_url: RequestInfo | URL, _options?: RequestInit) => {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Hi there!'
          }
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    })
  } as Response;
}) as typeof fetch;

  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.openai.com',
      apiKey: 'fake-key',
      defaultModel: 'gpt-4o-mini'
    });

    const response = await client.generate({
      messages: [{ role: 'user', content: 'Hello' }]
    });

    assert.strictEqual(response.message.role, 'assistant');
    assert.strictEqual(response.message.content, 'Hi there!');
    assert.strictEqual(response.usage?.totalTokens, 15);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenAiCompatibleClient baseUrl normalization', async (t) => {
  const originalFetch = global.fetch;
  let lastUrl = '';

  global.fetch = (async (url: RequestInfo | URL, _options?: RequestInit) => {
    lastUrl = url.toString();
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'Hi' } }]
      })
    } as Response;
  }) as typeof fetch;

  try {
    await t.test('OpenAI URL becomes https://api.openai.com/v1/chat/completions', async () => {
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://api.openai.com', apiKey: 'test', defaultModel: 'm' });
      await client.generate({ messages: [] });
      assert.strictEqual(lastUrl, 'https://api.openai.com/v1/chat/completions');
    });

    await t.test('FreeModel URL becomes https://api.freemodel.dev/v1/chat/completions', async () => {
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://api.freemodel.dev', apiKey: 'test', defaultModel: 'm' });
      await client.generate({ messages: [] });
      assert.strictEqual(lastUrl, 'https://api.freemodel.dev/v1/chat/completions');
    });

    await t.test('passing LLM_BASE_URL with /v1 does not produce /v1/v1', async () => {
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://api.openai.com/v1', apiKey: 'test', defaultModel: 'm' });
      await client.generate({ messages: [] });
      assert.strictEqual(lastUrl, 'https://api.openai.com/v1/chat/completions');
    });

    await t.test('trailing slashes are stripped', async () => {
      const client = new OpenAiCompatibleClient({ baseUrl: 'https://api.openai.com/v1/', apiKey: 'test', defaultModel: 'm' });
      await client.generate({ messages: [] });
      assert.strictEqual(lastUrl, 'https://api.openai.com/v1/chat/completions');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('structured clients request JSON mode without weakening caller validation', async () => {
  const originalFetch = global.fetch;
  let body: Record<string, unknown> = {};
  global.fetch = (async (_url: RequestInfo | URL, options?: RequestInit) => {
    body = JSON.parse(String(options?.body || '{}')) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { role: 'assistant', content: '{"intent":"ok"}' } }] }),
    } as Response;
  }) as typeof fetch;
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://api.mistral.ai',
      apiKey: 'test',
      defaultModel: 'mistral-small-2603',
      jsonMode: true,
    });
    await client.generate({ messages: [{ role: 'user', content: 'Return JSON.' }] });
    assert.deepEqual(body.response_format, { type: 'json_object' });
  } finally {
    global.fetch = originalFetch;
  }
});
