import assert from 'node:assert/strict';
import { test } from 'node:test';

import { citedListingsV1 } from '../src/officialAssets.js';

// A retired source is no longer read, so its rows stay "listed" forever. On
// 2026-10-10 a paid identity answer still cited `base_docs_technical` for
// NVDAc, three days after Base took that table down.
const row = (sourceKind: string, currentlyListed = true) => ({ sourceKind, currentlyListed });

test('a retired source is not cited while a source still read lists the address', () => {
  const cited = citedListingsV1([row('base_docs_technical'), row('base_product_list'), row('coinbase_stocks_api')]);
  assert.deepEqual(cited.map((listing) => listing.sourceKind), ['base_product_list', 'coinbase_stocks_api']);
});

test('a row a read source dropped is still cited, as dropped', () => {
  const cited = citedListingsV1([row('base_docs_technical'), row('base_product_list', false), row('coinbase_stocks_api')]);
  assert.deepEqual(
    cited.map((listing) => [listing.sourceKind, listing.currentlyListed]),
    [['base_product_list', false], ['coinbase_stocks_api', true]],
  );
});

test('with no source still read listing it, every row is cited rather than none', () => {
  // The standing these rows decide is still OFFICIAL here, and the official
  // worker fails on this state; citing nothing would contradict the standing.
  const rows = [row('base_docs_technical'), row('base_product_list', false)];
  assert.deepEqual(citedListingsV1(rows), rows);
});
