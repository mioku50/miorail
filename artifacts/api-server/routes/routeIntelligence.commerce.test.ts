import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import {
  compareCommerceRoutesV1,
  createBitrefillCatalogSourceV1,
  type CommerceCatalogSourceV1,
} from '@mioagent/commerce-engine';
import { createMemoryCommerceStorageRepository, type CommerceStorageRepository } from '@mioagent/route-storage';
import { commerceRouteRuntime, routeIntelligenceRouter } from './routeIntelligence.js';

// A detonator on the global fetch: the commerce seams resolve LIVE Bitrefill
// readings in production, so a test that forgets to stub one fails loudly
// instead of quietly opening a socket.
globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// T64.2: the commerce routes over DURABLE storage. The memory repository is
// injected through the runtime seam, so these tests exercise the same
// invariants the Postgres implementation enforces — one order row per
// idempotency key, tenant isolation on every read, and an uncertain provider
// call that is never retried.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const OTHER_USER = { id: `eip155:8453:${OTHER_WALLET}`, address: OTHER_WALLET, chainId: 8453 as const };
const NOW = new Date('2026-07-25T12:00:00.000Z');
const PAY_TO = '0x480cd46e6fade651a0437deadda53d5c8e7d846a';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const originalRuntime = { ...commerceRouteRuntime };
const originalChainEnv = process.env.CHAIN_ENV;

const COMPARE_ONLY_FLAGS = {
  routeIntelligenceV1: true,
  legacyTerminal: true,
  paidIntelligence: false,
  earnRouteV1: false,
  commerceRouteV1: true,
  commerceExecutionV1: false,
  nftRouteV1: false,
  nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, b20PublicContextV1: false, b20TargetedMeasureV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false,
} as const;
const CHECKOUT_FLAGS = { ...COMPARE_ONLY_FLAGS, commerceExecutionV1: true } as const;

const MESSAGE = 'Buy a US Steam gift card for $25';
const COMPARE_BODY = { message: MESSAGE, walletAddress: WALLET, requestId: 'commerce-req-1' };

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
  packages: [{ package_value: '25', value: '25', usdc_price: '25', in_stock: true }],
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

/** The one durable repository the whole suite shares. A "restart" is modelled
 * by rebuilding the express app while keeping this instance — exactly what a
 * process restart does to Postgres. */
let repository: CommerceStorageRepository;
let providerCalls = 0;

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

function createdInvoice(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    order: {
      invoiceId: 'inv-1',
      totalAtomic: '25840000',
      payTo: PAY_TO as `0x${string}`,
      asset: USDC as `0x${string}`,
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
      items: [{ productId: 'steam-usa', packageValue: '25', orderId: null }],
      providerFeeAtomic: null,
      paymentStatus: 'unpaid',
      orderStatus: 'created',
      ...overrides,
    },
  };
}

beforeEach(() => {
  repository = createMemoryCommerceStorageRepository();
  providerCalls = 0;
  commerceRouteRuntime.flags = () => ({ ...CHECKOUT_FLAGS });
  commerceRouteRuntime.now = () => NOW;
  commerceRouteRuntime.compare = (input) => compareCommerceRoutesV1({ catalog: stubCatalog() }, input);
  commerceRouteRuntime.repository = () => repository;
  commerceRouteRuntime.migrationAvailable = async () => true;
  commerceRouteRuntime.createOrder = async () => {
    providerCalls += 1;
    return createdInvoice();
  };
  process.env.CHAIN_ENV = 'mainnet';
});

afterEach(() => {
  Object.assign(commerceRouteRuntime, originalRuntime);
  if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
  else process.env.CHAIN_ENV = originalChainEnv;
});

async function compare(user = USER, requestId = 'commerce-req-1') {
  const response = await request(routeApp(user))
    .post('/api/route-intelligence/commerce/compare')
    .send({ ...COMPARE_BODY, walletAddress: user.address, requestId });
  assert.equal(response.status, 200);
  assert.equal(response.body.outcome, 'compared');
  return response.body as {
    routeRunId: string;
    routeCard: { routeCardHash: string; comparisons: { candidate: { candidateHash: string } }[] };
  };
}

function orderBody(compared: Awaited<ReturnType<typeof compare>>, requestId = 'order-1') {
  return {
    routeRunId: compared.routeRunId,
    routeCardHash: compared.routeCard.routeCardHash,
    selectedCandidateHash: compared.routeCard.comparisons[0].candidate.candidateHash,
    walletAddress: WALLET,
    requestId,
  };
}

describe('T64.2 durable commerce compare', () => {
  test('a comparison is persisted and returns its run id', async () => {
    const compared = await compare();
    assert.ok(compared.routeRunId.length > 0);
    const run = await repository.getCommerceRouteRun(compared.routeRunId, USER.id);
    assert.ok(run);
    const cards = await repository.listCommerceRouteCards(compared.routeRunId, USER.id);
    assert.equal(cards.length, 1);
    const candidates = await repository.listCommerceCandidates(compared.routeRunId, USER.id);
    assert.equal(candidates.length, 1);
    const evidence = await repository.listCommerceEvidence(compared.routeRunId, USER.id);
    assert.equal(evidence.length, 1);
  });

  test('missing commerce storage is a stable 503, never a partial write', async () => {
    commerceRouteRuntime.migrationAvailable = async () => false;
    const response = await request(routeApp()).post('/api/route-intelligence/commerce/compare').send(COMPARE_BODY);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'commerce_storage_unavailable');
  });

  test('another tenant cannot read this run', async () => {
    const compared = await compare();
    assert.equal(await repository.getCommerceRouteRun(compared.routeRunId, OTHER_USER.id), null);
  });

  test('the Base plugin example reaches Bitrefill with an Amazon-only query', async () => {
    const seenUrls: string[] = [];
    const amazonSearch = {
      products: [{ slug: 'amazon-usa', name: 'Amazon US', country_code: 'US', currency: 'USD', in_stock: true }],
    };
    const amazonDetail = {
      slug: 'amazon-usa',
      name: 'Amazon US',
      country_code: 'US',
      currency: 'USD',
      in_stock: true,
      recipient_required: false,
      packages: [{ package_value: '25', value: '25', usdc_price: '25', in_stock: true }],
    };
    const catalog = createBitrefillCatalogSourceV1({
      fetchImpl: (async (input: RequestInfo | URL) => {
        seenUrls.push(String(input));
        return new Response(JSON.stringify(String(input).includes('detail') ? amazonDetail : amazonSearch), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    commerceRouteRuntime.compare = (input) => compareCommerceRoutesV1({ catalog }, input);

    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/compare')
      .send({
        message: 'Find a 25 USD Amazon US gift card on Bitrefill',
        walletAddress: WALLET,
        requestId: 'base-plugin-bitrefill-example',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'compared');
    assert.match(seenUrls[0] ?? '', /[?&]q=Amazon(?:&|$)/);
    assert.doesNotMatch(seenUrls[0] ?? '', /Find|Bitrefill/);
  });

  test('product_not_found records that the catalogue was reached', async () => {
    commerceRouteRuntime.compare = async () => ({ ok: false, reason: 'product_not_found' });
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/compare')
      .send(COMPARE_BODY);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      outcome: 'unsupported',
      reason: 'product_not_found',
      catalogueStatus: 'reached_no_match',
    });
  });
});

describe('T64.2 idempotent invoice creation', () => {
  test('comparing being enabled does NOT enable checkout', async () => {
    const compared = await compare();
    commerceRouteRuntime.flags = () => ({ ...COMPARE_ONLY_FLAGS });
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/orders')
      .send(orderBody(compared));
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'commerce_execution_disabled');
  });

  test('a checkout returns the EXACT invoice amount alongside the estimate', async () => {
    const compared = await compare();
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/orders')
      .send(orderBody(compared));
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'created');
    // The catalogue estimated 25 USDC; the invoice requires 25.84.
    assert.equal(response.body.amounts.estimatedMinimumAtomic, '25000000');
    assert.equal(response.body.amounts.exactAmountAtomic, '25840000');
    assert.equal(response.body.amounts.exceedsEstimate, true);
    assert.equal(response.body.amounts.differenceAtomic, '840000');
    // The estimate is NOT overwritten by the exact amount.
    assert.equal(response.body.order.estimate.totalAtomic, '25000000');
    assert.equal(response.body.invoice.amountAtomic, '25840000');
    // Nothing is signed or paid by creating an invoice.
    assert.equal(response.body.order.paymentState, 'awaiting_signature');
    assert.equal(response.body.order.paymentTransactionHash, null);
    assert.equal(response.body.invoice.paymentStatus, 'awaiting_signature');
    assert.equal(providerCalls, 1);
  });

  test('a repeated request does NOT create a second invoice', async () => {
    const compared = await compare();
    const app = routeApp();
    const first = await request(app).post('/api/route-intelligence/commerce/orders').send(orderBody(compared));
    const second = await request(app).post('/api/route-intelligence/commerce/orders').send(orderBody(compared));
    assert.equal(first.body.outcome, 'created');
    assert.equal(second.body.outcome, 'created');
    assert.equal(second.body.invoice.invoiceId, first.body.invoice.invoiceId);
    assert.equal(second.body.orderId, first.body.orderId);
    assert.equal(providerCalls, 1, 'the provider must be called exactly once');
  });

  test('a different requestId is a different checkout, by design', async () => {
    const compared = await compare();
    commerceRouteRuntime.createOrder = async () => {
      providerCalls += 1;
      return createdInvoice({ invoiceId: `inv-${providerCalls}` });
    };
    const app = routeApp();
    await request(app).post('/api/route-intelligence/commerce/orders').send(orderBody(compared, 'order-1'));
    await request(app).post('/api/route-intelligence/commerce/orders').send(orderBody(compared, 'order-2'));
    assert.equal(providerCalls, 2);
  });

  test('an uncertain provider result is durable and is NEVER retried', async () => {
    const compared = await compare();
    commerceRouteRuntime.createOrder = async () => {
      providerCalls += 1;
      return {
        ok: false as const,
        reason: 'invoice_creation_unknown' as const,
        detail: 'The checkout call did not return a definite answer.',
      };
    };
    const app = routeApp();
    const first = await request(app).post('/api/route-intelligence/commerce/orders').send(orderBody(compared));
    assert.equal(first.status, 200);
    assert.equal(first.body.outcome, 'invoice_creation_unknown');
    assert.match(first.body.reason, /may exist/i);

    // The retry must NOT call the provider again — that is how a duplicate
    // invoice gets created for money the user may already owe.
    const second = await request(app).post('/api/route-intelligence/commerce/orders').send(orderBody(compared));
    assert.equal(second.body.outcome, 'invoice_creation_unknown');
    assert.equal(providerCalls, 1, 'an uncertain checkout is never automatically retried');
  });

  test('an invoice above the authorized ceiling is refused', async () => {
    const compared = await compare();
    commerceRouteRuntime.createOrder = async () => createdInvoice({ totalAtomic: '90000000' });
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/orders')
      .send(orderBody(compared));
    assert.equal(response.body.outcome, 'blocked');
    assert.match(response.body.reason, /spend_ceiling_exceeded/);
  });

  test('an invoice naming another asset or recipient is refused', async () => {
    const compared = await compare();
    const overrides: { label: string; patch: Record<string, unknown> }[] = [
      { label: 'wrong-asset', patch: { asset: '0x00000000000000000000000000000000deadbeef' } },
      { label: 'wrong-recipient', patch: { payTo: '0x00000000000000000000000000000000deadbeef' } },
    ];
    for (const override of overrides) {
      commerceRouteRuntime.createOrder = async () => createdInvoice(override.patch);
      const response = await request(routeApp())
        .post('/api/route-intelligence/commerce/orders')
        .send(orderBody(compared, `order-${override.label}`));
      assert.equal(response.body.outcome, 'blocked');
      assert.match(response.body.reason, /pinned_(asset|recipient)_mismatch/);
    }
  });

  test('an already-expired invoice is refused', async () => {
    const compared = await compare();
    commerceRouteRuntime.createOrder = async () =>
      createdInvoice({ expiresAt: new Date(NOW.getTime() - 1_000).toISOString() });
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/orders')
      .send(orderBody(compared));
    assert.equal(response.body.outcome, 'blocked');
    assert.match(response.body.reason, /order_expired/);
  });

  test('a stale route card hash is a refresh, never a re-priced order', async () => {
    const compared = await compare();
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/orders')
      .send({ ...orderBody(compared), routeCardHash: `0x${'0'.repeat(64)}` });
    assert.equal(response.body.outcome, 'refresh_required');
    assert.equal(providerCalls, 0);
  });

  test('an expired comparison cannot be ordered against', async () => {
    const compared = await compare();
    commerceRouteRuntime.now = () => new Date(NOW.getTime() + 60 * 60_000);
    const response = await request(routeApp())
      .post('/api/route-intelligence/commerce/orders')
      .send(orderBody(compared));
    assert.equal(response.body.outcome, 'refresh_required');
    assert.match(response.body.reason, /expired/i);
    assert.equal(providerCalls, 0);
  });

  test('another tenant cannot order against this run', async () => {
    const compared = await compare();
    const response = await request(routeApp(OTHER_USER))
      .post('/api/route-intelligence/commerce/orders')
      .send({ ...orderBody(compared), walletAddress: OTHER_WALLET });
    assert.equal(response.body.outcome, 'refresh_required');
    assert.equal(providerCalls, 0);
  });
});

describe('T64.2 durable status and reconciliation', () => {
  async function openCheckout() {
    const compared = await compare();
    const created = await request(routeApp())
      .post('/api/route-intelligence/commerce/orders')
      .send(orderBody(compared));
    assert.equal(created.body.outcome, 'created');
    return created.body as { orderId: string; invoice: { invoiceId: string } };
  }

  test('a checkout survives a server restart', async () => {
    const opened = await openCheckout();
    // A new express app on the SAME durable repository is what a restart looks
    // like to the storage layer.
    const response = await request(routeApp()).get(
      `/api/route-intelligence/commerce/orders/${opened.invoice.invoiceId}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'status');
    assert.equal(response.body.orderId, opened.orderId);
    assert.equal(response.body.order.invoice.amountAtomic, '25840000');
  });

  test('another wallet cannot read this checkout', async () => {
    const opened = await openCheckout();
    const response = await request(routeApp(OTHER_USER)).get(
      `/api/route-intelligence/commerce/orders/${opened.invoice.invoiceId}`,
    );
    assert.equal(response.body.outcome, 'unknown_order');
  });

  test('payment settled with NO confirmed order is never a purchase', async () => {
    const opened = await openCheckout();
    commerceRouteRuntime.readOrderStatus = async () => ({
      ok: true as const,
      status: {
        invoiceId: opened.invoice.invoiceId,
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
    const response = await request(routeApp()).post(
      `/api/route-intelligence/commerce/orders/${opened.invoice.invoiceId}/reconcile`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.proof.finalStatus, 'order_unconfirmed');
    assert.notEqual(response.body.order.status, 'delivered');
    // The provider status must not claim the order was confirmed.
    assert.equal(response.body.providerStatus, 'payment_settled');
  });

  test('delivery without a confirmed order cannot be recorded', async () => {
    const opened = await openCheckout();
    commerceRouteRuntime.readOrderStatus = async () => ({
      ok: true as const,
      status: {
        invoiceId: opened.invoice.invoiceId,
        paymentSettled: true,
        paymentTransactionHash: `0x${'a'.repeat(64)}` as `0x${string}`,
        settledAt: NOW.toISOString(),
        // The storefront claims delivery but names NO order id.
        orderIds: [],
        deliveryState: 'all_delivered' as const,
        itemCount: 1,
        deliveredCount: 1,
        observedAt: NOW.toISOString(),
      },
    });
    const response = await request(routeApp()).post(
      `/api/route-intelligence/commerce/orders/${opened.invoice.invoiceId}/reconcile`,
    );
    assert.equal(response.status, 200);
    assert.notEqual(response.body.proof.finalStatus, 'delivered');
    assert.equal(response.body.proof.order.state, 'unknown');
  });

  test('a fully confirmed order reconciles to delivered and is persisted', async () => {
    const opened = await openCheckout();
    commerceRouteRuntime.readOrderStatus = async () => ({
      ok: true as const,
      status: {
        invoiceId: opened.invoice.invoiceId,
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
    const response = await request(routeApp()).post(
      `/api/route-intelligence/commerce/orders/${opened.invoice.invoiceId}/reconcile`,
    );
    assert.equal(response.body.proof.finalStatus, 'delivered');
    assert.equal(response.body.providerStatus, 'delivered');
    const stored = await repository.getCommerceProof(opened.orderId, USER.id);
    assert.equal(stored?.finalStatus, 'delivered');
    const events = await repository.listCommerceOrderEvents(opened.orderId, USER.id);
    assert.ok(events.length >= 2);
  });

  test('an unreachable storefront is an honest outcome, not a 500', async () => {
    const opened = await openCheckout();
    commerceRouteRuntime.readOrderStatus = async () => ({ ok: false as const, reason: 'provider_timeout' });
    const response = await request(routeApp()).post(
      `/api/route-intelligence/commerce/orders/${opened.invoice.invoiceId}/reconcile`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'provider_unavailable');
  });

  test('no delivery secret or credential is ever stored', async () => {
    const opened = await openCheckout();
    const record = await repository.getCommerceOrder(opened.orderId, USER.id);

    // Field NAMES, not substrings — `recipientPolicy: 'pinned'` legitimately
    // contains "pin", and a naive substring check would both false-positive on
    // it and miss a nested key.
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key.toLowerCase());
          walk(inner);
        }
      }
    };
    walk(record);
    for (const forbidden of ['redemption', 'redemptioninfo', 'pin', 'code', 'secret', 'apikey', 'accesstoken', 'authorization']) {
      assert.ok(!keys.includes(forbidden), `no stored field may be named "${forbidden}"`);
    }
    // And no credential VALUE leaked in either.
    const serialized = JSON.stringify(record);
    assert.ok(!serialized.includes('Bearer '));
    assert.ok(!serialized.includes('X-Access-Token'));
  });

  test('history is tenant-scoped', async () => {
    const opened = await openCheckout();
    const mine = await request(routeApp()).get('/api/route-intelligence/commerce/history');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.items.length, 1);
    assert.equal(mine.body.items[0].orderId, opened.orderId);
    assert.equal(mine.body.items[0].exactAmountAtomic, '25840000');
    assert.equal(mine.body.items[0].estimatedAmountAtomic, '25000000');

    const theirs = await request(routeApp(OTHER_USER)).get('/api/route-intelligence/commerce/history');
    assert.equal(theirs.body.items.length, 0);
  });

  test('a malformed invoice id is refused', async () => {
    const response = await request(routeApp()).get('/api/route-intelligence/commerce/orders/%20');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_commerce_invoice_id');
  });
});
