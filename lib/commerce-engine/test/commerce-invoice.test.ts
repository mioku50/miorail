import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBitrefillPersonalOrderGatewayV1,
  invoiceAddressV1,
  invoicePriceToAtomicV1,
  validateCommerceInvoiceScopedTermsV1,
  validateCommercePaymentTermsV1,
  validateCommerceInvoiceV1,
  type CommerceCreateOrderResultV1,
} from '../src/index.js';
import {
  CommerceCandidateV1Schema,
  CommerceRouteIntentV1Schema,
  hashCommerceCandidateV1,
  hashCommerceRouteIntentV1,
  ZERO_HASH_V1,
  type CommerceCandidateV1,
  type CommerceRouteIntentV1,
} from '@mioagent/route-domain';

globalThis.fetch = (() => {
  throw new Error('Unit tests must not perform live network calls');
}) as typeof fetch;

// ---------------------------------------------------------------------------
// T64.2.1 — regressions from a REAL created invoice (2026-07-25):
//
//   payment = { method: "usdc_base", currency: "USDC", price: 5640000,
//               status: "unpaid", address: "0xE9Ee…9fe8" }
//
// Three things this pins:
//   * the exact charge is `price`, already in USDC BASE UNITS — not `amount`,
//     and not a decimal;
//   * the deposit address is issued PER INVOICE and is NOT the x402 payTo;
//   * a read failure AFTER a successful POST must never claim nothing was
//     created, because an invoice exists.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const NOW = new Date('2026-07-25T12:00:00.000Z');
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const X402_PAY_TO = '0x480cd46e6fade651a0437deadda53d5c8e7d846a';
const INVOICE_ADDRESS = '0xe9ee32de59335e4b64dc2c224d7a79fcb43f9fe8';
const API_KEY = 'personal-api-key';

const USDC_ASSET = {
  assetId: `eip155:8453/erc20:${USDC}`,
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: USDC,
  symbol: 'USDC',
  decimals: 6,
};

function intent(): CommerceRouteIntentV1 {
  const nowIso = NOW.toISOString();
  const draft = {
    schemaVersion: 'commerce-route-intent/v1' as const,
    id: 'commerce-intent:test',
    tenantId: 'tenant',
    walletAddress: WALLET,
    chainId: 8453 as const,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'ready' as const,
    intentHash: ZERO_HASH_V1,
    goal: 'commerce' as const,
    query: 'Steam',
    kind: 'gift_card' as const,
    country: 'US',
    requestedValue: { amountDecimal: '5', currency: 'USD' },
    paymentAsset: USDC_ASSET,
    maxSpendAtomic: '5750000',
    recipientInput: null,
    optimizationMode: 'exact_denomination' as const,
    executionRequested: false,
  };
  return CommerceRouteIntentV1Schema.parse({
    ...draft,
    intentHash: hashCommerceRouteIntentV1(draft as unknown as CommerceRouteIntentV1),
  });
}

function candidate(parent = intent()): CommerceCandidateV1 {
  const nowIso = NOW.toISOString();
  const draft = {
    schemaVersion: 'commerce-candidate/v1' as const,
    id: 'commerce-candidate:test',
    tenantId: parent.tenantId,
    walletAddress: parent.walletAddress,
    chainId: parent.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'quoted' as const,
    intentHash: parent.intentHash,
    candidateHash: ZERO_HASH_V1,
    product: {
      provider: 'bitrefill' as const,
      productId: 'steam-usa',
      name: 'Steam USD',
      kind: 'gift_card' as const,
      country: 'US',
      currency: 'USD',
      packageValue: '5',
      packageId: 'steam-usa<&>5',
      recipientRequired: false,
    },
    fiatPrice: { amountDecimal: '5', currency: 'USD' },
    payment: { asset: USDC_ASSET, amountAtomic: '5000000', amountDecimal: '5' },
    fees: {
      productPriceAtomic: '5000000',
      providerFeeAtomic: null,
      networkFeeAtomic: null,
      totalAtomic: '5000000',
      totalBasis: 'minimum' as const,
    },
    availability: 'in_stock' as const,
    deliveryModel: 'digital_code' as const,
    recipientRequired: false,
    paymentTarget: { asset: USDC, payTo: X402_PAY_TO as `0x${string}` },
    observedAt: nowIso,
    expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    provider: { id: 'bitrefill-x402-v1', displayName: 'Bitrefill', kind: 'protocol' as const, operator: 'Bitrefill' },
  };
  return CommerceCandidateV1Schema.parse({
    ...draft,
    candidateHash: hashCommerceCandidateV1(draft as unknown as CommerceCandidateV1),
  });
}

/** The real invoice body, verbatim from the storefront. */
const LIVE_INVOICE = {
  meta: {},
  data: {
    id: 'cce07a81-53e7-4962-a824-4c0d43e55028',
    status: 'not_delivered',
    created_time: '2026-07-25T20:48:06.837Z',
    payment: {
      method: 'usdc_base',
      address: '0xE9Ee32de59335e4B64dC2C224D7a79fcB43F9fe8',
      currency: 'USDC',
      price: 5640000,
      status: 'unpaid',
      commission: 0,
    },
    orders: [{ id: '6a652106bab6e3aba7ada8ff', status: 'created' }],
  },
};

function gatewayFor(body: unknown, status = 200) {
  const requests: { url: string; body: unknown }[] = [];
  const gateway = createBitrefillPersonalOrderGatewayV1({
    apiKey: API_KEY,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  return { gateway, requests };
}

const ORDER_INPUT = {
  productId: 'steam-usa',
  packageValue: '5',
  packageId: 'steam-usa<&>5',
  recipientInput: null,
  maxSpendAtomic: '5750000',
  refundAddress: WALLET,
  now: NOW,
};

// --- price ------------------------------------------------------------------

test('payment.price is read as USDC base units, not as a decimal', async () => {
  const { gateway } = gatewayFor(LIVE_INVOICE);
  const result = await gateway.createOrder(ORDER_INPUT);
  assert.ok(result.ok);
  // 5640000 base units = 5.64 USDC. Treating it as a decimal would have made
  // it 5,640,000 USDC.
  assert.equal(result.order.totalAtomic, '5640000');
});

test('a fractional price is refused rather than guessed at', () => {
  assert.equal(invoicePriceToAtomicV1(5640000), '5640000');
  assert.equal(invoicePriceToAtomicV1('5640000'), '5640000');
  assert.equal(invoicePriceToAtomicV1(5.64), null);
  assert.equal(invoicePriceToAtomicV1('5.64'), null);
  assert.equal(invoicePriceToAtomicV1(-1), null);
  assert.equal(invoicePriceToAtomicV1(undefined), null);
});

test('a missing payment.price fails closed and says the invoice EXISTS', async () => {
  const body = { meta: {}, data: { ...LIVE_INVOICE.data, payment: { ...LIVE_INVOICE.data.payment, price: undefined } } };
  const { gateway } = gatewayFor(body);
  const result = (await gateway.createOrder(ORDER_INPUT)) as Extract<
    CommerceCreateOrderResultV1,
    { reason: 'invoice_creation_unknown' }
  >;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invoice_creation_unknown');
  assert.match(result.detail, /exists at the storefront/i);
  assert.match(result.detail, /cce07a81/);
});

test('the undocumented payment.amount is NOT used as a substitute', async () => {
  const body = {
    meta: {},
    data: {
      ...LIVE_INVOICE.data,
      // `amount` is not the documented field. Its presence must not rescue a
      // missing `price`.
      payment: { ...LIVE_INVOICE.data.payment, price: undefined, amount: '5.64' },
    },
  };
  const { gateway } = gatewayFor(body);
  const result = await gateway.createOrder(ORDER_INPUT);
  assert.equal(result.ok, false);
});

// --- recipient --------------------------------------------------------------

test('the per-invoice address is used, never the x402 payTo', async () => {
  const { gateway } = gatewayFor(LIVE_INVOICE);
  const result = await gateway.createOrder(ORDER_INPUT);
  assert.ok(result.ok);
  assert.equal(result.order.payTo, INVOICE_ADDRESS);
  assert.notEqual(result.order.payTo, X402_PAY_TO);
  assert.equal(result.order.recipientPolicy, 'invoice_scoped');
});

test('an invoice with no usable address is refused, and the invoice EXISTS', async () => {
  const body = { meta: {}, data: { ...LIVE_INVOICE.data, payment: { ...LIVE_INVOICE.data.payment, address: 'not-an-address' } } };
  const { gateway } = gatewayFor(body);
  const result = (await gateway.createOrder(ORDER_INPUT)) as Extract<
    CommerceCreateOrderResultV1,
    { reason: 'invoice_creation_unknown' }
  >;
  assert.equal(result.reason, 'invoice_creation_unknown');
  assert.match(result.detail, /exists at the storefront/i);
});

test('a wrong settlement rail or currency is refused', async () => {
  for (const patch of [{ method: 'lightning' }, { currency: 'EUR' }]) {
    const body = { meta: {}, data: { ...LIVE_INVOICE.data, payment: { ...LIVE_INVOICE.data.payment, ...patch } } };
    const { gateway } = gatewayFor(body);
    const result = await gateway.createOrder(ORDER_INPUT);
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'invoice_creation_unknown');
  }
});

test('the x402 payTo is not accepted as an invoice-scoped recipient by accident', () => {
  // A pinned-policy invoice must equal the constant …
  assert.deepEqual(
    validateCommercePaymentTermsV1({
      network: 'eip155:8453',
      asset: USDC,
      payTo: INVOICE_ADDRESS,
      amountAtomic: '5640000',
      maxSpendAtomic: '5750000',
      resource: 'https://api.bitrefill.com/x402/invoice/pay',
    }),
    { ok: false, reason: 'pinned_recipient_mismatch' },
  );
  // … while an invoice-scoped one only has to be a real, non-zero address.
  assert.deepEqual(
    validateCommerceInvoiceScopedTermsV1({
      network: 'eip155:8453',
      asset: USDC,
      payTo: INVOICE_ADDRESS,
      amountAtomic: '5640000',
      maxSpendAtomic: '5750000',
    }),
    { ok: true },
  );
  assert.deepEqual(
    validateCommerceInvoiceScopedTermsV1({
      network: 'eip155:8453',
      asset: USDC,
      payTo: `0x${'0'.repeat(40)}`,
      amountAtomic: '5640000',
      maxSpendAtomic: '5750000',
    }),
    { ok: false, reason: 'pinned_recipient_mismatch' },
  );
  assert.equal(invoiceAddressV1('0xE9Ee32de59335e4B64dC2C224D7a79fcB43F9fe8'), INVOICE_ADDRESS);
  assert.equal(invoiceAddressV1('nope'), null);
});

test('an invoice-scoped recipient is recorded as such, never as pinned', () => {
  const parent = intent();
  const validated = validateCommerceInvoiceV1({
    provider: {
      invoiceId: 'inv-1',
      network: 'eip155:8453',
      asset: USDC,
      payTo: INVOICE_ADDRESS,
      amountAtomic: '5640000',
      expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      paymentStatus: 'unpaid',
      orderStatus: 'created',
      productId: 'steam-usa',
      packageValue: '5',
      recipientPolicy: 'invoice_scoped',
    },
    intent: parent,
    candidate: candidate(parent),
    authenticatedWallet: WALLET,
    now: NOW,
  });
  assert.ok(validated.ok);
  assert.equal(validated.invoice.recipientPolicy, 'invoice_scoped');
  assert.equal(validated.invoice.payTo, INVOICE_ADDRESS);

  // The same address under the PINNED policy is refused.
  const pinned = validateCommerceInvoiceV1({
    provider: {
      invoiceId: 'inv-1',
      network: 'eip155:8453',
      asset: USDC,
      payTo: INVOICE_ADDRESS,
      amountAtomic: '5640000',
      expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      paymentStatus: 'unpaid',
      orderStatus: 'created',
      productId: 'steam-usa',
      packageValue: '5',
      recipientPolicy: 'pinned',
    },
    intent: parent,
    candidate: candidate(parent),
    authenticatedWallet: WALLET,
    now: NOW,
  });
  assert.deepEqual(pinned, { ok: false, reason: 'pinned_recipient_mismatch' });
});

// --- the order line ---------------------------------------------------------

test('a fixed denomination is ordered by package_id, not by value', async () => {
  const { gateway, requests } = gatewayFor(LIVE_INVOICE);
  await gateway.createOrder(ORDER_INPUT);
  const body = requests[0].body as { products: Record<string, unknown>[] };
  assert.equal(body.products[0].package_id, 'steam-usa<&>5');
  assert.equal(body.products[0].value, undefined);
  assert.equal(body.products[0].product_id, 'steam-usa');
});

test('a product with no package id falls back to value, for range pricing', async () => {
  const { gateway, requests } = gatewayFor(LIVE_INVOICE);
  await gateway.createOrder({ ...ORDER_INPUT, packageId: null });
  const body = requests[0].body as { products: Record<string, unknown>[] };
  assert.equal(body.products[0].package_id, undefined);
  assert.equal(body.products[0].value, '5');
});

test('the invoice request still pins the settlement rail and never auto-pays', async () => {
  const { gateway, requests } = gatewayFor(LIVE_INVOICE);
  await gateway.createOrder(ORDER_INPUT);
  const body = requests[0].body as { payment_method: string; auto_pay: boolean };
  assert.equal(body.payment_method, 'usdc_base');
  assert.equal(body.auto_pay, false);
});

// --- never claim nothing was created ---------------------------------------

test('an unreadable body after a successful POST is uncertain, not a failure', async () => {
  const { gateway } = gatewayFor({ unexpected: true });
  const result = await gateway.createOrder(ORDER_INPUT);
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'invoice_creation_unknown');
});

test('an amount above the ceiling still reports that the invoice exists', async () => {
  const body = { meta: {}, data: { ...LIVE_INVOICE.data, payment: { ...LIVE_INVOICE.data.payment, price: 900000000 } } };
  const { gateway } = gatewayFor(body);
  const result = (await gateway.createOrder(ORDER_INPUT)) as Extract<
    CommerceCreateOrderResultV1,
    { reason: 'invoice_creation_unknown' }
  >;
  assert.equal(result.reason, 'invoice_creation_unknown');
  assert.match(result.detail, /above the 5750000 you authorized/);
  assert.match(result.detail, /exists at the storefront/i);
});
