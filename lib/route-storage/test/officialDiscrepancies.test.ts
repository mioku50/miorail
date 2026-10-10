import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  officialSourceDiscrepanciesV1,
  type OfficialMembershipRowV1,
  type OfficialSourceKindV1,
} from '../src/officialAssets.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const NEW = '0xb200000000000000000000000000000000000002';
const SHOWN = '0xb200000000000000000000000000000000000003';
const ORPHAN = '0xb200000000000000000000000000000000000004';

const TICKERS: Record<string, string> = { [AAPL]: 'AAPLc', [NEW]: 'NEWc', [SHOWN]: 'SHOWNc', [ORPHAN]: 'ORPHc' };
function row(tokenAddress: string, sourceKind: OfficialSourceKindV1, currentlyListed = true): OfficialMembershipRowV1 {
  return { tokenAddress, sourceKind, ticker: TICKERS[tokenAddress]!, lastSeenAt: '2026-10-07T18:52:30.918Z', currentlyListed };
}

test('absence from the product page is not a disagreement; an asset only the page shows is', () => {
  // 127 issued and 10 on offer printed 117 "disagreements" every hour and put
  // "the reviewed sources do not agree" on 117 cards.
  const found = officialSourceDiscrepanciesV1({
    reviewedKinds: ['base_product_list', 'coinbase_stocks_api'],
    rows: [
      row(AAPL, 'coinbase_stocks_api'), row(AAPL, 'base_product_list'),
      row(NEW, 'coinbase_stocks_api'),
      row(SHOWN, 'base_product_list'),
    ],
  });
  assert.deepEqual(found, [{
    kind: 'listed_in_one_source', tokenAddress: SHOWN, ticker: 'SHOWNc',
    listedIn: ['base_product_list'], missingFrom: ['coinbase_stocks_api'],
  }]);
});

test('the product page rotating an asset off is not a delisting; the API dropping one is', () => {
  const found = officialSourceDiscrepanciesV1({
    reviewedKinds: ['base_product_list', 'coinbase_stocks_api'],
    rows: [row(AAPL, 'coinbase_stocks_api'), row(AAPL, 'base_product_list', false), row(NEW, 'coinbase_stocks_api', false)],
  });
  assert.deepEqual(found, [{
    kind: 'delisted_by_source', tokenAddress: NEW, ticker: 'NEWc',
    sourceKind: 'coinbase_stocks_api', lastSeenAt: '2026-10-07T18:52:30.918Z',
  }]);
});

test('a retired source is no place an asset goes missing from, but what only it lists is still reported', () => {
  const found = officialSourceDiscrepanciesV1({
    reviewedKinds: ['base_docs_technical', 'coinbase_stocks_api'],
    rows: [
      // Added by the API after the page stopped: not "missing from the docs".
      row(NEW, 'coinbase_stocks_api'),
      // Dropped from the docs table before it was retired: not a delisting now.
      row(AAPL, 'base_docs_technical', false), row(AAPL, 'coinbase_stocks_api'),
      // Kept official by the frozen page alone: still a disagreement.
      row(ORPHAN, 'base_docs_technical'),
    ],
  });
  assert.deepEqual(found, [{
    kind: 'listed_in_one_source', tokenAddress: ORPHAN, ticker: 'ORPHc',
    listedIn: ['base_docs_technical'], missingFrom: ['coinbase_stocks_api'],
  }]);
});
