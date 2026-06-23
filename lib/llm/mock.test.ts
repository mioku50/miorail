import test from 'node:test';
import assert from 'node:assert/strict';
import { MockLlmProvider } from './src/mock.js';
import { LlmRequest } from './src/types.js';

test('MockLlmProvider should return single deterministic string response', async () => {
  const provider = new MockLlmProvider('test response');
  const req: LlmRequest = { messages: [{ role: 'user', content: 'hello' }] };

  const res = await provider.generate(req);

  assert.equal(res.message.content, 'test response');
  assert.equal(res.message.role, 'assistant');
  assert.deepEqual(provider.requests, [req]);
});

test('MockLlmProvider should cycle through array of responses', async () => {
  const provider = new MockLlmProvider(['resp1', 'resp2']);
  const req: LlmRequest = { messages: [{ role: 'user', content: 'hello' }] };

  const res1 = await provider.generate(req);
  assert.equal(res1.message.content, 'resp1');

  const res2 = await provider.generate(req);
  assert.equal(res2.message.content, 'resp2');

  const res3 = await provider.generate(req);
  assert.equal(res3.message.content, 'resp1');
});

test('MockLlmProvider should use function response', async () => {
  const provider = new MockLlmProvider((req) => `echo: ${req.messages[0].content}`);
  const req: LlmRequest = { messages: [{ role: 'user', content: 'hello' }] };

  const res = await provider.generate(req);
  assert.equal(res.message.content, 'echo: hello');
});
