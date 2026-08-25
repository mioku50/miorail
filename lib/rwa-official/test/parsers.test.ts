import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { describe } from 'node:test';

import { parseBaseDocsCorpusV1 } from '../src/baseDocsCorpus.js';
import { parseBaseProductListV1 } from '../src/productList.js';
import { officialCorpusHashV1, officialDocumentHashV1 } from '../src/snapshot.js';

const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');

const DOCS = fixture('tokenized-stocks-on-base.md');
const LIST = fixture('brand-base-stocks.html');

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const REGISTRY = '0x3f3e8cf41cdd3b1d118c16471ab0113dfddd5cad';

describe('the technical corpus', () => {
  test('reads every issued asset, address first', () => {
    const parsed = parseBaseDocsCorpusV1(DOCS);
    assert.ok(parsed.ok);
    // Thirteen equities on 2026-08-25. The count is asserted so that an asset
    // silently disappearing from the document fails here.
    assert.equal(parsed.assets.length, 13);
    assert.deepEqual(
      parsed.assets.map((asset) => asset.ticker).sort(),
      ['AAPLc', 'AMZNc', 'COINc', 'CRCLc', 'GOOGLc', 'INTCc', 'METAc', 'MSFTc', 'MSTRc', 'NVDAc', 'SNDKc', 'SPCXc', 'TSLAc'],
    );
    for (const asset of parsed.assets) {
      assert.match(asset.tokenAddress, /^0x[0-9a-f]{40}$/, `${asset.ticker} must be normalized`);
    }
  });

  test('the oracle registry is not an asset', () => {
    const parsed = parseBaseDocsCorpusV1(DOCS);
    assert.ok(parsed.ok);
    // It sits in the same table and it is not a token. Rather than naming it,
    // the parser keeps only rows whose label is a bare ticker -- and reports
    // what it set aside, so a new non-asset row is visible instead of lost.
    assert.equal(parsed.assets.some((asset) => asset.tokenAddress === REGISTRY), false);
    assert.deepEqual(parsed.otherEntries, [{ label: 'Onchain Registry', address: REGISTRY }]);
  });

  test('each asset binds to the feed the same document names for it', () => {
    const parsed = parseBaseDocsCorpusV1(DOCS);
    assert.ok(parsed.ok);
    const apple = parsed.assets.find((asset) => asset.tokenAddress === AAPL);
    assert.equal(apple?.referenceFeedAddress, '0x787f13dea48db0897cbcdd985de77809d837f988');
    // Every one of the thirteen has a feed in this document. If that ever
    // stops being true the asset keeps its identity and loses its reference
    // value, which is the correct failure.
    assert.equal(parsed.assets.filter((asset) => asset.referenceFeedAddress === null).length, 0);
  });

  test('a feed is never bound by resemblance', () => {
    const parsed = parseBaseDocsCorpusV1(
      DOCS.replace('| Coinbase AAPL  |', '| Coinbase AAPL Inc |'),
    );
    assert.ok(parsed.ok);
    const apple = parsed.assets.find((asset) => asset.tokenAddress === AAPL);
    assert.equal(apple?.referenceFeedAddress, null);
    assert.equal(apple?.ticker, 'AAPLc');
  });

  test('a document without the corpus is a refusal, never an empty corpus', () => {
    const parsed = parseBaseDocsCorpusV1('# Tokenized Stocks on Base\n\nNothing here.\n');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.refusal, 'contract_address_table_missing');
  });

  test('the same address twice is a refusal', () => {
    const doubled = DOCS.replace(
      '| AMZNc            | `0xb200000000000000000000d9192b6B456483C2E8` |',
      '| AMZNc            | `0xb200000000000000000000C2e324d24d7eEcd1fb` |',
    );
    const parsed = parseBaseDocsCorpusV1(doubled);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.refusal, 'duplicate_address');
  });
});

describe('the product list', () => {
  test('reads the assets currently offered, symbol and address from one element', () => {
    const parsed = parseBaseProductListV1(LIST);
    assert.ok(parsed.ok);
    assert.deepEqual(
      parsed.assets.map((asset) => asset.ticker).sort(),
      ['AAPLc', 'GOOGLc', 'METAc', 'NVDAc'],
    );
    assert.equal(parsed.assets.find((asset) => asset.ticker === 'AAPLc')?.tokenAddress, AAPL);
    // The product surface publishes no reference feed, and inventing one from
    // the other source would attach evidence to a document that never said it.
    assert.equal(parsed.assets.every((asset) => asset.referenceFeedAddress === null), true);
  });

  test('markup that no longer carries the link is a refusal', () => {
    const parsed = parseBaseProductListV1('<div><a href="https://brand.base.org/stocks">Stocks</a></div>');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.refusal, 'no_asset_rows');
  });

  test('one symbol on two addresses stops the parse', () => {
    const conflicted = LIST.replace(
      '0xb200000000000000000000C2e324d24d7eEcd1fb',
      '0xb200000000000000000000dead0000000000ad01',
    ).concat(
      '<a aria-label="View AAPLc on BaseScan" href="https://basescan.org/token/0xb200000000000000000000C2e324d24d7eEcd1fb"></a>',
    );
    const parsed = parseBaseProductListV1(conflicted);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.refusal, 'ticker_maps_to_multiple_addresses');
  });
});

describe('snapshot hashes', () => {
  test('the corpus hash ignores document order and notices membership', () => {
    const parsed = parseBaseDocsCorpusV1(DOCS);
    assert.ok(parsed.ok);
    const reversed = [...parsed.assets].reverse();
    assert.equal(officialCorpusHashV1(parsed.assets), officialCorpusHashV1(reversed));
    assert.notEqual(officialCorpusHashV1(parsed.assets), officialCorpusHashV1(parsed.assets.slice(1)));
  });

  test('the document hash notices a change the corpus hash does not', () => {
    const parsed = parseBaseDocsCorpusV1(DOCS);
    const reworded = DOCS.replace('All feeds return 8 decimals', 'Every feed returns 8 decimals');
    const rewordedParse = parseBaseDocsCorpusV1(reworded);
    assert.ok(parsed.ok && rewordedParse.ok);
    assert.notEqual(officialDocumentHashV1(DOCS), officialDocumentHashV1(reworded));
    assert.equal(officialCorpusHashV1(parsed.assets), officialCorpusHashV1(rewordedParse.assets));
  });
});
