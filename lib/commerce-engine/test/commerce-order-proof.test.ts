import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyCommerceOrderStatusV1,
  buildCommerceOrderV1,
  buildCommerceRouteProofV1,
  buildCommercePaymentRequirementsV1,
  canTransitionCommerceOrderV1,
  commerceProofNeedsReconciliationV1,
  createBitrefillOrderGatewayV1,
  isCommerceProofSuccessfulV1,
  isSettledInvoiceStatusV1,
  mapDeliveryStateV1,
  selectCommerceBaseAcceptsV1,
  type CommerceCreatedOrderV1,
  type CommerceOrderStatusObservationV1,
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

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const NOW = new Date('2026-07-25T12:00:00.000Z');
const PAY_TO = '0x480cd46e6fade651a0437deadda53d5c8e7d846a';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const USDC_ASSET = {
  assetId: `eip155:8453/erc20:${USDC}`,
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: USDC as `0x${string}`,
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
    requestedValue: { amountDecimal: '25', currency: 'USD' },
    paymentAsset: USDC_ASSET,
    maxSpendAtomic: '28750000',
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
      name: 'Steam US',
      kind: 'gift_card' as const,
      country: 'US',
      currency: 'USD',
      packageValue: '25',
      recipientRequired: false,
    },
    fiatPrice: { amountDecimal: '25', currency: 'USD' },
    payment: { asset: USDC_ASSET, amountAtomic: '25500000', amountDecimal: '25.5' },
    fees: {
      productPriceAtomic: '25500000',
      providerFeeAtomic: null,
      networkFeeAtomic: null,
      totalAtomic: '25500000',
      totalBasis: 'exact_quote' as const,
    },
    availability: 'in_stock' as const,
    deliveryModel: 'digital_code' as const,
    recipientRequired: false,
    paymentTarget: { asset: USDC as `0x${string}`, payTo: PAY_TO as `0x${string}` },
    observedAt: nowIso,
    expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    provider: { id: 'bitrefill-x402-v1', displayName: 'Bitrefill', kind: 'protocol' as const, operator: 'Bitrefill' },
  };
  return CommerceCandidateV1Schema.parse({
    ...draft,
    candidateHash: hashCommerceCandidateV1(draft as unknown as CommerceCandidateV1),
  });
}

const CREATED: CommerceCreatedOrderV1 = {
  invoiceId: 'inv-1',
  totalAtomic: '25500000',
  payTo: PAY_TO as `0x${string}`,
  asset: USDC as `0x${string}`,
  expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
  items: [{ productId: 'steam-usa', packageValue: '25', orderId: null }],
};

function order() {
  const result = buildCommerceOrderV1({ intent: intent(), candidate: candidate(), created: CREATED, now: NOW });
  assert.ok(result.ok, 'expected a valid order');
  return result.order;
}

function observation(
  overrides: Partial<CommerceOrderStatusObservationV1> = {},
): CommerceOrderStatusObservationV1 {
  return {
    invoiceId: 'inv-1',
    paymentSettled: true,
    paymentTransactionHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    settledAt: new Date(NOW.getTime() + 5_000).toISOString(),
    orderIds: ['ord-1'],
    deliveryState: 'all_delivered',
    itemCount: 1,
    deliveredCount: 1,
    observedAt: new Date(NOW.getTime() + 10_000).toISOString(),
    ...overrides,
  };
}

// --- Order creation --------------------------------------------------------

test('a created checkout becomes an order that has signed nothing yet', () => {
  const created = order();
  assert.equal(created.status, 'created');
  assert.equal(created.paymentState, 'awaiting_signature');
  assert.equal(created.deliveryState, 'not_started');
  assert.equal(created.paymentTransactionHash, null);
  assert.equal(created.payTo, PAY_TO);
});

test('a checkout that names another recipient is refused', () => {
  const result = buildCommerceOrderV1({
    intent: intent(),
    candidate: candidate(),
    created: { ...CREATED, payTo: '0x00000000000000000000000000000000deadbeef' as `0x${string}` },
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'pinned_recipient_mismatch' });
});

test('a checkout that names another asset is refused', () => {
  const result = buildCommerceOrderV1({
    intent: intent(),
    candidate: candidate(),
    created: { ...CREATED, asset: '0x00000000000000000000000000000000deadbeef' as `0x${string}` },
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'pinned_asset_mismatch' });
});

test('a checkout above the authorized ceiling is refused', () => {
  const result = buildCommerceOrderV1({
    intent: intent(),
    candidate: candidate(),
    created: { ...CREATED, totalAtomic: '90000000' },
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'spend_ceiling_exceeded' });
});

test('an already-expired checkout is refused', () => {
  const result = buildCommerceOrderV1({
    intent: intent(),
    candidate: candidate(),
    created: { ...CREATED, expiresAt: new Date(NOW.getTime() - 1_000).toISOString() },
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'order_expired' });
});

// --- Payment review --------------------------------------------------------

const ACCEPTS = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: USDC,
  payTo: PAY_TO,
  maxAmountRequired: '25500000',
  resource: 'https://api.bitrefill.com/x402/invoice/pay',
  maxTimeoutSeconds: 600,
};

test('payment requirements restate exactly what the wallet will authorize', () => {
  const result = buildCommercePaymentRequirementsV1({
    accepts: ACCEPTS,
    order: order(),
    intent: intent(),
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.requirements.payTo, PAY_TO);
  assert.equal(result.requirements.asset, USDC);
  assert.equal(result.requirements.maxAmountAtomic, '25500000');
  assert.equal(result.requirements.invoiceId, 'inv-1');
});

test('a 402 envelope pointing at another host produces no signing prompt', () => {
  const result = buildCommercePaymentRequirementsV1({
    accepts: { ...ACCEPTS, resource: 'https://evil.example/x402/invoice/pay' },
    order: order(),
    intent: intent(),
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'pinned_host_mismatch' });
});

test('a 402 envelope on another chain produces no signing prompt', () => {
  const result = buildCommercePaymentRequirementsV1({
    accepts: { ...ACCEPTS, network: 'eip155:1' },
    order: order(),
    intent: intent(),
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'pinned_chain_mismatch' });
});

test('a 402 envelope asking for more than the order total is refused', () => {
  const result = buildCommercePaymentRequirementsV1({
    accepts: { ...ACCEPTS, maxAmountRequired: '26000000' },
    order: order(),
    intent: intent(),
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'spend_ceiling_exceeded' });
});

test('an unsupported payment scheme is refused', () => {
  const result = buildCommercePaymentRequirementsV1({
    accepts: { ...ACCEPTS, scheme: 'upto' },
    order: order(),
    intent: intent(),
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'provider_invalid_response' });
});

// --- Order lifecycle -------------------------------------------------------

test('the order lifecycle never walks backwards', () => {
  assert.equal(canTransitionCommerceOrderV1('created', 'payment_confirmed'), true);
  assert.equal(canTransitionCommerceOrderV1('delivered', 'fulfilling'), false);
  assert.equal(canTransitionCommerceOrderV1('failed', 'delivered'), false);
  assert.equal(canTransitionCommerceOrderV1('payment_confirmed', 'created'), false);
});

test('a status reading for another invoice is refused', () => {
  const result = applyCommerceOrderStatusV1({
    order: order(),
    observation: observation({ invoiceId: 'inv-other' }),
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'order_not_confirmed' });
});

test('a settled payment with no transaction hash is refused', () => {
  const result = applyCommerceOrderStatusV1({
    order: order(),
    observation: observation({ paymentTransactionHash: null }),
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'provider_invalid_response' });
});

test('a fully delivered reading advances the order to delivered', () => {
  const result = applyCommerceOrderStatusV1({ order: order(), observation: observation(), now: NOW });
  assert.ok(result.ok);
  assert.equal(result.order.status, 'delivered');
  assert.equal(result.order.paymentState, 'settled');
  assert.equal(result.order.deliveryState, 'all_delivered');
  assert.equal(result.order.items[0].orderId, 'ord-1');
});

test('a paid but unfulfilled reading stops at payment_confirmed', () => {
  const result = applyCommerceOrderStatusV1({
    order: order(),
    observation: observation({ deliveryState: 'unknown', deliveredCount: 0, orderIds: [] }),
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.order.status, 'payment_confirmed');
  assert.notEqual(result.order.status, 'delivered');
});

// --- The Commerce Route Proof ---------------------------------------------

test('payment, confirmed order, and delivery together are a proof', () => {
  const result = buildCommerceRouteProofV1({
    order: order(),
    observation: observation(),
    evidenceSetHash: ZERO_HASH_V1,
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.proof.finalStatus, 'delivered');
  assert.equal(isCommerceProofSuccessfulV1(result.proof), true);
  assert.equal(result.proof.payment.state, 'settled');
  assert.equal(result.proof.order.state, 'confirmed');
  assert.equal(result.proof.delivery.deliveredCount, 1);
});

test('a settled payment with NO confirmed order is never a successful proof', () => {
  const result = buildCommerceRouteProofV1({
    order: order(),
    observation: observation({ orderIds: [], deliveryState: 'unknown', deliveredCount: 0 }),
    evidenceSetHash: ZERO_HASH_V1,
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.proof.finalStatus, 'order_unconfirmed');
  assert.equal(isCommerceProofSuccessfulV1(result.proof), false);
  assert.equal(commerceProofNeedsReconciliationV1(result.proof), true);
  assert.equal(result.proof.payment.state, 'settled');
  assert.equal(result.proof.order.state, 'unknown');
});

test('a confirmed order with no delivery yet is not a successful proof', () => {
  const result = buildCommerceRouteProofV1({
    order: order(),
    observation: observation({ deliveryState: 'pending', deliveredCount: 0 }),
    evidenceSetHash: ZERO_HASH_V1,
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.proof.finalStatus, 'pending');
  assert.equal(isCommerceProofSuccessfulV1(result.proof), false);
});

test('an unpaid order proves nothing and reports no delivery', () => {
  const result = buildCommerceRouteProofV1({
    order: order(),
    observation: observation({
      paymentSettled: false,
      paymentTransactionHash: null,
      settledAt: null,
      orderIds: [],
      deliveryState: 'not_started',
      deliveredCount: 0,
    }),
    evidenceSetHash: ZERO_HASH_V1,
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.proof.finalStatus, 'pending');
  assert.equal(result.proof.delivery.deliveredCount, 0);
  assert.equal(result.proof.order.state, 'not_created');
});

test('a failed fulfilment is a failure, not a partial success', () => {
  const result = buildCommerceRouteProofV1({
    order: order(),
    observation: observation({ deliveryState: 'failed', deliveredCount: 0 }),
    evidenceSetHash: ZERO_HASH_V1,
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.proof.finalStatus, 'failed');
});

test('the proof is bound to its own order', () => {
  const result = buildCommerceRouteProofV1({
    order: order(),
    observation: observation({ invoiceId: 'inv-other' }),
    evidenceSetHash: ZERO_HASH_V1,
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'order_not_confirmed' });
});

// --- Gateway mapping -------------------------------------------------------

test('an unrecognised delivery word becomes unknown, never progress', () => {
  assert.equal(mapDeliveryStateV1('all_delivered'), 'all_delivered');
  assert.equal(mapDeliveryStateV1('somethings_up'), 'unknown');
  assert.equal(mapDeliveryStateV1(undefined), 'unknown');
});

test('only a settled invoice status counts as paid', () => {
  assert.equal(isSettledInvoiceStatusV1('payment_confirmed'), true);
  assert.equal(isSettledInvoiceStatusV1('pending'), false);
  assert.equal(isSettledInvoiceStatusV1(undefined), false);
});

test('the gateway never returns redemption material into the domain', async () => {
  const gateway = createBitrefillOrderGatewayV1({
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          invoice_id: 'inv-1',
          invoice_status: 'payment_confirmed',
          orders_delivery_status: 'all_delivered',
          transaction: `0x${'a'.repeat(64)}`,
          orders: [
            {
              id: 'ord-1',
              delivery_status: 'all_delivered',
              redemption_info: { code: 'SECRET-CODE', pin: '1234' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
  });
  const result = await gateway.readOrderStatus({ invoiceId: 'inv-1', now: NOW });
  assert.ok(result.ok);
  const serialized = JSON.stringify(result.status);
  assert.ok(!serialized.includes('SECRET-CODE'));
  assert.ok(!serialized.includes('1234'));
  assert.deepEqual(result.status.orderIds, ['ord-1']);
  assert.equal(result.status.deliveryState, 'all_delivered');
});

test('the gateway refuses a checkout above the authorized ceiling', async () => {
  const gateway = createBitrefillOrderGatewayV1({
    fetchImpl: (async () =>
      new Response(JSON.stringify({ invoice_id: 'inv-1', price_usdc: '90' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });
  const result = await gateway.createOrder({
    productId: 'steam-usa',
    packageValue: '25',
    recipientInput: null,
    maxSpendAtomic: '28750000',
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'spend_ceiling_exceeded' });
});

// --- Pinned against the provider's REAL 402 envelope -----------------------
//
// Recorded from a live read-only GET to
// https://api.bitrefill.com/x402/gift-cards/search on 2026-07-25. It is x402
// v2 (`amount`, envelope-level `resource`) and offers FOUR chains — which is
// exactly why the Base entry has to be selected rather than taken by position.

const LIVE_402_ENVELOPE = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://api.bitrefill.com/x402/invoice/pay', serviceName: 'Bitrefill' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '25000000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
    {
      scheme: 'exact',
      network: 'eip155:42161',
      amount: '25000000',
      asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      payTo: '0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A',
      maxTimeoutSeconds: 300,
    },
    {
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      amount: '25000000',
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      payTo: '5yASLjtNssGXDv6bR9e71WXKxRymDiUzbgkGPqkQNgRn',
      maxTimeoutSeconds: 300,
    },
  ],
};

test('the Base entry is selected out of a multi-chain 402, not taken by position', () => {
  const selected = selectCommerceBaseAcceptsV1(LIVE_402_ENVELOPE);
  assert.ok(selected.ok);
  assert.equal(selected.accepts.network, 'eip155:8453');
  assert.equal(selected.accepts.asset.toLowerCase(), USDC);
  assert.equal(selected.resource, 'https://api.bitrefill.com/x402/invoice/pay');
});

test('a 402 that offers no Base USDC entry produces no payment', () => {
  const selected = selectCommerceBaseAcceptsV1({
    ...LIVE_402_ENVELOPE,
    accepts: LIVE_402_ENVELOPE.accepts.filter((entry) => entry.network !== 'eip155:8453'),
  });
  assert.deepEqual(selected, { ok: false, reason: 'pinned_asset_mismatch' });
});

test('the live x402 v2 envelope builds reviewable payment terms', () => {
  const result = buildCommercePaymentRequirementsV1({
    accepts: LIVE_402_ENVELOPE,
    order: order(),
    intent: intent(),
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.requirements.maxAmountAtomic, '25000000');
  assert.equal(result.requirements.payTo, PAY_TO);
  assert.equal(result.requirements.resource, 'https://api.bitrefill.com/x402/invoice/pay');
});

test('a Base entry naming another recipient is not selected', () => {
  const selected = selectCommerceBaseAcceptsV1({
    ...LIVE_402_ENVELOPE,
    accepts: [{ ...LIVE_402_ENVELOPE.accepts[0], payTo: '0x00000000000000000000000000000000deadbeef' }],
  });
  assert.deepEqual(selected, { ok: false, reason: 'pinned_asset_mismatch' });
});
