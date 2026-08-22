import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASE_MCP_PROVIDER_LINK_HOSTS_V1,
  baseMcpProviderCtaV1,
} from './baseMcpProviderLinks.js';

describe('provider CTAs come from the registry, never from a model', () => {
  it('an unknown plugin gets no link rather than a guessed one', () => {
    assert.equal(baseMcpProviderCtaV1({ pluginId: 'not-a-plugin' }), null);
    assert.equal(baseMcpProviderCtaV1({ pluginId: '' }), null);
  });

  it('a known plugin with no object gets its home page', () => {
    assert.deepEqual(baseMcpProviderCtaV1({ pluginId: 'venice' }), {
      label: 'Explore models on Venice',
      url: 'https://venice.ai/models',
    });
  });

  it('an object id becomes a deep link named after the object', () => {
    assert.deepEqual(baseMcpProviderCtaV1({ pluginId: 'opensea', objectId: 'gribbits', objectName: 'GRiBBiTS' }), {
      label: 'View GRiBBiTS on OpenSea',
      url: 'https://opensea.io/collection/gribbits',
    });
  });

  it('a token address deep-links, and a symbol never does', () => {
    const address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    assert.equal(
      baseMcpProviderCtaV1({ pluginId: 'gmgn', objectId: address, objectName: 'USDC' })?.url,
      `https://gmgn.ai/base/token/${address}`,
    );
    // A symbol is not an identifier — two tokens share one — so it must not
    // become a path segment that looks like it identifies something.
    assert.equal(
      baseMcpProviderCtaV1({ pluginId: 'gmgn', objectId: 'USDC' })?.url,
      'https://gmgn.ai/?chain=base',
    );
  });

  it('a hostile object id cannot leave the provider host', () => {
    for (const hostile of [
      '//evil.example/x',
      'https://evil.example',
      '../../evil',
      'gribbits/../../../etc',
      'a b',
      'x'.repeat(400),
    ]) {
      const cta = baseMcpProviderCtaV1({ pluginId: 'opensea', objectId: hostile });
      assert.ok(cta, 'a refused id must still yield the home page');
      assert.equal(new URL(cta.url).host, 'opensea.io', `escaped with: ${hostile}`);
    }
  });

  it('every reachable host is https and pinned', () => {
    for (const [pluginId] of Object.entries({ venice: 1, opensea: 1, avantis: 1, balancer: 1, gmgn: 1 })) {
      const cta = baseMcpProviderCtaV1({ pluginId });
      assert.ok(cta);
      const url = new URL(cta.url);
      assert.equal(url.protocol, 'https:');
      assert.ok(BASE_MCP_PROVIDER_LINK_HOSTS_V1.includes(url.host), `${url.host} is not a declared host`);
    }
  });
});
