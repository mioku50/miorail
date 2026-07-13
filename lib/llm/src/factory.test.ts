import test from 'node:test';
import assert from 'node:assert';
import { createLlmProvider } from './factory.js';
import { OpenAiCompatibleClient } from './openai.js';

test('createLlmProvider', async (t) => {
  const originalEnv = { ...process.env };

  t.afterEach(() => {
    process.env = { ...originalEnv };
  });

  await t.test('LLM_PROVIDER=mock is rejected by the production factory', () => {
    process.env.LLM_PROVIDER = 'mock';
    assert.throws(() => createLlmProvider(), /Unsupported production LLM_PROVIDER/);
  });

  await t.test('LLM_PROVIDER=openai requires OPENAI_API_KEY', () => {
    process.env.LLM_PROVIDER = 'openai';
    delete process.env.OPENAI_API_KEY;
    assert.throws(() => createLlmProvider(), /OPENAI_API_KEY is not set/);
  });

  await t.test('LLM_PROVIDER=openai returns OpenAiCompatibleClient with correct key', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key';
    const provider = createLlmProvider();
    assert.ok(provider instanceof OpenAiCompatibleClient);
  });

  await t.test('LLM_PROVIDER=openai-compatible requires missing config', () => {
    process.env.LLM_PROVIDER = 'openai-compatible';
    delete process.env.LLM_BASE_URL;
    assert.throws(() => createLlmProvider(), /is not set/);
  });

  await t.test('LLM_PROVIDER=openai-compatible returns OpenAiCompatibleClient with config', () => {
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'http://localhost/v1';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'test-model';
    const provider = createLlmProvider();
    assert.ok(provider instanceof OpenAiCompatibleClient);
  });

  await t.test('LLM_PAYMENT_MODE=x402 creates provider and fails closed lazily without buyer payer config', async () => {
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_PAYMENT_MODE = 'x402';
    process.env.LLM_BASE_URL = 'http://localhost/v1';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'test-model';
    const provider = createLlmProvider();
    assert.ok(provider instanceof OpenAiCompatibleClient);
    await assert.rejects(
      () => provider.generate({ messages: [{ role: 'user', content: 'hello' }] }),
      /x402 buyer payment signer is unavailable|x402_buyer_payer_missing_config/,
    );
  });

  await t.test('missing config does not leak secrets in error message', () => {
    process.env.LLM_PROVIDER = 'openai';
    delete process.env.OPENAI_API_KEY;
    try {
      createLlmProvider();
    } catch (err: unknown) {
      assert.ok(!(err as Error).message.includes('sk-'));
    }
  });

  await t.test('CHAIN_ENV=sepolia throws if real provider not configured', () => {
    process.env.CHAIN_ENV = 'sepolia';
    process.env.NODE_ENV = 'production';
    delete process.env.LLM_PROVIDER; // defaults to mock implicitly
    assert.throws(() => createLlmProvider(), /LLM provider is not configured/);
  });

  await t.test('CHAIN_ENV=sepolia rejects explicit mock', () => {
    process.env.CHAIN_ENV = 'sepolia';
    process.env.NODE_ENV = 'production';
    process.env.LLM_PROVIDER = 'mock';
    assert.throws(() => createLlmProvider(), /Unsupported production LLM_PROVIDER/);
  });
});
