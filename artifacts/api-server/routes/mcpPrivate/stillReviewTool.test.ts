import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SpendInvoiceStatusNameV1 } from '@mioagent/commerce-engine';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';

import type { LendingPaymentV1 } from '../../lib/lendingDraft.js';
import type { LendingRunV1 } from '../../lib/lendingReview.js';
import { MemoryLoanExecutionStoreV1, type LoanExecutionV1 } from '../../lib/loanExecutionStore.js';
import { STILL_PUBLIC_ORIGIN_V1 } from '../../lib/stillOrigin.js';
import { createSpendOrderStoreV1 } from '../../lib/stillSpendOrders.js';
import { verifyStillSpendShareV1 } from '../../lib/stillSpendShare.js';
import type { SpendWalletReadyV1 } from '../../lib/stillSpendWallet.js';
import { MemorySpendWalletStoreV1, type SpendWalletPaymentV1 } from '../../lib/stillSpendWalletStore.js';
import { rwaLendingRuntimeV1 } from '../rwaLending.js';
import { stillSpendRuntimeV1 } from '../stillSpend.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { StillReviewStatusOutputV1Schema, stillReviewStatusV1, type StillReviewStatusDepsV1 } from './stillReviewTool.js';

// What happened to a review an assistant prepared. Every loan, invoice, hash
// and address here is synthetic.
const WALLET = `0x${'1'.repeat(40)}` as const, OTHER = `0x${'2'.repeat(40)}`;
const IDENTITY = { tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET };
const SECRET = 'a-test-secret-long-enough';
const NOW = new Date('2026-11-02T15:00:00.000Z');
const INVOICE = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', DRAFT = '0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11';
const TX = `0x${'ab'.repeat(32)}` as const;
const NVDAC = STOCKS.find((stock) => stock.id === 'NVDAc')!.token.toLowerCase();
const PAYMENT: LendingPaymentV1 = { merchant: 'bitrefill', orderId: INVOICE, payTo: `0x${'3'.repeat(40)}`, assets: '9800000', productName: 'Bitrefill eSIM Japan',
  packageValue: '5GB, 30 Days', faceCurrency: 'USD', expiresAt: '2026-11-02T15:15:00.000Z' };

function run(payment: LendingPaymentV1 | null): Extract<LendingRunV1, { state: 'ready' }> {
  const calls: ExecutionCallV1[] = [{ index: 0, callType: 'other', to: ADDRESSES.aaveSpoke.toLowerCase() as `0x${string}`, valueWei: '0', data: '0x12345678', asset: null, amountAtomic: null, recipient: null, spender: null }];
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'11'.repeat(32)}`, expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    atomicRequired: true, steps: [{ index: 0, to: calls[0]!.to, reading: 'Synthetic fixture only' }], measured: { blockNumber: 53_100_000, provider: 'fixture', loanDeltaAssets: '9800000' },
    facts: { operation: 'borrow', venue: 'aave-v4', collateralTokenAddress: NVDAC, collateralSymbol: 'NVDAc', collateralDecimals: 8,
      marketId: ADDRESSES.aaveSpoke.toLowerCase(), amountMode: 'assets', requestedAssets: '9800000', maximumDebitAssets: '0', collateralSupplyAssets: '0',
      debtBeforeAssets: '0', debtAfterAssets: '9800000', collateralBeforeAssets: '0', collateralAfterAssets: '0', debtBeforeShares: '0', debtAfterShares: '1', blockNumber: 53_100_000, warnings: [],
      ...(payment ? { payment } : {}) } };
}

async function fixture(input: { payment?: LendingPaymentV1 | null; owner?: string; state?: LoanExecutionV1['state']; heldOrder?: boolean; allowRead?: boolean; returning?: boolean;
  lastRead?: SpendInvoiceStatusNameV1 } = {}) {
  const store = new MemoryLoanExecutionStoreV1();
  const owner = input.owner ?? WALLET;
  const review = run(input.payment === undefined ? PAYMENT : input.payment);
  // Repay all, then take the stock back.
  if (input.returning) Object.assign(review.facts, { operation: 'repay', amountMode: 'all', requestedAssets: null, maximumDebitAssets: '190000',
    debtBeforeAssets: '180030', debtAfterAssets: '0', collateralBeforeAssets: '3014121', collateralAfterAssets: '0', collateralReturnAssets: '3014121' });
  await store.putReady({ owner: { tenantId: `eip155:8453:${owner}`, walletAddress: owner }, draftId: DRAFT, run: review, now: NOW });
  const orders = createSpendOrderStoreV1({ now: () => NOW });
  if (input.heldOrder ?? true) {
    orders.put({ orderId: INVOICE, ...IDENTITY, productId: 'bitrefill-esim-japan', productName: PAYMENT.productName, packageValue: PAYMENT.packageValue, faceCurrency: 'USD',
      priceAtomic: PAYMENT.assets, payTo: PAYMENT.payTo, refillTo: null, createdAt: NOW.toISOString(), expiresAt: PAYMENT.expiresAt, accessToken: 'access-token-0123456789', paymentLink: null });
  }
  const invoiceReads: string[] = [];
  const deps: StillReviewStatusDepsV1 = {
    store: async () => store,
    // The page's refresh reads Base; here the chain has already answered.
    refresh: async ({ owner: who, executionId }) => {
      const record = await store.get({ owner: who, executionId });
      return record && { ...record, state: input.state ?? record.state, transactionHash: input.state === 'confirmed' ? TX : null };
    },
    orders,
    // As the Spend page reads it: Bitrefill's kept reading, under the page's own limit.
    invoice: async ({ wallet, order }) => {
      assert.equal(wallet, WALLET);
      if (!(input.allowRead ?? true)) return { status: input.lastRead ? { status: input.lastRead, accessLink: null, esimInstallLink: null } : null,
        readAt: input.lastRead ? NOW.toISOString() : null, error: 'bitrefill_rate_limited' };
      invoiceReads.push(order.orderId);
      return { status: { status: 'complete', accessLink: null, esimInstallLink: null }, readAt: NOW.toISOString(), error: null };
    },
    secret: SECRET,
  };
  return { deps, invoiceReads };
}

test('a link nobody has opened ready on this wallet is not_opened, and another wallet’s review is not visible', async () => {
  const { deps } = await fixture({ owner: OTHER });
  const status = await stillReviewStatusV1(IDENTITY, { reviewId: DRAFT }, deps);
  assert.deepEqual(Object.keys(status).sort(), ['next', 'reviewId', 'state']);
  assert.equal(status.state, 'not_opened');
  assert.match(status.next, /Nothing was sent/);
});

test('an open purchase review asks Bitrefill nothing before the payment could have been sent', async () => {
  const { deps, invoiceReads } = await fixture();
  const status = await stillReviewStatusV1(IDENTITY, { reviewId: DRAFT.toUpperCase() }, deps);
  assert.equal(status.state, 'ready');
  assert.equal(status.collateral, 'NVDAc');
  assert.deepEqual(status.purchase, { productName: PAYMENT.productName, packageValue: '5GB, 30 Days', priceUsdc: '9.8', invoiceExpiresAt: PAYMENT.expiresAt,
    invoiceStatus: null, invoiceStatusError: null, shareUrl: null });
  assert.deepEqual(invoiceReads, []);
});

test('a confirmed purchase carries Bitrefill’s own word for the invoice and a share link that names no wallet', async () => {
  const { deps, invoiceReads } = await fixture({ state: 'confirmed' });
  const status = await stillReviewStatusV1(IDENTITY, { reviewId: DRAFT }, deps);
  assert.equal(status.state, 'confirmed');
  assert.equal(status.transactionHash, TX);
  assert.equal(status.purchase?.invoiceStatus, 'complete');
  assert.deepEqual(invoiceReads, [INVOICE]);
  assert.match(status.next, /Confirmed onchain.*Bitrefill reads it as complete/);
  const shareUrl = status.purchase?.shareUrl ?? '';
  assert.ok(shareUrl.startsWith(`${STILL_PUBLIC_ORIGIN_V1}/spend/p/ss1.`), shareUrl);
  const claim = verifyStillSpendShareV1(shareUrl.replace(`${STILL_PUBLIC_ORIGIN_V1}/spend/p/`, ''), SECRET);
  assert.deepEqual(claim, { productName: PAYMENT.productName, packageLabel: '5GB, 30 Days', priceAtomic: '9800000', collateral: 'NVDAc', venue: 'aave-v4' });
  assert.ok(!shareUrl.includes(WALLET.slice(2)) && !shareUrl.includes(TX.slice(2)));
});

test('a forgotten order or a spent limit leaves Bitrefill unread, and says so', async () => {
  const forgotten = await fixture({ state: 'confirmed', heldOrder: false });
  const once = await stillReviewStatusV1(IDENTITY, { reviewId: DRAFT }, forgotten.deps);
  assert.deepEqual([once.purchase?.invoiceStatus, once.purchase?.invoiceStatusError], [null, 'spend_order_forgotten']);
  assert.match(once.next, /its email to the user is the receipt/);
  assert.deepEqual(forgotten.invoiceReads, []);
  const limited = await fixture({ state: 'submitted', allowRead: false });
  const twice = await stillReviewStatusV1(IDENTITY, { reviewId: DRAFT }, limited.deps);
  assert.equal(twice.purchase?.invoiceStatusError, 'bitrefill_rate_limited');
  assert.deepEqual(limited.invoiceReads, []);
});

test('a reading Bitrefill could not give again stays, named as its last word and with the reason', async () => {
  const { deps, invoiceReads } = await fixture({ state: 'confirmed', allowRead: false, lastRead: 'payment_confirmed' });
  const status = await stillReviewStatusV1(IDENTITY, { reviewId: DRAFT }, deps);
  assert.deepEqual([status.purchase?.invoiceStatus, status.purchase?.invoiceStatusError], ['payment_confirmed', 'bitrefill_rate_limited']);
  assert.match(status.next, /Bitrefill last read it as payment_confirmed, and could not be asked again just now\./);
  assert.deepEqual(invoiceReads, []);
});

test('a repayment that took the stock back names how much of it came back, once confirmed', async () => {
  const { deps } = await fixture({ payment: null, state: 'confirmed', returning: true });
  const status = await stillReviewStatusV1(IDENTITY, { reviewId: DRAFT }, deps);
  assert.deepEqual([status.operation, status.collateralReturned], ['repay', '0.03014121']);
  assert.match(status.next, /The loan is closed and 0\.03014121 NVDAc is back in the wallet\./);
  assert.equal(StillReviewStatusOutputV1Schema.safeParse(status).success, true);
  const open = await stillReviewStatusV1(IDENTITY, { reviewId: DRAFT }, (await fixture({ payment: null, state: 'submitted', returning: true })).deps);
  assert.doesNotMatch(open.next, /back in the wallet/);
});

test('a loan without a purchase has no purchase block, and unknown is never called a failure', async () => {
  const { deps } = await fixture({ payment: null, state: 'unknown' });
  const status = await stillReviewStatusV1(IDENTITY, { reviewId: DRAFT }, deps);
  assert.equal(status.state, 'unknown');
  assert.equal(status.purchase, undefined);
  assert.match(status.next, /not a failure of the transaction/);
});

// A purchase paid from the wallet's own USDC is named by its invoice (2026-11-04).
function walletRun(): SpendWalletReadyV1 {
  const calls: ExecutionCallV1[] = [{ index: 0, callType: 'transfer', to: ADDRESSES.usdc.toLowerCase() as `0x${string}`, valueWei: '0', data: '0xa9059cbb', asset: null,
    amountAtomic: PAYMENT.assets, recipient: PAYMENT.payTo as `0x${string}`, spender: null }];
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'22'.repeat(32)}`, expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    steps: [{ index: 0, to: calls[0]!.to, reading: 'Synthetic fixture only' }],
    facts: { payment: PAYMENT, usdcBeforeAtomic: '12500000', usdcAfterAtomic: '2700000', blockNumber: 53_100_000, warnings: [] } };
}
function walletPayment(state: SpendWalletPaymentV1['state']): SpendWalletPaymentV1 {
  return { ...IDENTITY, paymentId: '9d7f5c2a-1b3e-4f60-8a7d-2c4b6e8f0a12', orderId: INVOICE, state, run: walletRun(), attemptId: state === 'ready' ? null : '7a1e3c5b-2d4f-4a6b-8c9d-0e1f2a3b4c5d',
    batchId: null, transactionHash: state === 'confirmed' ? TX : null, verification: null, errorCode: null, version: 3, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
}

test('a purchase paid from the wallet is read by its invoice: waiting while Spend holds it, then its payment page’s own record', async () => {
  const { deps, invoiceReads } = await fixture();
  const asked: string[] = [];
  let record: SpendWalletPaymentV1 | null = null;
  const reading = { ...deps, walletPayment: async ({ orderId }: { orderId: string }) => { asked.push(orderId); return orderId === INVOICE ? record : null; } };
  const waiting = await stillReviewStatusV1(IDENTITY, { reviewId: INVOICE }, reading);
  assert.deepEqual([waiting.state, waiting.paidFrom, waiting.purchase?.priceUsdc, waiting.purchase?.invoiceStatus], ['not_opened', 'wallet', '9.8', null]);
  assert.match(waiting.next, /payment page/);
  record = walletPayment('ready');
  const open = await stillReviewStatusV1(IDENTITY, { reviewId: INVOICE }, reading);
  assert.deepEqual([open.state, open.paidFrom, open.transactionHash], ['ready', 'wallet', null]);
  assert.deepEqual(invoiceReads, [], 'Bitrefill is asked nothing before the payment could have been sent');
  record = walletPayment('confirmed');
  const paid = await stillReviewStatusV1(IDENTITY, { reviewId: INVOICE }, reading);
  assert.deepEqual([paid.state, paid.paidFrom, paid.transactionHash, paid.purchase?.invoiceStatus, paid.purchase?.shareUrl], ['confirmed', 'wallet', TX, 'complete', null]);
  assert.match(paid.next, /No loan was taken\. Bitrefill reads the invoice as complete\.$/);
  assert.equal(paid.operation, undefined);
  assert.deepEqual(invoiceReads, [INVOICE]);
  assert.deepEqual(asked, [INVOICE, INVOICE, INVOICE]);
  for (const status of [waiting, open, paid]) assert.equal(StillReviewStatusOutputV1Schema.safeParse(status).success, true);
  // A loan's review is still read as a loan, and an id Still knows nothing of says only that.
  assert.equal((await stillReviewStatusV1(IDENTITY, { reviewId: DRAFT }, reading)).paidFrom, undefined);
  const nothing = await stillReviewStatusV1(IDENTITY, { reviewId: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a' }, reading);
  assert.deepEqual(Object.keys(nothing).sort(), ['next', 'reviewId', 'state']);
});

test('the connected surface lists it as a read, and its answer fits the schema it advertises', async (t) => {
  const original = { ...rwaLendingRuntimeV1 }, spend = { ...stillSpendRuntimeV1 };
  const store = new MemoryLoanExecutionStoreV1(), payments = new MemorySpendWalletStoreV1();
  rwaLendingRuntimeV1.store = async () => store;
  rwaLendingRuntimeV1.secret = () => SECRET;
  stillSpendRuntimeV1.walletPayments = async () => payments;
  t.after(() => { Object.assign(rwaLendingRuntimeV1, original); Object.assign(stillSpendRuntimeV1, spend); });
  const client = new Client({ name: 'still-review-test', version: '1' });
  const server = createMiorailPrivateMcpServerV1({ ...IDENTITY, chainId: 8453, tokenId: 'test-grant', source: 'oauth' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(() => client.close());
  const tool = (await client.listTools()).tools.find((entry) => entry.name === 'miorail_get_still_review_status')!;
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ['reviewId']);
  const answer = await client.callTool({ name: 'miorail_get_still_review_status', arguments: { reviewId: DRAFT } });
  assert.deepEqual((answer as unknown as { structuredContent: { state: string } }).structuredContent.state, 'not_opened');
  // A wallet payment the page prepared is read through the page's own store.
  await payments.putReady({ owner: IDENTITY, run: walletRun(), now: NOW });
  const ready = await client.callTool({ name: 'miorail_get_still_review_status', arguments: { reviewId: INVOICE } });
  const wallet = (ready as unknown as { structuredContent: { state: string; paidFrom?: string } }).structuredContent;
  assert.deepEqual([wallet.state, wallet.paidFrom], ['ready', 'wallet']);
  const odd = await client.callTool({ name: 'miorail_get_still_review_status', arguments: { reviewId: 'not-a-review' } });
  assert.equal((odd as { isError?: boolean }).isError, true);
});
