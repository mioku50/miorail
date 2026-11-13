import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COINBASE_STOCKS_MAX_PAGES_V1,
  COINBASE_STOCKS_MAX_RECORDS_V1,
  parseCoinbaseStocksApiV1,
  readCoinbaseStocksApiV1,
  officialCorpusHashV1,
  type OfficialSourceAssetV1,
} from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coinbase-stocks-api.json', import.meta.url), 'utf8'),
);
const netflix = fixture.tokens.find((row: { symbol: string }) => row.symbol === 'NFLXc');
const parse = (tokens: unknown[]) => parseCoinbaseStocksApiV1(JSON.stringify({ tokens }));

test('the issuer snapshot establishes all 26 launch addresses without NAV', () => {
  const result = parse(fixture.tokens);
  assert.ok(result.ok);
  assert.equal(result.assets.length, 58);
  const symbols =
    'NFLXc AVGOc LLYc GMEc DJTc RDDTc HTZc QUBTc HIMSc TTWOc MRNAc RBLXc BEc MRVLc ORCLc ASTSc AMDc PYPLc WENc DUOLc SOUNc CAKEc PTONc PMc NVAXc PFEc'.split(
      ' ',
    );
  for (const symbol of symbols) {
    const asset: OfficialSourceAssetV1 | undefined = result.assets.find(
      (row) => row.ticker === symbol,
    );
    assert.ok(asset, symbol);
    assert.match(asset.tokenAddress, /^0xb200[0-9a-f]{36}$/);
    assert.ok(asset.underlyingIsin);
    assert.equal(asset.tokenDecimals, 8);
    assert.equal(asset.referenceFeedAddress, null, 'a missing NAV does not invent a feed');
    assert.equal('totalSupplyAtomic' in asset, false);
    assert.equal('multiplierWad' in asset, false);
  }
});

test('protobuf omission of zero supply and optional NAV is accepted', () => {
  assert.ok(
    parse([
      {
        ...netflix,
        total_supply: undefined,
        nav_price: undefined,
        nav_price_updated_at: undefined,
      },
    ]).ok,
  );
  assert.ok(
    parse([{ ...netflix, total_supply: 0, nav_price: null, nav_price_updated_at: null }]).ok,
  );
});

test('malformed or truncated responses refuse the whole snapshot', () => {
  for (const body of ['{', '{}', '{"tokens":[]}', '{"tokens":null}'])
    assert.equal(parseCoinbaseStocksApiV1(body).ok, false);
  for (const change of [
    { contract_address: '0x' + 'a'.repeat(40) },
    { symbol: 'Netflix Inc' },
    { isin: 'US64110L1062' },
    { isin: 'NFLX' },
    { name: '' },
    { decimals: 8.5 },
    { decimals: -1 },
    { decimals: 256 },
    { multiplier: 0 },
    { multiplier: '1000000000000000000' },
    { total_supply: -1 },
    { total_supply: '420' },
    { nav_price: -2 },
    { nav_price_updated_at: 'not a date' },
    { redeem_paused: 'false' },
  ])
    assert.equal(parse([netflix, { ...netflix, ...change }]).ok, false, JSON.stringify(change));
  assert.equal(
    parse([
      netflix,
      { ...netflix, contract_address: netflix.contract_address.toUpperCase().replace('0X', '0x') },
    ]).ok,
    false,
  );
});

test('two addresses sharing a display symbol remain two issuer records', () => {
  const result = parse([
    netflix,
    { ...netflix, contract_address: '0xb200000000000000000000000000000000000001' },
  ]);
  assert.ok(result.ok);
  assert.equal(result.assets.length, 2);
});

test('identity hash ignores market movement but includes an ISIN reassignment', () => {
  const first = parse([netflix]);
  const moved = parse([
    {
      ...netflix,
      total_supply: 9999,
      multiplier: 1.02,
      nav_price: 123,
      nav_price_updated_at: '2026-10-02T14:00:00Z',
    },
  ]);
  const reassigned = parse([{ ...netflix, isin: 'US67066G1040' }]);
  assert.ok(first.ok && moved.ok && reassigned.ok);
  assert.equal(officialCorpusHashV1(first.assets), officialCorpusHashV1(moved.assets));
  assert.notEqual(officialCorpusHashV1(first.assets), officialCorpusHashV1(reassigned.assets));
});

const PAGE_URL = 'https://api.coinbase.com/v1/tokenized-stocks';
/** Every page asks for Coinbase's largest size, and the next keeps it (audit BASE-3). */
const FIRST = `${PAGE_URL}?page_size=500`;
const other = { ...netflix, contract_address: '0xb200000000000000000000000000000000000002' };
const pages =
  (bodies: Record<string, unknown>) =>
  async (url: string): Promise<{ ok: true; body: string } | { ok: false; detail: string }> => {
    const body = bodies[url];
    if (body instanceof Error) return { ok: false, detail: body.message };
    return { ok: true, body: typeof body === 'string' ? body : JSON.stringify(body) };
  };

test('one page of several is refused, so it can never withdraw the rest', () => {
  const page = parseCoinbaseStocksApiV1(JSON.stringify({ tokens: [netflix], next_page_token: 'MHhi' }));
  assert.ok(!page.ok && /next_page_token is set/.test(page.detail));
  for (const end of [{}, { next_page_token: '' }, { next_page_token: null }])
    assert.ok(parseCoinbaseStocksApiV1(JSON.stringify({ tokens: [netflix], ...end })).ok, JSON.stringify(end));
});

test('every page is read and handed over as one list', async () => {
  const asked: string[] = [];
  const fetchPage = pages({
    [FIRST]: { tokens: [netflix], next_page_token: 'MHhi/+=' },
    [`${FIRST}&page_token=MHhi%2F%2B%3D`]: { tokens: [other] },
  });
  const read = await readCoinbaseStocksApiV1({
    url: PAGE_URL,
    fetchPage: (url) => (asked.push(url), fetchPage(url)),
  });
  assert.deepEqual(asked, [FIRST, `${FIRST}&page_token=MHhi%2F%2B%3D`]);
  assert.ok(read.ok);
  const parsed = parseCoinbaseStocksApiV1(read.body);
  assert.ok(parsed.ok);
  assert.deepEqual(
    parsed.assets.map((asset) => asset.tokenAddress),
    [netflix.contract_address.toLowerCase(), other.contract_address],
  );
});

test('a page that fails makes the whole read fail, never a shorter list', async () => {
  const unreachable = await readCoinbaseStocksApiV1({
    url: PAGE_URL,
    fetchPage: pages({
      [FIRST]: { tokens: [netflix], next_page_token: 'p2' },
      [`${FIRST}&page_token=p2`]: new Error('http 503'),
    }),
  });
  assert.deepEqual(unreachable, { ok: false, detail: 'page 2: http 503' });
  const garbled = await readCoinbaseStocksApiV1({
    url: PAGE_URL,
    fetchPage: pages({
      [FIRST]: { tokens: [netflix], next_page_token: 'p2' },
      [`${FIRST}&page_token=p2`]: '<html>',
    }),
  });
  assert.ok(garbled.ok);
  assert.equal(parseCoinbaseStocksApiV1(garbled.body).ok, false);
  // A list that loops, or runs past the page bound, keeps its token and is refused.
  for (const read of [
    await readCoinbaseStocksApiV1({
      url: PAGE_URL,
      fetchPage: pages({
        [FIRST]: { tokens: [netflix], next_page_token: 'p2' },
        [`${FIRST}&page_token=p2`]: { tokens: [other], next_page_token: 'p2' },
      }),
    }),
    await readCoinbaseStocksApiV1({
      url: PAGE_URL,
      maxPages: 1,
      fetchPage: pages({ [FIRST]: { tokens: [netflix], next_page_token: 'p2' } }),
    }),
  ]) {
    assert.ok(read.ok);
    const parsed = parseCoinbaseStocksApiV1(read.body);
    assert.ok(!parsed.ok && /next_page_token is set/.test(parsed.detail));
  }
});

// Audit BASE-3 (2026-11-14): the parser refused any list of more than 500 records, the size of ONE page in
// Coinbase's OpenAPI ("Values above 500 are capped at 500"). Coinbase listed 348 on 2026-11-13, about ten
// more a day, so near the end of November every pass would have refused the whole list.
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...netflix, contract_address: `0xb200${i.toString(16).padStart(36, '0')}` }));

test('a list longer than one page of 500 is the whole list, and only a runaway one is refused', () => {
  for (const n of [348, 500, 501, 5_000]) {
    const parsed = parse(many(n));
    assert.ok(parsed.ok, String(n));
    assert.equal(parsed.assets.length, n);
  }
  const runaway = parse(many(5_001));
  assert.ok(!runaway.ok && /at most 5000 records/.test(runaway.detail));
});

test('an answer that ignores the page size is still read to its end: 501 records in six pages of 100', async () => {
  const rows = many(501);
  const bodies: Record<string, unknown> = {};
  for (let page = 0; page < 6; page += 1) {
    const url = page === 0 ? FIRST : `${FIRST}&page_token=p${page}`;
    bodies[url] = { tokens: rows.slice(page * 100, page * 100 + 100), ...(page < 5 ? { next_page_token: `p${page + 1}` } : {}) };
  }
  const read = await readCoinbaseStocksApiV1({ url: PAGE_URL, fetchPage: pages(bodies) });
  assert.ok(read.ok);
  const parsed = parseCoinbaseStocksApiV1(read.body);
  assert.ok(parsed.ok);
  assert.equal(parsed.assets.length, 501);
  assert.equal(COINBASE_STOCKS_MAX_PAGES_V1 * 100 >= COINBASE_STOCKS_MAX_RECORDS_V1, true, 'pages enough for the most records at the default size');
});
