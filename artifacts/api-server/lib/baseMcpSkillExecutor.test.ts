import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadSkillExecutorForMessage,
  loadSkillExecutor,
  SkillPathNotAllowedError,
} from './baseMcpSkillExecutor.js';

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('the skill executor loads ONLY when the user explicitly named the protocol', () => {
  assert.equal(loadSkillExecutorForMessage('what is the weather today')?.namespace, undefined);
  assert.equal(loadSkillExecutorForMessage('Show Moonwell USDC supply markets')?.namespace, 'moonwell');
  assert.equal(loadSkillExecutorForMessage('Quote 0.1 USDC to ETH')?.namespace, 'uniswap');
});

test('MCP-only skills without an HTTP manifest (e.g. Morpho) yield no executor', () => {
  assert.equal(loadSkillExecutor('morpho'), null);
  assert.equal(loadSkillExecutor('not-a-real-plugin'), null);
});

test('the execution plan exposes only the manifest-allowlisted paths for Moonwell', () => {
  const executor = loadSkillExecutor('moonwell')!;
  assert.ok(executor);
  assert.deepEqual(executor.allowedPaths, ['/v1/markets', '/v1/rates', '/v1/positions', '/v1/health', '/v1/rewards', '/v1/token-balance', '/v1/prepare']);
});

test('KyberSwap executor exposes only the T53 read route path plus the T56 route/build path', () => {
  const executor = loadSkillExecutor('kyberswap')!;
  assert.deepEqual(executor.allowedPaths, ['/base/api/v1/routes', '/base/api/v1/route/build']);
  assert.deepEqual(executor.manifest.allowlist.methods, ['GET', 'POST']);
});

test('Moonwell markets are reachable through the executor (gateway + manifest allowlist, no auth required)', async () => {
  const executor = loadSkillExecutor('moonwell')!;
  let capturedUrl: string | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ markets: [{ symbol: 'USDC' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await executor.request({ path: '/v1/markets?chain=base', method: 'GET' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { markets: [{ symbol: 'USDC' }] });
    assert.equal(capturedUrl, 'https://api.moonwell.fi/v1/markets?chain=base');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the executor rejects a path outside the manifest allowlist before reaching the gateway', async () => {
  const executor = loadSkillExecutor('moonwell')!;
  await assert.rejects(
    () => executor.request({ path: '/v1/admin/danger', method: 'POST' }),
    SkillPathNotAllowedError,
  );
});

test('prompt injection cannot redirect the executor to a foreign host: only the manifest host is ever used', async () => {
  const executor = loadSkillExecutor('uniswap')!;
  // Even if a caller passes an absolute-looking foreign URL as the "path",
  // the executor builds the URL from the manifest host, so the only way this
  // resolves is as a literal, non-matching path segment on the real host —
  // and it fails the pathPrefixes check.
  await assert.rejects(
    () => executor.request({ path: 'https://evil.example.com/v1/quote', method: 'POST' }),
    SkillPathNotAllowedError,
  );
});

test('Uniswap quote works through the executor in mcp mode without UNISWAP_API_KEY', async () => {
  const executor = loadSkillExecutor('uniswap')!;
  let capturedHeaders: Record<string, string> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({ quote: { output: { amount: '1' } } }), { status: 200 });
  }) as typeof fetch;
  try {
    await withEnv({ BASE_MCP_PLUGIN_MODE: undefined, UNISWAP_API_KEY: undefined, UNISWAP_MCP_GATEWAY_KEY: 'gateway-secret' }, async () => {
      const result = await executor.request({ path: '/v1/quote', method: 'POST', body: { amount: '1' } });
      assert.equal(result.status, 200);
    });
    assert.equal(capturedHeaders?.['x-api-key'], 'gateway-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
