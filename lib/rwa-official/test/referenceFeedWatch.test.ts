import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  parseBaseDocsCorpusV1,
  parseBaseDocsFeedTableV1,
  parseCoinbaseStocksApiV1,
  watchReferenceFeedsV1,
  type ReferenceFeedWatchAssetV1,
} from '../src/index.js';

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
/** The page as Base served it on 2026-10-10: no address table, ten feeds. */
const current = read('list-tokenized-stocks-2026-10-10.md');
/** The page with both tables, as the corpus parser bound them. */
const older = read('list-tokenized-stocks.md');

test('the page that lost its address table still publishes its feeds, read on their own', () => {
  assert.equal(parseBaseDocsCorpusV1(current).ok, false);
  const table = parseBaseDocsFeedTableV1(current);
  assert.ok(table.ok);
  assert.deepEqual(table.feeds.map((feed) => feed.label), [
    'Coinbase AAPL', 'Coinbase AMZN', 'Coinbase GOOGL', 'Coinbase META', 'Coinbase MSFT',
    'Coinbase MSTR', 'Coinbase NVDA', 'Coinbase SNDK', 'Coinbase SPCX', 'Coinbase TSLA',
  ]);
  for (const feed of table.feeds) assert.match(feed.feedAddress, /^0x[0-9a-f]{40}$/);
});

test('on the page with both tables, every feed read on its own is one the corpus bound', () => {
  const corpus = parseBaseDocsCorpusV1(older);
  const table = parseBaseDocsFeedTableV1(older);
  assert.ok(corpus.ok && table.ok);
  const bound = new Set(corpus.assets.map((asset) => asset.referenceFeedAddress));
  assert.ok(table.feeds.length > 0);
  for (const feed of table.feeds) assert.ok(bound.has(feed.feedAddress), feed.label);
});

test('a page without the table, or with an empty or repeated one, is refused', () => {
  const refusal = (markdown: string) => {
    const table = parseBaseDocsFeedTableV1(markdown);
    return table.ok ? null : table.refusal;
  };
  assert.equal(refusal('# List Tokenized Stocks\n\nNo feeds here.'), 'feed_table_missing');
  assert.equal(refusal('| Feed | Address |\n| - | - |\n\n### Offchain'), 'no_feed_rows');
  const one = `0x${'1'.repeat(40)}`;
  const two = `0x${'2'.repeat(40)}`;
  assert.equal(refusal(`| Feed | Address |\n| - | - |\n| Coinbase AAPL | \`${one}\` |\n| Coinbase AAPL | \`${two}\` |`), 'duplicate_feed');
  assert.equal(refusal(`| Feed | Address |\n| - | - |\n| Coinbase AAPL | \`${one}\` |\n| Coinbase AMZN | \`${one}\` |`), 'duplicate_feed');
});

test('the table ends where its rows do, so the next section cannot leak into it', () => {
  const one = `0x${'1'.repeat(40)}`;
  const table = parseBaseDocsFeedTableV1(
    `| Feed | Address |\n| - | - |\n| Coinbase AAPL | \`${one}\` |\n\n| Ticker | Contract address |\n| - | - |\n| AAPLc | \`0x${'b'.repeat(40)}\` |`,
  );
  assert.ok(table.ok);
  assert.deepEqual(table.feeds, [{ label: 'Coinbase AAPL', feedAddress: one }]);
});

test('a feed Miorail holds matches; one it does not hold, or holds elsewhere, is to review', () => {
  const feed = (digit: string) => `0x${digit.repeat(40)}`;
  const asset = (ticker: string, held: string | null, referenceValuePublished = true): ReferenceFeedWatchAssetV1 => ({
    tokenAddress: `0xb200${ticker.toLowerCase().padEnd(36, '0').replace(/[^0-9a-f]/g, '0')}`,
    ticker, heldFeedAddress: held, referenceValuePublished,
  });
  const watch = watchReferenceFeedsV1({
    feeds: [
      { label: 'Coinbase AAPL', feedAddress: feed('1') },
      { label: 'Coinbase ARM', feedAddress: feed('2') },
      { label: 'Coinbase NVDA', feedAddress: feed('3') },
      { label: 'Coinbase ZZZ', feedAddress: feed('4') },
    ],
    assets: [
      asset('AAPLc', feed('1')),
      asset('ARMc', null),
      asset('NVDAc', feed('9')),
      asset('INTCc', null),
      asset('NFLXc', null, false),
    ],
  });
  assert.deepEqual(watch.matched, ['AAPLc']);
  assert.deepEqual(watch.unbound.map((row) => [row.ticker, row.feedAddress]), [['ARMc', feed('2')]]);
  assert.deepEqual(watch.moved.map((row) => [row.ticker, row.heldFeedAddress]), [['NVDAc', feed('9')]]);
  assert.deepEqual(watch.unmatched, [{ label: 'Coinbase ZZZ', feedAddress: feed('4'), candidates: 0 }]);
  // The issuer says these have a reference value; Miorail holds no feed.
  assert.deepEqual(watch.referenceValueWithoutFeed, ['ARMc', 'INTCc']);
});

test('a label two listed tokens answer to binds neither', () => {
  const watch = watchReferenceFeedsV1({
    feeds: [{ label: 'Coinbase AAPL', feedAddress: `0x${'1'.repeat(40)}` }],
    assets: [
      { tokenAddress: `0xb200${'1'.repeat(36)}`, ticker: 'AAPLc', heldFeedAddress: null, referenceValuePublished: false },
      { tokenAddress: `0xb200${'2'.repeat(36)}`, ticker: 'AAPL', heldFeedAddress: null, referenceValuePublished: false },
    ],
  });
  assert.deepEqual(watch.unbound, []);
  assert.equal(watch.unmatched[0]?.candidates, 2);
});

test('the issuer API says which tokens carry a reference value', () => {
  const fixture = JSON.parse(read('coinbase-stocks-api.json'));
  const netflix = fixture.tokens.find((row: { symbol: string }) => row.symbol === 'NFLXc');
  const parsed = parseCoinbaseStocksApiV1(JSON.stringify({ tokens: [
    { ...netflix, nav_price: 123.45, nav_price_updated_at: '2026-10-09T20:00:00Z' },
    { ...netflix, contract_address: `0xb200${'7'.repeat(36)}`, symbol: 'NFLXd', nav_price: undefined, nav_price_updated_at: undefined },
  ] }));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.assets.map((asset) => asset.referenceValuePublished), [true, false]);
  assert.deepEqual(parsed.assets.map((asset) => asset.referenceFeedAddress), [null, null]);
});
