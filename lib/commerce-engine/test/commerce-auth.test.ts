import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BITREFILL_INVOICE_CREATE_PATH_V1,
  BITREFILL_V2_INVOICES_PATH_V1,
  BITREFILL_V2_PRODUCT_SEARCH_PATH_V1,
  COMMERCE_PAYMENT_METHOD_V1,
  CommerceCredentialSurfaceError,
  buildCommerceUrlV1,
  commerceAuthHeadersV1,
  commerceSurfaceForPathV1,
  createBitrefillPersonalCatalogSourceV1,
  createBitrefillPersonalOrderGatewayV1,
  resolveCommerceCredentialV1,
  resolveV2PackagePriceV1,
  selectV2ProductV1,
  v2InvoiceDeliveryStateV1,
} from '../src/index.js';

globalThis.fetch = (() => {
  throw new Error('Unit tests must not perform live network calls');
}) as typeof fetch;

const NOW = new Date('2026-07-25T12:00:00.000Z');
const API_KEY = 'personal-api-key-not-a-session-token';
const SESSION = 'siwx-session-jwt';

// ---------------------------------------------------------------------------
// T64.1 — the rule: a Personal API key is Bearer on /v2/*, a SIWX session is
// X-Access-Token on /x402/*, and neither is ever sent to the other surface.
// ---------------------------------------------------------------------------

test('a Personal API key authenticates /v2 with Bearer', () => {
  const headers = commerceAuthHeadersV1({ kind: 'personal_api', apiKey: API_KEY }, BITREFILL_V2_PRODUCT_SEARCH_PATH_V1);
  assert.equal(headers['X-Access-Token'], undefined);
  assert.deepEqual(headers, { authorization: `Bearer ${API_KEY}` });
});

test('a SIWX session authenticates /x402 with X-Access-Token', () => {
  const headers = commerceAuthHeadersV1({ kind: 'x402_session', accessToken: SESSION }, BITREFILL_INVOICE_CREATE_PATH_V1);
  assert.equal(headers.authorization, undefined);
  assert.deepEqual(headers, { 'X-Access-Token': SESSION });
});

test('a Personal API key is REFUSED on an x402 route, not silently sent', () => {
  assert.throws(
    () => commerceAuthHeadersV1({ kind: 'personal_api', apiKey: API_KEY }, BITREFILL_INVOICE_CREATE_PATH_V1),
    CommerceCredentialSurfaceError,
  );
});

test('a SIWX session is REFUSED on the Personal API', () => {
  assert.throws(
    () => commerceAuthHeadersV1({ kind: 'x402_session', accessToken: SESSION }, BITREFILL_V2_INVOICES_PATH_V1),
    CommerceCredentialSurfaceError,
  );
});

test('the refusal names the pair and never the credential value', () => {
  try {
    commerceAuthHeadersV1({ kind: 'personal_api', apiKey: API_KEY }, BITREFILL_INVOICE_CREATE_PATH_V1);
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof CommerceCredentialSurfaceError);
    assert.ok(!error.message.includes(API_KEY), 'the key must not appear in the error');
    assert.equal(error.credentialKind, 'personal_api');
    assert.equal(error.surface, 'x402');
  }
});

test('an unknown path can be authenticated by nothing', () => {
  assert.equal(commerceSurfaceForPathV1('/v3/products'), null);
  assert.throws(
    () => commerceAuthHeadersV1({ kind: 'personal_api', apiKey: API_KEY }, '/v3/products'),
    CommerceCredentialSurfaceError,
  );
});

test('anonymous sends no credential header at all', () => {
  assert.deepEqual(commerceAuthHeadersV1({ kind: 'anonymous' }, BITREFILL_V2_PRODUCT_SEARCH_PATH_V1), {});
  assert.deepEqual(commerceAuthHeadersV1({ kind: 'anonymous' }, BITREFILL_INVOICE_CREATE_PATH_V1), {});
});

test('the API key wins over a session token, and they are never merged', () => {
  assert.deepEqual(resolveCommerceCredentialV1({ apiKey: API_KEY, accessToken: SESSION }), {
    kind: 'personal_api',
    apiKey: API_KEY,
  });
  assert.deepEqual(resolveCommerceCredentialV1({ accessToken: SESSION }), {
    kind: 'x402_session',
    accessToken: SESSION,
  });
  assert.deepEqual(resolveCommerceCredentialV1({}), { kind: 'anonymous' });
  // Whitespace-only configuration is not a credential.
  assert.deepEqual(resolveCommerceCredentialV1({ apiKey: '   ' }), { kind: 'anonymous' });
});

// --- The Personal API catalogue --------------------------------------------

const V2_SEARCH_BODY = {
  meta: { _endpoint: '/products/search', count: 1 },
  data: [
    {
      id: 'steam-usa',
      name: 'Steam',
      country_code: 'US',
      country_name: 'United States',
      currency: 'USD',
      categories: ['gaming'],
      recipient_type: 'none',
      in_stock: true,
      packages: [
        { id: 'steam-usa<&>25', value: '25', price: 43460, amount: 25 },
        { id: 'steam-usa<&>10', value: '10', price: 17520, amount: 10 },
      ],
    },
    {
      id: 'steam-italy',
      name: 'Steam',
      country_code: 'IT',
      country_name: 'Italy',
      currency: 'EUR',
      categories: ['gaming'],
      recipient_type: 'none',
      in_stock: true,
      packages: [{ id: 'steam-italy<&>25', value: '25', price: 45900, amount: 25 }],
    },
  ],
};

const SEARCH_INPUT = {
  query: 'Steam',
  kind: 'gift_card' as const,
  country: 'US',
  requestedValueDecimal: '25',
  requestedCurrency: 'USD',
  now: NOW,
};

function personalFetch(body: unknown = V2_SEARCH_BODY, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

test('the Personal API catalogue sends Bearer and reads one endpoint', async () => {
  const { impl, calls } = personalFetch();
  const source = createBitrefillPersonalCatalogSourceV1({ fetchImpl: impl, apiKey: API_KEY });
  const result = await source.search(SEARCH_INPUT);
  assert.ok(result.ok);
  assert.equal(result.observation.packages.length, 2);
  assert.equal(result.observation.endpoint, '/v2/products/search');
  assert.equal(calls.length, 1, 'search already carries packages — no detail call needed');
  assert.ok(calls[0].url.startsWith('https://api.bitrefill.com/v2/products/search'));
  assert.equal(calls[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].headers['x-access-token'], undefined);
});

test('the API key never reaches the evidence hashes', async () => {
  const a = await createBitrefillPersonalCatalogSourceV1({
    fetchImpl: personalFetch().impl,
    apiKey: API_KEY,
  }).search(SEARCH_INPUT);
  const b = await createBitrefillPersonalCatalogSourceV1({
    fetchImpl: personalFetch().impl,
    apiKey: 'a-completely-different-key',
  }).search(SEARCH_INPUT);
  assert.ok(a.ok && b.ok);
  assert.equal(a.observation.requestHash, b.observation.requestHash);
  assert.equal(a.observation.responseHash, b.observation.responseHash);
});

test('country selection happens here, because /v2 search has no country filter', () => {
  assert.equal(selectV2ProductV1(V2_SEARCH_BODY.data, { query: 'Steam', country: 'US' })?.id, 'steam-usa');
  assert.equal(selectV2ProductV1(V2_SEARCH_BODY.data, { query: 'Steam', country: 'DE' }), null);
});

test('without a key the Personal API surface is unconfigured, not anonymous', async () => {
  const source = createBitrefillPersonalCatalogSourceV1({ fetchImpl: personalFetch().impl });
  assert.deepEqual(await source.search(SEARCH_INPUT), { ok: false, reason: 'provider_not_configured' });
});

test('a rejected key is a configuration failure, not an HTTP error', async () => {
  for (const status of [401, 403]) {
    const source = createBitrefillPersonalCatalogSourceV1({
      fetchImpl: personalFetch({ message: 'Invalid authorization token' }, status).impl,
      apiKey: API_KEY,
    });
    assert.deepEqual(await source.search(SEARCH_INPUT), { ok: false, reason: 'provider_not_configured' });
  }
});

test('a /v2 price is a minimum — the exact USDC total comes from the invoice', () => {
  const priced = resolveV2PackagePriceV1({ id: 'steam-usa<&>25', value: '25', price: 25, amount: 25 }, 'USD');
  assert.ok('fees' in priced);
  assert.equal(priced.fees.totalBasis, 'minimum');
  assert.equal(priced.fees.totalAtomic, '25000000');
  assert.equal(priced.fees.providerFeeAtomic, null);
});

// REGRESSION, from the live catalogue on 2026-07-25. `/v2` publishes no
// currency for `package.price` anywhere in the response, and it is plainly not
// the product currency: a $200 Steam card is `{ value: "200", amount: 200,
// price: 347689 }` under `currency: "USD"`. Deriving the total from `price`
// produced a 347,687 USDC "minimum" for a $200 card.
const LIVE_V2_STEAM_PACKAGES = [
  { id: 'steam-usa<&>200', value: '200', price: 347689, amount: 200 },
  { id: 'steam-usa<&>50', value: '50', price: 83866, amount: 50 },
  { id: 'steam-usa<&>20', value: '20', price: 33472, amount: 20 },
  { id: 'steam-usa<&>10', value: '10', price: 17520, amount: 10 },
  { id: 'steam-usa<&>5', value: '5', price: 8760, amount: 5 },
];

test('the unlabelled /v2 `price` field is never used as a settlement total', () => {
  for (const pkg of LIVE_V2_STEAM_PACKAGES) {
    const priced = resolveV2PackagePriceV1(pkg, 'USD');
    assert.ok('fees' in priced, `expected a price for ${pkg.id}`);
    // The face value, not `price`.
    assert.equal(priced.fees.totalAtomic, `${pkg.amount}000000`);
    assert.equal(priced.fiatAmountDecimal, String(pkg.amount));
    assert.equal(priced.fees.totalBasis, 'minimum');
  }
});

test('a $200 card never costs 347,687 USDC', () => {
  const priced = resolveV2PackagePriceV1(LIVE_V2_STEAM_PACKAGES[0], 'USD');
  assert.ok('fees' in priced);
  assert.equal(priced.fees.totalAtomic, '200000000');
  assert.notEqual(priced.fees.totalAtomic, '347689000000');
});

test('a descriptive package value is a label, not a price', () => {
  assert.deepEqual(resolveV2PackagePriceV1({ id: 'esim<&>1gb', value: '1GB, 7 Days', price: 500 }, 'USD'), {
    failure: 'price_unavailable',
  });
});

test('a non-USD /v2 product is refused rather than converted', () => {
  assert.deepEqual(resolveV2PackagePriceV1({ id: 'x<&>25', value: '25', price: 25 }, 'EUR'), {
    failure: 'fx_rate_unavailable',
  });
});

// --- The Personal API order gateway ----------------------------------------

test('a Personal API invoice pins payment_method to usdc_base', async () => {
  const bodies: unknown[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        meta: {},
        data: {
          id: 'inv-1',
          status: 'unpaid',
          expires_time: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
          // The real shape: `price` in USDC base units and a per-invoice address.
          payment: {
            method: 'usdc_base',
            currency: 'USDC',
            price: 25000000,
            status: 'unpaid',
            address: '0xE9Ee32de59335e4B64dC2C224D7a79fcB43F9fe8',
          },
          orders: [{ id: 'ord-1', status: 'pending' }],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const gateway = createBitrefillPersonalOrderGatewayV1({ fetchImpl: impl, apiKey: API_KEY });
  const result = await gateway.createOrder({
    productId: 'steam-usa',
    packageValue: '25',
    recipientInput: null,
    maxSpendAtomic: '28750000',
    refundAddress: '0x1111111111111111111111111111111111111111',
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.order.invoiceId, 'inv-1');
  assert.equal(result.order.totalAtomic, '25000000');
  // T64.2.1: the Personal API issues a deposit address PER INVOICE, so the
  // recipient comes from the invoice — never the x402 constant.
  assert.equal(result.order.payTo, '0xe9ee32de59335e4b64dc2c224d7a79fcb43f9fe8');
  assert.notEqual(result.order.payTo, '0x480cd46e6fade651a0437deadda53d5c8e7d846a');
  assert.equal(result.order.recipientPolicy, 'invoice_scoped');
  // The ASSET stays pinned; method and currency were both checked.
  assert.equal(result.order.asset, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');

  const body = bodies[0] as { payment_method: string; auto_pay: boolean; refund_address: string; products: unknown[] };
  assert.equal(body.payment_method, COMMERCE_PAYMENT_METHOD_V1);
  assert.equal(body.payment_method, 'usdc_base');
  // Never auto-pay: the wallet authorizes the payment, not the server.
  assert.equal(body.auto_pay, false);
  assert.equal(body.refund_address, '0x1111111111111111111111111111111111111111');
});

test('a Personal API checkout without a refund address is refused', async () => {
  const gateway = createBitrefillPersonalOrderGatewayV1({ fetchImpl: personalFetch().impl, apiKey: API_KEY });
  const result = await gateway.createOrder({
    productId: 'steam-usa',
    packageValue: '25',
    recipientInput: null,
    maxSpendAtomic: '28750000',
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'provider_not_configured' });
});

test('a Personal API invoice above the ceiling is refused', async () => {
  const impl = (async () =>
    new Response(
      JSON.stringify({
        meta: {},
        data: {
          id: 'inv-1',
          status: 'unpaid',
          payment: {
            method: 'usdc_base',
            currency: 'USDC',
            price: 90000000,
            status: 'unpaid',
            address: '0xE9Ee32de59335e4B64dC2C224D7a79fcB43F9fe8',
          },
          orders: [],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  const gateway = createBitrefillPersonalOrderGatewayV1({ fetchImpl: impl, apiKey: API_KEY });
  const result = await gateway.createOrder({
    productId: 'steam-usa',
    packageValue: '25',
    recipientInput: null,
    maxSpendAtomic: '28750000',
    refundAddress: '0x1111111111111111111111111111111111111111',
    now: NOW,
  });
  // An over-ceiling invoice still EXISTS at the storefront, so the failure says
  // so instead of claiming nothing was created.
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'invoice_creation_unknown');
});

test('delivery is derived from the order lines, and stays unknown when there are none', () => {
  assert.equal(v2InvoiceDeliveryStateV1([], true), 'unknown');
  assert.equal(v2InvoiceDeliveryStateV1([{ id: 'a', delivered: true }], true), 'all_delivered');
  assert.equal(
    v2InvoiceDeliveryStateV1([{ id: 'a', delivered: true }, { id: 'b', status: 'pending' }], true),
    'partially_delivered',
  );
  assert.equal(v2InvoiceDeliveryStateV1([{ id: 'a', status: 'pending' }], true), 'pending');
  // Nothing is delivered before the payment settles.
  assert.equal(v2InvoiceDeliveryStateV1([{ id: 'a', delivered: true }], false), 'not_started');
});

test('the Personal API status read never returns redemption material', async () => {
  const impl = (async () =>
    new Response(
      JSON.stringify({
        meta: {},
        data: {
          id: 'inv-1',
          status: 'paid',
          payment: { status: 'paid', amount: '25' },
          orders: [{ id: 'ord-1', delivered: true, redemption_info: { code: 'SECRET-CODE', pin: '4242' } }],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  const gateway = createBitrefillPersonalOrderGatewayV1({ fetchImpl: impl, apiKey: API_KEY });
  const result = await gateway.readOrderStatus({ invoiceId: 'inv-1', now: NOW });
  assert.ok(result.ok);
  const serialized = JSON.stringify(result.status);
  assert.ok(!serialized.includes('SECRET-CODE'));
  assert.ok(!serialized.includes('4242'));
  assert.equal(result.status.paymentSettled, true);
  assert.equal(result.status.deliveryState, 'all_delivered');
  assert.deepEqual(result.status.orderIds, ['ord-1']);
});

test('the /v2 id paths are pinned, and nothing else on /v2 is reachable', () => {
  assert.ok(buildCommerceUrlV1('/v2/invoices/abc').endsWith('/v2/invoices/abc'));
  assert.ok(buildCommerceUrlV1('/v2/products/steam-usa').endsWith('/v2/products/steam-usa'));
  assert.throws(() => buildCommerceUrlV1('/v2/accounts/balance'), /not pinned/);
  assert.throws(() => buildCommerceUrlV1('/v2/anything'), /not pinned/);
});
