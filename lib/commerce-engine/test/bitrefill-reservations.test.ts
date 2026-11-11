import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BITREFILL_MCP_TOKEN_URL_V1,
  BITREFILL_MCP_URL_V1,
  createBitrefillGuestCatalogV1,
  createBitrefillGuestCheckoutV1,
} from '../src/index.js';

const NOW = new Date('2026-11-11T12:00:00Z');
const INVOICE = '11111111-2222-4333-8444-555555555555';
const OTHER_INVOICE = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const ACCESS = 'synthetic-invoice-access-0123456789';
const REFUSED = { ok: false, reason: 'bitrefill_rate_limited' } as const;
const PAYMENT = { invoiceId: INVOICE, accessToken: ACCESS };
const CREATE = { productId: 'synthetic-esim', packageValue: '1 GB', email: 'buyer@example.com', quotedAtomic: 180_000n, now: NOW };

interface ToolRequest {
  name: string;
  args: Record<string, unknown>;
  authorization: string | null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function rpc(text: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function tokenResponse(index: number): Response {
  return new Response(JSON.stringify({ access_token: 'synthetic-guest-token-' + index + '-0123456789', expires_in: 21600 }), { status: 200 });
}

/** Everything is synthetic: this fetch never leaves the process. Count OAuth too. */
function provider(options: {
  token?: (index: number) => Response | Promise<Response>;
  tool?: (request: ToolRequest) => Response | Promise<Response> | undefined;
} = {}) {
  const calls: Array<{ kind: 'token' } | ({ kind: 'tool' } & ToolRequest)> = [];
  let tokens = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === BITREFILL_MCP_TOKEN_URL_V1) {
      calls.push({ kind: 'token' });
      tokens += 1;
      return await (options.token?.(tokens) ?? tokenResponse(tokens));
    }
    assert.equal(url, BITREFILL_MCP_URL_V1);
    const payload = JSON.parse(String(init.body)) as { params: { name: string; arguments: Record<string, unknown> } };
    const request = { name: payload.params.name, args: payload.params.arguments, authorization: new Headers(init.headers).get('authorization') };
    calls.push({ kind: 'tool', ...request });
    const custom = options.tool?.(request);
    if (custom !== undefined) return await custom;
    if (request.name === 'get-product-details') return rpc('id: ' + String(request.args.product_id) + '\nname: Synthetic product');
    if (request.name === 'search-products') return rpc('products: []');
    if (request.name === 'get-invoice-by-id') return rpc(JSON.stringify({ invoice_status: 'unpaid' }));
    assert.equal(request.name, 'buy-products');
    return rpc(JSON.stringify({ response: {
      invoice_id: INVOICE, invoice_access_token: ACCESS, expiration_minutes: 15,
      // An invoice must name Base itself, or Still reads no invoice from it.
      payment_info: { address: '0x3333333333333333333333333333333333333333', amount: '0.18', currency: 'USDC', contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    } }));
  }) as typeof fetch;
  return { fetchImpl, calls, tokenCount: () => tokens };
}

describe('Bitrefill reserves capacity inside the existing transport windows', () => {
  it('public product probing and search leave six fresh checkout reads, without exceeding twenty including OAuth', async () => {
    let at = 1_000;
    const mock = provider();
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: mock.fetchImpl, now: () => at });
    for (let index = 0; index < 13; index++) {
      assert.equal((await catalog.product('public-' + index)).ok, true);
    }
    assert.equal(mock.calls.length, 14); // One OAuth request and thirteen product reads.
    assert.deepEqual(await catalog.product('public-over-cap'), REFUSED);
    assert.deepEqual(await catalog.search({ type: 'esim', country: 'DE' }), REFUSED);
    assert.equal(mock.calls.length, 14);
    for (let index = 0; index < 6; index++) {
      assert.equal((await catalog.product('checkout-' + index, { freshForCheckout: true })).ok, true);
    }
    assert.equal(mock.calls.length, 20);
    assert.deepEqual(await catalog.product('checkout-over-total', { freshForCheckout: true }), REFUSED);
    assert.equal(mock.calls.length, 20);
    const last = mock.calls.at(-1)!;
    assert.equal(last.kind, 'tool');
    if (last.kind === 'tool') assert.deepEqual(last.args, { product_id: 'checkout-5', currency: 'USDC' });
    at += 60_001;
    assert.equal((await catalog.product('public-new-window')).ok, true);
    assert.equal(mock.tokenCount(), 1); // Reuse the existing token, not a new quota.
  });

  it('priority requests count against the total, rather than reducing the ordinary sub-limit', async () => {
    const mock = provider();
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: mock.fetchImpl, now: () => 1_000 });
    assert.equal((await catalog.product('checkout-first', { freshForCheckout: true })).ok, true);
    for (let index = 0; index < 14; index++) assert.equal((await catalog.product('public-' + index)).ok, true);
    assert.equal(mock.calls.length, 16); // Two priority requests (OAuth + product), fourteen ordinary.
    assert.deepEqual(await catalog.product('public-over-cap'), REFUSED);
    for (let index = 0; index < 4; index++) assert.equal((await catalog.product('checkout-' + index, { freshForCheckout: true })).ok, true);
    assert.equal(mock.calls.length, 20);
    assert.deepEqual(await catalog.product('checkout-over-total', { freshForCheckout: true }), REFUSED);
  });

  it('two orders polling status cannot spend the four slots reserved for a third purchase and payment checks', async () => {
    let at = 1_000;
    const mock = provider();
    const checkout = createBitrefillGuestCheckoutV1({ fetchImpl: mock.fetchImpl, now: () => at });
    for (let index = 0; index < 5; index++) {
      assert.equal((await checkout.readInvoice({ ...PAYMENT, invoiceId: index % 2 ? OTHER_INVOICE : INVOICE }, { purpose: 'display' })).ok, true);
    }
    assert.equal(mock.calls.length, 6); // Five polls plus their one OAuth request.
    assert.deepEqual(await checkout.readInvoice(PAYMENT, { purpose: 'display' }), REFUSED);
    assert.equal((await checkout.createInvoice(CREATE)).ok, true);
    assert.equal((await checkout.readInvoice(PAYMENT)).ok, true); // An omitted purpose remains a safety read.
    assert.equal((await checkout.readInvoice(PAYMENT, { purpose: 'payment' })).ok, true);
    assert.equal((await checkout.createInvoice(CREATE)).ok, true);
    assert.equal(mock.calls.length, 10);
    assert.deepEqual(await checkout.createInvoice(CREATE), REFUSED);
    assert.deepEqual(await checkout.readInvoice(PAYMENT), REFUSED);
    assert.equal(mock.calls.length, 10);
    at += 60_001;
    assert.equal((await checkout.readInvoice(PAYMENT, { purpose: 'display' })).ok, true);
    assert.equal(mock.tokenCount(), 1);
  });
});

describe('OAuth single-flight and 401 retries share the original request budget', () => {
  it('a concurrent catalogue cold start makes one OAuth request', async () => {
    const started = deferred<void>(), release = deferred<Response>();
    const mock = provider({ token: () => { started.resolve(undefined); return release.promise; } });
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: mock.fetchImpl, now: () => 1_000 });
    const reads = Array.from({ length: 10 }, (_, index) => catalog.product('parallel-' + index));
    await started.promise;
    assert.equal(mock.tokenCount(), 1);
    release.resolve(tokenResponse(1));
    const results = await Promise.all(reads);
    assert.ok(results.every((result) => result.ok));
    assert.equal(mock.tokenCount(), 1);
    assert.equal(mock.calls.length, 11);
  });

  it('a failed token flight is cleared so a later attempt can recover', async () => {
    const mock = provider({ token: (index) => index === 1 ? new Response('', { status: 503 }) : tokenResponse(index) });
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: mock.fetchImpl, now: () => 1_000 });
    assert.deepEqual(await catalog.product('first'), { ok: false, reason: 'bitrefill_unreachable' });
    assert.equal((await catalog.product('second')).ok, true);
    assert.equal(mock.tokenCount(), 2);
    assert.equal(mock.calls.length, 3);
  });

  it('a priority 401, refresh and retry all spend priority slots in the same twenty-request window', async () => {
    let refuseOnce = true;
    const mock = provider({ tool: (request) => {
      if (request.args.product_id === 'checkout-refresh' && refuseOnce) {
        refuseOnce = false;
        return new Response('', { status: 401 });
      }
      return undefined;
    } });
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: mock.fetchImpl, now: () => 1_000 });
    for (let index = 0; index < 13; index++) assert.equal((await catalog.product('public-' + index)).ok, true);
    assert.equal(mock.calls.length, 14);
    assert.equal((await catalog.product('checkout-refresh', { freshForCheckout: true })).ok, true);
    assert.equal(mock.calls.length, 17); // Failed tool request, one OAuth refresh, successful retry.
    assert.equal(mock.tokenCount(), 2);
    for (let index = 0; index < 3; index++) assert.equal((await catalog.product('checkout-' + index, { freshForCheckout: true })).ok, true);
    assert.deepEqual(await catalog.product('checkout-over-total', { freshForCheckout: true }), REFUSED);
    assert.equal(mock.calls.length, 20);
  });

  it('an ordinary 401 retry cannot promote itself into checkout capacity', async () => {
    let refuseOnce = true;
    const mock = provider({ tool: (request) => {
      if (request.args.product_id === 'public-refresh' && refuseOnce) {
        refuseOnce = false;
        return new Response('', { status: 401 });
      }
      return undefined;
    } });
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: mock.fetchImpl, normalPerMinute: 4, now: () => 1_000 });
    assert.equal((await catalog.product('warm')).ok, true);
    assert.deepEqual(await catalog.product('public-refresh'), REFUSED);
    assert.equal(mock.calls.length, 4); // OAuth, warm read, 401 read, OAuth; no unbudgeted retry.
    assert.equal(mock.tokenCount(), 2);
    assert.equal((await catalog.product('checkout', { freshForCheckout: true })).ok, true);
    assert.equal(mock.calls.length, 5);
  });

  it('a late 401 for an old token does not discard the replacement another request already obtained', async () => {
    const startedA = deferred<void>(), startedB = deferred<void>();
    const answerA = deferred<Response>(), answerB = deferred<Response>();
    const mock = provider({ tool: (request) => {
      if (request.authorization !== 'Bearer synthetic-guest-token-1-0123456789') return undefined;
      if (request.args.product_id === 'parallel-a') { startedA.resolve(undefined); return answerA.promise; }
      if (request.args.product_id === 'parallel-b') { startedB.resolve(undefined); return answerB.promise; }
      return undefined;
    } });
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: mock.fetchImpl, now: () => 1_000 });
    assert.equal((await catalog.product('warm')).ok, true);
    const first = catalog.product('parallel-a'), second = catalog.product('parallel-b');
    await Promise.all([startedA.promise, startedB.promise]);
    answerA.resolve(new Response('', { status: 401 }));
    assert.equal((await first).ok, true);
    assert.equal(mock.tokenCount(), 2);
    answerB.resolve(new Response('', { status: 401 }));
    assert.equal((await second).ok, true);
    assert.equal(mock.tokenCount(), 2);
    assert.equal(mock.calls.length, 7);
  });
});
