import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOWED_PARTNER_HOSTS,
  PartnerHostNotAllowlistedError,
  partnerFetch,
  pluginScopedFetch,
  PluginHttpScopeError,
  baseMcpPluginModeFromEnv,
  resolvePluginCredential,
  type PluginHttpScope,
} from './httpAllowlist.js';

test('partnerFetch calls through for an allowlisted host and always sets an abort timeout', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response('ok');
  }) as typeof fetch;

  const response = await partnerFetch('https://api.moonwell.fi/v1/markets?chain=base', {}, { fetchImpl });
  assert.equal(await response.text(), 'ok');
  assert.equal(capturedUrl, 'https://api.moonwell.fi/v1/markets?chain=base');
  assert.ok(capturedInit?.signal instanceof AbortSignal);
});

test('partnerFetch rejects a non-allowlisted host before any network call', async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response('');
  }) as typeof fetch;

  await assert.rejects(
    () => partnerFetch('https://evil.example.com/steal', {}, { fetchImpl }),
    PartnerHostNotAllowlistedError,
  );
  assert.equal(called, false);
});

test('partnerFetch honors a custom timeoutMs', async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    capturedInit = init;
    return new Response('ok');
  }) as typeof fetch;

  await partnerFetch('https://trade-api.gateway.uniswap.org/v1/quote', {}, { fetchImpl, timeoutMs: 1234 });
  assert.ok(capturedInit?.signal instanceof AbortSignal);
});

test('ALLOWED_PARTNER_HOSTS covers exactly the sanctioned partner hosts', () => {
  assert.deepEqual([...ALLOWED_PARTNER_HOSTS], [
    'api.moonwell.fi',
    'trade-api.gateway.uniswap.org',
    'liquidity.api.uniswap.org',
    'mcp.morpho.org',
    'api.morpho.org',
    'api.bitrefill.com',
    'api.opensea.io',
    'api.venice.ai',
    // Phase 17.5 — the Dinari Enterprise catalogue (both environments) and the
    // registry that issues composite FIGIs. Read-only, and the only reason the
    // sandbox host is listed is that production access is gated behind a
    // verification form; which one is used is configuration, not this list.
    'api-enterprise.sbt.dinari.com',
    'api-enterprise.sandbox.dinari.com',
    // Phase 13.8 — Euler's public v3 read API. The only host added for the
    // third lender Base names, and it is a second opinion on a reading taken
    // from the vault factory first, never the only source for it.
    'v3.euler.finance',
    'api.openfigi.com',
  ]);
});

const uniswapScope: PluginHttpScope = {
  pluginId: 'uniswap',
  hosts: ['trade-api.gateway.uniswap.org'],
  methods: ['GET', 'POST'],
  pathPrefixes: ['/v1/quote'],
};

test('pluginScopedFetch calls through when host, method, and path all match the plugin scope', async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    capturedInit = init;
    return new Response('ok');
  }) as typeof fetch;

  const response = await pluginScopedFetch(
    uniswapScope,
    'https://trade-api.gateway.uniswap.org/v1/quote',
    { method: 'POST' },
    { fetchImpl },
  );
  assert.equal(await response.text(), 'ok');
  assert.ok(capturedInit?.signal instanceof AbortSignal);
});

test('pluginScopedFetch rejects a host outside the plugin scope before any network call', async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response(''); }) as typeof fetch;
  await assert.rejects(
    () => pluginScopedFetch(uniswapScope, 'https://evil.example.com/v1/quote', { method: 'POST' }, { fetchImpl }),
    (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'host',
  );
  assert.equal(called, false);
});

test('pluginScopedFetch rejects a method outside the plugin scope', async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response(''); }) as typeof fetch;
  await assert.rejects(
    () => pluginScopedFetch(uniswapScope, 'https://trade-api.gateway.uniswap.org/v1/quote', { method: 'DELETE' }, { fetchImpl }),
    (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'method',
  );
  assert.equal(called, false);
});

test('pluginScopedFetch rejects a path outside the plugin scope, blocking prompt-injected path redirection', async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response(''); }) as typeof fetch;
  await assert.rejects(
    () => pluginScopedFetch(uniswapScope, 'https://trade-api.gateway.uniswap.org/v1/swap', { method: 'POST' }, { fetchImpl }),
    (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'path',
  );
  assert.equal(called, false);
});

test('pluginScopedFetch parses the URL authority correctly: an "@" in the path can never smuggle another host', async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response('ok'); }) as typeof fetch;
  // '/v1/quote@evil.example.com' is a path on trade-api.gateway.uniswap.org,
  // not a redirect to evil.example.com — `new URL().host` proves this.
  const response = await pluginScopedFetch(
    uniswapScope,
    'https://trade-api.gateway.uniswap.org/v1/quote@evil.example.com',
    { method: 'POST' },
    { fetchImpl },
  );
  assert.equal(await response.text(), 'ok');
  assert.equal(called, true);
  assert.equal(new URL('https://trade-api.gateway.uniswap.org/v1/quote@evil.example.com').host, 'trade-api.gateway.uniswap.org');
});

test('pluginScopedFetch always applies an AbortSignal.timeout', async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    capturedInit = init;
    return new Response('ok');
  }) as typeof fetch;
  await pluginScopedFetch(uniswapScope, 'https://trade-api.gateway.uniswap.org/v1/quote', { method: 'GET' }, { fetchImpl, timeoutMs: 1234 });
  assert.ok(capturedInit?.signal instanceof AbortSignal);
});

test('baseMcpPluginModeFromEnv defaults to mcp and only direct requires an explicit opt-in', () => {
  const previous = process.env.BASE_MCP_PLUGIN_MODE;
  try {
    delete process.env.BASE_MCP_PLUGIN_MODE;
    assert.equal(baseMcpPluginModeFromEnv(), 'mcp');
    process.env.BASE_MCP_PLUGIN_MODE = 'direct';
    assert.equal(baseMcpPluginModeFromEnv(), 'direct');
    process.env.BASE_MCP_PLUGIN_MODE = 'garbage';
    assert.equal(baseMcpPluginModeFromEnv(), 'mcp');
  } finally {
    if (previous === undefined) delete process.env.BASE_MCP_PLUGIN_MODE;
    else process.env.BASE_MCP_PLUGIN_MODE = previous;
  }
});

test('resolvePluginCredential reads UNISWAP_MCP_GATEWAY_KEY in mcp mode and UNISWAP_API_KEY in direct mode; UNISWAP_API_KEY is not required in mcp mode', () => {
  const previousGateway = process.env.UNISWAP_MCP_GATEWAY_KEY;
  const previousDirect = process.env.UNISWAP_API_KEY;
  try {
    process.env.UNISWAP_MCP_GATEWAY_KEY = 'gateway-secret';
    delete process.env.UNISWAP_API_KEY;
    assert.equal(resolvePluginCredential('uniswap', 'mcp'), 'gateway-secret');
    assert.equal(resolvePluginCredential('uniswap', 'direct'), undefined);

    process.env.UNISWAP_API_KEY = 'direct-secret';
    assert.equal(resolvePluginCredential('uniswap', 'direct'), 'direct-secret');
    assert.equal(resolvePluginCredential('moonwell', 'mcp'), undefined);
  } finally {
    if (previousGateway === undefined) delete process.env.UNISWAP_MCP_GATEWAY_KEY; else process.env.UNISWAP_MCP_GATEWAY_KEY = previousGateway;
    if (previousDirect === undefined) delete process.env.UNISWAP_API_KEY; else process.env.UNISWAP_API_KEY = previousDirect;
  }
});

test('in mcp mode with no gateway key, UNISWAP_API_KEY is used rather than refusing', () => {
  // The production configuration that broke: UNISWAP_API_KEY set and valid,
  // no gateway key, default mode. The resolver returned undefined and every
  // Uniswap quote failed with PluginCredentialMissingError — so Uniswap
  // vanished from comparisons and the route card had nothing to recommend.
  //
  // Safe because the plugin allowlist pins the host: the executor calls
  // trade-api.gateway.uniswap.org, the API that issued this very key.
  const previousGateway = process.env.UNISWAP_MCP_GATEWAY_KEY;
  const previousDirect = process.env.UNISWAP_API_KEY;
  try {
    delete process.env.UNISWAP_MCP_GATEWAY_KEY;
    process.env.UNISWAP_API_KEY = 'direct-secret';
    assert.equal(resolvePluginCredential('uniswap', 'mcp'), 'direct-secret');

    // The gateway key still wins where it is configured — the fallback is a
    // fallback, not a replacement.
    process.env.UNISWAP_MCP_GATEWAY_KEY = 'gateway-secret';
    assert.equal(resolvePluginCredential('uniswap', 'mcp'), 'gateway-secret');

    // And an empty gateway key is absent, not a credential.
    process.env.UNISWAP_MCP_GATEWAY_KEY = '   ';
    assert.equal(resolvePluginCredential('uniswap', 'mcp'), 'direct-secret');

    // With neither, it still refuses. The fallback does not invent a key.
    delete process.env.UNISWAP_MCP_GATEWAY_KEY;
    delete process.env.UNISWAP_API_KEY;
    assert.equal(resolvePluginCredential('uniswap', 'mcp'), undefined);
  } finally {
    if (previousGateway === undefined) delete process.env.UNISWAP_MCP_GATEWAY_KEY;
    else process.env.UNISWAP_MCP_GATEWAY_KEY = previousGateway;
    if (previousDirect === undefined) delete process.env.UNISWAP_API_KEY;
    else process.env.UNISWAP_API_KEY = previousDirect;
  }
});
