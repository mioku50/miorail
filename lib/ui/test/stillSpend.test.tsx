import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { StillSpend, type StillSpendModelV1 } from '../src/still/StillSpend';
import { skyStateV1 } from '../src/still/skyState';
import { spendCountryDefaultV1, spendOrderErrorV1, spendOrderViewV1, spendPayOpenV1, spendProductViewV1, spendSearchViewV1 } from '../src/still/spendView';

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

  it('measures a price against a whole room only, and a price over it fills the bar', () => {
    const full = spendProductViewV1(GERMANY, { cents: '1325', complete: true }).product!;
    assert.deepEqual(full.packages.map((row) => row.share), [253 / 1325, 1, 1]);
    // A partial room is a floor: a share of it would overstate the price's weight.
    assert.deepEqual(spendProductViewV1(GERMANY, { cents: '1325', complete: false }).product!.packages.map((row) => row.share), [null, null, null]);
    assert.deepEqual(spendProductViewV1(GERMANY, { cents: '0', complete: true }).product!.packages.map((row) => row.share), [null, null, null]);
    assert.deepEqual(spendProductViewV1(GERMANY, null).product!.packages.map((row) => row.share), [null, null, null]);
  });

  it('a gift card shows its face value with its currency; a top-up says it needs the number', () => {
    const card = spendProductViewV1({ outcome: 'product', product: { id: 'amazon_de-germany', name: 'Amazon.de', recipientType: null,
      packages: [{ value: '50', faceCurrency: 'EUR', priceUsdc: '58.80' }] } }, null).product!;
    assert.deepEqual(card.packages[0], { value: '50', label: '50 EUR', price: '58.80 USDC', room: null, share: null, payable: false });
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

describe('paying from Still, as the page says it', () => {
  const OPEN = { ...GERMANY, checkout: { enabled: true, available: true, capAtomic: '100000000' } };

  it('offers payment only where the server pays this product, and only under its cap', () => {
    const view = spendProductViewV1({ ...OPEN, product: { ...OPEN.product, packages: [...OPEN.product.packages, { value: 'Unlimited, 90 Days', faceCurrency: 'USD', priceUsdc: '100.000001' }] } }, null).product!;
    assert.deepEqual(view.packages.map((row) => [row.value, row.payable]), [['1GB, 7 Days', true], ['10GB, 30 Days', true], ['Unlimited, 15 Days', true], ['Unlimited, 90 Days', false]]);
    assert.equal(view.cap, '100 USDC');
    assert.deepEqual(spendProductViewV1(GERMANY, null).product!.packages.map((row) => row.payable), [false, false, false]);
    assert.equal(spendProductViewV1({ ...OPEN, checkout: { enabled: true, available: false, capAtomic: '100000000' } }, null).product!.cap, null);
    assert.equal(spendPayOpenV1({ checkout: { enabled: true } }), true);
    assert.equal(spendPayOpenV1({ checkout: { enabled: 'yes' } }), false);
    assert.equal(spendPayOpenV1(undefined), false);
  });

  it('reads an opened invoice for its owner, with Bitrefill’s state in words and only its own links', () => {
    const order = (priceAtomic: string, status: unknown = { status: 'payment_confirmed', accessLink: 'https://www.bitrefill.com/order/1', esimInstallLink: null }) => spendOrderViewV1({
      order: { orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', productName: 'Bitrefill eSIM Germany', packageValue: '10GB, 30 Days', priceAtomic,
        expiresAt: '2026-11-01T12:15:00.000Z', paymentLink: 'https://www.bitrefill.com/invoice/x?token=t' }, status });
    assert.deepEqual(order('13250000'), { orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', productName: 'Bitrefill eSIM Germany', packageValue: '10GB, 30 Days',
      priceUsdc: '13.25', priceAtomic: '13250000', expiresAt: '2026-11-01T12:15:00.000Z', orderLink: 'https://www.bitrefill.com/order/1',
      status: 'Payment confirmed', delivered: false, esimInstallLink: null });
    assert.equal(order('13000000')!.priceUsdc, '13.00');
    assert.equal(order('13250001')!.priceUsdc, '13.250001');
    // No status read: the invoice page stands in, and no state is claimed.
    assert.deepEqual([order('13250000', null)!.status, order('13250000', null)!.orderLink], [null, 'https://www.bitrefill.com/invoice/x?token=t']);
    assert.equal(order('13250000', { status: 'complete', accessLink: 'https://evil.example/order' })!.orderLink, 'https://www.bitrefill.com/invoice/x?token=t');
    assert.equal(order('13250000', { status: 'complete' })!.delivered, true);
    assert.equal(spendOrderViewV1({ order: { orderId: 'x' } }), null);
  });

  it('says each refusal in the reader’s words, and anything unknown as nothing paid', () => {
    assert.match(spendOrderErrorV1('spend_over_cap'), /at most 100 USDC/);
    assert.match(spendOrderErrorV1('bitrefill_invoice_price_changed'), /different price/);
    assert.match(spendOrderErrorV1('API error: 500 Internal Server Error'), /Nothing was paid/);
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
    assert.match(html, /<li class="still-spend-price" data-fit="within"><span class="still-spend-price-top"><span class="still-spend-price-label">10GB, 30 Days<\/span><span class="mono still-spend-price-amount">13\.25 USDC<\/span><\/span><span class="still-spend-meter" aria-hidden="true"><span style="width:100%"><\/span><\/span><span class="still-spend-price-foot"><span class="still-spend-fit">Within your room<\/span><\/span><\/li>/);
    assert.match(html, /<li class="still-spend-price" data-fit="over"><span class="still-spend-price-top"><span class="still-spend-price-label">Unlimited, 15 Days<\/span><span class="mono still-spend-price-amount">40\.00 USDC<\/span><\/span><span class="still-spend-meter" aria-hidden="true"><span style="width:100%"><\/span><\/span><span class="still-spend-price-foot"><span class="still-spend-fit">More than your room<\/span><\/span><\/li>/);
    assert.match(html, /<span class="still-spend-price-label">1GB, 7 Days<\/span>.*?<span style="width:19%"><\/span>/);
    assert.match(html, /<span class="still-spend-room-label">Your Still room now<\/span><span class="still-spend-room-amount">\$13\.25<\/span>/);
    assert.match(html, /Bitrefill sells these under its own terms/);
    assert.match(html, /Not offered to US persons/);
    assert.doesNotMatch(html, /Buy|Pay now|<form/);
  });

  it('signed out, it offers sign-in instead of a comparison; gift cards ask for a brand', () => {
    const html = renderToStaticMarkup(<StillSpend model={model({ signedIn: false, room: null, product: spendProductViewV1(GERMANY, null).product })} />);
    assert.match(html, /<a href="\/signin\?next=%2Fspend">Sign in<\/a> to see which of these your Still room covers\./);
    assert.doesNotMatch(html, /within your room|more than your room|still-spend-meter/i);
    const cards = renderToStaticMarkup(<StillSpend model={model({ type: 'giftcard', products: [], selected: null, product: null })} />);
    assert.match(cards, /<label class="still-borrow-label" for="[^"]+-brand">Brand<\/label>/);
    assert.match(cards, /Nothing in stock here for Germany\./);
  });

  it('with paying open, a price under the cap offers Pay with Still, and a chosen one asks for the receipt email', () => {
    const pay = { chosen: null, onChoose: noop, email: '', onEmail: noop, creating: false, error: null, onCreate: noop };
    const open = { ...GERMANY, checkout: { enabled: true, available: true, capAtomic: '100000000' } };
    const html = renderToStaticMarkup(<StillSpend model={model({ product: spendProductViewV1(open, { cents: '1325', complete: true }).product, pay })} />);
    assert.match(html, /Pay with Still: a loan for the exact price pays Bitrefill in the same transaction/);
    assert.equal((html.match(/>Pay with Still<\/button>/g) ?? []).length, 3);
    assert.doesNotMatch(html, /Email for Bitrefill/);
    const chosen = renderToStaticMarkup(<StillSpend model={model({ type: 'giftcard', product: spendProductViewV1(open, null).product, pay: { ...pay, chosen: '10GB, 30 Days', email: 'buyer@example.com' } })} />);
    assert.match(chosen, /13\.25 USDC for Bitrefill eSIM Germany · 10GB, 30 Days/);
    assert.match(chosen, /Email for Bitrefill’s receipt/);
    assert.match(chosen, /Never buy a gift card because someone asked you to pay them with one/);
    assert.match(chosen, />Open invoice and choose collateral<\/button>/);
    // Without the switch there is no button and the page still says nothing can be bought.
    const closed = renderToStaticMarkup(<StillSpend model={model({ pay: null })} />);
    assert.doesNotMatch(closed, /Pay with Still<\/button>/);
    assert.match(closed, /Nothing can be bought here yet/);
  });
});
