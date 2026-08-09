import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  BASE_MCP_ALL_PLUGIN_HOSTS_V1,
  BASE_MCP_PLUGIN_HOSTS_V1,
} from './baseMcpPluginHosts.generated.js';
import {
  PluginHttpScopeError,
  baseMcpPluginScopeV1,
  pluginScopedFetch,
  type PluginHttpScope,
} from './httpAllowlist.js';

const ok = async () => new Response('{}', { status: 200 });

describe('a plugin known only from Base’s spec is pinned to its hosts', () => {
  test('an allowlisted host is reachable at any path or method', async () => {
    // The point of loosening: seventeen native plugins had no manifest, so the
    // path check blocked them outright. That was absent capability wearing a
    // security justification, not a boundary.
    const scope = baseMcpPluginScopeV1('opensea');
    assert.ok(scope);
    await pluginScopedFetch(scope, 'https://api.opensea.io/api/v2/anything', { method: 'POST' }, { fetchImpl: ok });
    await pluginScopedFetch(scope, 'https://api.opensea.io/some/other/path', {}, { fetchImpl: ok });
  });

  test('another plugin’s host is still refused', async () => {
    // Host pinning is the check that actually stops prompt injection: a right
    // path on the WRONG host is exfiltration.
    const scope = baseMcpPluginScopeV1('opensea')!;
    await assert.rejects(
      () => pluginScopedFetch(scope, 'https://api.bankr.bot/v1/x', {}, { fetchImpl: ok }),
      (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'host',
    );
  });

  test('a host that merely embeds an allowlisted one is refused', async () => {
    const scope = baseMcpPluginScopeV1('kyberswap')!;
    for (const url of [
      'https://aggregator-api.kyberswap.com.evil.test/route',
      'https://evil.test/?x=aggregator-api.kyberswap.com',
    ]) {
      await assert.rejects(
        () => pluginScopedFetch(scope, url, {}, { fetchImpl: ok }),
        (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'host',
        url,
      );
    }
  });

  test('a plugin Base does not publish gets no scope, so it makes no request', () => {
    // Null, not an empty allowlist. An unknown plugin is one nobody checked,
    // and `yo` named no API host at all — that is not a free pass either.
    assert.equal(baseMcpPluginScopeV1('definitely-not-a-plugin'), null);
    assert.equal(baseMcpPluginScopeV1('yo'), null);
  });
});

describe('a hand-written manifest keeps every check it declared', () => {
  const manifest: PluginHttpScope = {
    pluginId: 'uniswap',
    hosts: ['trade-api.gateway.uniswap.org'],
    methods: ['GET'],
    pathPrefixes: ['/v1/quote'],
  };

  test('a declared method list is still enforced', async () => {
    await assert.rejects(
      () =>
        pluginScopedFetch(
          manifest,
          'https://trade-api.gateway.uniswap.org/v1/quote',
          { method: 'POST' },
          { fetchImpl: ok },
        ),
      (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'method',
    );
  });

  test('a declared path prefix is still enforced', async () => {
    await assert.rejects(
      () =>
        pluginScopedFetch(
          manifest,
          'https://trade-api.gateway.uniswap.org/v1/swap',
          {},
          { fetchImpl: ok },
        ),
      (error: unknown) => error instanceof PluginHttpScopeError && error.code === 'path',
    );
  });
});

describe('the generated list is a boundary, not a scrape', () => {
  test('no social, chat or docs host reached the allowlist', () => {
    for (const banned of ['x.com', 'discord.gg', 't.me', 'pbs.twimg.com', 'github.com']) {
      assert.ok(!BASE_MCP_ALL_PLUGIN_HOSTS_V1.includes(banned), banned);
    }
    assert.equal(BASE_MCP_ALL_PLUGIN_HOSTS_V1.some((host) => /^docs\./.test(host)), false);
  });

  test('mcp.base.org and the RPC are not plugin hosts', () => {
    // Reached through the MCP client and the configured RPC respectively.
    // Letting a plugin call either through this gateway would route around the
    // credential handling each of them has of its own.
    for (const banned of ['mcp.base.org', 'mainnet.base.org']) {
      assert.ok(!BASE_MCP_ALL_PLUGIN_HOSTS_V1.includes(banned), banned);
    }
  });

  test('every entry is a bare hostname, never a URL, port or wildcard', () => {
    for (const host of BASE_MCP_ALL_PLUGIN_HOSTS_V1) {
      assert.match(host, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, host);
    }
  });

  test('all twenty native plugins are present', () => {
    assert.equal(Object.keys(BASE_MCP_PLUGIN_HOSTS_V1).length, 20);
  });
});
