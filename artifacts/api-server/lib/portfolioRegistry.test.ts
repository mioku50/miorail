import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';

import type { OfficialAssetIdentityV1 } from '@mioagent/route-storage';

import {
  clearPortfolioRegistryCacheForTests,
  portfolioRegistryMarksV1,
  portfolioRegistryRuntime,
  withRegistryMarksV1,
} from './portfolioRegistry.js';

const AAPLC = '0xb2000000000000000000009ee8a7ce0fd7aad1fb';
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const BCOIN = '0xbbcb0356bb9e6b3faa5cbf9e5f36185d53403ac9';
const COPY = '0x2a970e0000000000000000000000000000008636';
const OTHER = '0x3333333333333333333333333333333333333333';

function asset(tokenAddress: string, issuer: string, ticker: string): OfficialAssetIdentityV1 {
  return { chainId: 8453, tokenAddress, issuer, listings: [{ ticker }] } as unknown as OfficialAssetIdentityV1;
}

const REGISTRY = [asset(AAPLC, 'coinbase', 'AAPLc'), asset(NVDAC, 'coinbase', 'NVDAc'), asset(BCOIN, 'backed', 'bCOIN')];

afterEach(() => {
  clearPortfolioRegistryCacheForTests();
});

describe('a wallet’s tokens against the official registry', () => {
  test('the contract decides: official by address, a lookalike by its ticker at another address', () => {
    const marks = portfolioRegistryMarksV1(
      [
        // The real NVDAc calls itself NVDA onchain; its address is what counts.
        { symbol: 'NVDA', address: NVDAC.toUpperCase().replace('0X', '0x') },
        // Seen in production: 15 "AAPLc" named "Apple Inc," at another address.
        { symbol: 'AAPLc', address: COPY },
      ],
      REGISTRY,
    );
    assert.deepEqual(marks.get(NVDAC), { standing: 'official', ticker: 'NVDAc' });
    assert.deepEqual(marks.get(COPY), { standing: 'lookalike', ticker: 'AAPLc', officialAddress: AAPLC });
  });

  test('a Coinbase stock’s own ticker is protected, in any case; a Backed root is not', () => {
    const marks = portfolioRegistryMarksV1(
      [
        { symbol: 'nvda', address: COPY },
        { symbol: 'COIN', address: OTHER },
      ],
      REGISTRY,
    );
    assert.deepEqual(marks.get(COPY), { standing: 'lookalike', ticker: 'NVDAc', officialAddress: NVDAC });
    // "bCOIN" protects "bCOIN" only: every token called COIN is not a copy of it.
    assert.equal(marks.has(OTHER), false);
    assert.equal(portfolioRegistryMarksV1([{ symbol: 'bcoin', address: OTHER }], REGISTRY).get(OTHER)?.ticker, 'bCOIN');
  });

  test('a token the registry says nothing about carries no mark', () => {
    assert.equal(portfolioRegistryMarksV1([{ symbol: 'SPY', address: OTHER }], REGISTRY).size, 0);
  });
});

describe('the portfolio answer', () => {
  test('off mainnet the registry is never read', async () => {
    let reads = 0;
    const original = portfolioRegistryRuntime.officialAssets;
    portfolioRegistryRuntime.officialAssets = async () => {
      reads += 1;
      return REGISTRY;
    };
    try {
      const tokens = [{ symbol: 'AAPLc', address: COPY }];
      assert.deepEqual(await withRegistryMarksV1(tokens, 'sepolia'), tokens);
      assert.equal(reads, 0);
      const marked = await withRegistryMarksV1(tokens, 'mainnet');
      assert.equal(marked[0]?.registry?.standing, 'lookalike');
    } finally {
      portfolioRegistryRuntime.officialAssets = original;
    }
  });

  test('a registry Miorail could not read leaves every token unmarked', async () => {
    const original = portfolioRegistryRuntime.officialAssets;
    portfolioRegistryRuntime.officialAssets = async () => {
      throw new Error('connection refused');
    };
    try {
      const tokens = [{ symbol: 'AAPLc', address: COPY }];
      const answered = await withRegistryMarksV1(tokens, 'mainnet');
      assert.deepEqual(answered, tokens);
      assert.equal('registry' in answered[0]!, false);
    } finally {
      portfolioRegistryRuntime.officialAssets = original;
    }
  });
});
