import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginHttpScopeError } from '@mioagent/security/httpAllowlist';
import {
  pluginHttpRequest,
  PluginNotAvailableError,
  PluginChainNotAllowedError,
  PluginCredentialMissingError,
} from './pluginHttpGateway.js';

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('pluginHttpRequest rejects an unknown plugin before any network call', async () => {
  let called = false;
  await assert.rejects(
    () => pluginHttpRequest({
      plugin: 'not-a-real-plugin',
      url: 'https://example.com/v1/quote',
      method: 'GET',
      fetchImpl: (async () => { called = true; return new Response('ok'); }) as typeof fetch,
    }),
    PluginNotAvailableError,
  );
  assert.equal(called, false);
});

test('pluginHttpRequest rejects a chain outside the plugin manifest', async () => {
  await assert.rejects(
    () => pluginHttpRequest({
      plugin: 'uniswap',
      url: 'https://trade-api.gateway.uniswap.org/v1/quote',
      method: 'POST',
      chainId: 1,
      mode: 'direct',
      fetchImpl: (async () => new Response('ok')) as typeof fetch,
    }),
    PluginChainNotAllowedError,
  );
});

test('pluginHttpRequest rejects a host outside the plugin allowlist (arbitrary web_request host)', async () => {
  let called = false;
  await withEnv({ UNISWAP_API_KEY: 'direct-key' }, async () => {
    await assert.rejects(
      () => pluginHttpRequest({
        plugin: 'uniswap',
        url: 'https://evil.example.com/v1/quote',
        method: 'POST',
        mode: 'direct',
        fetchImpl: (async () => { called = true; return new Response('ok'); }) as typeof fetch,
      }),
      PluginHttpScopeError,
    );
  });
  assert.equal(called, false);
});

test('pluginHttpRequest rejects a path outside the plugin allowlist (prompt injection cannot redirect path)', async () => {
  await withEnv({ UNISWAP_API_KEY: 'direct-key' }, async () => {
    await assert.rejects(
      () => pluginHttpRequest({
        plugin: 'uniswap',
        url: 'https://trade-api.gateway.uniswap.org/v1/other',
        method: 'POST',
        mode: 'direct',
        fetchImpl: (async () => new Response('ok')) as typeof fetch,
      }),
      (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'path',
    );
  });
});

test('pluginHttpRequest requires a credential for auth: api-key plugins and never fetches without one', async () => {
  let called = false;
  await withEnv({ UNISWAP_API_KEY: undefined, UNISWAP_MCP_GATEWAY_KEY: undefined }, async () => {
    await assert.rejects(
      () => pluginHttpRequest({
        plugin: 'uniswap',
        url: 'https://trade-api.gateway.uniswap.org/v1/quote',
        method: 'POST',
        mode: 'mcp',
        fetchImpl: (async () => { called = true; return new Response('ok'); }) as typeof fetch,
      }),
      PluginCredentialMissingError,
    );
  });
  assert.equal(called, false);
});

test('mcp mode resolves UNISWAP_MCP_GATEWAY_KEY without requiring UNISWAP_API_KEY', async () => {
  let capturedHeaders: Record<string, string> | undefined;
  await withEnv({ UNISWAP_API_KEY: undefined, UNISWAP_MCP_GATEWAY_KEY: 'gateway-secret' }, async () => {
    const result = await pluginHttpRequest({
      plugin: 'uniswap',
      url: 'https://trade-api.gateway.uniswap.org/v1/quote',
      method: 'POST',
      body: { amount: '1' },
      mode: 'mcp',
      fetchImpl: (async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ quote: { output: { amount: '1' } } }), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(result.status, 200);
  });
  assert.equal(capturedHeaders?.['x-api-key'], 'gateway-secret');
});

test('pluginHttpRequest never echoes the resolved credential back in the sanitized response body', async () => {
  const result = await withEnv({ UNISWAP_API_KEY: undefined, UNISWAP_MCP_GATEWAY_KEY: 'super-secret-gateway-key' }, () => pluginHttpRequest({
    plugin: 'uniswap',
    url: 'https://trade-api.gateway.uniswap.org/v1/quote',
    method: 'POST',
    mode: 'mcp',
    fetchImpl: (async () => new Response(JSON.stringify({
      echo: 'contains super-secret-gateway-key inline',
      authorization: 'Bearer super-secret-gateway-key',
    }), { status: 200 })) as typeof fetch,
  }));
  const serialized = JSON.stringify(result.data);
  assert.equal(serialized.includes('super-secret-gateway-key'), false);
  assert.equal((result.data as Record<string, unknown>).authorization, '[redacted]');
});

test('pluginHttpRequest drops arbitrary caller-supplied headers — only content-type and the resolved credential reach the wire', async () => {
  let capturedHeaders: Record<string, string> | undefined;
  await withEnv({ UNISWAP_API_KEY: 'direct-key' }, async () => {
    await pluginHttpRequest({
      plugin: 'uniswap',
      url: 'https://trade-api.gateway.uniswap.org/v1/quote',
      method: 'POST',
      mode: 'direct',
      // Simulates an attempt to inject an arbitrary header (e.g. from
      // upstream model output) — only extraHeaders set by trusted routing
      // code are honored, and even those cannot override the credential.
      extraHeaders: { 'x-api-key': 'attacker-supplied-key', 'x-forwarded-for': '1.2.3.4' },
      fetchImpl: (async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
  });
  assert.equal(capturedHeaders?.['x-api-key'], 'direct-key');
  assert.equal(capturedHeaders?.['x-forwarded-for'], '1.2.3.4');
});

test('pluginHttpRequest works for auth: none plugins (Moonwell) without any credential', async () => {
  let capturedHeaders: Record<string, string> | undefined;
  const result = await pluginHttpRequest({
    plugin: 'moonwell',
    url: 'https://api.moonwell.fi/v1/markets?chain=base',
    method: 'GET',
    fetchImpl: (async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ markets: [] }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(result.status, 200);
  assert.equal(capturedHeaders?.['x-api-key'], undefined);
});
