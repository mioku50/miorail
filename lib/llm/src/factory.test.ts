import test from 'node:test';
import assert from 'node:assert';
import { createLlmProvider, providerLabelV1 } from './factory.js';
import { LlmProviderChainV1 } from './fallback.js';
import { OpenAiCompatibleClient } from './openai.js';

/** Clears every fallback variable so one subtest cannot configure another. */
function clearFallbackEnv(): void {
  delete process.env.LLM_FALLBACK_BASE_URL;
  delete process.env.LLM_FALLBACK_API_KEY;
  delete process.env.LLM_FALLBACK_MODEL;
  delete process.env.LLM_FALLBACK_2_BASE_URL;
  delete process.env.LLM_FALLBACK_2_API_KEY;
  delete process.env.LLM_FALLBACK_2_MODEL;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  delete process.env.AGENTROUTER_API_KEY;
}

test('createLlmProvider', async (t) => {
  const originalEnv = { ...process.env };

  t.beforeEach(() => {
    clearFallbackEnv();
  });

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

  // --- the empty-value case that broke production -------------------------

  await t.test('an EMPTY LLM_BASE_URL counts as unset and names itself', () => {
    // `.env` carried LLM_BASE_URL twice and the second one was blank. node
    // --env-file takes the last, so the server built a client against "".
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = '';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'test-model';
    assert.throws(() => createLlmProvider(), /LLM_BASE_URL is not set/);
    assert.throws(() => createLlmProvider(), /duplicate key/);
  });

  await t.test('the error names every missing variable, not just the first', () => {
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = '   ';
    delete process.env.LLM_API_KEY;
    process.env.LLM_MODEL = '';
    assert.throws(() => createLlmProvider(), /LLM_BASE_URL, LLM_API_KEY, LLM_MODEL is not set/);
  });

  // --- fallback chain ------------------------------------------------------

  await t.test('no fallback variables means no chain — the fallback is optional', () => {
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'https://api.airforce';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    assert.ok(createLlmProvider() instanceof OpenAiCompatibleClient);
  });

  await t.test('a fully configured fallback wraps the primary in a chain', () => {
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'https://api.airforce';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.LLM_FALLBACK_BASE_URL = 'https://openrouter.ai/api';
    process.env.LLM_FALLBACK_API_KEY = 'test-fallback';
    process.env.LLM_FALLBACK_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
    assert.ok(createLlmProvider() instanceof LlmProviderChainV1);
  });

  await t.test('a HALF configured fallback throws instead of silently having none', () => {
    // Ignoring this would mean the fallback is discovered missing on the one
    // day it was supposed to matter.
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'https://api.airforce';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.LLM_FALLBACK_BASE_URL = 'https://openrouter.ai/api';
    process.env.LLM_FALLBACK_MODEL = '';
    assert.throws(
      () => createLlmProvider(),
      /LLM fallback is partially configured — missing: LLM_FALLBACK_API_KEY, LLM_FALLBACK_MODEL/,
    );
  });

  await t.test('OPENROUTER_KEY is accepted when the fallback IS OpenRouter', () => {
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'https://api.airforce';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.LLM_FALLBACK_BASE_URL = 'https://openrouter.ai/api';
    process.env.LLM_FALLBACK_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
    process.env.OPENROUTER_KEY = 'sk-or-test';
    assert.ok(createLlmProvider() instanceof LlmProviderChainV1);
  });

  await t.test('an OpenRouter key is NEVER sent to a different host', () => {
    // A bearer token is a credential for one host. Resolving it for an
    // unrelated base URL would hand it to whoever that host turns out to be.
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'https://api.airforce';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.LLM_FALLBACK_BASE_URL = 'https://someone-elses-gateway.example';
    process.env.LLM_FALLBACK_MODEL = 'some-model';
    process.env.OPENROUTER_KEY = 'sk-or-test';
    assert.throws(() => createLlmProvider(), /missing: LLM_FALLBACK_API_KEY/);
  });

  await t.test('a second spare joins the chain after the first', () => {
    // One spare stops being a spare when the primary answers 429 on most
    // requests, which is what api.airforce does here.
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'https://api.airforce';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.LLM_FALLBACK_BASE_URL = 'https://openrouter.ai/api';
    process.env.LLM_FALLBACK_API_KEY = 'test-fallback';
    process.env.LLM_FALLBACK_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
    process.env.LLM_FALLBACK_2_BASE_URL = 'https://agentrouter.org';
    process.env.LLM_FALLBACK_2_MODEL = 'gpt-5.6-sol';
    process.env.AGENTROUTER_API_KEY = 'ar-test';
    assert.ok(createLlmProvider() instanceof LlmProviderChainV1);
  });

  await t.test('a HALF configured second spare throws, exactly like the first', () => {
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'https://api.airforce';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.LLM_FALLBACK_2_BASE_URL = 'https://agentrouter.org';
    assert.throws(
      () => createLlmProvider(),
      /missing: LLM_FALLBACK_2_API_KEY, LLM_FALLBACK_2_MODEL/,
    );
  });

  await t.test('an AgentRouter key is NEVER sent to a different host', () => {
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'https://api.airforce';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.LLM_FALLBACK_2_BASE_URL = 'https://someone-elses-gateway.example';
    process.env.LLM_FALLBACK_2_MODEL = 'some-model';
    process.env.AGENTROUTER_API_KEY = 'ar-test';
    assert.throws(() => createLlmProvider(), /missing: LLM_FALLBACK_2_API_KEY/);
  });

  await t.test('a second spare alone is a chain, with no first spare configured', () => {
    process.env.LLM_PROVIDER = 'openai-compatible';
    process.env.LLM_BASE_URL = 'https://api.airforce';
    process.env.LLM_API_KEY = 'test';
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.LLM_FALLBACK_2_BASE_URL = 'https://agentrouter.org';
    process.env.LLM_FALLBACK_2_MODEL = 'gpt-5.6-sol';
    process.env.AGENTROUTER_API_KEY = 'ar-test';
    assert.ok(createLlmProvider() instanceof LlmProviderChainV1);
  });

  await t.test('the fallback applies to a direct OpenAI primary too', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test';
    process.env.LLM_FALLBACK_BASE_URL = 'https://openrouter.ai/api';
    process.env.LLM_FALLBACK_API_KEY = 'test-fallback';
    process.env.LLM_FALLBACK_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
    assert.ok(createLlmProvider() instanceof LlmProviderChainV1);
  });
});

test('providerLabelV1 reports the host and never a path or credential', () => {
  assert.equal(providerLabelV1('https://api.airforce'), 'api.airforce');
  assert.equal(providerLabelV1('https://openrouter.ai/api'), 'openrouter.ai');
  // Some gateways carry a token in the path; the label must not.
  assert.equal(providerLabelV1('https://gateway.example/v1/sk-secret-token'), 'gateway.example');
  assert.equal(providerLabelV1(''), 'llm-provider');
});

test('two links on the same host are told apart in the log', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = { ...originalEnv };
  });
  clearFallbackEnv();
  process.env.LLM_PROVIDER = 'openai-compatible';
  process.env.LLM_BASE_URL = 'https://api.airforce';
  process.env.LLM_API_KEY = 'test';
  process.env.LLM_MODEL = 'gpt-4o-mini';
  // Both spares are OpenRouter, on different models. Production logged
  // "openrouter.ai failed, falling over to openrouter.ai" — true, and useless.
  process.env.LLM_FALLBACK_BASE_URL = 'https://openrouter.ai/api';
  process.env.LLM_FALLBACK_MODEL = 'qwen/qwen3.7-flash';
  process.env.LLM_FALLBACK_2_BASE_URL = 'https://openrouter.ai/api';
  process.env.LLM_FALLBACK_2_MODEL = 'nvidia/nemotron-3-nano-30b-a3b:free';
  process.env.OPENROUTER_KEY = 'sk-or-test';

  const warnings: string[] = [];
  const originalWarn = console.warn;
  const originalFetch = globalThis.fetch;
  console.warn = (message: string) => warnings.push(message);
  // Offline: the factory builds its own clients, so the only seam is fetch.
  // Without this the chain dials three real hosts and waits out three 60s
  // timeouts inside a unit test.
  globalThis.fetch = (async () => {
    throw new Error('offline in tests');
  }) as typeof fetch;
  try {
    await assert.rejects(() =>
      createLlmProvider().generate({ messages: [{ role: 'user', content: 'hi' }] }),
    );
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
  }
  const hops = warnings.join('\n');
  assert.match(hops, /openrouter\.ai \(qwen\/qwen3\.7-flash\)/);
  assert.match(hops, /openrouter\.ai \(nvidia\/nemotron-3-nano-30b-a3b:free\)/);
  // The unique host keeps its short, familiar name.
  assert.match(hops, /^\[llm\] api\.airforce failed/m);
});
