import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { StillLoanShare, StillLoanShared, StillSpend, StillSpendPaid, StillSpendShared, StillSpendWalletPay, type StillSpendModelV1 } from '../src/still/StillSpend';
import type { StillSpendWalletModelV1 } from '../src/still/useSpendWalletPayment';
import { skyStateV1 } from '../src/still/skyState';
import {
  SPEND_COUNTRIES_V1,
  spendCountryDefaultV1,
  spendCountryOptionsV1,
  spendOrderErrorV1,
  spendOrderViewV1,
  spendPayOpenV1,
  spendPhoneDraftV1,
  spendPhonePrefixesTextV1,
  spendProductViewV1,
  spendSearchViewV1,
  loanShareTextV1,
  loanShareViewV1,
  spendSharePathV1,
  spendShareTextV1,
  spendShareViewV1,
  spendOwedCentsV1,
  spendUsdcTextV1,
  spendWalletCoversV1,
  spendWalletViewV1,
} from '../src/still/spendView';

void React;

// Bitrefill's own reading of a top-up, made up in its shape: the number it goes to is the buyer's to give.
const AIRTEL = { outcome: 'product', readAt: '2026-11-01T10:00:00.000Z', product: {
  id: 'airtel-india', name: 'Airtel India', country: 'IN', inStock: true, recipientType: 'phone_number', url: null,
  packages: [{ value: '10', faceCurrency: 'INR', priceUsdc: '0.11' }, { value: '120', faceCurrency: 'INR', priceUsdc: '1.31' }],
} };

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

  it('says a product sold only after Bitrefill’s prepayment steps cannot be paid from Still', () => {
    const prepaid = spendProductViewV1({ ...GERMANY, product: { ...GERMANY.product, recipientType: 'none', prepayment: true },
      checkout: { enabled: true, available: false, capAtomic: '100000000', phone: null } }, null).product!;
    assert.match(prepaid.needs ?? '', /^Bitrefill sells this only after steps such as the player’s game ID/);
    assert.ok(prepaid.packages.every((row) => !row.payable));
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
    assert.deepEqual(card.packages[0], { value: '50', label: '50 EUR', price: '58.80 USDC', room: null, share: null, payable: false, wallet: null });
    assert.equal(card.needs, null);
    const topUp = spendProductViewV1({ outcome: 'product', product: { id: 'ortel-germany', name: 'Ortel', recipientType: 'phone_number', packages: [] } }, null).product!;
    assert.equal(topUp.needs, 'Buying it needs the phone number to top up.');
    assert.equal(topUp.phone, null);
    assert.equal(spendProductViewV1({ outcome: 'unavailable' }, null).product, null);
  });

  it('starts in the reader’s own country when the page offers it', () => {
    assert.equal(spendCountryDefaultV1('fr-FR'), 'FR');
    assert.equal(spendCountryDefaultV1('ru-RU'), 'RU');
    assert.equal(spendCountryDefaultV1('kk-KZ'), 'KZ');
    assert.equal(spendCountryDefaultV1('en'), 'DE');
    assert.equal(spendCountryDefaultV1('xx-ZZ'), 'DE');
  });

  it('offers every inhabited country but the embargoed ones, listed by name', () => {
    const codes = new Set<string>(SPEND_COUNTRIES_V1);
    assert.equal(codes.size, SPEND_COUNTRIES_V1.length);
    for (const code of ['KZ', 'RU', 'IN', 'ID', 'PH', 'NG', 'UZ', 'KG', 'GE', 'AM', 'US', 'DE']) assert.equal(codes.has(code), true, code);
    for (const code of ['CU', 'IR', 'KP', 'SY', 'AQ']) assert.equal(codes.has(code), false, code);
    const names = spendCountryOptionsV1().map((country) => country.name);
    assert.equal(names.length, SPEND_COUNTRIES_V1.length);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
    assert.equal(spendCountryOptionsV1().find((country) => country.code === 'KZ')?.name, 'Kazakhstan');
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
      packageLabel: '10GB, 30 Days', priceUsdc: '13.25', priceAtomic: '13250000', expiresAt: '2026-11-01T12:15:00.000Z', orderLink: 'https://www.bitrefill.com/order/1',
      status: 'Payment confirmed', delivered: false, esimInstallLink: null, refillTo: null });
    assert.equal(order('13000000')!.priceUsdc, '13.00');
    assert.equal(order('13250001')!.priceUsdc, '13.250001');
    // No status read: the invoice page stands in, and no state is claimed.
    assert.deepEqual([order('13250000', null)!.status, order('13250000', null)!.orderLink], [null, 'https://www.bitrefill.com/invoice/x?token=t']);
    assert.equal(order('13250000', { status: 'complete', accessLink: 'https://evil.example/order' })!.orderLink, 'https://www.bitrefill.com/invoice/x?token=t');
    assert.equal(order('13250000', { status: 'complete' })!.delivered, true);
    assert.equal(spendOrderViewV1({ order: { orderId: 'x' } }), null);
    // A top-up's order says its face value and the number it goes to, as the server holds it.
    const topUp = spendOrderViewV1({ order: { orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', productName: 'Airtel India', packageValue: '10', faceCurrency: 'INR',
      priceAtomic: '110000', expiresAt: '2026-11-01T12:15:00.000Z', paymentLink: null, refillTo: '+919876543210' }, status: null })!;
    assert.deepEqual([topUp.packageLabel, topUp.priceUsdc, topUp.refillTo], ['10 INR', '0.11', '+919876543210']);
    assert.equal(spendOrderViewV1({ order: { orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', productName: 'Airtel India', packageValue: '10', priceAtomic: '110000',
      expiresAt: '2026-11-01T12:15:00.000Z', refillTo: '919876543210<script>' }, status: null })!.refillTo, null);
  });

  it('a top-up is paid only with its number, written with the operator’s calling code', () => {
    const open = { ...AIRTEL, checkout: { enabled: true, available: true, capAtomic: '100000000', phone: { callingCode: '91' } } };
    const view = spendProductViewV1(open, { cents: '171', complete: true }).product!;
    assert.deepEqual(view.phone, { callingCode: '91', prefixes: ['91'] });
    assert.equal(view.needs, null);
    assert.deepEqual(view.packages.map((row) => [row.label, row.price, row.payable, row.room]), [['10 INR', '0.11 USDC', true, 'within'], ['120 INR', '1.31 USDC', true, 'within']]);
    // Without the calling code from the server there is no number to ask for, so nothing to pay.
    const unsaid = spendProductViewV1({ ...open, checkout: { enabled: true, available: true, capAtomic: '100000000', phone: null } }, null).product!;
    assert.deepEqual([unsaid.phone, unsaid.packages.map((row) => row.payable), unsaid.needs], [null, [false, false], 'Buying it needs the phone number to top up.']);
    assert.equal(spendProductViewV1({ ...open, checkout: { ...open.checkout, phone: { callingCode: '+91' } } }, null).product!.phone, null);
    // Where countries share a code, the server names this country's own prefixes; a list that is not of this code is no rule.
    assert.deepEqual(spendProductViewV1({ ...open, checkout: { ...open.checkout, phone: { callingCode: '7', prefixes: ['76', '77'] } } }, null).product!.phone, { callingCode: '7', prefixes: ['76', '77'] });
    assert.equal(spendProductViewV1({ ...open, checkout: { ...open.checkout, phone: { callingCode: '7', prefixes: ['91'] } } }, null).product!.phone, null);
    // An eSIM never asks for a number, whatever the answer says.
    assert.equal(spendProductViewV1({ ...GERMANY, checkout: open.checkout }, null).product!.phone, null);
  });

  it('reads a number as Still will send it, and only with the calling code', () => {
    const india = { callingCode: '91', prefixes: ['91'] }, kazakhstan = { callingCode: '7', prefixes: ['76', '77'] };
    for (const written of ['+91 98765 43210', '0091 98765-43210', '(+91) 98765.43210', '919876543210']) assert.equal(spendPhoneDraftV1(written, india), '+919876543210', written);
    for (const written of ['98765 43210', '+1 202 555 0100', '+91 12', 'call me', '+91 98765 43210 98765', '']) assert.equal(spendPhoneDraftV1(written, india), null, written);
    assert.equal(spendPhoneDraftV1('+7 777 123 4567', kazakhstan), '+77771234567');
    // A Russian number shares +7, and a Kazakh operator cannot top it up.
    assert.equal(spendPhoneDraftV1('+7 912 345 6789', kazakhstan), null);
    assert.equal(spendPhonePrefixesTextV1(kazakhstan), '+7 6 or +7 7');
    assert.equal(spendPhonePrefixesTextV1({ callingCode: '1', prefixes: ['1809', '1829', '1849'] }), '+1 809, +1 829 or +1 849');
    assert.equal(spendPhonePrefixesTextV1(india), '+91');
  });

  it('says each refusal in the reader’s words, and anything unknown as nothing paid', () => {
    assert.match(spendOrderErrorV1('spend_over_cap'), /at most 100 USDC/);
    assert.match(spendOrderErrorV1('bitrefill_invoice_price_changed'), /different price/);
    // Bitrefill's own words, as the server cleaned them, or the plain fact when it said nothing.
    assert.equal(spendOrderErrorV1('bitrefill_refused: Minimum order is 1 USD'), 'Bitrefill refused this invoice and said: “Minimum order is 1 USD” Nothing was paid.');
    assert.equal(spendOrderErrorV1('bitrefill_refused'), 'Bitrefill refused this invoice. Nothing was paid.');
    assert.equal(spendOrderErrorV1('bitrefill_guest_refused: invalid_client'), 'Bitrefill is not letting Still in right now, so Spend cannot open an invoice for any product. Nothing was paid.');
    assert.match(spendOrderErrorV1('spend_product_prepayment'), /^Bitrefill sells this only after steps such as the player’s game ID/);
    // Still's own limit is said to be Still's, never Bitrefill's.
    assert.equal(spendOrderErrorV1('spend_rate_limited'), 'Still opens at most six invoices an hour for one wallet, and you have opened six. Try again later; nothing was opened.');
    assert.match(spendOrderErrorV1('spend_phone_needed'), /phone number to top up/);
    assert.match(spendOrderErrorV1('spend_phone_invalid'), /country code/);
    assert.match(spendOrderErrorV1('spend_product_not_buyable'), /account or a username/);
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
    assert.match(html, /Paying with Still is not open on this server\. The prices below are <strong>Bitrefill<\/strong>’s own, in USDC\./);
    // Who sells is said where the page begins.
    assert.match(html, /gift cards from <strong class="still-provider">Bitrefill<\/strong>, priced in USDC\./);
    assert.match(html, /<li class="still-spend-price" data-fit="within"><span class="still-spend-price-top"><span class="still-spend-price-label">10GB, 30 Days<\/span><span class="mono still-spend-price-amount">13\.25 USDC<\/span><\/span><span class="still-spend-meter" aria-hidden="true"><span style="width:100%"><\/span><\/span><span class="still-spend-price-foot"><span class="still-spend-fits"><span class="still-spend-fit">Within your room<\/span><\/span><\/span><\/li>/);
    assert.match(html, /<li class="still-spend-price" data-fit="over"><span class="still-spend-price-top"><span class="still-spend-price-label">Unlimited, 15 Days<\/span><span class="mono still-spend-price-amount">40\.00 USDC<\/span><\/span><span class="still-spend-meter" aria-hidden="true"><span style="width:100%"><\/span><\/span><span class="still-spend-price-foot"><span class="still-spend-fits"><span class="still-spend-fit">More than your room<\/span><\/span><\/span><\/li>/);
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
    const pay = { chosen: null, onChoose: noop, email: '', onEmail: noop, phone: '', onPhone: noop, creating: false, error: null, onCreate: noop };
    const open = { ...GERMANY, checkout: { enabled: true, available: true, capAtomic: '100000000' } };
    const html = renderToStaticMarkup(<StillSpend model={model({ product: spendProductViewV1(open, { cents: '1325', complete: true }).product, pay })} />);
    assert.match(html, /Pay with Still: a loan for the exact price pays <strong>Bitrefill<\/strong>, or the USDC already in your wallet does, with no loan\. Your own wallet approves either\./);
    assert.equal((html.match(/>Pay with Still<\/button>/g) ?? []).length, 3);
    assert.doesNotMatch(html, /Email for Bitrefill/);
    const chosen = renderToStaticMarkup(<StillSpend model={model({ type: 'giftcard', product: spendProductViewV1(open, null).product, pay: { ...pay, chosen: '10GB, 30 Days', email: 'buyer@example.com' } })} />);
    assert.match(chosen, /13\.25 USDC for Bitrefill eSIM Germany · 10GB, 30 Days/);
    assert.match(chosen, /Email for Bitrefill’s receipt/);
    assert.match(chosen, /Never buy a gift card because someone asked you to pay them with one/);
    assert.match(chosen, />Open invoice and choose collateral<\/button>/);
    // The checkout opens right under the chosen price, before the prices after it.
    const first = renderToStaticMarkup(<StillSpend model={model({ product: spendProductViewV1(open, null).product, pay: { ...pay, chosen: '1GB, 7 Days' } })} />);
    const at = (text: string) => first.indexOf(text);
    assert.ok(at('1GB, 7 Days</span>') < at('class="still-spend-checkout"') && at('class="still-spend-checkout"') < at('10GB, 30 Days</span>'));
    assert.match(first, /<ul class="still-spend-prices" aria-label="Prices in USDC">.*<\/ul><form .*<\/form><ul class="still-spend-prices" aria-label="More prices in USDC">/);
    // Without the switch there is no button, and the page says paying is not open here.
    const closed = renderToStaticMarkup(<StillSpend model={model({ pay: null })} />);
    assert.doesNotMatch(closed, /Pay with Still<\/button>/);
    assert.match(closed, /Paying with Still is not open on this server/);
    // Open, for a reader not signed in: what signing in opens, never that nothing can be bought.
    const guest = renderToStaticMarkup(<StillSpend model={model({ pay: null, payAfterSignIn: true })} />);
    assert.match(guest, /Sign in with your wallet to pay with Still/);
    assert.doesNotMatch(guest, /not open on this server|Nothing can be bought/);
  });

  it('a top-up asks for the number with its calling code, says what Bitrefill tops up, and waits for a whole number', () => {
    const pay = { chosen: '10', onChoose: noop, email: 'buyer@example.com', onEmail: noop, phone: '', onPhone: noop, creating: false, error: null, onCreate: noop };
    const open = { ...AIRTEL, checkout: { enabled: true, available: true, capAtomic: '100000000', phone: { callingCode: '91' } } };
    const product = spendProductViewV1(open, null).product;
    const empty = renderToStaticMarkup(<StillSpend model={model({ type: 'refill', product, pay })} />);
    assert.match(empty, /0\.11 USDC for Airtel India · 10 INR/);
    assert.match(empty, /<label class="still-borrow-label" for="[^"]+-phone">Phone number to top up<\/label>/);
    assert.match(empty, /type="tel"[^>]*placeholder="\+91 …"/);
    assert.match(empty, /Write it with the country code, \+91\. A top-up sent to a wrong number cannot be taken back\./);
    assert.match(empty, /<button type="submit" class="still-btn" disabled="">Open invoice and choose collateral<\/button>/);
    assert.doesNotMatch(empty, /Never buy a gift card/);
    const typed = renderToStaticMarkup(<StillSpend model={model({ type: 'refill', product, pay: { ...pay, phone: '+91 98765 43210' } })} />);
    assert.match(typed, /Bitrefill tops up <strong class="mono">\+919876543210<\/strong>\./);
    assert.match(typed, /<button type="submit" class="still-btn">Open invoice and choose collateral<\/button>/);
    // Where the code is shared, the field says which numbers this operator tops up, and a number of the other country waits.
    const kz = spendProductViewV1({ ...open, product: { ...open.product, id: 'beeline-kazakhstan', name: 'Beeline Kazakhstan', country: 'KZ',
      packages: [{ value: '100', faceCurrency: 'KZT', priceUsdc: '0.26' }] }, checkout: { ...open.checkout, phone: { callingCode: '7', prefixes: ['76', '77'] } } }, null).product;
    const russian = renderToStaticMarkup(<StillSpend model={model({ type: 'refill', product: kz, pay: { ...pay, chosen: '100', phone: '+7 912 345 67 89' } })} />);
    assert.match(russian, /Write it with the country code: numbers here start with \+7 6 or \+7 7\./);
    assert.match(russian, /<button type="submit" class="still-btn" disabled="">Open invoice and choose collateral<\/button>/);
    // A gift card or an eSIM never shows the field.
    const esim = renderToStaticMarkup(<StillSpend model={model({ product: spendProductViewV1({ ...GERMANY, checkout: open.checkout }, null).product, pay: { ...pay, chosen: '10GB, 30 Days' } })} />);
    assert.doesNotMatch(esim, /Phone number to top up/);
  });
});

describe('a purchase, shared', () => {
  const TOKEN = `ss1.${'e'.repeat(120)}.${'s'.repeat(43)}`;
  const SHARE = { outcome: 'share', share: { productName: 'PUBG Mobile UC International', packageLabel: '10 UC', priceUsdc: '0.18',
    collateralLabel: 'NVDA', collateralName: 'NVIDIA stock', venueName: 'Aave' } };

  it('takes only a link the server issued, and only the words it verified', () => {
    assert.equal(spendSharePathV1(`/spend/p/${TOKEN}`), `/spend/p/${TOKEN}`);
    for (const bad of [`https://evil.example/spend/p/${TOKEN}`, `/spend/p/${TOKEN}/x`, '/spend/p/ss1.a.b', `/w/${TOKEN}`, null, 7]) assert.equal(spendSharePathV1(bad), null);
    assert.deepEqual(spendShareViewV1(SHARE), SHARE.share);
    assert.equal(spendShareViewV1({ outcome: 'share_invalid' }), null);
    assert.equal(spendShareViewV1({ ...SHARE, share: { ...SHARE.share, venueName: 'Elsewhere' } }), null);
    assert.equal(spendShareViewV1({ ...SHARE, share: { ...SHARE.share, priceUsdc: '0.18 USDC' } }), null);
    // A stock token is named by its ticker, as the card names it; crypto keeps its symbol.
    assert.equal(spendShareTextV1({ productName: 'PUBG Mobile UC International', collateralSymbol: 'NVDAc' }),
      'Paid for PUBG Mobile UC International with a USDC loan against my NVDA, without selling it. On Base, through Still.');
    assert.match(spendShareTextV1({ productName: 'Bitrefill eSIM Germany', collateralSymbol: 'cbBTC' }), /against my cbBTC,/);
  });

  it('after the loan is confirmed, offers X and Farcaster with the stills.lat link once the server signed one', () => {
    const order = spendOrderViewV1({ order: { orderId: '2ff5ad58-0000-4000-8000-000000000000', productName: 'PUBG Mobile UC International', packageValue: '10 UC',
      faceCurrency: null, priceAtomic: '180000', expiresAt: '2026-11-01T16:00:00.000Z', paymentLink: null }, status: { status: 'complete' } });
    const url = `https://stills.lat/spend/p/${TOKEN}`;
    const html = renderToStaticMarkup(<StillSpendPaid order={order} reading={false} share={{ url, text: 'Paid for PUBG Mobile UC International with a USDC loan.' }} />);
    assert.match(html, /Share this purchase:/);
    assert.ok(html.includes(`https://x.com/intent/tweet?text=Paid%20for%20PUBG%20Mobile%20UC%20International%20with%20a%20USDC%20loan.&amp;url=${encodeURIComponent(url)}`));
    assert.ok(html.includes(`https://farcaster.xyz/~/compose?text=Paid%20for%20PUBG%20Mobile%20UC%20International%20with%20a%20USDC%20loan.&amp;embeds[]=${encodeURIComponent(url)}`));
    assert.doesNotMatch(renderToStaticMarkup(<StillSpendPaid order={order} reading={false} />), /Share this purchase/);
  });

  it('a shared link shows its card and words, and an unverified one shows nothing it claims', () => {
    const sky = skyStateV1({ now: new Date('2026-11-01T15:00:00Z') });
    const html = renderToStaticMarkup(<StillSpendShared sky={sky} view={spendShareViewV1(SHARE)} reading={false} cardUrl="/api/public/still/spend-card.png?t=x" />);
    assert.match(html, /Paid with a loan/);
    assert.match(html, /PUBG Mobile UC International, 10 UC, for 0\.18 USDC\. Borrowed against NVDA through Aave and paid to Bitrefill with that loan on Base, without selling\./);
    assert.match(html, /<img class="still-spend-card" src="\/api\/public\/still\/spend-card\.png\?t=x"/);
    assert.match(html, /Not offered to US persons/);
    const unverified = renderToStaticMarkup(<StillSpendShared sky={sky} view={null} reading={false} cardUrl={null} />);
    assert.match(unverified, /could not be verified, so nothing about it is shown/);
    assert.doesNotMatch(unverified, /<img|Still checked this loan/);
  });
});

describe('a loan, shared', () => {
  // 2026-11-03, the operator: «нет карточки после успешного взятия займа для шаринга».
  const TOKEN = `sl1.${'e'.repeat(60)}.${'s'.repeat(43)}`;
  const LOAN = { outcome: 'share', share: { kind: 'loan', borrowedUsdc: '2.00', collateralLabel: 'NVDA', collateralName: 'NVIDIA stock', venueName: 'Aave' } };

  it('takes a loan link the server issued, and reads its words apart from a purchase’s', () => {
    assert.equal(spendSharePathV1(`/spend/p/${TOKEN}`), `/spend/p/${TOKEN}`);
    assert.equal(spendSharePathV1(`/spend/p/sx1.${'e'.repeat(60)}.${'s'.repeat(43)}`), null);
    assert.deepEqual(loanShareViewV1(LOAN), { borrowedUsdc: '2.00', collateralLabel: 'NVDA', collateralName: 'NVIDIA stock', venueName: 'Aave' });
    // A loan's words are not a purchase, and a purchase's are not a loan.
    assert.equal(spendShareViewV1(LOAN), null);
    assert.equal(loanShareViewV1({ outcome: 'share', share: { productName: 'PUBG', packageLabel: '10 UC', priceUsdc: '0.18', collateralLabel: 'NVDA', collateralName: 'NVIDIA stock', venueName: 'Aave' } }), null);
    assert.equal(loanShareViewV1({ ...LOAN, share: { ...LOAN.share, borrowedUsdc: '2 USDC' } }), null);
    assert.equal(loanShareTextV1({ collateralSymbol: 'NVDAc' }), 'Spent without selling: a USDC loan against my NVDA, which I keep. On Base, through Still.');
  });

  it('after the loan is confirmed, shows its card and offers X and Farcaster', () => {
    const url = `https://miorail.xyz/spend/p/${TOKEN}`;
    const html = renderToStaticMarkup(<StillLoanShare share={{ url, text: loanShareTextV1({ collateralSymbol: 'NVDAc' }) }} cardUrl={`/api/public/still/spend-card.png?t=${TOKEN}`} />);
    assert.match(html, /<img class="still-spend-card" src="\/api\/public\/still\/spend-card\.png\?t=sl1\./);
    assert.match(html, /Share this loan’s card:/);
    assert.ok(html.includes(`embeds[]=${encodeURIComponent(url)}`));
    assert.ok(html.includes(`https://x.com/intent/tweet?text=Spent%20without%20selling`));
  });

  it('a shared loan link shows its card and what it claims, and no wallet', () => {
    const sky = skyStateV1({ now: new Date('2026-11-03T15:00:00Z') });
    const html = renderToStaticMarkup(<StillLoanShared sky={sky} view={loanShareViewV1(LOAN)!} cardUrl="/api/public/still/spend-card.png?t=x" />);
    assert.match(html, /Spent without selling/);
    assert.match(html, /2\.00 USDC borrowed against NVDA through Aave on Base\. Nothing was sold: it is the loan’s collateral\./);
    assert.match(html, /<img class="still-spend-card" src="\/api\/public\/still\/spend-card\.png\?t=x"/);
    assert.match(html, /Not offered to US persons/);
    assert.doesNotMatch(html, /0x[0-9a-fA-F]{6}/);
  });
});

describe('paying from the wallet’s own USDC, as the page says it', () => {
  const noop = () => {};
  const ORDER = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', PAY_TO = '0x3333333333333333333333333333333333333333';
  const payment = { merchant: 'bitrefill', orderId: ORDER, payTo: PAY_TO, assets: '2000000', productName: 'PUBG Mobile', packageValue: '60 UC', faceCurrency: null, expiresAt: '2026-11-03T18:15:00.000Z' };
  const ready = { orderId: ORDER, state: 'ready', attemptId: null, batchId: null, transactionHash: null, errorCode: null, updatedAt: '2026-11-03T18:00:00.000Z',
    facts: { payment, usdcBeforeAtomic: '2120000', usdcAfterAtomic: '120000', blockNumber: 53_470_000,
      warnings: ['Your wallet sends 2 USDC of its own to Bitrefill’s invoice address 0x3333…3333 for PUBG Mobile · 60 UC. No loan is taken.'] },
    calls: [{ to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', value: '0', data: '0xa9059cbb' }], callsHash: `0x${'1'.repeat(64)}`, signingTermsHash: `0x${'2'.repeat(64)}`,
    expiresAt: '2026-11-03T18:02:00.000Z', steps: [] };

  it('says USDC exactly, compares the wallet’s USDC with a price to the unit, and sums a debt only when every one was read', () => {
    assert.deepEqual(['2000000', '2120000', '13250000', '1500001', '0'].map(spendUsdcTextV1), ['2.00 USDC', '2.12 USDC', '13.25 USDC', '1.500001 USDC', '0.00 USDC']);
    assert.equal(spendUsdcTextV1('-1'), null);
    assert.deepEqual([spendWalletCoversV1('2530000', '2.53'), spendWalletCoversV1('2529999', '2.53'), spendWalletCoversV1(null, '2.53'), spendWalletCoversV1('9', 'x')], [true, false, null, null]);
    assert.equal(spendOwedCentsV1({ venues: [{ debtCents: '201' }, { debtCents: '0' }] }), '201');
    assert.equal(spendOwedCentsV1({ venues: [{ debtCents: '201' }, { debtCents: null }] }), null);
    assert.equal(spendOwedCentsV1({ venues: [{ debtCents: '0' }] }), null);
    assert.equal(spendOwedCentsV1(null), null);
  });

  it('reads the server’s answer: a ready payment with its one call, a refusal in its own words, and nothing that does not match', () => {
    const view = spendWalletViewV1(ready)!;
    assert.deepEqual({ state: view.state, price: view.price, payTo: view.payTo, before: view.before, after: view.after, block: view.block, label: view.packageLabel },
      { state: 'ready', price: '2.00 USDC', payTo: '0x3333…3333', before: '2.12 USDC', after: '0.12 USDC', block: 53_470_000, label: '60 UC' });
    assert.deepEqual(view.ready, { calls: ready.calls, callsHash: ready.callsHash, signingTermsHash: ready.signingTermsHash });
    const sent = spendWalletViewV1({ ...ready, state: 'submitted', calls: undefined, callsHash: undefined, signingTermsHash: undefined, transactionHash: `0x${'ab'.repeat(32)}` })!;
    assert.deepEqual([sent.state, sent.ready, sent.transactionHash], ['submitted', null, `0x${'ab'.repeat(32)}`]);
    const refused = spendWalletViewV1({ orderId: ORDER, state: 'refused', refusal: 'spend_wallet_usdc_short', detail: 'Your wallet holds 1.50 USDC and this invoice is 2.00 USDC.' })!;
    assert.deepEqual([refused.state, refused.refusal, refused.detail, refused.ready], ['refused', 'spend_wallet_usdc_short', 'Your wallet holds 1.50 USDC and this invoice is 2.00 USDC.', null]);
    // Another invoice's facts, a ready answer without its call, or two calls are not this payment.
    assert.equal(spendWalletViewV1({ ...ready, facts: { ...ready.facts, payment: { ...payment, orderId: '00000000-0000-4000-8000-000000000001' } } }), null);
    assert.equal(spendWalletViewV1({ ...ready, calls: undefined }), null);
    assert.equal(spendWalletViewV1({ ...ready, calls: [...ready.calls, ...ready.calls] }), null);
  });

  it('the room card says what is owed and the wallet’s USDC, and a covered price is paid from the wallet first', () => {
    const open = { ...GERMANY, checkout: { enabled: true, available: true, capAtomic: '100000000' } };
    const pay = { chosen: null, onChoose: noop, email: '', onEmail: noop, phone: '', onPhone: noop, creating: false, error: null, onCreate: noop };
    const base = { sky: skyStateV1({ now: new Date('2026-10-28T15:00:00Z') }), signedIn: true, signInHref: '/signin', type: 'esim' as const, onType: noop,
      country: 'DE', onCountry: noop, query: '', onQuery: noop, onSearch: noop, searching: false, products: null, searchError: null, selected: 'bitrefill-esim-germany', onSelect: noop,
      productLoading: false, productError: null, room: { cents: '20', complete: true } };
    const html = renderToStaticMarkup(<StillSpend model={{ ...base, product: spendProductViewV1(open, base.room, '3000000').product, owedCents: '201', walletUsdc: '3.00 USDC', pay }} />);
    assert.match(html, /<span class="still-spend-room-label">Your Still room now<\/span><span class="still-spend-room-amount">\$0\.20<\/span>/);
    assert.match(html, /What Still can lend you now, on top of the <strong>\$2\.01<\/strong> you already owe\./);
    assert.match(html, /<span class="still-spend-room-label">In your wallet<\/span><span class="still-spend-room-usdc mono">3\.00 USDC<\/span><span class="still-spend-room-note">It pays a price up to this directly, with no loan\.<\/span>/);
    // 2.53 is covered by the wallet's 3 USDC, though it is over the room; 13.25 is neither.
    assert.match(html, /1GB, 7 Days<\/span>.*?<span class="still-spend-fit">More than your room<\/span><span class="still-spend-fit is-wallet">Your USDC covers it<\/span>/);
    assert.doesNotMatch(html.slice(html.indexOf('10GB, 30 Days')), /^.*?Your USDC covers it.*?Unlimited/);
    const chosen = renderToStaticMarkup(<StillSpend model={{ ...base, product: spendProductViewV1(open, base.room, '3000000').product, walletUsdc: '3.00 USDC',
      pay: { ...pay, chosen: '1GB, 7 Days', email: 'buyer@example.com' } }} />);
    assert.match(chosen, /the USDC already in your wallet pays it: one transfer of exactly 2\.53 USDC, no loan/);
    assert.match(chosen, /<button type="submit" class="still-btn">Pay 2\.53 USDC from your wallet<\/button><button type="button" class="still-btn sec">Borrow it instead<\/button>/);
    // A price the wallet does not cover is paid with a loan, and the page says why.
    const over = renderToStaticMarkup(<StillSpend model={{ ...base, product: spendProductViewV1(open, base.room, '3000000').product, walletUsdc: '3.00 USDC',
      pay: { ...pay, chosen: '10GB, 30 Days', email: 'buyer@example.com' } }} />);
    assert.match(over, />Open invoice and choose collateral<\/button>/);
    assert.match(over, /Your wallet holds 3\.00 USDC, less than this price\./);
    assert.doesNotMatch(over, /from your wallet<\/button>/);
    // Opening the invoice says which button opened it.
    const opening = renderToStaticMarkup(<StillSpend model={{ ...base, product: spendProductViewV1(open, base.room, '3000000').product,
      pay: { ...pay, chosen: '1GB, 7 Days', email: 'buyer@example.com', creating: true, creatingWith: 'wallet' } }} />);
    assert.match(opening, /<button type="submit" class="still-btn" disabled="">Opening the invoice…<\/button><button type="button" class="still-btn sec" disabled="">Borrow it instead<\/button>/);
  });

  const walletModel = (patch: Partial<StillSpendWalletModelV1> = {}): StillSpendWalletModelV1 => ({
    loading: false, error: null, view: spendWalletViewV1(ready), busy: false, walletError: null, lock: null, onPay: noop, checking: false, onCheck: null, onRetry: null, ...patch });
  const sky = skyStateV1({ now: new Date('2026-11-03T18:00:00Z') });

  it('the payment page shows what was checked and offers one button for exactly the price', () => {
    const html = renderToStaticMarkup(<StillSpendWalletPay sky={sky} model={walletModel()} order={null} orderReading={false} />);
    assert.match(html, /<h1>Pay from your wallet<\/h1>/);
    assert.match(html, /One transfer of the USDC already in your wallet pays <strong class="still-provider">Bitrefill<\/strong>’s invoice\. No loan is taken\./);
    assert.match(html, /2\.00 USDC for PUBG Mobile · 60 UC/);
    assert.match(html, /<dt>In your wallet<\/dt><dd class="mono">2\.12 USDC<\/dd><\/div><div><dt>After paying<\/dt><dd class="mono">0\.12 USDC<\/dd>/);
    assert.match(html, /Read at Base block <span class="mono">53,470,000<\/span>; the transfer was run on that same state/);
    assert.match(html, /<button type="button" class="still-btn">Pay 2\.00 USDC<\/button>/);
    assert.match(html, /A payment sent cannot be taken back by Still/);
    assert.doesNotMatch(renderToStaticMarkup(<StillSpendWalletPay sky={sky} model={walletModel({ onPay: null })} order={null} orderReading={false} />), /<button type="button" class="still-btn">Pay/);
  });

  it('the payment page says a refusal in the server’s words, and how a sent payment stands', () => {
    const refused = renderToStaticMarkup(<StillSpendWalletPay sky={sky} order={null} orderReading={false}
      model={walletModel({ view: spendWalletViewV1({ orderId: ORDER, state: 'refused', refusal: 'spend_wallet_usdc_short', detail: 'Your wallet holds 1.50 USDC and this invoice is 2.00 USDC.' }) })} />);
    assert.match(refused, /role="alert">Your wallet holds 1\.50 USDC and this invoice is 2\.00 USDC\. <a [^>]*href="\/spend"[^>]*>Back to Spend<\/a>/);
    assert.doesNotMatch(refused, /Pay 2\.00 USDC|Check again/);
    // A refusal of a moment can be read again.
    const again = renderToStaticMarkup(<StillSpendWalletPay sky={sky} order={null} orderReading={false}
      model={walletModel({ onRetry: noop, view: spendWalletViewV1({ orderId: ORDER, state: 'refused', refusal: 'spend_simulation_moved', detail: 'The payment could not be checked on the same Base state as your wallet’s balance.' }) })} />);
    assert.match(again, /<button type="button" class="still-btn sec">Check again<\/button>/);
    const hash = `0x${'ab'.repeat(32)}`;
    const states: Array<[string, RegExp]> = [
      ['submitted', /Sent\. Still is reading the payment from Base\. Transaction 0xabababab…ababab\./],
      ['unknown', /Your wallet did not say whether it sent the payment/],
      ['failed', /The transfer failed onchain: no USDC left your wallet for it, and Bitrefill was not paid\./],
      ['confirmed', /Paid: Base shows your transfer to Bitrefill’s invoice\./],
    ];
    for (const [state, words] of states) {
      const html = renderToStaticMarkup(<StillSpendWalletPay sky={sky} order={null} orderReading={false}
        model={walletModel({ view: spendWalletViewV1({ ...ready, state, calls: undefined, transactionHash: hash }) })} />);
      assert.match(html, words, state);
      assert.doesNotMatch(html, /<button type="button" class="still-btn">Pay/, state);
    }
    const paid = renderToStaticMarkup(<StillSpendWalletPay sky={sky} order={null} orderReading
      model={walletModel({ view: spendWalletViewV1({ ...ready, state: 'confirmed', calls: undefined, transactionHash: hash }) })} />);
    assert.match(paid, /Paid to Bitrefill from your wallet/);
    assert.doesNotMatch(paid, /with the loan|Share this purchase/);
  });
});
