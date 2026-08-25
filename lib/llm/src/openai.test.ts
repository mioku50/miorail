import test from 'node:test';
import assert from 'node:assert';

import { OpenAiCompatibleClient } from './openai.js';

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
