import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchBackedBaseTokensV1,
  isinUnderlyingKeyV1,
  reviewedBackedBaseRepresentationsV1,
} from '../src/backedAssetsApi.js';

const ASSET = {
  id: 'c1077d76-ba02-4ab1-bd91-db0d18191c1a',
  name: 'Backed NVIDIA Corp',
  symbol: 'bNVDA',
  isin: 'CH1173294336',
  underlyingSymbol: 'NVDA',
  underlyingIsin: 'US67066G1040',
  isTradingHalted: false,
  deployments: [
    {
      address: '0xA34C5E0ABE843E10461E2C9586EA03E55DBCC495',
      network: 'Base',
      wrapperAddress: '0x7E8101A1C322D394B3961498C7D40D2DFA94C392',
    },
    { address: '0x1111111111111111111111111111111111111111', network: 'Ethereum' },
  ],
};

test('Backed mapping joins exact Base addresses to underlying ISIN, never ticker', () => {
  const rows = reviewedBackedBaseRepresentationsV1([ASSET]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.tokenAddress, row.representationKind, row.underlyingKey]),
    [
      [
        '0x7e8101a1c322d394b3961498c7d40d2dfa94c392',
        'non_rebasing_erc4626_wrapper',
        'security:isin:US67066G1040',
      ],
      [
        '0xa34c5e0abe843e10461e2c9586ea03e55dbcc495',
        'rebasing_erc20',
        'security:isin:US67066G1040',
      ],
    ],
  );
  assert.equal(isinUnderlyingKeyV1('us67066g1040'), 'security:isin:US67066G1040');
});

test('Backed fetch refuses a successful empty Base corpus', async () => {
  const result = await fetchBackedBaseTokensV1({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          nodes: [{ ...ASSET, deployments: [] }],
          page: { currentPage: 0, hasNextPage: false },
        }),
      ),
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'unparsable',
    detail: 'the successful bTokens corpus named no exact Base representations',
  });
});
