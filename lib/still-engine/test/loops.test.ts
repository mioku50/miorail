import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';

import { LOOP_BRANDS_V1, loopBrandByIdV1, loopBrandOfV1, loopBrandProductsV1 } from '../src/loops.js';
import { STOCKS } from '../src/registry.js';

const token = (id: string) => STOCKS.find((stock) => stock.id === id)!.token;

// Real Bitrefill product ids, read from its catalogue through still_find_spend on 2026-11-17.
const REAL_V1: ReadonlyArray<[string, string, string]> = [
  ['AAPLc', 'itunes-germany', 'apple'],
  ['AAPLc', 'apple-united-kingdom', 'apple'],
  ['AAPLc', 'apple-france', 'apple'],
  ['AMZNc', 'amazon_de-germany', 'amazon'],
  ['AMZNc', 'amazon-uk', 'amazon'],
  ['AMZNc', 'amazon_fr-france', 'amazon'],
  ['GOOGLc', 'google-play-germany', 'google'],
  ['GOOGLc', 'google-play-united-kingdom', 'google'],
  ['METAc', 'meta-quest-germany', 'meta'],
  ['METAc', 'meta-quest-eu', 'meta'],
  ['METAc', 'meta-quest-uk-united-kingdom', 'meta'],
  ['MSFTc', 'xbox-germany', 'microsoft'],
  ['MSFTc', 'xbox-currency-united-kingdom', 'microsoft'],
  ['MSFTc', 'xbox-game-pass-ultimate-uk', 'microsoft'],
];

describe('a Loop: a loan against a company pays that company’s card', () => {
  it('knows every brand card Bitrefill sold on 2026-11-17, by the stock it needs', () => {
    for (const [collateral, productId, brand] of REAL_V1) {
      assert.equal(loopBrandOfV1({ collateralTokenAddress: token(collateral), productId })?.brand, brand, productId);
      // The facts carry the token in lower case; a checksummed one is the same token.
      assert.equal(loopBrandOfV1({ collateralTokenAddress: token(collateral).toLowerCase(), productId })?.brand, brand, productId);
    }
  });

  it('is not a Loop when the card is another company’s', () => {
    assert.equal(loopBrandOfV1({ collateralTokenAddress: token('AAPLc'), productId: 'amazon_de-germany' }), null);
    assert.equal(loopBrandOfV1({ collateralTokenAddress: token('MSFTc'), productId: 'itunes-germany' }), null);
    assert.equal(loopBrandOfV1({ collateralTokenAddress: token('AMZNc'), productId: 'amazonas-tours' }), null, 'a prefix needs its separator');
  });

  it('is never a Loop against NVIDIA, SpaceX or Tesla: Bitrefill sells no card of theirs', () => {
    for (const id of ['NVDAc', 'SPCXc', 'TSLAc']) {
      for (const [, productId] of REAL_V1) assert.equal(loopBrandOfV1({ collateralTokenAddress: token(id), productId }), null, `${id} ${productId}`);
    }
    assert.ok(!LOOP_BRANDS_V1.some((row) => ['NVDAc', 'SPCXc', 'TSLAc'].includes(row.collateral)));
  });

  it('is never a Loop against gold, bitcoin or ether, or when the loan paid nothing', () => {
    assert.equal(loopBrandOfV1({ collateralTokenAddress: `0x${'1'.repeat(40)}`, productId: 'itunes-germany' }), null);
    for (const productId of [null, undefined, '', 'ITUNES-GERMANY', 'itunes germany', `itunes-${'x'.repeat(100)}`]) {
      assert.equal(loopBrandOfV1({ collateralTokenAddress: token('AAPLc'), productId }), null, String(productId));
    }
  });

  it('names a brand once, for a stock Still accepts', () => {
    assert.equal(new Set(LOOP_BRANDS_V1.map((row) => row.brand)).size, LOOP_BRANDS_V1.length);
    for (const row of LOOP_BRANDS_V1) assert.ok(STOCKS.some((stock) => stock.id === row.collateral), row.collateral);
  });
});

// 2026-11-19: /loops sent every brand to Spend's front page. A link names the brand, Spend searches its word, and
// keeps only the cards that make a Loop: "Xbox" in DE also found Kinguin, G2A and Call of Duty points.
test('a brand is found by its id, and a search keeps only the cards of that brand', () => {
  assert.equal(loopBrandByIdV1('apple')?.search, 'Apple');
  assert.equal(loopBrandByIdV1('nvidia'), null);
  assert.equal(loopBrandByIdV1(null), null);
  const found = [{ id: 'kinguin-gift-card-international' }, { id: 'call-of-duty_-points-xbox-version' }, { id: 'g2a-international' }, { id: 'xbox-germany' }];
  assert.deepEqual(loopBrandProductsV1('microsoft', found), [{ id: 'xbox-germany' }]);
  assert.deepEqual(loopBrandProductsV1('apple', [{ id: 'itunes-germany' }, { id: 'media-markt-germany' }, { id: 'apple-united-kingdom' }]),
    [{ id: 'itunes-germany' }, { id: 'apple-united-kingdom' }]);
  for (const row of LOOP_BRANDS_V1) assert.ok(row.search.length > 0 && row.search.length <= 40, row.brand);
});
