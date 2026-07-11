import assert from 'node:assert/strict';
import test from 'node:test';
import { filterTrustedMorphoVaults, formatTrustedMorphoVaults } from './morphoVaultTrust.js';

const config = {
  minTvlUsd: 1_000_000,
  maxApyPct: 100,
  trustedVaultAddresses: new Set<string>(),
};

function vault(overrides: Record<string, unknown> = {}) {
  return {
    address: '0x1111111111111111111111111111111111111111',
    name: 'Curated USDC Vault',
    asset: {
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      symbol: 'USDC',
    },
    curator: '0x2222222222222222222222222222222222222222',
    apyPct: 5.25,
    feePct: 5,
    tvlUsd: 25_000_000,
    ...overrides,
  };
}

test('Morpho trust filter excludes extreme, test, low-TVL, wrong-chain, and non-USDC vaults', () => {
  const payload = {
    chain: 'base',
    vaults: [
      vault(),
      vault({ address: '0x3333333333333333333333333333333333333333', name: 'Test USDC 9999%', apyPct: 9999 }),
      vault({ address: '0x4444444444444444444444444444444444444444', name: 'Tiny USDC', tvlUsd: 10 }),
      vault({
        address: '0x5555555555555555555555555555555555555555',
        name: 'Wrong asset',
        asset: { address: '0x6666666666666666666666666666666666666666', symbol: 'USDC' },
      }),
      vault({ address: '0x7777777777777777777777777777777777777777', name: 'Unverified USDC', curator: undefined }),
    ],
  };

  const result = filterTrustedMorphoVaults(payload, config);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, 'Curated USDC Vault');
  const display = formatTrustedMorphoVaults(result);
  assert.match(display, /TVL:/);
  assert.match(display, /APY: 5\.25% \(Morpho apyPct\)/);
  assert.match(display, /Fee: 5\.00%/);
  assert.match(display, /Risk:/);
});

test('Morpho trust filter rejects non-Base payloads entirely', () => {
  assert.deepEqual(filterTrustedMorphoVaults({ chain: 'ethereum', vaults: [vault()] }, config), []);
});
