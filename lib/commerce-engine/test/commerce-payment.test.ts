import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ERC20_TRANSFER_SELECTOR_V1,
  ERC20_TRANSFER_TOPIC_V1,
  buildCommerceOnchainPaymentV1,
  buildCommercePaymentBlueprintV1,
  buildCommercePaymentCallV1,
  commercePaymentProgressV1,
  commercePaymentSafetyKernelV1,
  commercePaymentSignableV1,
  commercePaymentUnconfirmedV1,
  commerceRedactedResponseHashV1,
  decodeUsdcTransferCallDataV1,
  encodeUsdcTransferCallDataV1,
  findCommercePaymentTransferV1,
  readCommerceDeliveryV1,
  redactCommerceDeliveryV1,
  revalidateCommerceInvoiceV1,
  type CommerceReceiptV1,
} from '../src/index.js';
import {
  CommerceCandidateV1Schema,
  CommerceInvoiceV1Schema,
  CommerceOrderV1Schema,
  CommerceRouteIntentV1Schema,
  hashCommerceCandidateV1,
  hashCommerceInvoiceV1,
  hashCommerceOrderV1,
  hashCommerceRouteIntentV1,
  ZERO_HASH_V1,
  type CommerceCandidateV1,
  type CommerceInvoiceV1,
  type CommerceOrderV1,
  type CommerceRouteIntentV1,
} from '@mioagent/route-domain';

globalThis.fetch = (() => {
  throw new Error('Unit tests must not perform live network calls');
}) as typeof fetch;

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const NOW = new Date('2026-07-26T12:00:00.000Z');
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const RECIPIENT = '0x36df47740a31654665d596cf5e1b1eee72024dbb' as const;
const AMOUNT = '5640000';
const CARD_HASH = `0x${'c'.repeat(64)}` as const;

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
    paymentTarget: { asset: USDC, payTo: RECIPIENT },
    observedAt: nowIso,
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    provider: { id: 'bitrefill-x402-v1', displayName: 'Bitrefill', kind: 'protocol' as const, operator: 'Bitrefill' },
  };
  return CommerceCandidateV1Schema.parse({
    ...draft,
    candidateHash: hashCommerceCandidateV1(draft as unknown as CommerceCandidateV1),
  });
}

function invoice(overrides: Partial<CommerceInvoiceV1> = {}): CommerceInvoiceV1 {
  const base = {
    schemaVersion: 'commerce-invoice/v1' as const,
    invoiceHash: ZERO_HASH_V1,
    invoiceId: 'inv-1',
    provider: 'bitrefill' as const,
    network: 'eip155:8453' as const,
    asset: USDC,
    payTo: RECIPIENT,
    amountAtomic: AMOUNT,
    providerFeeAtomic: null,
    refundAddress: WALLET,
    recipientPolicy: 'invoice_scoped' as const,
    paymentStatus: 'awaiting_signature' as const,
    orderStatus: 'invoice_created' as const,
    observedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    ...overrides,
  };
  return CommerceInvoiceV1Schema.parse({
    ...base,
    invoiceHash: hashCommerceInvoiceV1(base as unknown as CommerceInvoiceV1),
  });
}

function order(parent = intent(), inv = invoice()): CommerceOrderV1 {
  const nowIso = NOW.toISOString();
  const base = {
    schemaVersion: 'commerce-order/v1' as const,
    id: 'commerce-order:test',
    tenantId: parent.tenantId,
    walletAddress: parent.walletAddress,
    chainId: parent.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'created' as const,
    intentHash: parent.intentHash,
    candidateHash: candidate(parent).candidateHash,
    orderHash: ZERO_HASH_V1,
    provider: 'bitrefill' as const,
    invoiceId: inv.invoiceId,
    items: [{ productId: 'steam-usa', packageValue: '5', orderId: null, deliveryState: 'not_started' as const }],
    amount: { asset: USDC_ASSET, amountAtomic: AMOUNT, amountDecimal: '5.64' },
    payTo: RECIPIENT,
    paymentState: 'awaiting_signature' as const,
    deliveryState: 'not_started' as const,
    paymentTransactionHash: null,
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    providerStatus: 'invoice_created' as const,
    estimate: { totalAtomic: '5000000', totalBasis: 'minimum' as const },
    invoice: inv,
  };
  return CommerceOrderV1Schema.parse({
    ...base,
    orderHash: hashCommerceOrderV1(base as unknown as CommerceOrderV1),
  });
}

function blueprint(inv = invoice()) {
  const parent = intent();
  const result = buildCommercePaymentBlueprintV1({
    order: order(parent, inv),
    orderId: 'commerce-order-row:1',
    invoice: inv,
    intent: parent,
    candidate: candidate(parent),
    routeCardHash: CARD_HASH,
    authenticatedWallet: WALLET,
    now: NOW,
  });
  assert.ok(result.ok, 'the blueprint must build');
  return result.blueprint;
}

// --- The exact call ---------------------------------------------------------

test('the payment is one exact USDC transfer with no allowance and no native value', () => {
  const call = buildCommercePaymentCallV1({ recipient: RECIPIENT, amountAtomic: AMOUNT });
  assert.ok(call);
  assert.equal(call.to, USDC);
  assert.equal(call.valueWei, '0');
  assert.equal(call.spender, null);
  assert.equal(call.callType, 'transfer');
  assert.equal(call.recipient, RECIPIENT);
  assert.equal(call.amountAtomic, AMOUNT);
});

test('the calldata is a bare transfer with NO builder-code suffix', () => {
  const data = encodeUsdcTransferCallDataV1({ recipient: RECIPIENT, amountAtomic: AMOUNT });
  assert.ok(data);
  assert.ok(data.startsWith(ERC20_TRANSFER_SELECTOR_V1));
  // selector (10 chars incl. 0x) + exactly two 32-byte words. Anything longer
  // is a different call as far as the token contract is concerned.
  assert.equal(data.length, 10 + 128);
  assert.deepEqual(decodeUsdcTransferCallDataV1(data), { recipient: RECIPIENT, amountAtomic: AMOUNT });
});

test('appended calldata is not decodable as this payment', () => {
  const data = `${encodeUsdcTransferCallDataV1({ recipient: RECIPIENT, amountAtomic: AMOUNT })}deadbeef`;
  assert.equal(decodeUsdcTransferCallDataV1(data), null);
});

test('a zero amount or malformed recipient encodes nothing', () => {
  assert.equal(encodeUsdcTransferCallDataV1({ recipient: RECIPIENT, amountAtomic: '0' }), null);
  assert.equal(encodeUsdcTransferCallDataV1({ recipient: 'nope', amountAtomic: AMOUNT }), null);
});

// --- Safety kernel ----------------------------------------------------------

test('the kernel reads the CALLDATA, not the call object fields', () => {
  const honest = buildCommercePaymentCallV1({ recipient: RECIPIENT, amountAtomic: AMOUNT })!;
  // A call whose fields claim the invoice terms but whose calldata pays
  // someone else must be blocked.
  const tampered = {
    ...honest,
    data: encodeUsdcTransferCallDataV1({
      recipient: '0x00000000000000000000000000000000deadbeef',
      amountAtomic: AMOUNT,
    })!,
  };
  const result = commercePaymentSafetyKernelV1({
    calls: [tampered],
    invoice: invoice(),
    authenticatedWallet: WALLET,
    intent: intent(),
    now: NOW,
  });
  assert.equal(result.verdict, 'blocked');
  assert.match(String(result.blockedReason), /pays the invoice address/);
});

test('the kernel blocks a second call, a native value, and an allowance', () => {
  const call = buildCommercePaymentCallV1({ recipient: RECIPIENT, amountAtomic: AMOUNT })!;
  const cases: { patch: Record<string, unknown>; extra?: boolean; match: RegExp }[] = [
    { patch: { valueWei: '1' }, match: /no native value/ },
    { patch: { spender: RECIPIENT }, match: /no allowance/ },
    { patch: { to: '0x00000000000000000000000000000000deadbeef' }, match: /canonical Base USDC/ },
  ];
  for (const item of cases) {
    const result = commercePaymentSafetyKernelV1({
      calls: [{ ...call, ...item.patch } as typeof call],
      invoice: invoice(),
      authenticatedWallet: WALLET,
      intent: intent(),
      now: NOW,
    });
    assert.equal(result.verdict, 'blocked');
    assert.match(String(result.blockedReason), item.match);
  }
  const two = commercePaymentSafetyKernelV1({
    calls: [call, call],
    invoice: invoice(),
    authenticatedWallet: WALLET,
    intent: intent(),
    now: NOW,
  });
  assert.equal(two.verdict, 'blocked');
  assert.match(String(two.blockedReason), /exactly one call/);
});

test('the kernel blocks an amount above the ceiling and an expired invoice', () => {
  const big = invoice({ amountAtomic: '9000000' });
  assert.equal(
    commercePaymentSafetyKernelV1({
      calls: [buildCommercePaymentCallV1({ recipient: RECIPIENT, amountAtomic: '9000000' })!],
      invoice: big,
      authenticatedWallet: WALLET,
      intent: intent(),
      now: NOW,
    }).verdict,
    'blocked',
  );
  assert.equal(
    commercePaymentSafetyKernelV1({
      calls: [buildCommercePaymentCallV1({ recipient: RECIPIENT, amountAtomic: AMOUNT })!],
      invoice: invoice(),
      authenticatedWallet: WALLET,
      intent: intent(),
      now: new Date(NOW.getTime() + 3_600_000),
    }).verdict,
    'blocked',
  );
});

// --- Blueprint --------------------------------------------------------------

test('the blueprint is bound to the invoice, the order and the card', () => {
  const value = blueprint();
  assert.equal(value.invoiceId, 'inv-1');
  assert.equal(value.exactAmountAtomic, AMOUNT);
  assert.equal(value.recipient, RECIPIENT);
  assert.equal(value.recipientPolicy, 'invoice_scoped');
  assert.equal(value.routeCardHash, CARD_HASH);
  assert.equal(value.status, 'ready_for_review');
  assert.equal(value.approvedCallsHash, null);
  assert.equal(value.calls.length, 1);
});

test('an unsimulated payment is never signable', () => {
  const value = blueprint();
  const gate = commercePaymentSignableV1(value, NOW);
  assert.equal(gate.signable, false);
  assert.match(String(gate.reason), /not been simulated/);
});

test('a reverted simulation is never signable', () => {
  const value = { ...blueprint(), simulationState: { ...blueprint().simulationState, status: 'failed' as const } };
  const gate = commercePaymentSignableV1(value, NOW);
  assert.equal(gate.signable, false);
  assert.match(String(gate.reason), /reverted/);
});

test('a passed simulation on a live invoice is signable', () => {
  const value = {
    ...blueprint(),
    simulationState: {
      status: 'passed' as const,
      observedAt: NOW.toISOString(),
      blockNumber: '1',
      requestHash: ZERO_HASH_V1,
      responseHash: ZERO_HASH_V1,
      errorCode: null,
    },
  };
  assert.equal(commercePaymentSignableV1(value, NOW).signable, true);
  // …but not once the price lock is gone.
  assert.equal(commercePaymentSignableV1(value, new Date(NOW.getTime() + 3_600_000)).signable, false);
});

// --- Revalidation -----------------------------------------------------------

function freshInvoice(overrides: Record<string, unknown> = {}) {
  return {
    invoiceId: 'inv-1',
    paymentStatus: 'unpaid',
    method: 'usdc_base',
    currency: 'USDC',
    amountAtomic: AMOUNT,
    recipient: RECIPIENT,
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    productId: 'steam-usa',
    packageValue: '5',
    ...overrides,
  };
}

function revalidate(overrides: Record<string, unknown> = {}, now = NOW) {
  const parent = intent();
  const inv = invoice();
  return revalidateCommerceInvoiceV1({
    fresh: freshInvoice(overrides),
    persisted: inv,
    order: order(parent, inv),
    intent: parent,
    candidate: candidate(parent),
    authenticatedWallet: WALLET,
    now,
  });
}

test('an unchanged invoice revalidates', () => {
  assert.deepEqual(revalidate(), { ok: true });
});

test('a changed amount stops the payment and does NOT open a new invoice', () => {
  const result = revalidate({ amountAtomic: '6000000' });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'invoice_changed');
  assert.match((result as { detail: string }).detail, /amount changed/);
});

test('a changed recipient stops the payment', () => {
  const result = revalidate({ recipient: '0x00000000000000000000000000000000deadbeef' });
  assert.equal((result as { reason: string }).reason, 'invoice_changed');
  assert.match((result as { detail: string }).detail, /payment address changed/);
});

test('an already-paid invoice is not paid again', () => {
  assert.equal((revalidate({ paymentStatus: 'paid' }) as { reason: string }).reason, 'invoice_changed');
});

test('a changed rail or currency stops the payment', () => {
  assert.equal((revalidate({ method: 'lightning' }) as { reason: string }).reason, 'invoice_changed');
  assert.equal((revalidate({ currency: 'EUR' }) as { reason: string }).reason, 'invoice_changed');
});

test('an expired invoice is refused', () => {
  const result = revalidate({}, new Date(NOW.getTime() + 3_600_000));
  assert.equal((result as { reason: string }).reason, 'invoice_expired');
});

test('a different product or denomination is refused', () => {
  assert.equal((revalidate({ productId: 'amazon-us' }) as { reason: string }).reason, 'invoice_changed');
  assert.equal((revalidate({ packageValue: '10' }) as { reason: string }).reason, 'invoice_changed');
});

// --- Onchain proof ----------------------------------------------------------

function transferLog(overrides: { from?: string; to?: string; amount?: string; token?: string } = {}) {
  const pad = (value: string) => value.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return {
    address: overrides.token ?? USDC,
    topics: [
      ERC20_TRANSFER_TOPIC_V1,
      `0x${pad(overrides.from ?? WALLET)}`,
      `0x${pad(overrides.to ?? RECIPIENT)}`,
    ],
    data: `0x${pad(BigInt(overrides.amount ?? AMOUNT).toString(16))}`,
  };
}

function receipt(overrides: Partial<CommerceReceiptV1> = {}): CommerceReceiptV1 {
  return {
    transactionHash: `0x${'a'.repeat(64)}`,
    status: 'success',
    blockNumber: '30000000',
    gasUsed: '52000',
    chainId: 8453,
    logs: [transferLog()],
    ...overrides,
  };
}

test('a matching Transfer log proves the payment', () => {
  const result = buildCommerceOnchainPaymentV1({
    receipt: receipt(),
    blueprint: blueprint(),
    payer: WALLET,
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.payment.state, 'verified');
  assert.equal(result.payment.actualAmountAtomic, AMOUNT);
  assert.equal(result.payment.actualRecipient, RECIPIENT);
  assert.equal(result.payment.actualSender, WALLET);
});

test('a successful receipt with NO Transfer log is unverified, never paid', () => {
  const result = buildCommerceOnchainPaymentV1({
    receipt: receipt({ logs: [] }),
    blueprint: blueprint(),
    payer: WALLET,
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.payment.state, 'unverified');
  assert.equal(result.payment.actualAmountAtomic, null);
});

test('a Transfer to the wrong address, amount, token or from the wrong wallet is not this payment', () => {
  for (const log of [
    transferLog({ to: '0x00000000000000000000000000000000deadbeef' }),
    transferLog({ amount: '1' }),
    transferLog({ token: '0x00000000000000000000000000000000deadbeef' }),
    transferLog({ from: '0x00000000000000000000000000000000deadbeef' }),
  ]) {
    const result = buildCommerceOnchainPaymentV1({
      receipt: receipt({ logs: [log] }),
      blueprint: blueprint(),
      payer: WALLET,
      now: NOW,
    });
    assert.ok(result.ok);
    assert.equal(result.payment.state, 'unverified');
  }
});

test('a reverted receipt is reverted, and a missing one is honest about it', () => {
  const reverted = buildCommerceOnchainPaymentV1({
    receipt: receipt({ status: 'reverted', logs: [] }),
    blueprint: blueprint(),
    payer: WALLET,
    now: NOW,
  });
  assert.ok(reverted.ok);
  assert.equal(reverted.payment.state, 'reverted');
  assert.deepEqual(
    buildCommerceOnchainPaymentV1({ receipt: null, blueprint: blueprint(), payer: WALLET, now: NOW }),
    { ok: false, reason: 'receipt_missing' },
  );
  assert.deepEqual(
    buildCommerceOnchainPaymentV1({ receipt: receipt({ chainId: 1 }), blueprint: blueprint(), payer: WALLET, now: NOW }),
    { ok: false, reason: 'wrong_chain' },
  );
});

test('the Transfer finder requires every field to match at once', () => {
  assert.ok(findCommercePaymentTransferV1({ logs: [transferLog()], from: WALLET, to: RECIPIENT, amountAtomic: AMOUNT }));
  assert.equal(
    findCommercePaymentTransferV1({ logs: [transferLog()], from: WALLET, to: RECIPIENT, amountAtomic: '1' }),
    null,
  );
});

// --- Provider ladder --------------------------------------------------------

test('each rung of the provider ladder requires the one below it', () => {
  const base = {
    onchainVerified: true,
    providerPaymentSeen: false,
    providerPaymentConfirmed: false,
    orderConfirmed: false,
    delivered: false,
    refunded: false,
    failed: false,
  };
  assert.equal(commercePaymentProgressV1(base), 'payment_submitted');
  assert.equal(commercePaymentProgressV1({ ...base, providerPaymentSeen: true }), 'payment_detected');
  assert.equal(
    commercePaymentProgressV1({ ...base, providerPaymentSeen: true, providerPaymentConfirmed: true }),
    'order_processing',
  );
  assert.equal(
    commercePaymentProgressV1({ ...base, providerPaymentConfirmed: true, orderConfirmed: true }),
    'delivery_pending',
  );
  assert.equal(
    commercePaymentProgressV1({ ...base, providerPaymentConfirmed: true, orderConfirmed: true, delivered: true }),
    'delivered',
  );
  // Delivery claimed WITHOUT a confirmed order never reads as delivered.
  assert.notEqual(commercePaymentProgressV1({ ...base, delivered: true }), 'delivered');
  assert.equal(commercePaymentProgressV1({ ...base, refunded: true }), 'refunded');
  assert.equal(commercePaymentProgressV1({ ...base, failed: true }), 'failed');
});

test('paid onchain but never seen by the provider becomes a reconciliation case', () => {
  assert.equal(
    commercePaymentUnconfirmedV1({ onchainVerified: true, providerPaymentSeen: false, elapsedMs: 600_000, boundMs: 300_000 }),
    true,
  );
  assert.equal(
    commercePaymentUnconfirmedV1({ onchainVerified: true, providerPaymentSeen: false, elapsedMs: 10_000, boundMs: 300_000 }),
    false,
  );
  assert.equal(
    commercePaymentUnconfirmedV1({ onchainVerified: true, providerPaymentSeen: true, elapsedMs: 600_000, boundMs: 300_000 }),
    false,
  );
});

// --- Delivery secrets -------------------------------------------------------

const DELIVERED_ORDER = {
  id: 'ord-1',
  status: 'delivered',
  delivered: true,
  delivered_time: '2026-07-26T12:05:00.000Z',
  redemption_info: { code: 'SECRET-CODE-1234', pin: '4242', link: 'https://redeem.example/abc' },
};

test('redemption material is redacted before anything is hashed', () => {
  const redacted = JSON.stringify(redactCommerceDeliveryV1(DELIVERED_ORDER));
  for (const secret of ['SECRET-CODE-1234', '4242', 'redeem.example']) {
    assert.ok(!redacted.includes(secret), `"${secret}" must not survive redaction`);
  }
  // The same order with a different code hashes the SAME, which proves the
  // hash carries nothing worth stealing.
  const a = commerceRedactedResponseHashV1(DELIVERED_ORDER);
  const b = commerceRedactedResponseHashV1({
    ...DELIVERED_ORDER,
    redemption_info: { code: 'A-COMPLETELY-DIFFERENT-CODE', pin: '0000', link: 'https://other.example' },
  });
  assert.equal(a, b);
});

test('a delivered order yields the secret once and a storable record that omits it', () => {
  const result = readCommerceDeliveryV1({ order: DELIVERED_ORDER, orderStatus: 'delivered', now: NOW });
  assert.ok(result.ok);
  assert.equal(result.record.redemptionAvailable, true);
  assert.equal(result.record.orderStatus, 'delivered');
  assert.equal(result.record.deliveryObservedAt, '2026-07-26T12:05:00.000Z');
  // The record is what gets persisted — it must contain no material at all.
  const stored = JSON.stringify(result.record);
  for (const secret of ['SECRET-CODE-1234', '4242', 'redeem.example']) {
    assert.ok(!stored.includes(secret));
  }
  assert.equal(result.secret?.fields.code, 'SECRET-CODE-1234');
});

test('an undelivered order yields no secret at all', () => {
  const result = readCommerceDeliveryV1({
    order: { ...DELIVERED_ORDER, status: 'created', delivered: false },
    orderStatus: 'order_processing',
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.secret, null);
  assert.equal(result.record.redemptionAvailable, false);
  assert.equal(result.record.deliveryObservedAt, null);
});

test('a provider that says delivered but returns nothing to redeem does not claim availability', () => {
  const result = readCommerceDeliveryV1({
    order: { id: 'ord-1', status: 'delivered', delivered: true, redemption_info: {} },
    orderStatus: 'delivered',
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.record.redemptionAvailable, false);
  assert.equal(result.secret, null);
});
