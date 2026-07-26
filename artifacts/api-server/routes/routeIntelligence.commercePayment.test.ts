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
import {
  commerceDeliveryRuntime,
  commercePaymentRuntime,
  commerceRouteRuntime,
  routeIntelligenceRouter,
} from './routeIntelligence.js';

globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// T64.3: the payment rail, end to end on fixtures. Nothing here signs, sends
// USDC, or calls a wallet — the whole point is that the server cannot.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const OTHER_USER = { id: `eip155:8453:${OTHER_WALLET}`, address: OTHER_WALLET, chainId: 8453 as const };
const NOW = new Date('2026-07-26T12:00:00.000Z');
const RECIPIENT = '0x36df47740a31654665d596cf5e1b1eee72024dbb';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const AMOUNT = '25840000';
const originalRuntime = { ...commerceRouteRuntime };
const originalPayment = { ...commercePaymentRuntime };
const originalDelivery = { ...commerceDeliveryRuntime };
const originalChainEnv = process.env.CHAIN_ENV;

const FLAGS = {
  routeIntelligenceV1: true,
  legacyTerminal: true,
  paidIntelligence: false,
  earnRouteV1: false,
  commerceRouteV1: true,
  commerceExecutionV1: true,
  nftRouteV1: false,
  nftExecutionV1: false,
} as const;

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

let repository: CommerceStorageRepository;

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

beforeEach(() => {
  repository = createMemoryCommerceStorageRepository();
  commerceRouteRuntime.flags = () => ({ ...FLAGS });
  commerceRouteRuntime.now = () => NOW;
  commerceRouteRuntime.compare = (input) => compareCommerceRoutesV1({ catalog: stubCatalog() }, input);
  commerceRouteRuntime.repository = () => repository;
  commerceRouteRuntime.migrationAvailable = async () => true;
  commerceRouteRuntime.createOrder = async () => ({
    ok: true as const,
    order: {
      invoiceId: 'inv-1',
      totalAtomic: AMOUNT,
      payTo: RECIPIENT as `0x${string}`,
      asset: USDC as `0x${string}`,
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
      items: [{ productId: 'steam-usa', packageValue: '25', orderId: 'ord-1' }],
      providerFeeAtomic: null,
      recipientPolicy: 'invoice_scoped' as const,
      paymentStatus: 'unpaid',
      orderStatus: 'created',
    },
  });
  commercePaymentRuntime.now = () => NOW;
  commercePaymentRuntime.readInvoiceDetail = async () => ({
    ok: true as const,
    status: {
      invoiceId: 'inv-1',
      paymentSettled: false,
      paymentTransactionHash: null,
      settledAt: null,
      orderIds: ['ord-1'],
      deliveryState: 'not_started' as const,
      itemCount: 1,
      deliveredCount: 0,
      observedAt: NOW.toISOString(),
    },
  });
  commerceDeliveryRuntime.readOrder = async () => null;
  process.env.CHAIN_ENV = 'mainnet';
});

afterEach(() => {
  Object.assign(commerceRouteRuntime, originalRuntime);
  Object.assign(commercePaymentRuntime, originalPayment);
  Object.assign(commerceDeliveryRuntime, originalDelivery);
  if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
  else process.env.CHAIN_ENV = originalChainEnv;
});

async function openCheckout(user = USER) {
  const compared = await request(routeApp(user))
    .post('/api/route-intelligence/commerce/compare')
    .send({ message: 'Buy a US Steam gift card for $25', walletAddress: user.address, requestId: 'cmp-1' });
  assert.equal(compared.body.outcome, 'compared');
  const created = await request(routeApp(user))
    .post('/api/route-intelligence/commerce/orders')
    .send({
      routeRunId: compared.body.routeRunId,
      routeCardHash: compared.body.routeCard.routeCardHash,
      selectedCandidateHash: compared.body.routeCard.comparisons[0].candidate.candidateHash,
      walletAddress: user.address,
      requestId: 'ord-req-1',
    });
  assert.equal(created.body.outcome, 'created', JSON.stringify(created.body));
  return created.body as { orderId: string };
}

async function prepare(orderId: string, user = USER) {
  return request(routeApp(user))
    .post(`/api/route-intelligence/commerce/orders/${orderId}/payment/prepare`)
    .send({ requestId: 'pay-1' });
}

describe('T64.3 payment prepare', () => {
  test('the exact call is one USDC transfer to the invoice address', async () => {
    const opened = await openCheckout();
    const response = await prepare(opened.orderId);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'prepared', JSON.stringify(response.body));
    const blueprint = response.body.blueprint;
    assert.equal(blueprint.calls.length, 1);
    assert.equal(blueprint.calls[0].to, USDC);
    assert.equal(blueprint.calls[0].valueWei, '0');
    assert.equal(blueprint.calls[0].spender, null);
    assert.equal(blueprint.recipient, RECIPIENT);
    assert.equal(blueprint.exactAmountAtomic, AMOUNT);
    assert.equal(blueprint.recipientPolicy, 'invoice_scoped');
    assert.equal(response.body.safety.verdict, 'allowed');
    // Unsimulated: the wallet is NOT offered.
    assert.equal(response.body.signable, false);
    assert.match(String(response.body.signableReason), /not been simulated/);
  });

  test('preparing twice returns the SAME blueprint, never a second prompt', async () => {
    const opened = await openCheckout();
    const first = await prepare(opened.orderId);
    const second = await prepare(opened.orderId);
    assert.equal(first.body.blueprint.blueprintHash, second.body.blueprint.blueprintHash);
  });

  test('a changed invoice amount stops the payment and opens no replacement', async () => {
    const opened = await openCheckout();
    commercePaymentRuntime.readInvoiceDetail = async () => ({
      ok: true as const,
      status: {
        invoiceId: 'inv-other',
        paymentSettled: false,
        paymentTransactionHash: null,
        settledAt: null,
        orderIds: [],
        deliveryState: 'not_started' as const,
        itemCount: 1,
        deliveredCount: 0,
        observedAt: NOW.toISOString(),
      },
    });
    const response = await prepare(opened.orderId);
    assert.equal(response.body.outcome, 'invoice_changed');
  });

  test('an already-paid invoice is never paid again', async () => {
    const opened = await openCheckout();
    commercePaymentRuntime.readInvoiceDetail = async () => ({
      ok: true as const,
      status: {
        invoiceId: 'inv-1',
        paymentSettled: true,
        paymentTransactionHash: `0x${'a'.repeat(64)}` as `0x${string}`,
        settledAt: NOW.toISOString(),
        orderIds: ['ord-1'],
        deliveryState: 'not_started' as const,
        itemCount: 1,
        deliveredCount: 0,
        observedAt: NOW.toISOString(),
      },
    });
    const response = await prepare(opened.orderId);
    assert.equal(response.body.outcome, 'invoice_changed');
  });

  test('an expired invoice is refused', async () => {
    const opened = await openCheckout();
    commercePaymentRuntime.now = () => new Date(NOW.getTime() + 3_600_000);
    const response = await prepare(opened.orderId);
    assert.equal(response.body.outcome, 'invoice_expired');
  });

  test('the execution gate keeps the whole rail closed', async () => {
    const opened = await openCheckout();
    commerceRouteRuntime.flags = () => ({ ...FLAGS, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false });
    for (const path of ['payment/prepare', 'payment/approve', 'payment/submission']) {
      const response = await request(routeApp())
        .post(`/api/route-intelligence/commerce/orders/${opened.orderId}/${path}`)
        .send({});
      assert.equal(response.status, 404);
      assert.equal(response.body.code, 'commerce_execution_disabled');
    }
  });

  test('another wallet cannot prepare this payment', async () => {
    const opened = await openCheckout();
    const response = await prepare(opened.orderId, OTHER_USER);
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'commerce_order_not_found');
  });
});

describe('T64.3 approve and submission', () => {
  async function preparedAndSimulated() {
    const opened = await openCheckout();
    const prepared = await prepare(opened.orderId);
    // Mark the simulation as passed, the way the paid-simulation route would.
    const stored = await repository.getCommercePaymentBlueprint(opened.orderId, USER.id);
    assert.ok(stored);
    await repository.updateCommercePaymentBlueprint({
      orderId: opened.orderId,
      userId: USER.id,
      blueprint: {
        ...stored.blueprint,
        simulationState: {
          status: 'passed',
          observedAt: NOW.toISOString(),
          blockNumber: '30000000',
          requestHash: `0x${'1'.repeat(64)}`,
          responseHash: `0x${'2'.repeat(64)}`,
          errorCode: null,
        },
      },
    });
    return { orderId: opened.orderId, blueprintHash: prepared.body.blueprint.blueprintHash };
  }

  test('an unsimulated payment is never approved for signing', async () => {
    const opened = await openCheckout();
    const prepared = await prepare(opened.orderId);
    const response = await request(routeApp())
      .post(`/api/route-intelligence/commerce/orders/${opened.orderId}/payment/approve`)
      .send({ blueprintHash: prepared.body.blueprint.blueprintHash, walletAddress: WALLET });
    assert.equal(response.body.outcome, 'blocked');
    assert.match(response.body.reason, /simulated/);
  });

  test('a simulated payment returns an UNSIGNED single-call payload', async () => {
    const { orderId, blueprintHash } = await preparedAndSimulated();
    const response = await request(routeApp())
      .post(`/api/route-intelligence/commerce/orders/${orderId}/payment/approve`)
      .send({ blueprintHash, walletAddress: WALLET });
    assert.equal(response.body.outcome, 'approved', JSON.stringify(response.body));
    assert.equal(response.body.payload.calls.length, 1);
    assert.equal(response.body.payload.calls[0].to, USDC);
    assert.equal(response.body.payload.calls[0].value, '0x0');
    assert.equal(response.body.payload.from, WALLET);
    assert.equal(response.body.payload.chainId, '0x2105');
    // No signature field exists anywhere in the response.
    assert.ok(!JSON.stringify(response.body).includes('signature'));
  });

  test('a wallet cancellation is recorded as cancelled, not as a payment', async () => {
    const { orderId, blueprintHash } = await preparedAndSimulated();
    const approved = await request(routeApp())
      .post(`/api/route-intelligence/commerce/orders/${orderId}/payment/approve`)
      .send({ blueprintHash, walletAddress: WALLET });
    const response = await request(routeApp())
      .post(`/api/route-intelligence/commerce/orders/${orderId}/payment/submission`)
      .send({
        blueprintHash,
        approvedCallsHash: approved.body.payload.approvedCallsHash,
        walletAddress: WALLET,
        batchId: null,
        transactionHash: null,
        walletStatus: 'cancelled',
      });
    assert.equal(response.body.outcome, 'cancelled');
    const stored = await repository.getCommercePaymentBlueprint(orderId, USER.id);
    assert.notEqual(stored?.blueprint.status, 'submitted');
  });

  test('a submission that does not match the approved calls is a conflict', async () => {
    const { orderId, blueprintHash } = await preparedAndSimulated();
    const response = await request(routeApp())
      .post(`/api/route-intelligence/commerce/orders/${orderId}/payment/submission`)
      .send({
        blueprintHash,
        approvedCallsHash: `0x${'9'.repeat(64)}`,
        walletAddress: WALLET,
        batchId: 'batch-1',
        transactionHash: `0x${'a'.repeat(64)}`,
        walletStatus: 'submitted',
      });
    assert.equal(response.body.outcome, 'conflict');
  });

  test('a duplicate submission is idempotent; a different transaction is a conflict', async () => {
    const { orderId, blueprintHash } = await preparedAndSimulated();
    const approved = await request(routeApp())
      .post(`/api/route-intelligence/commerce/orders/${orderId}/payment/approve`)
      .send({ blueprintHash, walletAddress: WALLET });
    const body = {
      blueprintHash,
      approvedCallsHash: approved.body.payload.approvedCallsHash,
      walletAddress: WALLET,
      batchId: 'batch-1',
      transactionHash: `0x${'a'.repeat(64)}`,
      walletStatus: 'submitted' as const,
    };
    const app = routeApp();
    const first = await request(app).post(`/api/route-intelligence/commerce/orders/${orderId}/payment/submission`).send(body);
    const repeat = await request(app).post(`/api/route-intelligence/commerce/orders/${orderId}/payment/submission`).send(body);
    assert.equal(first.body.outcome, 'recorded');
    assert.equal(repeat.body.outcome, 'recorded');
    assert.equal(repeat.body.status.transactionHash, body.transactionHash);

    const other = await request(app)
      .post(`/api/route-intelligence/commerce/orders/${orderId}/payment/submission`)
      .send({ ...body, transactionHash: `0x${'b'.repeat(64)}` });
    assert.equal(other.body.outcome, 'conflict');
  });
});

describe('T64.3 delivery secrets', () => {
  async function submittedOrder() {
    const opened = await openCheckout();
    await prepare(opened.orderId);
    return opened.orderId;
  }

  test('delivery is refused until the PROVIDER confirms it', async () => {
    const orderId = await submittedOrder();
    const response = await request(routeApp()).get(`/api/route-intelligence/commerce/orders/${orderId}/delivery`);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'not_delivered');
  });

  test('a delivered order returns the code once, no-store, and stores none of it', async () => {
    const orderId = await submittedOrder();
    const stored = await repository.getCommercePaymentBlueprint(orderId, USER.id);
    assert.ok(stored);
    await repository.updateCommercePaymentBlueprint({
      orderId,
      userId: USER.id,
      blueprint: stored.blueprint,
      providerProgress: 'delivered',
    });
    commerceDeliveryRuntime.readOrder = async () => ({
      id: 'ord-1',
      status: 'delivered',
      delivered: true,
      delivered_time: '2026-07-26T12:05:00.000Z',
      redemption_info: { code: 'SECRET-CODE-1234', pin: '4242' },
    });

    const response = await request(routeApp()).get(`/api/route-intelligence/commerce/orders/${orderId}/delivery`);
    assert.equal(response.body.outcome, 'delivered');
    assert.equal(response.body.fields.code, 'SECRET-CODE-1234');
    assert.match(String(response.headers['cache-control']), /no-store/);
    assert.equal(response.headers['referrer-policy'], 'no-referrer');

    // Nothing of it reaches storage.
    const after = await repository.getCommercePaymentBlueprint(orderId, USER.id);
    const serialized = JSON.stringify(after);
    assert.ok(!serialized.includes('SECRET-CODE-1234'));
    assert.ok(!serialized.includes('4242'));
    assert.equal(after?.deliveryRecord?.redemptionAvailable, true);
    assert.ok(after?.deliveryRecord?.redactedResponseHash);
  });

  test('another wallet cannot read a delivered code', async () => {
    const orderId = await submittedOrder();
    const stored = await repository.getCommercePaymentBlueprint(orderId, USER.id);
    assert.ok(stored);
    await repository.updateCommercePaymentBlueprint({
      orderId,
      userId: USER.id,
      blueprint: stored.blueprint,
      providerProgress: 'delivered',
    });
    commerceDeliveryRuntime.readOrder = async () => ({
      id: 'ord-1',
      status: 'delivered',
      delivered: true,
      redemption_info: { code: 'SECRET-CODE-1234' },
    });
    const response = await request(routeApp(OTHER_USER)).get(
      `/api/route-intelligence/commerce/orders/${orderId}/delivery`,
    );
    assert.equal(response.body.outcome, 'unknown_order');
    assert.ok(!JSON.stringify(response.body).includes('SECRET-CODE-1234'));
  });
});
