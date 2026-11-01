import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { StillSpend, type StillSpendModelV1 } from '../src/still/StillSpend';
import { skyStateV1 } from '../src/still/skyState';
import { spendCountryDefaultV1, spendProductViewV1, spendSearchViewV1 } from '../src/still/spendView';

void React;

const GERMANY = { outcome: 'product', readAt: '2026-11-01T10:00:00.000Z', product: {
  id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', country: 'DE', inStock: true, recipientType: 'mixed', url: null,
  packages: [
    { value: '1GB, 7 Days', faceCurrency: 'USD', priceUsdc: '2.53' },
    { value: '10GB, 30 Days', faceCurrency: 'USD', priceUsdc: '13.25' },
    { value: 'Unlimited, 15 Days', faceCurrency: 'USD', priceUsdc: '40.00' },
  ],
} };

describe('what a loan could pay for, as the page says it', () => {
  it('lists products in stock, with the countries a regional plan covers', () => {
    assert.deepEqual(spendSearchViewV1({ outcome: 'products', products: [
      { id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', countries: ['DE'], inStock: true },
      { id: 'bitrefill-esim-europe', name: 'Bitrefill eSIM Europe', countries: ['AT', 'DE', 'FR'], inStock: true },
      { id: 'sold-out', name: 'Sold out', countries: ['DE'], inStock: false },
      { id: '../buy-products', name: 'Not a product', countries: [], inStock: true },
    ] }), { products: [
      { id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', coverage: null },
      { id: 'bitrefill-esim-europe', name: 'Bitrefill eSIM Europe', coverage: '3 countries' },
    ], error: null });
    assert.match(spendSearchViewV1({ outcome: 'unavailable', reason: 'bitrefill_rate_limited' }).error!, /could not be read just now/);
  });

  it('compares each price with the room, rounding the price up, and says nothing over a partial room', () => {
    const full = spendProductViewV1(GERMANY, { cents: '1325', complete: true }).product!;
    assert.deepEqual(full.packages.map((row) => [row.label, row.price, row.room]), [
      ['1GB, 7 Days', '2.53 USDC', 'within'], ['10GB, 30 Days', '13.25 USDC', 'within'], ['Unlimited, 15 Days', '40.00 USDC', 'over'],
    ]);
    const partial = spendProductViewV1(GERMANY, { cents: '1325', complete: false }).product!;
    assert.deepEqual(partial.packages.map((row) => row.room), ['within', 'within', null]);
    const signedOut = spendProductViewV1(GERMANY, null).product!;
    assert.deepEqual(signedOut.packages.map((row) => row.room), [null, null, null]);
    // A price of a fraction of a cent more is not "within" a room it does not fit.
    const odd = spendProductViewV1({ ...GERMANY, product: { ...GERMANY.product, packages: [{ value: '1GB', faceCurrency: 'USD', priceUsdc: '13.250001' }] } }, { cents: '1325', complete: true });
    assert.equal(odd.product!.packages[0]!.room, 'over');
  });

  it('a gift card shows its face value with its currency; a top-up says it needs the number', () => {
    const card = spendProductViewV1({ outcome: 'product', product: { id: 'amazon_de-germany', name: 'Amazon.de', recipientType: null,
      packages: [{ value: '50', faceCurrency: 'EUR', priceUsdc: '58.80' }] } }, null).product!;
    assert.deepEqual(card.packages[0], { label: '50 EUR', price: '58.80 USDC', room: null });
    assert.equal(card.needs, null);
    const topUp = spendProductViewV1({ outcome: 'product', product: { id: 'ortel-germany', name: 'Ortel', recipientType: 'phone_number', packages: [] } }, null).product!;
    assert.equal(topUp.needs, 'Buying it needs the phone number to top up.');
    assert.equal(spendProductViewV1({ outcome: 'unavailable' }, null).product, null);
  });

  it('starts in the reader’s own country when the page offers it', () => {
    assert.equal(spendCountryDefaultV1('fr-FR'), 'FR');
    assert.equal(spendCountryDefaultV1('en'), 'DE');
    assert.equal(spendCountryDefaultV1('xx-ZZ'), 'DE');
  });
});

describe('the Spend page', () => {
  const noop = () => {};
  const model = (overrides: Partial<StillSpendModelV1> = {}): StillSpendModelV1 => ({
    sky: skyStateV1({ now: new Date('2026-10-28T15:00:00Z') }), signedIn: true, signInHref: '/signin?next=%2Fspend',
    type: 'esim', onType: noop, country: 'DE', onCountry: noop, query: '', onQuery: noop, onSearch: noop,
    searching: false, products: [{ id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', coverage: null }], searchError: null,
    selected: 'bitrefill-esim-germany', onSelect: noop,
    product: spendProductViewV1(GERMANY, { cents: '1325', complete: true }).product, productLoading: false, productError: null,
    room: { cents: '1325', complete: true }, ...overrides,
  });

  it('says it cannot buy, shows each USDC price against the room, and names who sells', () => {
    const html = renderToStaticMarkup(<StillSpend model={model()} />);
    assert.match(html, /Nothing can be bought here yet\. Paying from Still, with the loan and the payment in one transaction, is the next step\./);
    assert.match(html, /<dt>10GB, 30 Days<\/dt><dd><span class="mono">13\.25 USDC<\/span><span class="still-spend-fit">within your room<\/span><\/dd>/);
    assert.match(html, /<dt>Unlimited, 15 Days<\/dt><dd><span class="mono">40\.00 USDC<\/span><span class="still-spend-fit">more than your room<\/span><\/dd>/);
    assert.match(html, /Your Still room now: \$13\.25\./);
    assert.match(html, /Bitrefill sells these under its own terms/);
    assert.match(html, /Not offered to US persons/);
    assert.doesNotMatch(html, /Buy|Pay now|<form/);
  });

  it('signed out, it offers sign-in instead of a comparison; gift cards ask for a brand', () => {
    const html = renderToStaticMarkup(<StillSpend model={model({ signedIn: false, room: null, product: spendProductViewV1(GERMANY, null).product })} />);
    assert.match(html, /<a href="\/signin\?next=%2Fspend">Sign in<\/a> to see which of these your Still room covers\./);
    assert.doesNotMatch(html, /within your room|more than your room/);
    const cards = renderToStaticMarkup(<StillSpend model={model({ type: 'giftcard', products: [], selected: null, product: null })} />);
    assert.match(cards, /<label class="still-borrow-label" for="[^"]+-brand">Brand<\/label>/);
    assert.match(cards, /Nothing in stock here for Germany\./);
  });
});
