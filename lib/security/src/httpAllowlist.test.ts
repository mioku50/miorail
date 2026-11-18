import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  ALLOWED_PARTNER_HOSTS,
  ALLOWLISTED_MAX_REDIRECTS_V1,
  PartnerHostNotAllowlistedError,
  PartnerRequestRefusedError,
  partnerFetch,
  pluginScopedFetch,
  PluginHttpScopeError,
  baseMcpPluginModeFromEnv,
  resolvePluginCredential,
  type PluginHttpScope,
} from './httpAllowlist.js';

interface SentRequestV1 {
  url: string;
  method: string;
  redirect: RequestRedirect | undefined;
  headers: Headers;
  body: unknown;
}

/** A transport that answers from a script, one answer per request, and keeps
 * every request it was asked, credential headers included. */
function scriptedFetch(answers: Array<(url: string) => Response>) {
  const sent: SentRequestV1[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    sent.push({
      url,
      method: String(init.method ?? 'GET').toUpperCase(),
      redirect: init.redirect,
      headers: new Headers(init.headers),
      body: init.body,
    });
    const answer = answers[sent.length - 1];
    if (!answer) throw new Error(`no answer scripted for request ${sent.length}: ${url}`);
    return answer(url);
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const redirectTo = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
const answered = (text: string) => () => new Response(text, { status: 200 });

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
    'api.v4.aave.com',
    'api.bitrefill.com',
    'api.opensea.io',
    'api.venice.ai',
    // Phase 13.8 — Euler's public v3 read API. The only host added for the
    // third lender Base names, and it is a second opinion on a reading taken
    // from the vault factory first, never the only source for it.
    'v3.euler.finance',
    // The Stocks list: Coinbase's public Tokenized Stocks API and the icons it
    // links to, both read-only and both on fixed paths.
    'api.coinbase.com',
    'metadata.coinbase.com',
  ]);
});

const uniswapScope: PluginHttpScope = {
  pluginId: 'uniswap',
  hosts: ['trade-api.gateway.uniswap.org'],
  methods: ['GET', 'POST'],
  pathPrefixes: ['/v1/quote'],
};

test('GMGN resolves only a configured server read credential, without inventing one', () => {
  const previous = process.env.GMGN_API_KEY;
  try {
    delete process.env.GMGN_API_KEY;
    assert.equal(resolvePluginCredential('gmgn'), undefined);
    process.env.GMGN_API_KEY = '  gmgn-personal-fixture  ';
    assert.equal(resolvePluginCredential('gmgn', 'mcp'), 'gmgn-personal-fixture');
    assert.equal(resolvePluginCredential('gmgn', 'direct'), 'gmgn-personal-fixture');
    process.env.GMGN_API_KEY = '  ';
    assert.equal(resolvePluginCredential('gmgn'), undefined);
  } finally {
    if (previous === undefined) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = previous;
  }
});

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

// ---------------------------------------------------------------------------
// Audit P2-6, 2026-11-18: the host was checked on the first URL only, and fetch
// followed redirects by itself. Fetch removes only `Authorization` when a
// redirect changes origin, so OpenSea's `x-api-key` or a plugin's credential
// header went on to wherever the redirect pointed.
// ---------------------------------------------------------------------------

test('partnerFetch refuses a 302 to another host, and the credential header is never sent there', async () => {
  for (const elsewhere of ['https://collector.example.com/steal', 'https://api.venice.ai/api/v1/models']) {
    // The second is allowlisted too: the key is OpenSea's, and only OpenSea's origin may receive it.
    const { sent, fetchImpl } = scriptedFetch([redirectTo(elsewhere), answered('should never be asked')]);
    await assert.rejects(
      () => partnerFetch('https://api.opensea.io/api/v2/collections/x', { headers: { 'x-api-key': 'opensea-secret' } }, { fetchImpl }),
      (error: unknown) => error instanceof PartnerRequestRefusedError && /another origin/.test(error.detail),
    );
    assert.deepEqual(sent.map((request) => request.url), ['https://api.opensea.io/api/v2/collections/x']);
    assert.equal(sent.some((request) => new URL(request.url).origin !== 'https://api.opensea.io'), false);
    // Followed here, never by the platform: fetch itself would have carried the key on.
    assert.equal(sent[0]!.redirect, 'manual');
  }
});

test('partnerFetch follows a same-origin redirect, and checks the new URL again', async () => {
  const { sent, fetchImpl } = scriptedFetch([redirectTo('/v1/markets/?chain=base', 301), answered('markets')]);
  const response = await partnerFetch('https://api.moonwell.fi/v1/markets?chain=base', { headers: { accept: 'application/json' } }, { fetchImpl });
  assert.equal(await response.text(), 'markets');
  assert.deepEqual(sent.map((request) => request.url), [
    'https://api.moonwell.fi/v1/markets?chain=base',
    'https://api.moonwell.fi/v1/markets/?chain=base',
  ]);
  assert.equal(sent[1]!.headers.get('accept'), 'application/json');

  // The same host with the scheme changed is another origin: a downgrade is refused.
  const downgrade = scriptedFetch([redirectTo('http://api.moonwell.fi/v1/markets'), answered('plain text')]);
  await assert.rejects(
    () => partnerFetch('https://api.moonwell.fi/v1/markets', {}, { fetchImpl: downgrade.fetchImpl }),
    PartnerRequestRefusedError,
  );
  assert.equal(downgrade.sent.length, 1);
});

test('a redirect turns a POST into a GET the way fetch does, without its body', async () => {
  const { sent, fetchImpl } = scriptedFetch([redirectTo('/oauth/mcp/token/next', 303), answered('{}')]);
  await partnerFetch('https://api.bitrefill.com/oauth/mcp/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: 'grant_type=client_credentials',
  }, { fetchImpl });
  assert.deepEqual(sent.map((request) => [request.method, request.body ?? null, request.headers.get('content-type')]), [
    ['POST', 'grant_type=client_credentials', 'application/x-www-form-urlencoded'],
    ['GET', null, null],
  ]);
  assert.equal(sent[1]!.headers.get('accept'), 'application/json');

  // 307 and 308 ask again exactly: the same method and the same body.
  const kept = scriptedFetch([redirectTo('/mcp/', 308), answered('{}')]);
  await partnerFetch('https://api.bitrefill.com/mcp', { method: 'POST', body: '{"jsonrpc":"2.0"}' }, { fetchImpl: kept.fetchImpl });
  assert.deepEqual(kept.sent.map((request) => [request.method, request.body]), [['POST', '{"jsonrpc":"2.0"}'], ['POST', '{"jsonrpc":"2.0"}']]);
});

test('partnerFetch and pluginScopedFetch refuse http: before any network call', async () => {
  const { sent, fetchImpl } = scriptedFetch([answered('never')]);
  await assert.rejects(
    () => partnerFetch('http://api.moonwell.fi/v1/markets?chain=base', {}, { fetchImpl }),
    (error: unknown) => error instanceof PartnerRequestRefusedError && /https/.test(error.detail),
  );
  await assert.rejects(
    () => pluginScopedFetch(uniswapScope, 'http://trade-api.gateway.uniswap.org/v1/quote', { method: 'POST' }, { fetchImpl }),
    (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'scheme',
  );
  assert.equal(sent.length, 0);
});

test('the redirect limit holds: a chain longer than the limit is refused, not followed', async () => {
  const chain = Array.from({ length: ALLOWLISTED_MAX_REDIRECTS_V1 + 2 }, (_, index) => redirectTo(`/v1/quote/${index + 1}`));
  const { sent, fetchImpl } = scriptedFetch(chain);
  await assert.rejects(
    () => partnerFetch('https://api.moonwell.fi/v1/quote', {}, { fetchImpl }),
    (error: unknown) => error instanceof PartnerRequestRefusedError && /more than/.test(error.detail),
  );
  // The first request, and one more for each redirect followed; the one past the limit is never asked.
  assert.equal(sent.length, ALLOWLISTED_MAX_REDIRECTS_V1 + 1);

  const plugin = scriptedFetch(chain);
  await assert.rejects(
    () => pluginScopedFetch(uniswapScope, 'https://trade-api.gateway.uniswap.org/v1/quote', {}, { fetchImpl: plugin.fetchImpl }),
    (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'redirect',
  );
  assert.equal(plugin.sent.length, ALLOWLISTED_MAX_REDIRECTS_V1 + 1);
});

test('a caller’s own redirect: error is kept, and nothing is followed for it', async () => {
  const { sent, fetchImpl } = scriptedFetch([redirectTo('/graphql/'), answered('never')]);
  const response = await partnerFetch('https://api.v4.aave.com/graphql', { method: 'POST', redirect: 'error' }, { fetchImpl });
  assert.equal(response.status, 302);
  assert.deepEqual(sent.map((request) => [request.url, request.redirect]), [['https://api.v4.aave.com/graphql', 'error']]);
});

describe('a plugin redirect is checked against the plugin’s whole scope', () => {
  test('another host is refused even when the scope lists it, and the plugin credential never leaves its origin', async () => {
    const scope: PluginHttpScope = { pluginId: 'two-hosts', hosts: ['api.one.example', 'api.two.example'] };
    const { sent, fetchImpl } = scriptedFetch([redirectTo('https://api.two.example/v1/x'), answered('never')]);
    await assert.rejects(
      () => pluginScopedFetch(scope, 'https://api.one.example/v1/x', { headers: { 'x-api-key': 'plugin-secret' } }, { fetchImpl }),
      (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'redirect',
    );
    assert.deepEqual(sent.map((request) => [request.url, request.headers.get('x-api-key')]), [['https://api.one.example/v1/x', 'plugin-secret']]);
  });

  test('a same-origin hop outside the path prefixes is refused before it is asked', async () => {
    const { sent, fetchImpl } = scriptedFetch([redirectTo('/v1/swap', 307), answered('never')]);
    await assert.rejects(
      () => pluginScopedFetch(uniswapScope, 'https://trade-api.gateway.uniswap.org/v1/quote', { method: 'POST' }, { fetchImpl }),
      (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'path',
    );
    assert.equal(sent.length, 1);
  });

  test('a hop whose method the scope does not allow is refused: a POST-only scope never sends the GET a 302 asks for', async () => {
    const postOnly: PluginHttpScope = { ...uniswapScope, methods: ['POST'] };
    const { sent, fetchImpl } = scriptedFetch([redirectTo('/v1/quote/next'), answered('never')]);
    await assert.rejects(
      () => pluginScopedFetch(postOnly, 'https://trade-api.gateway.uniswap.org/v1/quote', { method: 'POST', body: '{}' }, { fetchImpl }),
      (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'method',
    );
    assert.equal(sent.length, 1);
  });

  test('a same-origin hop inside the scope is followed, credential and all', async () => {
    const { sent, fetchImpl } = scriptedFetch([redirectTo('/v1/quote/v2', 308), answered('{"quote":1}')]);
    const response = await pluginScopedFetch(uniswapScope, 'https://trade-api.gateway.uniswap.org/v1/quote',
      { method: 'POST', headers: { 'x-api-key': 'uniswap-secret' }, body: '{}' }, { fetchImpl });
    assert.equal(await response.text(), '{"quote":1}');
    assert.deepEqual(sent.map((request) => [request.url, request.method, request.headers.get('x-api-key')]), [
      ['https://trade-api.gateway.uniswap.org/v1/quote', 'POST', 'uniswap-secret'],
      ['https://trade-api.gateway.uniswap.org/v1/quote/v2', 'POST', 'uniswap-secret'],
    ]);
  });
});
