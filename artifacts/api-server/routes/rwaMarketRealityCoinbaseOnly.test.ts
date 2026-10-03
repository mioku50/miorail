import assert from 'node:assert/strict';
import test from 'node:test';

import type { UnderlyingAssetRepositoryV1 } from '@mioagent/route-storage';

import { coinbaseOnlyUnderlyingsV1 } from './rwaMarketReality.js';

const binding = (tokenAddress: string, issuerId: string | null, sourceKind: string) => ({
  chainId: 8453,
  tokenAddress,
  underlyingKey: 'security:isin:US67066G1040',
  sourceKind,
  sourceRef: 'x',
  observedAt: '2026-10-03T00:00:00.000Z',
  sourceHash: 'ab'.repeat(32),
  issuerId,
});

test('the Stocks screens assemble Coinbase’s representation and no other issuer’s', async () => {
  // Operator, 2026-10-03: Backed and Dinari beside Coinbase confused people.
  const base = {
    representationsOf: async () => [
      binding('0xb20000000000000000000078ee7ce2fe4908108c', 'coinbase', 'coinbase_stocks_api'),
      // A binding written before issuer typing existed is Coinbase's by its source.
      binding('0xb200000000000000000000000000000000000001', null, 'coinbase_b20_metadata'),
      binding('0xa34c5e0000000000000000000000000000c495', 'backed', 'backed_assets_api'),
      binding('0x92ecf60000000000000000000000000000001b97', 'dinari', 'dinari_stock_api'),
    ],
    underlyingOf: async () => null,
  } as unknown as UnderlyingAssetRepositoryV1;
  const rows = await coinbaseOnlyUnderlyingsV1(base).representationsOf({
    chainId: 8453,
    underlyingKey: 'security:isin:US67066G1040',
  });
  assert.deepEqual(
    rows.map((row) => row.tokenAddress),
    ['0xb20000000000000000000078ee7ce2fe4908108c', '0xb200000000000000000000000000000000000001'],
  );
  // Everything else is the repository's own.
  assert.equal(coinbaseOnlyUnderlyingsV1(base).underlyingOf, base.underlyingOf);
});
