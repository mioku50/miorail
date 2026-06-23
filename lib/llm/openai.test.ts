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
