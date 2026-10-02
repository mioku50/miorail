import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  parseCoinbaseStocksApiV1,
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
