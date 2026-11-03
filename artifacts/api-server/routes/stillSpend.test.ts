import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import type { BitrefillGuestCheckoutV1, SpendInvoiceStatusNameV1, SpendProductV1 } from '@mioagent/commerce-engine';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';

import { MemoryLoanExecutionStoreV1 } from '../lib/loanExecutionStore.js';
import { verifyLendingDraftV1, type LendingPaymentV1, type LendingQuestionV1 } from '../lib/lendingDraft.js';
import type { LendingRunV1 } from '../lib/lendingReview.js';
import { createSpendOrderStoreV1, stillBitrefillClientV1, type SpendOrderStoreV1 } from '../lib/stillSpendOrders.js';
import type { SpendWalletRunV1 } from '../lib/stillSpendWallet.js';
import { MemorySpendWalletStoreV1 } from '../lib/stillSpendWalletStore.js';
import { rwaBorrowRouter, rwaBorrowRuntimeV1 } from './rwaBorrow.js';
import { rwaLendingRouter, rwaLendingRuntimeV1 } from './rwaLending.js';
import { stillSpendRouter, stillSpendRuntimeV1 } from './stillSpend.js';

// Still Spend, stage 3, at the HTTP boundary: an invoice is opened for the
// session's wallet only, a loan for it carries the invoice as the server read
// it, and a review pays only an unpaid invoice nobody has sent yet. Every
// Bitrefill answer and every loan here is synthetic.
const WALLET = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
const PAY_TO = '0x3333333333333333333333333333333333333333';
const INVOICE = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34';
const NOW = new Date('2026-11-01T12:00:00Z'), SECRET = 'spend-route-fixture-secret-never-production';
const STOCK = STOCKS[0]!.token.toLowerCase();
const ESIM: SpendProductV1 = { id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', country: 'DE', inStock: true, recipientType: 'mixed', url: null,
  packages: [{ value: '10GB, 30 Days', faceCurrency: 'USD', priceUsdc: '13.25' }, { value: 'Unlimited', faceCurrency: 'USD', priceUsdc: '140.00' }] };

const originals = { spend: { ...stillSpendRuntimeV1 }, borrow: { ...rwaBorrowRuntimeV1 }, lending: { ...rwaLendingRuntimeV1 } };
let orders: SpendOrderStoreV1, loans: MemoryLoanExecutionStoreV1, wallets: MemorySpendWalletStoreV1, enabled: boolean, walletRuns: number;
let invoiceStatus: SpendInvoiceStatusNameV1, opened: unknown[], attached: number, loanRuns: number;

function checkout(): BitrefillGuestCheckoutV1 {
  return {
    async createInvoice(input) {
      opened.push(input);
      return { ok: true, value: { invoiceId: INVOICE, accessToken: 'access-token-0123456789', payTo: PAY_TO, amountAtomic: input.quotedAtomic,
        expiresAt: new Date(input.now.getTime() + 15 * 60_000).toISOString(), paymentLink: `https://www.bitrefill.com/invoice/${INVOICE}?token=t` } };
    },
    async readInvoice() {
      return { ok: true, value: { status: invoiceStatus, accessLink: null, esimInstallLink: null } };
    },
  };
}

function loanRun(question: LendingQuestionV1): Extract<LendingRunV1, { state: 'ready' }> {
  const calls: ExecutionCallV1[] = [{ index: 0, callType: 'other', to: ADDRESSES.aaveSpoke.toLowerCase() as `0x${string}`, valueWei: '0', data: '0x12345678', asset: null, amountAtomic: null, recipient: null, spender: null }];
  if (question.operation !== 'borrow') throw new Error('borrow only');
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'11'.repeat(32)}`, expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    atomicRequired: true, steps: [{ index: 0, to: calls[0]!.to, reading: 'Synthetic fixture only' }], measured: { blockNumber: 53_100_000, provider: 'fixture', loanDeltaAssets: question.borrowAssets },
    facts: { operation: 'borrow', venue: 'aave-v4', collateralTokenAddress: question.collateralTokenAddress, collateralSymbol: 'AAPLc', collateralDecimals: 18,
      marketId: ADDRESSES.aaveSpoke.toLowerCase(), amountMode: 'assets', requestedAssets: question.borrowAssets, maximumDebitAssets: '0', collateralSupplyAssets: question.collateralSupplyAssets,
      debtBeforeAssets: '0', debtAfterAssets: question.borrowAssets, collateralBeforeAssets: '0', collateralAfterAssets: '0', debtBeforeShares: '0', debtAfterShares: '1', blockNumber: 53_100_000, warnings: [] } };
}

// The wallet's own USDC pays the invoice: one transfer, as the real review prepares it.
function walletRun(payment: LendingPaymentV1): SpendWalletRunV1 {
  const calls: ExecutionCallV1[] = [{ index: 0, callType: 'transfer', to: ADDRESSES.usdc.toLowerCase() as `0x${string}`, valueWei: '0', data: '0xa9059cbb',
    asset: null, amountAtomic: payment.assets, recipient: payment.payTo as `0x${string}`, spender: null }];
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'44'.repeat(32)}`, expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    steps: [{ index: 0, to: calls[0]!.to, reading: 'Pay Bitrefill' }],
    facts: { payment, usdcBeforeAtomic: '20000000', usdcAfterAtomic: String(20_000_000n - BigInt(payment.assets)), blockNumber: 53_100_000, warnings: [] } };
}

function app(owner: string | null = WALLET) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (owner) Object.defineProperty(req, 'session', { value: { user: { id: `eip155:8453:${owner}`, address: owner, chainId: 8453 } } });
    next();
  });
  a.use('/api/still/spend', stillSpendRouter);
  a.use('/api/route-intelligence', rwaBorrowRouter, rwaLendingRouter);
  return a;
}

beforeEach(() => {
  orders = createSpendOrderStoreV1({ now: () => NOW });
  loans = new MemoryLoanExecutionStoreV1();
  wallets = new MemorySpendWalletStoreV1();
  enabled = true; invoiceStatus = 'unpaid'; opened = []; attached = 0; loanRuns = 0; walletRuns = 0;
  Object.assign(stillSpendRuntimeV1, { ...originals.spend, orders, enabled: () => enabled, now: () => NOW, checkout,
    catalog: () => ({ search: async () => ({ ok: true, value: [] }), product: async () => ({ ok: true, value: ESIM }) }),
    walletPayments: async () => wallets, loans: async () => loans,
    prepareWallet: async ({ payment }: { payment: LendingPaymentV1 }) => { walletRuns++; return walletRun(payment); } });
  Object.assign(rwaBorrowRuntimeV1, { ...originals.borrow, secret: () => SECRET, now: () => NOW, spendOrders: orders, spendEnabled: () => enabled });
  Object.assign(rwaLendingRuntimeV1, { ...originals.lending, store: async () => loans, secret: () => SECRET, now: () => NOW,
    spendOrders: orders, spendEnabled: () => enabled, spendCheckout: checkout, walletPayments: async () => wallets,
    runAave: async ({ question }: { question: LendingQuestionV1 }) => { loanRuns++; return loanRun(question); },
    attachPayment: async ({ run, payment }: { run: LendingRunV1; payment: LendingPaymentV1 }) => {
      attached++;
      if (run.state !== 'ready') return run;
      const calls = [...run.calls, { ...run.calls[0]!, index: 1, callType: 'transfer' as const, to: ADDRESSES.usdc.toLowerCase() as `0x${string}`, recipient: payment.payTo as `0x${string}`, amountAtomic: payment.assets }];
      return { ...run, calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'22'.repeat(32)}`, facts: { ...run.facts, payment },
        steps: [...run.steps, { index: 1, to: calls[1]!.to, reading: 'Pay Bitrefill' }] };
    } });
});
afterEach(() => {
  Object.assign(stillSpendRuntimeV1, originals.spend);
  Object.assign(rwaBorrowRuntimeV1, originals.borrow);
  Object.assign(rwaLendingRuntimeV1, originals.lending);
});

const ORDER = { productId: 'bitrefill-esim-germany', packageValue: '10GB, 30 Days', email: 'buyer@example.com' };

describe('opening a Bitrefill invoice from Still', () => {
  it('is off until the operator turns it on, and needs the wallet’s own session', async () => {
    enabled = false;
    assert.equal((await request(app()).post('/api/still/spend/orders').send(ORDER)).status, 503);
    enabled = true;
    assert.equal((await request(app(null)).post('/api/still/spend/orders').send(ORDER)).status, 401);
    assert.equal(opened.length, 0);
  });

  it('opens one invoice at the fresh quote and gives its owner everything but the token', async () => {
    const r = await request(app()).post('/api/still/spend/orders').send(ORDER);
    assert.equal(r.status, 200);
    assert.deepEqual(opened, [{ productId: 'bitrefill-esim-germany', packageValue: '10GB, 30 Days', email: 'buyer@example.com', quotedAtomic: 13_250_000n, now: NOW }]);
    assert.equal(r.body.order.orderId, INVOICE);
    assert.equal(r.body.order.priceAtomic, '13250000');
    assert.equal(r.body.order.payTo, PAY_TO);
    assert.equal(JSON.stringify(r.body).includes('access-token-0123456789'), false);
    const read = await request(app()).get(`/api/still/spend/orders/${INVOICE}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.status.status, 'unpaid');
    assert.equal(JSON.stringify(read.body).includes('access-token-0123456789'), false);
    // Another wallet cannot see that it exists.
    assert.equal((await request(app(OTHER)).get(`/api/still/spend/orders/${INVOICE}`)).status, 404);
  });

  it('a refusal by Bitrefill carries its own cleaned words, and logs no email', async () => {
    Object.assign(stillSpendRuntimeV1, { checkout: () => ({ ...checkout(), createInvoice: async () => ({ ok: false, reason: 'bitrefill_refused', detail: 'Minimum order is 1 USD' }) }) });
    const r = await request(app()).post('/api/still/spend/orders').send(ORDER);
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: 'bitrefill_refused', detail: 'Minimum order is 1 USD' });
  });

  it('refuses a package not on offer, one over the cap, a product needing an account, and stray fields', async () => {
    for (const body of [{ ...ORDER, packageValue: '99GB' }, { ...ORDER, packageValue: 'Unlimited' }, { ...ORDER, email: 'nobody' }, { ...ORDER, payTo: OTHER }]) {
      const r = await request(app()).post('/api/still/spend/orders').send(body);
      assert.ok(r.status === 400 || r.status === 409, JSON.stringify(body));
    }
    Object.assign(stillSpendRuntimeV1, { catalog: () => ({ search: async () => ({ ok: true, value: [] }),
      product: async () => ({ ok: true, value: { ...ESIM, id: 'free-fire-diamonds', recipientType: 'account' } }) }) });
    assert.equal((await request(app()).post('/api/still/spend/orders').send({ ...ORDER, productId: 'free-fire-diamonds' })).status, 409);
    assert.equal(opened.length, 0);
  });
});

describe('a phone top-up', () => {
  const AIRTEL: SpendProductV1 = { id: 'airtel-india', name: 'Airtel India', country: 'IN', inStock: true, recipientType: 'phone_number', url: null,
    packages: [{ value: '10', faceCurrency: 'INR', priceUsdc: '0.11' }] };
  const TOP_UP = { productId: 'airtel-india', packageValue: '10', email: 'buyer@example.com' };
  const sell = (product: SpendProductV1) => Object.assign(stillSpendRuntimeV1, { catalog: () => ({ search: async () => ({ ok: true, value: [] }), product: async () => ({ ok: true, value: product }) }) });

  it('sends Bitrefill the number in its digits, and shows it to the owner with the order', async () => {
    sell(AIRTEL);
    const r = await request(app()).post('/api/still/spend/orders').send({ ...TOP_UP, phone: '+91 98765 43210' });
    assert.equal(r.status, 200);
    assert.deepEqual(opened, [{ productId: 'airtel-india', packageValue: '10', email: 'buyer@example.com', refillInput: '919876543210', quotedAtomic: 110_000n, now: NOW }]);
    assert.deepEqual([r.body.order.refillTo, r.body.order.priceAtomic, r.body.order.faceCurrency], ['+919876543210', '110000', 'INR']);
    const read = await request(app()).get(`/api/still/spend/orders/${INVOICE}`);
    assert.equal(read.body.order.refillTo, '+919876543210');
    assert.equal((await request(app(OTHER)).get(`/api/still/spend/orders/${INVOICE}`)).status, 404);
  });

  it('opens nothing without a number, with a local one, or with one of another country', async () => {
    sell(AIRTEL);
    for (const [phone, error] of [[undefined, 'spend_phone_needed'], ['98765 43210', 'spend_phone_invalid'], ['+7 777 123 4567', 'spend_phone_invalid'], ['', 'spend_request_invalid']] as const) {
      const r = await request(app()).post('/api/still/spend/orders').send({ ...TOP_UP, ...(phone === undefined ? {} : { phone }) });
      assert.deepEqual([r.status, r.body.error], [400, error], String(phone));
    }
    // Kazakhstan shares +7 with Russia: a Russian number is not a Kazakh top-up.
    sell({ ...AIRTEL, id: 'beeline-kazakhstan', name: 'Beeline Kazakhstan', country: 'KZ', packages: [{ value: '100', faceCurrency: 'KZT', priceUsdc: '0.26' }] });
    const kz = { productId: 'beeline-kazakhstan', packageValue: '100', email: 'buyer@example.com' };
    assert.equal((await request(app()).post('/api/still/spend/orders').send({ ...kz, phone: '+7 912 345 6789' })).body.error, 'spend_phone_invalid');
    assert.equal(opened.length, 0);
    assert.equal((await request(app()).post('/api/still/spend/orders').send({ ...kz, phone: '+7 777 123 4567' })).status, 200);
    assert.equal((opened[0] as { refillInput?: string }).refillInput, '77771234567');
  });

  it('sends no number with anything else, and buys no top-up where the calling code is unknown', async () => {
    assert.deepEqual((await request(app()).post('/api/still/spend/orders').send({ ...ORDER, phone: '+49 151 2345 6789' })).body, { error: 'spend_request_invalid' });
    sell({ ...AIRTEL, country: null });
    assert.equal((await request(app()).post('/api/still/spend/orders').send({ ...TOP_UP, phone: '+91 98765 43210' })).body.error, 'spend_product_not_buyable');
    assert.equal(opened.length, 0);
  });
});

describe('a loan that pays the invoice', () => {
  async function openOrder() {
    assert.equal((await request(app()).post('/api/still/spend/orders').send(ORDER)).status, 200);
  }
  const intent = (patch: Record<string, unknown> = {}) => ({ collateralTokenAddress: STOCK, borrowAmountAtomic: '13250000', collateralSupplyAtomic: '0', spendOrderId: INVOICE, ...patch });

  it('carries the invoice as the server read it, for exactly its price', async () => {
    await openOrder();
    const r = await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send(intent());
    assert.equal(r.status, 200);
    assert.match(r.body.reviewUrl, /^\/lending\/miorail-lending-v3\./);
    const verified = verifyLendingDraftV1({ draft: r.body.reviewUrl.slice('/lending/'.length), secret: SECRET, now: NOW, walletAddress: WALLET, tenantId: `eip155:8453:${WALLET}` });
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.ok && verified.claims.question.operation === 'borrow' && verified.claims.question.payment, {
      merchant: 'bitrefill', orderId: INVOICE, payTo: PAY_TO, assets: '13250000', productName: 'Bitrefill eSIM Germany', packageValue: '10GB, 30 Days',
      faceCurrency: 'USD', expiresAt: '2026-11-01T12:15:00.000Z' });
    // Another amount, another wallet's order, or a payment with native ETH is not this loan.
    assert.equal((await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send(intent({ borrowAmountAtomic: '13250001' }))).status, 400);
    assert.equal((await request(app(OTHER)).post('/api/route-intelligence/rwa/borrow/intent').send(intent())).status, 409);
    assert.equal((await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send(intent({ collateralTokenAddress: ADDRESSES.weth.toLowerCase(), collateralSupplyAtomic: '1', nativeFundingAtomic: '1' }))).status, 400);
  });

  it('reviews the loan with the payment only while Bitrefill waits for it, once', async () => {
    await openOrder();
    const link = (await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send(intent())).body.reviewUrl.slice('/lending/'.length);
    const review = await request(app()).get(`/api/route-intelligence/rwa/lending/review/${link}`);
    assert.equal(review.body.state, 'ready');
    assert.equal(review.body.facts.payment.payTo, PAY_TO);
    assert.equal(review.body.calls.length, 2);
    assert.equal(attached, 1);
    // The first review is armed; a second review of the same invoice cannot be armed after it.
    const armed = await request(app()).post(`/api/route-intelligence/rwa/lending/executions/${review.body.executionId}/arm`).send({ callsHash: review.body.callsHash, signingTermsHash: review.body.signingTermsHash });
    assert.equal(armed.status, 200);
    const second = (await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send(intent())).body.reviewUrl.slice('/lending/'.length);
    const again = await request(app()).get(`/api/route-intelligence/rwa/lending/review/${second}`);
    assert.equal(again.body.state, 'refused');
    assert.equal(again.body.refusal, 'spend_invoice_has_attempt');
    assert.equal(again.body.calls, undefined);
  });

  it('refuses before measuring any loan when the invoice is gone, paid, or the switch is off', async () => {
    await openOrder();
    const link = (await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send(intent())).body.reviewUrl.slice('/lending/'.length);
    for (const [setup, refusal] of [
      [() => { invoiceStatus = 'payment_detected'; }, 'spend_invoice_not_unpaid'],
      [() => { invoiceStatus = 'blocked'; }, 'spend_invoice_not_unpaid'],
      [() => { enabled = false; }, 'spend_pay_off'],
      [() => { Object.assign(rwaLendingRuntimeV1, { spendOrders: createSpendOrderStoreV1({ now: () => NOW }) }); }, 'spend_order_unread'],
    ] as const) {
      setup();
      const r = await request(app()).get(`/api/route-intelligence/rwa/lending/review/${link}`);
      assert.equal(r.body.state, 'refused');
      assert.equal(r.body.refusal, refusal);
      assert.equal(r.body.calls, undefined);
      invoiceStatus = 'unpaid'; enabled = true; Object.assign(rwaLendingRuntimeV1, { spendOrders: orders });
    }
    assert.equal(loanRuns, 0);
    assert.equal(attached, 0);
  });
});

describe('paying the invoice from the wallet’s own USDC', () => {
  async function openOrder() {
    assert.equal((await request(app()).post('/api/still/spend/orders').send(ORDER)).status, 200);
  }
  const wallet = (path = '') => `/api/still/spend/orders/${INVOICE}/wallet${path}`;
  const loanLink = async () => (await request(app()).post('/api/route-intelligence/rwa/borrow/intent')
    .send({ collateralTokenAddress: STOCK, borrowAmountAtomic: '13250000', collateralSupplyAtomic: '0', spendOrderId: INVOICE })).body.reviewUrl.slice('/lending/'.length) as string;

  it('reviews one exact transfer for the invoice’s owner, while Bitrefill waits for it', async () => {
    await openOrder();
    assert.equal((await request(app(null)).post(wallet())).status, 401);
    const r = await request(app()).post(wallet());
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'ready');
    assert.deepEqual(r.body.calls, [{ to: ADDRESSES.usdc.toLowerCase(), value: '0', data: '0xa9059cbb' }]);
    assert.equal(r.body.facts.payment.payTo, PAY_TO);
    assert.equal(r.body.facts.payment.assets, '13250000');
    // Another wallet's invoice is not this one's to pay.
    assert.deepEqual((await request(app(OTHER)).post(wallet())).body, { orderId: INVOICE, state: 'refused', refusal: 'spend_order_unread',
      detail: 'Still no longer holds this Bitrefill invoice: it expired, or the server restarted. Open a new one from Spend. Nothing was sent.' });
    for (const [setup, refusal] of [
      [() => { invoiceStatus = 'payment_detected'; }, 'spend_invoice_not_unpaid'],
      [() => { enabled = false; }, null],
    ] as const) {
      walletRuns = 0; setup();
      const again = await request(app()).post(wallet());
      if (refusal) assert.deepEqual([again.body.state, again.body.refusal, again.body.calls], ['refused', refusal, undefined]);
      else assert.deepEqual([again.status, again.body.error], [503, 'spend_pay_off']);
      assert.equal(walletRuns, 0);
      invoiceStatus = 'unpaid'; enabled = true;
    }
  });

  it('arms once, takes the wallet’s answer, and from then on is read, never prepared again', async () => {
    await openOrder();
    const review = (await request(app()).post(wallet())).body;
    const terms = { callsHash: review.callsHash, signingTermsHash: review.signingTermsHash };
    assert.deepEqual((await request(app()).post(wallet('/arm')).send({ ...terms, signingTermsHash: `0x${'55'.repeat(32)}` })).body, { error: 'spend_wallet_not_ready' });
    const arms = await Promise.all([1, 2].map(() => request(app()).post(wallet('/arm')).send(terms)));
    assert.deepEqual(arms.map((r) => r.status).sort(), [200, 409]);
    const attemptId = arms.find((r) => r.status === 200)!.body.attemptId as string;
    const hash = `0x${'ab'.repeat(32)}`;
    assert.equal((await request(app()).post(wallet('/submission')).send({ attemptId, outcome: 'submitted', batchId: 'b', transactionHash: hash })).status, 400);
    const sent = await request(app()).post(wallet('/submission')).send({ attemptId, outcome: 'submitted', transactionHash: hash });
    assert.deepEqual([sent.body.state, sent.body.transactionHash, sent.body.calls], ['submitted', hash, undefined]);
    walletRuns = 0;
    const read = await request(app()).post(wallet());
    assert.deepEqual([read.body.state, read.body.calls, walletRuns], ['submitted', undefined, 0]);
  });

  it('a wallet that declined leaves the invoice free to pay again, by either way', async () => {
    await openOrder();
    const review = (await request(app()).post(wallet())).body;
    const armed = await request(app()).post(wallet('/arm')).send({ callsHash: review.callsHash, signingTermsHash: review.signingTermsHash });
    const declined = await request(app()).post(wallet('/submission')).send({ attemptId: armed.body.attemptId, outcome: 'rejected' });
    assert.equal(declined.body.state, 'ready');
    const loan = await request(app()).get(`/api/route-intelligence/rwa/lending/review/${await loanLink()}`);
    assert.equal(loan.body.state, 'ready');
  });

  it('pays one invoice once: a loan that holds it refuses the wallet, and the wallet that holds it refuses a loan', async () => {
    await openOrder();
    const loan = (await request(app()).get(`/api/route-intelligence/rwa/lending/review/${await loanLink()}`)).body;
    const review = (await request(app()).post(wallet())).body;
    assert.equal(review.state, 'ready');
    assert.equal((await request(app()).post(`/api/route-intelligence/rwa/lending/executions/${loan.executionId}/arm`)
      .send({ callsHash: loan.callsHash, signingTermsHash: loan.signingTermsHash })).status, 200);
    assert.deepEqual((await request(app()).post(wallet('/arm')).send({ callsHash: review.callsHash, signingTermsHash: review.signingTermsHash })).body,
      { error: 'spend_invoice_has_attempt' });
    const refused = await request(app()).post(wallet());
    assert.deepEqual([refused.body.state, refused.body.refusal, refused.body.calls], ['refused', 'spend_invoice_has_attempt', undefined]);

    // And the other way round, on a new invoice.
    loans = new MemoryLoanExecutionStoreV1(); wallets = new MemorySpendWalletStoreV1();
    Object.assign(rwaLendingRuntimeV1, { store: async () => loans, walletPayments: async () => wallets });
    Object.assign(stillSpendRuntimeV1, { loans: async () => loans, walletPayments: async () => wallets });
    const paying = (await request(app()).post(wallet())).body;
    const second = (await request(app()).get(`/api/route-intelligence/rwa/lending/review/${await loanLink()}`)).body;
    assert.equal(second.state, 'ready');
    assert.equal((await request(app()).post(wallet('/arm')).send({ callsHash: paying.callsHash, signingTermsHash: paying.signingTermsHash })).status, 200);
    assert.deepEqual((await request(app()).post(`/api/route-intelligence/rwa/lending/executions/${second.executionId}/arm`)
      .send({ callsHash: second.callsHash, signingTermsHash: second.signingTermsHash })).body, { error: 'spend_invoice_has_attempt' });
    const again = await request(app()).get(`/api/route-intelligence/rwa/lending/review/${await loanLink()}`);
    assert.deepEqual([again.body.state, again.body.refusal], ['refused', 'spend_invoice_has_attempt']);
  });

  it('arms a loan and the wallet pressed at the same moment for one invoice: exactly one of them', async () => {
    await openOrder();
    const loan = (await request(app()).get(`/api/route-intelligence/rwa/lending/review/${await loanLink()}`)).body;
    const review = (await request(app()).post(wallet())).body;
    // Both stores answer a moment late, as a database does: each arm reads the other kind before the
    // other's arm is written, and only the invoice's lock keeps the second from passing.
    const late = <T extends (...args: never[]) => Promise<unknown>>(arm: T) => (async (...args: Parameters<T>) => {
      await new Promise((resolve) => setTimeout(resolve, 20)); return arm(...args);
    }) as T;
    loans.arm = late(loans.arm.bind(loans));
    wallets.arm = late(wallets.arm.bind(wallets));
    const [byLoan, byWallet] = await Promise.all([
      request(app()).post(`/api/route-intelligence/rwa/lending/executions/${loan.executionId}/arm`).send({ callsHash: loan.callsHash, signingTermsHash: loan.signingTermsHash }),
      request(app()).post(wallet('/arm')).send({ callsHash: review.callsHash, signingTermsHash: review.signingTermsHash }),
    ]);
    assert.deepEqual([byLoan.status, byWallet.status].sort(), [200, 409]);
    assert.equal([byLoan, byWallet].find((r) => r.status === 409)!.body.error, 'spend_invoice_has_attempt');
  });
});

describe('Still’s registered Bitrefill client', () => {
  it('comes from the environment, and without a usable id the metadata document stays the client', () => {
    assert.deepEqual(stillBitrefillClientV1({ STILL_BITREFILL_CLIENT_ID: ' 00000000-0000-4000-8000-000000000001 ', STILL_BITREFILL_CLIENT_SECRET: 'fixture-secret' }),
      { clientId: '00000000-0000-4000-8000-000000000001', clientSecret: 'fixture-secret' });
    assert.deepEqual(stillBitrefillClientV1({ STILL_BITREFILL_CLIENT_ID: '00000000-0000-4000-8000-000000000001' }), { clientId: '00000000-0000-4000-8000-000000000001' });
    assert.deepEqual(stillBitrefillClientV1({ STILL_BITREFILL_CLIENT_SECRET: 'fixture-secret' }), {});
    assert.deepEqual(stillBitrefillClientV1({ STILL_BITREFILL_CLIENT_ID: 'not an id' }), {});
    assert.deepEqual(stillBitrefillClientV1({}), {});
  });
});
