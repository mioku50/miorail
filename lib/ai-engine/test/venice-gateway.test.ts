import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VENICE_PATHS_V1,
  createVeniceGatewayV1,
  isAllowlistedVeniceModelV1,
  observeVeniceModelV1,
  parseVeniceModelAllowlistV1,
  readUsdRateV1,
  redactVeniceTextV1,
} from '../src/index.js';

// A whole-fat Venice catalogue entry, in the shape the published API returns.
const LLAMA_ENTRY = {
  id: 'llama-3.3-70b',
  object: 'model',
  owned_by: 'venice.ai',
  type: 'text',
  created: 1_733_100_000,
  name: 'Llama 3.3 70B',
  description: 'A general reasoning model.',
  offline: false,
  context_length: 65_536,
  model_spec: {
    privacy: 'private',
    availableContextTokens: 65_536,
    maxCompletionTokens: 8_192,
    capabilities: {
      supportsFunctionCalling: true,
      supportsResponseSchema: true,
      supportsReasoning: false,
      supportsWebSearch: true,
      supportsVision: false,
      optimizedForCode: false,
      quantization: 'fp8',
    },
    pricing: {
      input: { usd: 0.7, diem: 0.1 },
      output: { usd: 2.8, diem: 0.4 },
    },
    traits: ['default'],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('a text model is observed field by field, with nothing invented', () => {
  const observed = observeVeniceModelV1(LLAMA_ENTRY);
  assert.ok(observed);
  assert.equal(observed.modelId, 'llama-3.3-70b');
  assert.equal(observed.privacyMode, 'private');
  assert.equal(observed.contextTokens, 65_536);
  assert.equal(observed.maxCompletionTokens, 8_192);
  assert.equal(observed.inputUsdPerMillion, '0.7');
  assert.equal(observed.outputUsdPerMillion, '2.8');
  assert.equal(observed.supportsToolCalling, true);
  assert.equal(observed.quantization, 'fp8');
});

test('an unreported capability stays null and never becomes false', () => {
  const observed = observeVeniceModelV1({
    ...LLAMA_ENTRY,
    model_spec: { ...LLAMA_ENTRY.model_spec, capabilities: {} },
  });
  assert.ok(observed);
  assert.equal(observed.supportsToolCalling, null);
  assert.equal(observed.supportsResponseSchema, null);
  assert.equal(observed.supportsWebSearch, null);
  assert.equal(observed.quantization, null);
});

test('an unpublished privacy mode reads as unknown, never as anonymized', () => {
  for (const privacy of [undefined, null, '', 'confidential', 'PRIVATE-ish']) {
    const observed = observeVeniceModelV1({
      ...LLAMA_ENTRY,
      model_spec: { ...LLAMA_ENTRY.model_spec, privacy },
    });
    assert.ok(observed);
    assert.equal(observed.privacyMode, 'unknown', `privacy=${String(privacy)}`);
  }
  const anonymized = observeVeniceModelV1({
    ...LLAMA_ENTRY,
    model_spec: { ...LLAMA_ENTRY.model_spec, privacy: 'anonymized' },
  });
  assert.equal(anonymized?.privacyMode, 'anonymized');
});

test('a non-text model in the response is dropped rather than reinterpreted', () => {
  assert.equal(observeVeniceModelV1({ ...LLAMA_ENTRY, type: 'image' }), null);
  assert.equal(observeVeniceModelV1({ ...LLAMA_ENTRY, id: '../../etc/passwd' }), null);
  assert.equal(observeVeniceModelV1({ ...LLAMA_ENTRY, id: 'a model with spaces' }), null);
  assert.equal(observeVeniceModelV1(null), null);
});

test('USD rates keep their scale instead of becoming exponent notation', () => {
  assert.equal(readUsdRateV1(1e-7), '0.0000001');
  assert.equal(readUsdRateV1(0), '0');
  assert.equal(readUsdRateV1(15), '15');
  assert.equal(readUsdRateV1(-1), null);
  assert.equal(readUsdRateV1('0.7'), null);
  assert.equal(readUsdRateV1(Number.NaN), null);
});

test('the model allowlist fails closed and rejects malformed ids', () => {
  assert.deepEqual(parseVeniceModelAllowlistV1(undefined), []);
  assert.deepEqual(parseVeniceModelAllowlistV1(''), []);
  assert.deepEqual(parseVeniceModelAllowlistV1('   '), []);
  assert.deepEqual(parseVeniceModelAllowlistV1('a, b ,,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseVeniceModelAllowlistV1('good,../bad,also good'), ['good']);
  assert.equal(isAllowlistedVeniceModelV1('llama-3.3-70b', []), false);
  assert.equal(isAllowlistedVeniceModelV1('llama-3.3-70b', ['llama-3.3-70b']), true);
  // Exact match only: no prefix and no case folding.
  assert.equal(isAllowlistedVeniceModelV1('llama-3.3-70b-turbo', ['llama-3.3-70b']), false);
  assert.equal(isAllowlistedVeniceModelV1('LLAMA-3.3-70B', ['llama-3.3-70b']), false);
});

test('redaction removes the key by value and every URL', () => {
  const key = 'vk-secret-1234567890';
  const redacted = redactVeniceTextV1(
    `request to https://api.venice.ai/api/v1/chat failed for key ${key}`,
    key,
  );
  assert.ok(!redacted.includes(key));
  assert.ok(!redacted.includes('api.venice.ai'));
  assert.ok(redacted.includes('<redacted>'));
  assert.ok(redactVeniceTextV1('x'.repeat(900), key).length <= 300);
});

test('the catalogue is read through the pinned path with a bearer header', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const gateway = createVeniceGatewayV1({
    apiKey: 'vk-test-key',
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), headers: init.headers as Record<string, string> });
      return jsonResponse({ object: 'list', type: 'text', data: [LLAMA_ENTRY] });
    }) as unknown as typeof fetch,
  });

  const result = await gateway.readTextModels({ now: new Date('2026-07-27T10:00:00.000Z') });
  assert.ok(result.ok);
  assert.equal(result.value.models.length, 1);
  assert.equal(seen[0]?.url, `https://api.venice.ai${VENICE_PATHS_V1.textModels()}`);
  assert.equal(seen[0]?.headers.authorization, 'Bearer vk-test-key');
});

test('the request hash carries the path but never the API key', async () => {
  const gateway = createVeniceGatewayV1({
    apiKey: 'vk-super-secret-key',
    fetchImpl: (async () => jsonResponse({ data: [LLAMA_ENTRY] })) as unknown as typeof fetch,
  });
  const result = await gateway.readTextModels({ now: new Date('2026-07-27T10:00:00.000Z') });
  assert.ok(result.ok);
  // A hash cannot be searched for a substring, so the real assertion is that
  // the SAME path under a DIFFERENT key hashes identically. If the key were in
  // the payload the two would differ.
  const other = createVeniceGatewayV1({
    apiKey: 'vk-a-completely-different-key',
    fetchImpl: (async () => jsonResponse({ data: [LLAMA_ENTRY] })) as unknown as typeof fetch,
  });
  const second = await other.readTextModels({ now: new Date('2026-07-27T11:00:00.000Z') });
  assert.ok(second.ok);
  assert.equal(result.value.requestHash, second.value.requestHash);
});

test('an empty catalogue is a named reason, not an empty success', async () => {
  const gateway = createVeniceGatewayV1({
    apiKey: 'vk-test-key',
    fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch,
  });
  const result = await gateway.readTextModels({ now: new Date() });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'no_text_models');
});

test('HTTP failures map to named reasons with redacted detail', async () => {
  const cases: [number, string][] = [
    [401, 'unauthorized'],
    [402, 'payment_required'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
  ];
  for (const [status, reason] of cases) {
    const gateway = createVeniceGatewayV1({
      apiKey: 'vk-leaky-key',
      fetchImpl: (async () =>
        new Response('failed at https://api.venice.ai with vk-leaky-key', { status })) as unknown as typeof fetch,
    });
    const result = await gateway.readTextModels({ now: new Date() });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, reason);
    assert.ok(!(result.detail ?? '').includes('vk-leaky-key'), `key leaked on ${status}`);
  }
});

test('an unconfigured key never reaches the network', async () => {
  let called = false;
  const gateway = createVeniceGatewayV1({
    apiKey: '',
    fetchImpl: (async () => {
      called = true;
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch,
  });
  const result = await gateway.readTextModels({ now: new Date() });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'not_configured');
  assert.equal(called, false);
});

// --- inference --------------------------------------------------------------

const COMPLETION_BODY = {
  id: 'chatcmpl-1',
  model: 'llama-3.3-70b',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Four.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
  cost: { usd: 0.0000133, diem: 0.000002 },
};

test('inference sends the pinned path and returns usage, cost and latency', async () => {
  let body: Record<string, unknown> = {};
  const gateway = createVeniceGatewayV1({
    apiKey: 'vk-test-key',
    fetchImpl: (async (url: string, init: RequestInit) => {
      assert.equal(String(url), `https://api.venice.ai${VENICE_PATHS_V1.chatCompletions()}`);
      body = JSON.parse(String(init.body));
      return jsonResponse(COMPLETION_BODY);
    }) as unknown as typeof fetch,
  });

  const result = await gateway.runInference({
    modelId: 'llama-3.3-70b',
    allowlist: ['llama-3.3-70b'],
    systemText: 'Answer briefly.',
    messages: [{ role: 'user', text: 'What is two plus two?' }],
    maxCompletionTokens: 64,
    temperature: 0.2,
    responseSchema: null,
    webSearch: false,
    now: new Date('2026-07-27T10:00:00.000Z'),
  });

  assert.ok(result.ok);
  assert.equal(result.value.text, 'Four.');
  assert.equal(result.value.finishReason, 'stop');
  assert.equal(result.value.promptTokens, 11);
  assert.equal(result.value.completionTokens, 2);
  assert.equal(result.value.actualCostUsd, '0.0000133');
  assert.ok(result.value.latencyMs >= 0);
  assert.equal(body.model, 'llama-3.3-70b');
  assert.equal(body.max_completion_tokens, 64);
  // Web search is off unless the intent asked for it.
  assert.deepEqual(body.venice_parameters, { enable_web_search: 'off' });
});

test('an unlisted model is refused before the prompt leaves the process', async () => {
  let called = false;
  const gateway = createVeniceGatewayV1({
    apiKey: 'vk-test-key',
    fetchImpl: (async () => {
      called = true;
      return jsonResponse(COMPLETION_BODY);
    }) as unknown as typeof fetch,
  });

  const result = await gateway.runInference({
    modelId: 'some-other-model',
    allowlist: ['llama-3.3-70b'],
    systemText: null,
    messages: [{ role: 'user', text: 'private business plan' }],
    maxCompletionTokens: 64,
    temperature: null,
    responseSchema: null,
    webSearch: false,
    now: new Date(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'model_not_allowlisted');
  assert.equal(called, false, 'the prompt must not reach the network');
});

test('a response naming a different model is refused, not recorded under the wrong name', async () => {
  const gateway = createVeniceGatewayV1({
    apiKey: 'vk-test-key',
    fetchImpl: (async () =>
      jsonResponse({ ...COMPLETION_BODY, model: 'something-cheaper' })) as unknown as typeof fetch,
  });
  const result = await gateway.runInference({
    modelId: 'llama-3.3-70b',
    allowlist: ['llama-3.3-70b'],
    systemText: null,
    messages: [{ role: 'user', text: 'hello' }],
    maxCompletionTokens: 16,
    temperature: null,
    responseSchema: null,
    webSearch: false,
    now: new Date(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'provider_invalid_response');
});

test('a filtered completion is a named result rather than a transport failure', async () => {
  const gateway = createVeniceGatewayV1({
    apiKey: 'vk-test-key',
    fetchImpl: (async () =>
      jsonResponse({
        ...COMPLETION_BODY,
        choices: [{ index: 0, message: { role: 'assistant' }, finish_reason: 'content_filter' }],
      })) as unknown as typeof fetch,
  });
  const result = await gateway.runInference({
    modelId: 'llama-3.3-70b',
    allowlist: ['llama-3.3-70b'],
    systemText: null,
    messages: [{ role: 'user', text: 'hello' }],
    maxCompletionTokens: 16,
    temperature: null,
    responseSchema: null,
    webSearch: false,
    now: new Date(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'content_filtered');
});

test('the response hash is over metadata, so the same usage hashes alike for different text', async () => {
  async function hashFor(text: string): Promise<string> {
    const gateway = createVeniceGatewayV1({
      apiKey: 'vk-test-key',
      fetchImpl: (async () =>
        jsonResponse({
          ...COMPLETION_BODY,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        })) as unknown as typeof fetch,
    });
    const result = await gateway.runInference({
      modelId: 'llama-3.3-70b',
      allowlist: ['llama-3.3-70b'],
      systemText: null,
      messages: [{ role: 'user', text: 'q' }],
      maxCompletionTokens: 16,
      temperature: null,
      responseSchema: null,
      webSearch: false,
      now: new Date('2026-07-27T10:00:00.000Z'),
    });
    assert.ok(result.ok);
    return result.value.responseHash;
  }

  // Same length, different content: the hash must not distinguish them, or it
  // would let anyone holding a proof confirm a guessed completion.
  assert.equal(await hashFor('AAAAA'), await hashFor('BBBBB'));
  // Different length IS visible — completion size is shape, not content.
  assert.notEqual(await hashFor('AAAAA'), await hashFor('AAAAAA'));
});

test('web search is opt-in and reaches the provider only when the intent asked', async () => {
  let body: Record<string, unknown> = {};
  const gateway = createVeniceGatewayV1({
    apiKey: 'vk-test-key',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return jsonResponse(COMPLETION_BODY);
    }) as unknown as typeof fetch,
  });
  await gateway.runInference({
    modelId: 'llama-3.3-70b',
    allowlist: ['llama-3.3-70b'],
    systemText: null,
    messages: [{ role: 'user', text: 'q' }],
    maxCompletionTokens: 16,
    temperature: null,
    responseSchema: null,
    webSearch: true,
    now: new Date(),
  });
  assert.deepEqual(body.venice_parameters, { enable_web_search: 'auto' });
});
