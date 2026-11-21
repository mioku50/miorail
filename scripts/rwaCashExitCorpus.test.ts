import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { OfficialAssetIdentityV1 } from '@mioagent/route-storage';

import {
  CORPUS_PAGE_LIMIT_V1,
  corpusV1,
  listedOfficialAssetsV1,
  mergeTargetsV1,
  registryTargetsV1,
  reopenLineupTargetsV1,
  reviewedRepresentationTargetsV1,
  weekendPriceFromRunV1,
  type SupplyCorpusReaderV1,
  type UnderlyingCorpusReaderV1,
} from './rwaCashExitCorpus.js';

const NVDAC = '0x1111111111111111111111111111111111111111';
/** Two reviewed representations of one company the registry no longer lists by name. */
const NVDA_FIRST = '0x2222222222222222222222222222222222222222';
const NVDA_SECOND = '0x3333333333333333333333333333333333333333';
const NVIDIA = 'security:isin:US67066G1040';
const EMPTY_CONTRACT = '0x4444444444444444444444444444444444444444';

function underlyingsV1(input: {
  total?: number;
  rows: { key: string; addresses: string[] }[];
}): UnderlyingCorpusReaderV1 {
  return {
    async underlyingCounts() {
      return {
        underlyings: input.total ?? input.rows.length,
        boundRepresentations: input.rows.reduce((sum, row) => sum + row.addresses.length, 0),
      };
    },
    async listUnderlyings({ limit }) {
      return input.rows.slice(0, limit).map((row) => ({
        underlying: {
          underlyingKey: row.key,
          assetClass: 'equity' as const,
          canonicalName: row.key,
          displaySymbol: row.key.toUpperCase(),
          identifierScheme: 'isin' as const,
          identifierValue: row.key,
          sourceKind: 'coinbase_stocks_api' as const,
          sourceRef: 'test',
          observedAt: '2026-09-03T00:00:00.000Z',
        },
        representationCount: row.addresses.length,
        issuerIds: ['coinbase'],
        liveRepresentationCount: row.addresses.length,
        representationCountsByIssuer: { coinbase: row.addresses.length },
      }));
    },
    async representationsOf({ underlyingKey }) {
      const row = input.rows.find((candidate) => candidate.key === underlyingKey);
      return (row?.addresses ?? []).map((address) => ({
        chainId: 8453 as const,
        tokenAddress: address,
        underlyingKey,
        sourceKind: 'coinbase_stocks_api' as const,
        sourceRef: 'test',
        observedAt: '2026-09-03T00:00:00.000Z',
      }));
    },
  };
}

function suppliesV1(states: Record<string, 'positive_supply' | 'zero_supply'>): SupplyCorpusReaderV1 {
  return {
    async readSupplies({ tokenAddresses }) {
      // Only the two fields the selection reads. The rest of the row lives in
      // Postgres and is nobody's business here — a second implementation of a
      // supply row is exactly the fake that drifts from what the DB refuses.
      return tokenAddresses
        .filter((address) => states[address])
        .map((address) => ({ tokenAddress: address, state: states[address]! })) as Awaited<
        ReturnType<SupplyCorpusReaderV1['readSupplies']>
      >;
    },
  };
}

describe('which representations the cash-exit pass measures', () => {
  test('the default corpus is everything reviewed, not one issuer’s registry', () => {
    // The bug this file exists to stop: the pass read `official_assets` (13
    // listings) while the cards came from `representation_underlying` (130
    // addresses), so 96 cards said "not measured" about the market when the
    // sentence was about us.
    assert.equal(corpusV1([]), 'reviewed');
    assert.equal(corpusV1(['--corpus', 'official']), 'official');
    assert.throws(() => corpusV1(['--corpus', 'everything']), /--corpus takes one of/);
  });

  test('tokens outstanding is the gate, and it is not a quality ranking', async () => {
    const targets = await reviewedRepresentationTargetsV1({
      underlyings: underlyingsV1({
        rows: [{ key: NVIDIA, addresses: [NVDA_FIRST, NVDA_SECOND, EMPTY_CONTRACT] }],
      }),
      supplies: suppliesV1({
        [NVDA_FIRST]: 'positive_supply',
        [NVDA_SECOND]: 'positive_supply',
        [EMPTY_CONTRACT]: 'zero_supply',
      }),
      limit: 10,
    });
    assert.deepEqual(
      targets.map((target) => target.tokenAddress),
      [NVDA_FIRST, NVDA_SECOND],
    );
    // Two addresses, one security. Both are measured, because two contracts are
    // two markets even where they are the same company.
    assert.equal(new Set(targets.map((t) => t.tokenAddress)).size, 2);
  });

  test('a representation nobody has read yet is measured, not assumed empty', async () => {
    // `supply_unknown` is OUR absence. Skipping it would hide the gap behind a
    // card that reads exactly like a contract with no tokens.
    const targets = await reviewedRepresentationTargetsV1({
      underlyings: underlyingsV1({ rows: [{ key: NVIDIA, addresses: [NVDA_FIRST] }] }),
      supplies: suppliesV1({}),
      limit: 10,
    });
    assert.deepEqual(
      targets.map((target) => target.tokenAddress),
      [NVDA_FIRST],
    );
  });

  test('a short page is refused rather than measured as if it were the corpus', async () => {
    await assert.rejects(
      reviewedRepresentationTargetsV1({
        underlyings: underlyingsV1({
          total: 130,
          rows: [{ key: NVIDIA, addresses: [NVDA_FIRST] }],
        }),
        supplies: suppliesV1({ [NVDA_FIRST]: 'positive_supply' }),
        limit: 1,
      }),
      /raise --underlying-limit rather than measuring a silent subset/,
    );
  });

  test('only a registry member carries the ticker a signal may name', () => {
    const registry = registryTargetsV1([
      {
        tokenAddress: NVDAC.toUpperCase(),
        listings: [{ ticker: 'NVDAc', currentlyListed: true }],
      } as unknown as OfficialAssetIdentityV1,
    ]);
    assert.deepEqual(registry, [
      {
        tokenAddress: NVDAC,
        symbol: 'NVDAc',
        signalTicker: 'NVDAc',
        origin: 'official_registry',
      },
    ]);
    const merged = mergeTargetsV1(registry, [
      { tokenAddress: NVDA_FIRST, symbol: null, signalTicker: null, origin: 'reviewed_representation' },
    ]);
    // A reviewed representation the registry does not list that gains a route
    // has changed, but it has not become an OFFICIAL ASSET, and nothing here
    // lets it be reported as one.
    assert.deepEqual(
      merged.map((target) => target.signalTicker),
      ['NVDAc', null],
    );
  });

  test('an address in both corpora is measured once, under the registry’s name', () => {
    const registry = registryTargetsV1([
      {
        tokenAddress: NVDAC,
        listings: [{ ticker: 'NVDAc', currentlyListed: true }],
      } as unknown as OfficialAssetIdentityV1,
    ]);
    const merged = mergeTargetsV1(registry, [
      { tokenAddress: NVDAC, symbol: null, signalTicker: null, origin: 'reviewed_representation' },
      { tokenAddress: NVDA_FIRST, symbol: null, signalTicker: null, origin: 'reviewed_representation' },
    ]);
    // Measuring one address twice in a pass writes two runs a minute apart and
    // lets the second be compared against the first as if the market had moved.
    assert.deepEqual(
      merged.map((target) => target.tokenAddress),
      [NVDAC, NVDA_FIRST],
    );
  });
});

describe('the official registry a pass reads', () => {
  function registryOfV1(size: number) {
    const asked: number[] = [];
    return {
      asked,
      reader: {
        async officialAssets(input: { limit: number }) {
          asked.push(input.limit);
          return Array.from(
            { length: Math.min(size, input.limit) },
            (_, index) => ({ tokenAddress: `0x${index.toString(16).padStart(40, '0')}` }) as unknown as OfficialAssetIdentityV1,
          );
        },
      },
    };
  }

  test('the whole registry is read in one page while it fits', async () => {
    // 288 listed on 2026-10-31, after Coinbase added 49 stocks in a day.
    const registry = registryOfV1(288);
    const assets = await listedOfficialAssetsV1(registry.reader);
    assert.equal(assets.length, 288);
    assert.deepEqual(registry.asked, [CORPUS_PAGE_LIMIT_V1]);
  });

  test('a full page is refused, since nothing says it was the whole registry', async () => {
    await assert.rejects(
      listedOfficialAssetsV1(registryOfV1(CORPUS_PAGE_LIMIT_V1 + 1).reader),
      /page through it rather than measuring a silent subset/,
    );
  });
});

// Audit 11-20 OPS-1: the reopen game's five stocks get a pass of their own.
describe('the reopen lineup pass', () => {
  const target = (tokenAddress: string, symbol: string) => ({ tokenAddress, symbol, signalTicker: null, origin: 'reviewed_representation' as const });
  const ids: Record<string, { symbol: string; coinbase: boolean } | null> = {
    '0xa1': { symbol: 'NVDA', coinbase: true },
    // Another issuer's NVDA is another question.
    '0xa2': { symbol: 'NVDA', coinbase: false },
    '0xa3': { symbol: 'TSLA', coinbase: true },
    '0xa4': { symbol: 'NFLX', coinbase: true },
    '0xa5': null,
  };

  test('only Coinbase tokens of lineup companies, and the companies it found none for', async () => {
    const picked = await reopenLineupTargetsV1({
      targets: Object.keys(ids).map((address) => target(address, 'X')),
      identify: async (address) => ids[address] ?? null,
    });
    assert.deepEqual(picked.targets.map((row) => row.tokenAddress), ['0xa1', '0xa3']);
    assert.deepEqual(picked.missing, ['AAPL', 'AMZN', 'MSTR']);
  });

  const side = (direction: 'buy' | 'sell', over: Record<string, unknown> = {}) => ({
    direction,
    requestedCashAtomic: '100000000',
    effectivePriceAtomic: '18712000000',
    effectivePriceDecimals: 8,
    reference: { valueAtomic: '18700000000', decimals: 8, referenceUpdatedAt: '2026-11-23T01:00:12.000Z' },
    ...over,
  });

  test('a run prices the stock only with a buy and a sell at $100, each beside its reference', () => {
    assert.equal(weekendPriceFromRunV1({ marketRealitySnapshots: [side('buy'), side('sell')] }), true);
    assert.equal(weekendPriceFromRunV1({ marketRealitySnapshots: [side('buy')] }), false);
    assert.equal(weekendPriceFromRunV1({ marketRealitySnapshots: [side('buy'), side('sell', { effectivePriceAtomic: null })] }), false);
    assert.equal(weekendPriceFromRunV1({ marketRealitySnapshots: [side('buy'), side('sell', { requestedCashAtomic: '1000000000' })] }), false);
    assert.equal(weekendPriceFromRunV1({ marketRealitySnapshots: [side('buy'), side('sell', { reference: { valueAtomic: '1', decimals: 8, referenceUpdatedAt: null } })] }), false);
    assert.equal(weekendPriceFromRunV1({ marketRealitySnapshots: null }), false);
    assert.equal(weekendPriceFromRunV1({}), false);
  });
});
