import test from 'node:test';
import assert from 'node:assert';
import { OpenAiCompatibleClient } from './src/openai.js';

test('OpenAiCompatibleClient generates correctly', async (t) => {
  const originalFetch = global.fetch;

  // Mock global.fetch
  global.fetch = async (url, options) => {
    assert.strictEqual(url, 'https://api.openai.com/v1/chat/completions');
    assert.strictEqual(options?.method, 'POST');
    const headers = options?.headers as Record<string, string>;
    assert.strictEqual(headers['Authorization'], 'Bearer fake-key');

    const body = JSON.parse(options?.body as string);
    assert.strictEqual(body.model, 'gpt-4o-mini');
    assert.strictEqual(body.messages[0].content, 'Hello');

    return {
      ok: true,
      json: async () => ({
        choices: [
          { message: { role: 'assistant', content: 'Hi there!' } }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      })
    } as any;
  };

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
    assert.strictEqual(response.usage?.totalTokens, 30);
  } finally {
    global.fetch = originalFetch;
  }
});
