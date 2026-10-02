import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryUnderlyingAssetRepository } from '@mioagent/route-storage';
import { parseCoinbaseStocksApiV1, officialCorpusHashV1 } from '@mioagent/rwa-official';
import { assembleMarketRealityIndexV1 } from '../lib/rwa-market-reality/src/engine.js';
import { bindCoinbaseStocksApiV1 } from './coinbaseStockBindings.js';

const parsed = parseCoinbaseStocksApiV1(
  readFileSync(
    new URL('../lib/rwa-official/test/fixtures/coinbase-stocks-api.json', import.meta.url),
    'utf8',
  ),
);
assert.ok(parsed.ok);
const assets = parsed.assets;
const at = '2026-10-02T15:00:00.000Z';

test('API-only stocks enter the consumer index by exact address and checked ISIN', async () => {
  const underlyings = createMemoryUnderlyingAssetRepository();
  const input = { assets, underlyings, sourceHash: officialCorpusHashV1(assets), observedAt: at };
  assert.equal((await bindCoinbaseStocksApiV1(input)).established, 58);
  const found = await underlyings.underlyingOf({
    chainId: 8453,
    tokenAddress: assets.find((a) => a.ticker === 'NFLXc')!.tokenAddress,
  });
  assert.equal(found!.underlying.underlyingKey, 'security:isin:US64110L1061');
  assert.equal(found!.binding.sourceKind, 'coinbase_stocks_api');
  assert.equal(found!.binding.evidenceStrength, 'reviewed_machine_address_mapping');
  assert.equal(found!.binding.observedBlockHash, null);
  const index = await assembleMarketRealityIndexV1(
    { underlyings, now: () => new Date(at) },
    { limit: 500, scope: 'coinbase_b20' },
  );
  assert.equal(index.entries.length, 58);
  assert.ok(index.entries.find((row) => row.displaySymbol === 'NFLX')!.coinbaseIssued);
  await bindCoinbaseStocksApiV1(input);
  assert.equal((await underlyings.listUnderlyings({ chainId: 8453, limit: 500 })).length, 58);
});

test('an existing chain mapping is preserved and conflicting ISINs are refused', async () => {
  const underlyings = createMemoryUnderlyingAssetRepository();
  const netflix = assets.find((a) => a.ticker === 'NFLXc')!;
  await bindCoinbaseStocksApiV1({
    assets: [netflix],
    underlyings,
    sourceHash: '11'.repeat(32),
    observedAt: at,
  });
  const original = (await underlyings.underlyingOf({
    chainId: 8453,
    tokenAddress: netflix.tokenAddress,
  }))!;
  await underlyings.bindRepresentation({
    ...original.binding,
    sourceKind: 'coinbase_b20_metadata',
    observedAt: at,
    observedBlockNumber: '52080000',
    observedBlockHash: '0x' + '22'.repeat(32),
    evidenceStrength: 'reviewed_issuer_identifier',
  });
  const before = await underlyings.underlyingOf({
    chainId: 8453,
    tokenAddress: netflix.tokenAddress,
  });
  const retained = await bindCoinbaseStocksApiV1({
    assets: [netflix],
    underlyings,
    sourceHash: '33'.repeat(32),
    observedAt: '2026-10-02T16:00:00.000Z',
  });
  assert.equal(retained.retained, 1);
  assert.deepEqual(
    await underlyings.underlyingOf({ chainId: 8453, tokenAddress: netflix.tokenAddress }),
    before,
  );
  const conflict = await bindCoinbaseStocksApiV1({
    assets: [{ ...netflix, underlyingIsin: 'US67066G1040' }],
    underlyings,
    sourceHash: '44'.repeat(32),
    observedAt: '2026-10-02T17:00:00.000Z',
  });
  assert.deepEqual(conflict.conflicts, [netflix.tokenAddress]);
  assert.deepEqual(
    await underlyings.underlyingOf({ chainId: 8453, tokenAddress: netflix.tokenAddress }),
    before,
  );
});
