import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BITREFILL_MCP_URL_V1,
  createBitrefillGuestCatalogV1,
  createBitrefillGuestCheckoutV1,
  createBitrefillGuestTransportV1,
  spendInvoiceFromAnswerV1,
  spendInvoiceStatusFromAnswerV1,
  spendShapeV1,
} from '../src/index.js';

// Bitrefill documents the buy-products answer only in prose: "`response`
// holds the invoice: invoice_id, invoice_access_token, expiration_minutes,
// cart_items, and for crypto a payment_info block (address and amount)".
// These invoices are made up in that shape; no real invoice was opened.
const NOW = new Date('2026-11-01T12:00:00Z');
const INVOICE_ID = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34';
const PAY_TO = '0x3333333333333333333333333333333333333333';
const QUOTED = 13_250_000n;

function answer(payment: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    response: {
      invoice_id: INVOICE_ID, invoice_access_token: 'access-token-0123456789', expiration_minutes: 30,
      cart_items: [{ product_id: 'bitrefill-esim-germany', package_value: '10GB, 30 Days' }],
      payment_info: { address: PAY_TO, ...payment },
      payment_link: `https://www.bitrefill.com/invoice/${INVOICE_ID}?token=t`, x402_payment_url: 'https://api.bitrefill.com/x402/invoice/pay',
      ...extra,
    },
    agent_instructions: 'Send the exact amount to the address before the invoice expires.',
  };
}

function rpc(text: string, isError = false): Response {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } });
  return new Response(`event: message\ndata: ${body}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function bitrefill(answers: Array<() => Response>) {
  const calls: Array<{ url: string; body: string }> = [];
  let next = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), body: String(init.body ?? '') });
    const reply = answers[next++];
    if (!reply) throw new Error(`unexpected call ${String(input)}`);
    return reply();
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const token = () => new Response(JSON.stringify({ access_token: 'guest-token-0123456789', expires_in: 21600 }), { status: 200 });

describe('a Bitrefill invoice is read only when it asks the price just quoted', () => {
  it('reads the address, the exact amount and a lifetime no longer than the price lock', () => {
    for (const payment of [{ amount: '13.25' }, { amount: 13.25 }, { price: '13.250000' }, { amount: '13250000' }, { amount: '13.25', currency: 'USDC' }]) {
      const read = spendInvoiceFromAnswerV1(answer(payment), QUOTED, NOW);
      assert.deepEqual(read, { ok: true, value: {
        invoiceId: INVOICE_ID, accessToken: 'access-token-0123456789', payTo: PAY_TO, amountAtomic: QUOTED,
        // Thirty minutes offered, fifteen counted: the USDC price lock.
        expiresAt: '2026-11-01T12:15:00.000Z', paymentLink: `https://www.bitrefill.com/invoice/${INVOICE_ID}?token=t`,
      } }, JSON.stringify(payment));
    }
    // The eCommerce page lists the same fields without the `response` wrapper.
    const flat = spendInvoiceFromAnswerV1({ ...answer({ amount: '13.25' }).response, expiration_minutes: 10 }, QUOTED, NOW);
    assert.equal(flat.ok && flat.value.expiresAt, '2026-11-01T12:10:00.000Z');
  });

  it('a different amount is a changed price, and a missing or unreadable one is no invoice', () => {
    assert.deepEqual(spendInvoiceFromAnswerV1(answer({ amount: '13.30' }), QUOTED, NOW).ok ? null : 'refused', 'refused');
    const changed = spendInvoiceFromAnswerV1(answer({ amount: '13.30' }), QUOTED, NOW);
    assert.equal(!changed.ok && changed.reason, 'bitrefill_invoice_price_changed');
    // Two amounts that disagree are no answer at all.
    assert.equal(!spendInvoiceFromAnswerV1(answer({ amount: '13.25', price: '13.30' }), QUOTED, NOW).ok, true);
    for (const payment of [{}, { amount: 'thirteen' }, { amount: '13.2500001' }, { amount: -13.25 }, { amount: '13.25', currency: 'BTC' }]) {
      const read = spendInvoiceFromAnswerV1(answer(payment), QUOTED, NOW);
      assert.equal(!read.ok && read.reason, 'bitrefill_invalid_response', JSON.stringify(payment));
    }
    // A base-unit figure counts only as the quoted price itself.
    assert.equal(spendInvoiceFromAnswerV1(answer({ amount: '13250001' }), QUOTED, NOW).ok, false);
  });

  it('refuses an invoice without its id, token or a Base address, and names its keys, never its values', () => {
    for (const broken of [
      answer({ amount: '13.25' }, { invoice_id: 'inv_123' }),
      answer({ amount: '13.25' }, { invoice_access_token: '' }),
      answer({ amount: '13.25', address: 'bc1qnotbase' }),
      answer({ amount: '13.25' }, { expiration_minutes: 'soon' }),
      { response: 'nothing' },
    ]) {
      const read = spendInvoiceFromAnswerV1(broken, QUOTED, NOW);
      assert.equal(read.ok, false);
      assert.ok(!read.ok && read.shape && !read.shape.includes(PAY_TO) && !read.shape.includes('access-token'));
    }
    assert.equal(spendShapeV1(answer({ amount: '13.25' })).includes('payment_info:{address:string,amount:string}'), true);
  });

  it('a payment link counts only on bitrefill.com over https', () => {
    const elsewhere = spendInvoiceFromAnswerV1(answer({ amount: '13.25' }, { payment_link: 'https://bitrefill.example.com/pay' }), QUOTED, NOW);
    assert.equal(elsewhere.ok && elsewhere.value.paymentLink, null);
  });

  it('reads the invoice status as JSON or TOON, and only Bitrefill’s own states', () => {
    assert.deepEqual(spendInvoiceStatusFromAnswerV1(JSON.stringify({ invoice_status: 'complete', access_link: 'https://www.bitrefill.com/order/1',
      orders: [{ status: 'delivered', esim_install_link: 'https://esim.bitrefill.com/install/1' }] })), { ok: true, value: {
      status: 'complete', accessLink: 'https://www.bitrefill.com/order/1', esimInstallLink: 'https://esim.bitrefill.com/install/1' } });
    assert.deepEqual(spendInvoiceStatusFromAnswerV1('invoice_status: unpaid\norders[0]:'), { ok: true, value: { status: 'unpaid', accessLink: null, esimInstallLink: null } });
    assert.equal(spendInvoiceStatusFromAnswerV1('invoice_status: expired').ok, false);
    assert.equal(spendInvoiceStatusFromAnswerV1('not an answer').ok, false);
  });
});

describe('Still’s guest checkout talks to Bitrefill only as it says', () => {
  it('opens a usdc_base invoice with crypto details and the buyer’s email, then reads it with its token', async () => {
    const { fetchImpl, calls } = bitrefill([token, () => rpc(JSON.stringify(answer({ amount: '13.25' }))), () => rpc('invoice_status: unpaid')]);
    const checkout = createBitrefillGuestCheckoutV1({ fetchImpl });
    const opened = await checkout.createInvoice({ productId: 'bitrefill-esim-germany', packageValue: '10GB, 30 Days', email: 'buyer@example.com', quotedAtomic: QUOTED, now: NOW });
    assert.equal(opened.ok, true);
    const call = JSON.parse(calls[1]!.body);
    assert.equal(calls[1]!.url, BITREFILL_MCP_URL_V1);
    assert.deepEqual(call.params, { name: 'buy-products', arguments: {
      cart_items: [{ product_id: 'bitrefill-esim-germany', package_value: '10GB, 30 Days' }], payment_method: 'usdc_base', return_payment_link: false, email: 'buyer@example.com' } });
    const status = await checkout.readInvoice({ invoiceId: INVOICE_ID, accessToken: 'access-token-0123456789' });
    assert.deepEqual(status, { ok: true, value: { status: 'unpaid', accessLink: null, esimInstallLink: null } });
    assert.deepEqual(JSON.parse(calls[2]!.body).params, { name: 'get-invoice-by-id', arguments: { invoice_id: INVOICE_ID, invoice_access_token: 'access-token-0123456789' } });
  });

  it('sends nothing for an email Bitrefill would refuse, and a tool error is a refusal', async () => {
    const { fetchImpl, calls } = bitrefill([token, () => rpc('{"error":"INVALID_INPUT"}', true)]);
    const checkout = createBitrefillGuestCheckoutV1({ fetchImpl });
    assert.deepEqual(await checkout.createInvoice({ productId: 'x', packageValue: '1', email: 'not an email', quotedAtomic: QUOTED, now: NOW }), { ok: false, reason: 'bitrefill_refused' });
    assert.equal(calls.length, 0);
    const refused = await checkout.createInvoice({ productId: 'bitrefill-esim-germany', packageValue: '1GB', email: 'buyer@example.com', quotedAtomic: QUOTED, now: NOW });
    assert.equal(!refused.ok && refused.reason, 'bitrefill_refused');
  });

  it('the catalogue and any other caller cannot reach a tool they did not list', async () => {
    const { fetchImpl, calls } = bitrefill([]);
    const reads = createBitrefillGuestTransportV1(['search-products', 'get-product-details'], { fetchImpl });
    assert.deepEqual(await reads.callTool('buy-products', {}), { ok: false, reason: 'bitrefill_refused' });
    assert.equal(calls.length, 0);
    // The catalogue's own factory exposes no way to buy.
    assert.deepEqual(Object.keys(createBitrefillGuestCatalogV1({ fetchImpl })).sort(), ['product', 'search']);
  });
});
