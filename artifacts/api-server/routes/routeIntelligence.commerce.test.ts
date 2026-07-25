import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { resolveCommerceIntentV1 } from '@mioagent/intent-engine';
import {
  compareCommerceRoutesV1,
  createBitrefillCatalogSourceV1,
  type CommerceCatalogSourceV1,
} from '@mioagent/commerce-engine';
import { commerceRouteRuntime, routeIntelligenceRouter } from './routeIntelligence.js';
import { clearCommerceOrdersV1 } from '../lib/commerceRouteConfig.js';

// A detonator on the global fetch: the commerce seams resolve LIVE Bitrefill
// readings in production, so a test that forgets to stub one fails loudly
// instead of quietly opening a socket. supertest drives the router over a
// local http server, never through fetch.
globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// T64: the commerce routes. Two independently gated surfaces —
// `commerce/compare` (read-only) and `commerce/orders` (opens a checkout) —
// so the tests assert that comparison being ON does not imply checkout is on.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const NOW = new Date('2026-07-25T12:00:00.000Z');
const originalRuntime = { ...commerceRouteRuntime };
const originalChainEnv = process.env.CHAIN_ENV;

const COMPARE_ONLY_FLAGS = {
  routeIntelligenceV1: true,
  legacyTerminal: true,
  paidIntelligence: false,
  earnRouteV1: false,
  commerceRouteV1: true,
  commerceExecutionV1: false,
} as const;

const CHECKOUT_FLAGS = { ...COMPARE_ONLY_FLAGS, commerceExecutionV1: true } as const;

const MESSAGE = 'Buy a US Steam gift card for $25';
const BODY = { message: MESSAGE, walletAddress: WALLET, requestId: 'commerce-req-1' };

const SEARCH_BODY = {
  products: [{ slug: 'steam-usa', name: 'Steam US', country_code: 'US', currency: 'USD', in_stock: true }],
};
const DETAIL_BODY = {
  slug: 'steam-usa',
  name: 'Steam US',
  country_code: 'US',
  currency: 'USD',
  in_stock: true,
  recipient_required: false,
  packages: [
    { package_value: '25', value: '25', usdc_price: '25', in_stock: true },
    { package_value: '10', value: '10', usdc_price: '10', in_stock: true },
  ],
};

function stubCatalog(): CommerceCatalogSourceV1 {
  return createBitrefillCatalogSourceV1({
    fetchImpl: (async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(String(input).includes('detail') ? DETAIL_BODY : SEARCH_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });
}

function routeApp(user: typeof USER | null = USER) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  app.use('/api/route-intelligence', routeIntelligenceRouter);
  return app;
}

async function comparisonFixture() {
  const resolution = resolveCommerceIntentV1({
    message: MESSAGE,
    tenantId: USER.id,
    walletAddress: WALLET as `0x${string}`,
    now: NOW,
  });
  assert.equal(resolution.status, 'ready');
  if (resolution.status !== 'ready') throw new Error('fixture intent not ready');
  const comparison = await compareCommerceRoutesV1({ catalog: stubCatalog() }, { intent: resolution.intent, now: NOW });
  assert.equal(comparison.ok, true);
  if (!comparison.ok) throw new Error('fixture comparison failed');
  return comparison;
}

describe('POST /api/route-intelligence/commerce/compare', () => {
  beforeEach(() => {
    commerceRouteRuntime.flags = () => ({ ...COMPARE_ONLY_FLAGS });
    commerceRouteRuntime.now = () => NOW;
    commerceRouteRuntime.compare = (input) => compareCommerceRoutesV1({ catalog: stubCatalog() }, input);
    process.env.CHAIN_ENV = 'mainnet';
  });

  afterEach(() => {
    Object.assign(commerceRouteRuntime, originalRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
    clearCommerceOrdersV1();
  });

  test('the route 404s while the commerce gate is off', async () => {
    for (const flags of [
      { ...COMPARE_ONLY_FLAGS, commerceRouteV1: false },
      { ...COMPARE_ONLY_FLAGS, routeIntelligenceV1: false },
    ]) {
      commerceRouteRuntime.flags = () => ({ ...flags });
      const response = await request(routeApp()).post('/api/route-intelligence/commerce/compare').send(BODY);
      assert.equal(response.status, 404);
      assert.equal(response.body.code, 'commerce_route_disabled');
    }
  });

  test('an unauthenticated or mismatched wallet is refused', async () => {
    assert.equal(
      (await request(routeApp(null)).post('/api/route-intelligence/commerce/compare').send(BODY)).status,
      401,
    );
    const mismatch = await request(routeApp())
      .post('/api/route-intelligence/commerce/compare')
      .send({ ...BODY, walletAddress: '0x2222222222222222222222222222222222222222' });
    assert.equal(mismatch.status, 403);
  });

  test('an unknown field is rejected rather than ignored', async () => {
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/compare')
      .send({ ...BODY, productId: 'steam-usa' });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_commerce_compare_request');
  });

  test('a ready request returns the Commerce Route Card with its disclosures', async () => {
    const response = await request(routeApp()).post('/api/route-intelligence/commerce/compare').send(BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'compared');
    assert.equal(response.body.countryInferred, false);
    assert.ok(response.body.routeCard.comparisons.length >= 1);
    // Delivery certainty has no source, so it is visible and unscored.
    const delivery = response.body.routeCard.comparisons[0].score.dimensions.find(
      (dimension: { dimension: string }) => dimension.dimension === 'delivery_certainty',
    );
    assert.equal(delivery.status, 'not_scored');
    assert.equal(delivery.score, null);
  });

  test('a request with no price asks instead of guessing', async () => {
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/compare')
      .send({ ...BODY, message: 'buy me a Steam gift card' });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'needs_clarification');
    assert.ok(response.body.issues.includes('amount_required'));
  });

  test('a non-commerce goal is reported unsupported, not compared', async () => {
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/compare')
      .send({ ...BODY, message: 'swap 100 USDC to ETH' });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'unsupported');
  });

  test('a provider failure is an honest outcome, not a 500', async () => {
    commerceRouteRuntime.compare = async () => ({ ok: false, reason: 'provider_timeout' as const });
    const response = await request(routeApp()).post('/api/route-intelligence/commerce/compare').send(BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'unsupported');
    assert.equal(response.body.reason, 'provider_timeout');
  });
});

describe('POST /api/route-intelligence/commerce/orders', () => {
  let cardHash = '';
  let candidateHash = '';

  beforeEach(async () => {
    commerceRouteRuntime.flags = () => ({ ...CHECKOUT_FLAGS });
    commerceRouteRuntime.now = () => NOW;
    commerceRouteRuntime.compare = (input) => compareCommerceRoutesV1({ catalog: stubCatalog() }, input);
    commerceRouteRuntime.createOrder = async (input) => ({
      ok: true as const,
      order: {
        invoiceId: 'inv-1',
        totalAtomic: '25000000',
        payTo: '0x480cd46e6fade651a0437deadda53d5c8e7d846a' as `0x${string}`,
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as `0x${string}`,
        expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
        items: [{ productId: input.productId, packageValue: input.packageValue, orderId: null }],
      },
    });
    process.env.CHAIN_ENV = 'mainnet';
    const comparison = await comparisonFixture();
    cardHash = comparison.routeCard.routeCardHash;
    candidateHash = comparison.routeCard.comparisons[0].candidate.candidateHash;
  });

  afterEach(() => {
    Object.assign(commerceRouteRuntime, originalRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
    clearCommerceOrdersV1();
  });

  function orderBody(overrides: Record<string, unknown> = {}) {
    return {
      message: MESSAGE,
      walletAddress: WALLET,
      routeCardHash: cardHash,
      selectedCandidateHash: candidateHash,
      requestId: 'commerce-order-1',
      ...overrides,
    };
  }

  test('comparing being enabled does NOT enable checkout', async () => {
    commerceRouteRuntime.flags = () => ({ ...COMPARE_ONLY_FLAGS });
    const response = await request(routeApp()).post('/api/route-intelligence/commerce/orders').send(orderBody());
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'commerce_execution_disabled');
  });

  test('a checkout is opened and its payment terms are returned for review', async () => {
    const response = await request(routeApp()).post('/api/route-intelligence/commerce/orders').send(orderBody());
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'created');
    // Nothing is signed or settled by opening a checkout.
    assert.equal(response.body.order.paymentState, 'awaiting_signature');
    assert.equal(response.body.order.deliveryState, 'not_started');
    assert.equal(response.body.order.paymentTransactionHash, null);
    assert.equal(response.body.payment.payTo, '0x480cd46e6fade651a0437deadda53d5c8e7d846a');
    assert.equal(response.body.payment.asset, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    assert.equal(response.body.payment.network, 'eip155:8453');
  });

  test('a stale route card hash is a refresh, never a re-priced order', async () => {
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/orders')
      .send(orderBody({ routeCardHash: `0x${'0'.repeat(64)}` }));
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'refresh_required');
  });

  test('a candidate that no longer re-derives is a refresh', async () => {
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/orders')
      .send(orderBody({ selectedCandidateHash: `0x${'1'.repeat(64)}` }));
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'refresh_required');
  });

  test('a checkout that names another recipient is blocked before any signing prompt', async () => {
    commerceRouteRuntime.createOrder = async (input) => ({
      ok: true as const,
      order: {
        invoiceId: 'inv-evil',
        totalAtomic: '25000000',
        payTo: '0x00000000000000000000000000000000deadbeef' as `0x${string}`,
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as `0x${string}`,
        expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
        items: [{ productId: input.productId, packageValue: input.packageValue, orderId: null }],
      },
    });
    const response = await request(routeApp()).post('/api/route-intelligence/commerce/orders').send(orderBody());
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'blocked');
    assert.match(response.body.reason, /pinned_recipient_mismatch/);
  });

  test('a storefront that will not open a checkout is an honest block, not a 500', async () => {
    commerceRouteRuntime.createOrder = async () => ({ ok: false as const, reason: 'provider_payment_required' });
    const response = await request(routeApp()).post('/api/route-intelligence/commerce/orders').send(orderBody());
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'blocked');
    assert.match(response.body.reason, /provider_payment_required/);
  });
});

describe('GET /api/route-intelligence/commerce/orders/:invoiceId', () => {
  beforeEach(async () => {
    commerceRouteRuntime.flags = () => ({ ...CHECKOUT_FLAGS });
    commerceRouteRuntime.now = () => NOW;
    commerceRouteRuntime.compare = (input) => compareCommerceRoutesV1({ catalog: stubCatalog() }, input);
    commerceRouteRuntime.createOrder = async (input) => ({
      ok: true as const,
      order: {
        invoiceId: 'inv-1',
        totalAtomic: '25000000',
        payTo: '0x480cd46e6fade651a0437deadda53d5c8e7d846a' as `0x${string}`,
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as `0x${string}`,
        expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
        items: [{ productId: input.productId, packageValue: input.packageValue, orderId: null }],
      },
    });
    process.env.CHAIN_ENV = 'mainnet';
    const comparison = await comparisonFixture();
    await request(routeApp())
      .post('/api/route-intelligence/commerce/orders')
      .send({
        message: MESSAGE,
        walletAddress: WALLET,
        routeCardHash: comparison.routeCard.routeCardHash,
        selectedCandidateHash: comparison.routeCard.comparisons[0].candidate.candidateHash,
        requestId: 'commerce-order-1',
      });
  });

  afterEach(() => {
    Object.assign(commerceRouteRuntime, originalRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
    clearCommerceOrdersV1();
  });

  test('another wallet cannot read this checkout', async () => {
    const other = { id: 'eip155:8453:0x2222222222222222222222222222222222222222', address: '0x2222222222222222222222222222222222222222', chainId: 8453 as const };
    const response = await request(routeApp(other)).get('/api/route-intelligence/commerce/orders/inv-1');
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'unknown_order');
  });

  test('payment, order, and delivery together report a delivered proof', async () => {
    commerceRouteRuntime.readOrderStatus = async () => ({
      ok: true as const,
      status: {
        invoiceId: 'inv-1',
        paymentSettled: true,
        paymentTransactionHash: `0x${'a'.repeat(64)}` as `0x${string}`,
        settledAt: NOW.toISOString(),
        orderIds: ['ord-1'],
        deliveryState: 'all_delivered' as const,
        itemCount: 1,
        deliveredCount: 1,
        observedAt: NOW.toISOString(),
      },
    });
    const response = await request(routeApp()).get('/api/route-intelligence/commerce/orders/inv-1');
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'status');
    assert.equal(response.body.proof.finalStatus, 'delivered');
    assert.equal(response.body.order.status, 'delivered');
  });

  test('a settled payment with NO confirmed order is never reported as a purchase', async () => {
    commerceRouteRuntime.readOrderStatus = async () => ({
      ok: true as const,
      status: {
        invoiceId: 'inv-1',
        paymentSettled: true,
        paymentTransactionHash: `0x${'a'.repeat(64)}` as `0x${string}`,
        settledAt: NOW.toISOString(),
        orderIds: [],
        deliveryState: 'unknown' as const,
        itemCount: 1,
        deliveredCount: 0,
        observedAt: NOW.toISOString(),
      },
    });
    const response = await request(routeApp()).get('/api/route-intelligence/commerce/orders/inv-1');
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'status');
    assert.equal(response.body.proof.finalStatus, 'order_unconfirmed');
    assert.notEqual(response.body.proof.finalStatus, 'delivered');
    assert.notEqual(response.body.order.status, 'delivered');
  });

  test('an unreachable storefront is an honest outcome, not a 500', async () => {
    commerceRouteRuntime.readOrderStatus = async () => ({ ok: false as const, reason: 'provider_timeout' });
    const response = await request(routeApp()).get('/api/route-intelligence/commerce/orders/inv-1');
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'provider_unavailable');
  });

  test('a malformed invoice id is refused', async () => {
    const response = await request(routeApp()).get('/api/route-intelligence/commerce/orders/%20');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_commerce_invoice_id');
  });
});
