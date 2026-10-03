import assert from 'node:assert/strict';
import test from 'node:test';

import { stockInboxSizeCapsV1 } from './stockBriefRead.js';

const NOW = Date.parse('2026-10-02T21:00:00.000Z');
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const PFE = '0xb20000000000000000000018fe7ec7d6dfeeb528';
const at = '2026-10-02T17:08:11.000Z';

test('a holding is capped at the smallest measured size that covers it', () => {
  // Production: 0.00088158 NVDAc at $234.69 is about $0.21, so the $100 rung
  // is the largest cost change that is still this holder's news.
  assert.deepEqual(
    stockInboxSizeCapsV1({
      holdings: [{ tokenAddress: NVDA, tokens: '0.00088158' }],
      references: [{ tokenAddress: NVDA, price: 234.685929, at }],
      watched: new Set(),
      now: NOW,
    }),
    [{ address: NVDA, maxCashAtomic: '100000000' }],
  );
  // $5,000 of it: everything up to the $10,000 rung.
  assert.deepEqual(
    stockInboxSizeCapsV1({
      holdings: [{ tokenAddress: NVDA, tokens: '21.3' }],
      references: [{ tokenAddress: NVDA, price: 234.685929, at }],
      watched: new Set(),
      now: NOW,
    }),
    [{ address: NVDA, maxCashAtomic: '10000000000' }],
  );
});

test('no cap where Miorail cannot judge the size, or the holder asked for the market', () => {
  const caps = stockInboxSizeCapsV1({
    holdings: [
      // No reference price: the holding cannot be valued.
      { tokenAddress: PFE, tokens: '3' },
      // Watched as well as held: the reader asked for the whole market.
      { tokenAddress: NVDA, tokens: '1' },
    ],
    references: [{ tokenAddress: NVDA, price: 234.68, at }],
    watched: new Set([NVDA]),
    now: NOW,
  });
  assert.deepEqual(caps, []);
  // Larger than every measured size, or a stale price: no cap either.
  assert.deepEqual(
    stockInboxSizeCapsV1({
      holdings: [{ tokenAddress: NVDA, tokens: '1000' }],
      references: [{ tokenAddress: NVDA, price: 234.68, at }],
      watched: new Set(),
      now: NOW,
    }),
    [],
  );
  assert.deepEqual(
    stockInboxSizeCapsV1({
      holdings: [{ tokenAddress: NVDA, tokens: '1' }],
      references: [{ tokenAddress: NVDA, price: 234.68, at: '2026-09-20T00:00:00.000Z' }],
      watched: new Set(),
      now: NOW,
    }),
    [],
  );
});
