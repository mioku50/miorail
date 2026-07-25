import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CommerceCandidateV1Schema,
  CommerceRouteIntentV1Schema,
  hashCommerceCandidateV1,
  hashCommerceRouteIntentV1,
  ZERO_HASH_V1,
  type CommerceCandidateV1,
  type CommerceRouteIntentV1,
} from '@mioagent/route-domain';
import { createMemoryCommerceStorageRepository, commerceIdempotencyKeyV1 } from '../src/index.js';

// T64.2: the invariants the durable layer exists for. The memory repository
// enforces the same ones the Postgres implementation does.

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const TENANT = `eip155:8453:${WALLET}`;
const OTHER_TENANT = 'eip155:8453:0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-07-25T12:00:00.000Z');
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

const USDC_ASSET = {
  assetId: `eip155:8453/erc20:${USDC}`,
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: USDC,
  symbol: 'USDC',
  decimals: 6,
};

function intent(tenantId = TENANT, id = 'commerce-intent:test', requestedDecimal = '25'): CommerceRouteIntentV1 {
  const nowIso = NOW.toISOString();
  const draft = {
    schemaVersion: 'commerce-route-intent/v1' as const,
    id,
    tenantId,
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
    requestedValue: { amountDecimal: requestedDecimal, currency: 'USD' },
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

function candidate(parent: CommerceRouteIntentV1): CommerceCandidateV1 {
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
      packageId: 'steam-usa<&>25',
      recipientRequired: false,
    },
    fiatPrice: { amountDecimal: '25', currency: 'USD' },
    payment: { asset: USDC_ASSET, amountAtomic: '25000000', amountDecimal: '25' },
    fees: {
      productPriceAtomic: '25000000',
      providerFeeAtomic: null,
      networkFeeAtomic: null,
      totalAtomic: '25000000',
      totalBasis: 'exact_quote' as const,
    },
    availability: 'in_stock' as const,
    deliveryModel: 'digital_code' as const,
    recipientRequired: false,
    paymentTarget: { asset: USDC, payTo: '0x480cd46e6fade651a0437deadda53d5c8e7d846a' as const },
    observedAt: nowIso,
    expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    provider: { id: 'bitrefill-x402-v1', displayName: 'Bitrefill', kind: 'protocol' as const, operator: 'Bitrefill' },
  };
  return CommerceCandidateV1Schema.parse({
    ...draft,
    candidateHash: hashCommerceCandidateV1(draft as unknown as CommerceCandidateV1),
  });
}

const RESERVATION = {
  routeCardHash: `0x${'a'.repeat(64)}`,
  productId: 'steam-usa',
  packageValue: '25',
  estimatedAmountAtomic: '25000000',
  refundAddress: WALLET,
};

test('the idempotency key is tenant, wallet, card, package and request together', () => {
  const base = {
    tenantId: TENANT,
    walletAddress: WALLET,
    routeCardHash: RESERVATION.routeCardHash,
    productId: 'steam-usa',
    packageValue: '25',
    requestId: 'req-1',
  };
  const key = commerceIdempotencyKeyV1(base);
  // Changing ANY component produces a different checkout.
  for (const patch of [
    { tenantId: OTHER_TENANT },
    { walletAddress: '0x2222222222222222222222222222222222222222' },
    { routeCardHash: `0x${'b'.repeat(64)}` },
    { packageValue: '10' },
    { requestId: 'req-2' },
  ]) {
    assert.notEqual(commerceIdempotencyKeyV1({ ...base, ...patch }), key);
  }
  // The wallet is normalized, so its casing cannot fork a checkout.
  assert.equal(commerceIdempotencyKeyV1({ ...base, walletAddress: WALLET.toUpperCase() }), key);
});

test('a repeated reservation returns the existing row and never a second one', async () => {
  const repository = createMemoryCommerceStorageRepository();
  const parent = intent();
  const run = await repository.createCommerceRouteRun(parent, 'req-1');
  const input = {
    routeRunId: run.id,
    userId: TENANT,
    walletAddress: WALLET,
    candidateHash: candidate(parent).candidateHash,
    idempotencyKey: 'key-1',
    ...RESERVATION,
  };
  const first = await repository.reserveCommerceOrder(input);
  const second = await repository.reserveCommerceOrder(input);
  assert.equal(first.outcome, 'reserved');
  assert.equal(second.outcome, 'existing');
  assert.equal(second.record.id, first.record.id);
});

test('a reserved order starts with no invoice at all', async () => {
  const repository = createMemoryCommerceStorageRepository();
  const parent = intent();
  const run = await repository.createCommerceRouteRun(parent, 'req-1');
  const reserved = await repository.reserveCommerceOrder({
    routeRunId: run.id,
    userId: TENANT,
    walletAddress: WALLET,
    candidateHash: candidate(parent).candidateHash,
    idempotencyKey: 'key-1',
    ...RESERVATION,
  });
  assert.equal(reserved.record.status, 'pending');
  assert.equal(reserved.record.invoiceId, null);
  assert.equal(reserved.record.exactAmountAtomic, null);
  // The estimate is known before the invoice; the exact amount is not.
  assert.equal(reserved.record.estimatedAmountAtomic, '25000000');
});

test('an uncertain checkout is durable and keeps its reservation', async () => {
  const repository = createMemoryCommerceStorageRepository();
  const parent = intent();
  const run = await repository.createCommerceRouteRun(parent, 'req-1');
  const reserved = await repository.reserveCommerceOrder({
    routeRunId: run.id,
    userId: TENANT,
    walletAddress: WALLET,
    candidateHash: candidate(parent).candidateHash,
    idempotencyKey: 'key-1',
    ...RESERVATION,
  });
  const marked = await repository.markCommerceOrderUnknown(reserved.record.id, TENANT, 'no answer');
  assert.equal(marked.status, 'creation_unknown');
  assert.equal(marked.invoiceId, null);
  // The row survives, so a retry still lands on `existing`.
  const retry = await repository.reserveCommerceOrder({
    routeRunId: run.id,
    userId: TENANT,
    walletAddress: WALLET,
    candidateHash: candidate(parent).candidateHash,
    idempotencyKey: 'key-1',
    ...RESERVATION,
  });
  assert.equal(retry.outcome, 'existing');
});

test('another tenant cannot read a run, an order, or the history', async () => {
  const repository = createMemoryCommerceStorageRepository();
  const parent = intent();
  const run = await repository.createCommerceRouteRun(parent, 'req-1');
  await repository.insertCommerceCandidate(run.id, candidate(parent));
  const reserved = await repository.reserveCommerceOrder({
    routeRunId: run.id,
    userId: TENANT,
    walletAddress: WALLET,
    candidateHash: candidate(parent).candidateHash,
    idempotencyKey: 'key-1',
    ...RESERVATION,
  });
  assert.equal(await repository.getCommerceRouteRun(run.id, OTHER_TENANT), null);
  assert.equal(await repository.getCommerceOrder(reserved.record.id, OTHER_TENANT), null);
  assert.deepEqual(await repository.listCommerceHistory(OTHER_TENANT, 20), []);
  assert.equal((await repository.listCommerceHistory(TENANT, 20)).length, 1);
});

test('a candidate from a different intent cannot be attached to this run', async () => {
  const repository = createMemoryCommerceStorageRepository();
  const parent = intent();
  await repository.createCommerceRouteRun(parent, 'req-1');
  // A genuinely different intent — different requested value, so a different
  // intentHash. (The id alone is a lifecycle field and is not hashed.)
  const foreign = intent(TENANT, 'commerce-intent:other', '50');
  assert.notEqual(foreign.intentHash, parent.intentHash);
  await assert.rejects(() => repository.insertCommerceCandidate(parent.id, candidate(foreign)));
});
