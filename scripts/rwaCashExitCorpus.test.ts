import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { OfficialAssetIdentityV1 } from '@mioagent/route-storage';

import {
  corpusV1,
  mergeTargetsV1,
  registryTargetsV1,
  reviewedRepresentationTargetsV1,
  type SupplyCorpusReaderV1,
  type UnderlyingCorpusReaderV1,
} from './rwaCashExitCorpus.js';

const NVDAC = '0x1111111111111111111111111111111111111111';
const NVDA_DSHARE = '0x2222222222222222222222222222222222222222';
const NVDA_WRAPPED = '0x3333333333333333333333333333333333333333';
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
        multiIssuerUnderlyings: 0,
      };
    },
    async listUnderlyings({ limit }) {
      return input.rows.slice(0, limit).map((row) => ({
        underlying: {
          underlyingKey: row.key,
          assetClass: 'equity' as const,
          canonicalName: row.key,
          displaySymbol: row.key.toUpperCase(),
          identifierScheme: 'dinari_stock_id' as const,
          identifierValue: row.key,
          sourceKind: 'dinari_stock_api' as const,
          sourceRef: 'test',
          observedAt: '2026-09-03T00:00:00.000Z',
        },
        representationCount: row.addresses.length,
        issuerIds: ['dinari'],
        liveRepresentationCount: row.addresses.length,
      }));
    },
    async representationsOf({ underlyingKey }) {
      const row = input.rows.find((candidate) => candidate.key === underlyingKey);
      return (row?.addresses ?? []).map((address) => ({
        chainId: 8453 as const,
        tokenAddress: address,
        underlyingKey,
        sourceKind: 'dinari_stock_api' as const,
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
        rows: [{ key: 'dinari:stock_id:nvda', addresses: [NVDA_DSHARE, NVDA_WRAPPED, EMPTY_CONTRACT] }],
      }),
      supplies: suppliesV1({
        [NVDA_DSHARE]: 'positive_supply',
        [NVDA_WRAPPED]: 'positive_supply',
        [EMPTY_CONTRACT]: 'zero_supply',
      }),
      limit: 10,
    });
    assert.deepEqual(
      targets.map((target) => target.tokenAddress),
      [NVDA_DSHARE, NVDA_WRAPPED],
    );
    // Two addresses, one security. Both are measured, because a wrapped dShare
    // and a dShare are different markets even where they are the same company.
    assert.equal(new Set(targets.map((t) => t.tokenAddress)).size, 2);
  });

  test('a representation nobody has read yet is measured, not assumed empty', async () => {
    // `supply_unknown` is OUR absence. Skipping it would hide the gap behind a
    // card that reads exactly like a contract with no tokens.
    const targets = await reviewedRepresentationTargetsV1({
      underlyings: underlyingsV1({ rows: [{ key: 'dinari:stock_id:nvda', addresses: [NVDA_DSHARE] }] }),
      supplies: suppliesV1({}),
      limit: 10,
    });
    assert.deepEqual(
      targets.map((target) => target.tokenAddress),
      [NVDA_DSHARE],
    );
  });

  test('a short page is refused rather than measured as if it were the corpus', async () => {
    await assert.rejects(
      reviewedRepresentationTargetsV1({
        underlyings: underlyingsV1({
          total: 130,
          rows: [{ key: 'dinari:stock_id:nvda', addresses: [NVDA_DSHARE] }],
        }),
        supplies: suppliesV1({ [NVDA_DSHARE]: 'positive_supply' }),
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
      { tokenAddress: NVDA_DSHARE, symbol: null, signalTicker: null, origin: 'reviewed_representation' },
    ]);
    // A Dinari dShare that gains a route has changed, but it has not become an
    // OFFICIAL ASSET, and nothing here lets it be reported as one.
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
      { tokenAddress: NVDA_DSHARE, symbol: null, signalTicker: null, origin: 'reviewed_representation' },
    ]);
    // Measuring one address twice in a pass writes two runs a minute apart and
    // lets the second be compared against the first as if the market had moved.
    assert.deepEqual(
      merged.map((target) => target.tokenAddress),
      [NVDAC, NVDA_DSHARE],
    );
  });
});
