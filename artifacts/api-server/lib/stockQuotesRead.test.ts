import assert from 'node:assert/strict';
import test from 'node:test';

import { readStockQuotesV1, stockIconPathV1 } from './stockQuotesRead.js';

const NOW = new Date('2026-10-03T14:00:00Z');
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const COINC = '0xb2000000000000000000000000000000000c0c0c';
const BNVDA = '0x1111111111111111111111111111111111111111';

test('the list is Coinbase’s stocks as the corpus binds them, named by Coinbase', async () => {
  const sinceAsked: Date[] = [];
  const result = await readStockQuotesV1(NOW, {
    prices: async (since) => {
      sinceAsked.push(since);
      return [
        { token: NVDAC, at: '2026-10-03T13:10:00.000Z', mid: 234.5 },
        // Priced and bound, but absent from Coinbase's API: listed, unnamed.
        { token: COINC, at: '2026-10-03T13:20:00.000Z', mid: 310 },
        // Another issuer's contract: never on this list.
        { token: BNVDA, at: '2026-10-03T13:30:00.000Z', mid: 233 },
      ];
    },
    meta: async () =>
      new Map([
        [NVDAC, { tokenAddress: NVDAC, symbol: 'NVDAc', name: 'NVIDIA Corporation', iconUrl: 'https://metadata.coinbase.com/equity_icons/x.png' }],
      ]),
    identify: async (tokenAddress) =>
      tokenAddress === NVDAC
        ? { underlyingKey: 'security:isin:US67066G1040' }
        : tokenAddress === COINC
          ? { underlyingKey: 'security:isin:US19260Q1076' }
          : null,
  });
  assert.equal(sinceAsked[0]!.toISOString(), '2026-10-02T12:00:00.000Z');
  assert.deepEqual(
    result.rows.map((row) => [row.tokenAddress, row.tokenSymbol, row.companyName, row.iconPath, row.priceUsd]),
    [
      [COINC, null, null, null, 310],
      [NVDAC, 'NVDAc', 'NVIDIA Corporation', stockIconPathV1(NVDAC), 234.5],
    ],
  );
});
