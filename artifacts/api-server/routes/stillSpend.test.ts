import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import { BITREFILL_MCP_TOKEN_URL_V1, createBitrefillGuestCatalogV1, createBitrefillGuestCheckoutV1,
  type BitrefillGuestCheckoutV1, type SpendInvoiceStatusNameV1, type SpendProductV1 } from '@mioagent/commerce-engine';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';
import { InMemoryRateLimiter } from '@mioagent/utils';

import { MemoryLoanExecutionStoreV1 } from '../lib/loanExecutionStore.js';
import { verifyLendingDraftV1, type LendingPaymentV1, type LendingQuestionV1 } from '../lib/lendingDraft.js';
import type { LendingRunV1 } from '../lib/lendingReview.js';
import { createSpendInvoiceReadsV1 } from '../lib/stillSpendInvoiceReads.js';
import { createSpendOrderStoreV1, spendDeliveryMaskedV1, stillBitrefillClientV1, type SpendOrderStoreV1 } from '../lib/stillSpendOrders.js';
import type { SpendWalletRunV1 } from '../lib/stillSpendWallet.js';
import { MemorySpendWalletStoreV1 } from '../lib/stillSpendWalletStore.js';
import { rwaBorrowRouter, rwaBorrowRuntimeV1 } from './rwaBorrow.js';
import { rwaLendingRouter, rwaLendingRuntimeV1 } from './rwaLending.js';
import { publicStillRouter, publicStillRuntimeV1, resetStillCardCachesV1 } from './stillPublic.js';
import { loanStoppedBeforePaymentV1, stillSpendRouter, stillSpendRuntimeV1 } from './stillSpend.js';

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

const originals = { spend: { ...stillSpendRuntimeV1 }, borrow: { ...rwaBorrowRuntimeV1 }, lending: { ...rwaLendingRuntimeV1 }, publicStill: { ...publicStillRuntimeV1 } };
let orders: SpendOrderStoreV1, loans: MemoryLoanExecutionStoreV1, wallets: MemorySpendWalletStoreV1, enabled: boolean, walletRuns: number;
let invoiceStatus: SpendInvoiceStatusNameV1, opened: unknown[], attached: number, loanRuns: number;
/** Every read of an invoice the stand-in for Bitrefill was asked for, by what it was for; and every quote, by how it was asked. */
let statusReads: string[], quotes: unknown[];

function checkout(): BitrefillGuestCheckoutV1 {
  return {
    async createInvoice(input) {
      opened.push(input);
      return { ok: true, value: { invoiceId: INVOICE, accessToken: 'access-token-0123456789', payTo: PAY_TO, amountAtomic: input.quotedAtomic,
        expiresAt: new Date(input.now.getTime() + 15 * 60_000).toISOString(), paymentLink: `https://www.bitrefill.com/invoice/${INVOICE}?token=t` } };
    },
    async readInvoice(_input, options) {
      statusReads.push(options?.purpose ?? 'payment');
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
  enabled = true; invoiceStatus = 'unpaid'; opened = []; attached = 0; loanRuns = 0; walletRuns = 0; statusReads = []; quotes = [];
  // Bitrefill's kept readings and the wallet's own limits on them, new for each test like the other budgets.
  const invoiceReads = createSpendInvoiceReadsV1();
  // Each test its own budget: the server's limiters count across a minute, and these tests run in less.
  Object.assign(stillSpendRuntimeV1, { ...originals.spend, orders, enabled: () => enabled, now: () => NOW, checkout, invoiceReads,
    walletLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 12 }), walletStatusLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 30 }),
    catalog: () => ({ search: async () => ({ ok: true, value: [] }), product: async (_id: string, options?: unknown) => { quotes.push(options); return { ok: true, value: ESIM }; } }),
    walletPayments: async () => wallets, loans: async () => loans,
    prepareWallet: async ({ payment }: { payment: LendingPaymentV1 }) => { walletRuns++; return walletRun(payment); } });
  Object.assign(rwaBorrowRuntimeV1, { ...originals.borrow, secret: () => SECRET, now: () => NOW, spendOrders: orders, spendEnabled: () => enabled });
  Object.assign(rwaLendingRuntimeV1, { ...originals.lending, store: async () => loans, secret: () => SECRET, now: () => NOW,
    spendOrders: orders, spendEnabled: () => enabled, spendCheckout: checkout, spendInvoiceReads: invoiceReads, walletPayments: async () => wallets,
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
  Object.assign(publicStillRuntimeV1, originals.publicStill);
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
    // Where the purchase goes is the owner's to see, as the invoice was opened (audit MCP-3).
    assert.deepEqual(r.body.order.deliverTo, { email: 'buyer@example.com', phone: null });
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

  // Re-audit R5, 2026-11-04: a batch id only the wallet knows, or an answer that never reached Still,
  // left a payment that may have landed "on its way" for good.
  it('takes a hash from the wallet as a lookup hint for a payment on its way, replaceable, and never for a settled one', async () => {
    await openOrder();
    const review = (await request(app()).post(wallet())).body;
    assert.equal((await request(app()).post(wallet('/transaction')).send({ transactionHash: `0x${'ab'.repeat(32)}` })).status, 409);
    const armed = await request(app()).post(wallet('/arm')).send({ callsHash: review.callsHash, signingTermsHash: review.signingTermsHash });
    await request(app()).post(wallet('/submission')).send({ attemptId: armed.body.attemptId, outcome: 'submitted', batchId: 'mm-batch-1' });
    assert.equal((await request(app()).post(wallet('/transaction')).send({ transactionHash: 'not-a-hash' })).status, 400);
    assert.equal((await request(app(OTHER)).post(wallet('/transaction')).send({ transactionHash: `0x${'ab'.repeat(32)}` })).status, 409);
    const first = await request(app()).post(wallet('/transaction')).send({ transactionHash: `0x${'AB'.repeat(32)}` });
    assert.deepEqual([first.status, first.body.state, first.body.transactionHash, first.body.batchId, first.body.errorCode],
      [200, 'unknown', `0x${'ab'.repeat(32)}`, 'mm-batch-1', 'spend_wallet_transaction_hint_unverified']);
    // A hint that matched nothing is replaced by the next, as the loan's is.
    const second = await request(app()).post(wallet('/transaction')).send({ transactionHash: `0x${'cd'.repeat(32)}` });
    assert.deepEqual([second.status, second.body.transactionHash], [200, `0x${'cd'.repeat(32)}`]);
    const store = await stillSpendRuntimeV1.walletPayments();
    const owner = { tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET };
    const held = await store.get({ owner, orderId: INVOICE });
    await store.recordVerification({ owner, orderId: INVOICE, expectedVersion: held!.version, state: 'confirmed', transactionHash: `0x${'cd'.repeat(32)}`,
      proof: { receiptFingerprint: `0x${'ee'.repeat(32)}` }, errorCode: null, now: new Date() });
    assert.deepEqual((await request(app()).post(wallet('/transaction')).send({ transactionHash: `0x${'ab'.repeat(32)}` })).body, { error: 'spend_wallet_attempt_changed' });
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
    // Another invoice at another time: the wallet's three payment checks a minute are its own again.
    const invoiceReads = createSpendInvoiceReadsV1();
    Object.assign(rwaLendingRuntimeV1, { store: async () => loans, walletPayments: async () => wallets, spendInvoiceReads: invoiceReads });
    Object.assign(stillSpendRuntimeV1, { loans: async () => loans, walletPayments: async () => wallets, invoiceReads });
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

// Audit SPEND-1/2/3 (2026-11-10). Bitrefill gives Still twenty catalogue calls and ten checkout calls a
// minute, for everyone: anyone reading the catalogue, or one wallet reading its own invoice, could spend
// them and leave nobody able to buy.
describe('what one wallet reads of its own invoice', () => {
  const read = () => request(app()).get(`/api/still/spend/orders/${INVOICE}`);

  it('asks Bitrefill once in fifteen seconds, from the ordinary part of the window, however often the page asks', async () => {
    assert.equal((await request(app()).post('/api/still/spend/orders').send(ORDER)).status, 200);
    invoiceStatus = 'payment_detected';
    const answers = await Promise.all(Array.from({ length: 20 }, read));
    assert.deepEqual(statusReads, ['display']);
    for (const answer of answers) {
      assert.deepEqual([answer.status, answer.body.status.status, answer.body.statusError, answer.body.settled], [200, 'payment_detected', null, false]);
      assert.ok(Number.isFinite(Date.parse(answer.body.statusReadAt)));
    }
  });

  it('says when the invoice is settled, so the page stops asking: delivered, or stopped by Bitrefill', async () => {
    assert.equal((await request(app()).post('/api/still/spend/orders').send(ORDER)).status, 200);
    const settled: Record<string, boolean> = {};
    for (const name of ['unpaid', 'payment_detected', 'payment_confirmed', 'pending', 'complete', 'blocked', 'denied', 'payment_error'] as const) {
      invoiceStatus = name;
      // Each status read as Bitrefill's own answer, not a kept one.
      Object.assign(stillSpendRuntimeV1, { invoiceReads: createSpendInvoiceReadsV1() });
      settled[name] = (await read()).body.settled;
    }
    assert.deepEqual(settled, { unpaid: false, payment_detected: false, payment_confirmed: false, pending: false,
      complete: true, blocked: true, denied: true, payment_error: true });
  });

  it('keeps Bitrefill’s last reading, with the reason, when it cannot be asked again', async () => {
    assert.equal((await request(app()).post('/api/still/spend/orders').send(ORDER)).status, 200);
    invoiceStatus = 'pending';
    let at = NOW.getTime();
    Object.assign(stillSpendRuntimeV1, { invoiceReads: createSpendInvoiceReadsV1({ now: () => at }) });
    assert.equal((await read()).body.status.status, 'pending');
    at += 16_000;
    Object.assign(stillSpendRuntimeV1, { checkout: () => ({ ...checkout(), readInvoice: async () => ({ ok: false, reason: 'bitrefill_rate_limited' }) }) });
    const held = (await read()).body;
    assert.deepEqual([held.status.status, held.statusError, held.statusReadAt, held.settled], ['pending', 'bitrefill_rate_limited', NOW.toISOString(), false]);
  });
});

describe('six invoices an hour for one wallet', () => {
  it('asks the fresh quote from the part of the catalogue’s window kept for buying', async () => {
    assert.equal((await request(app()).post('/api/still/spend/orders').send(ORDER)).status, 200);
    assert.deepEqual(quotes, [{ freshForCheckout: true }]);
  });

  it('counts requests sent together together: eight at once open six', async () => {
    const answers = await Promise.all(Array.from({ length: 8 }, () => request(app()).post('/api/still/spend/orders').send(ORDER)));
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 200, 200, 200, 200, 200, 429, 429]);
    assert.equal(opened.length, 6);
    assert.equal(orders.openedLastHour({ tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET }), 6);
  });

  it('does not count an invoice that did not open', async () => {
    Object.assign(stillSpendRuntimeV1, { catalog: () => ({ search: async () => ({ ok: true, value: [] }), product: async () => ({ ok: false, reason: 'bitrefill_unreachable' }) }) });
    for (let index = 0; index < 8; index++) assert.equal((await request(app()).post('/api/still/spend/orders').send(ORDER)).status, 503);
    assert.equal(orders.openedLastHour({ tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET }), 0);
  });
});

describe('Bitrefill’s two windows, with a part of each kept for buying', () => {
  const THIRD = '0x4444444444444444444444444444444444444444';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const PRODUCT = ['id: bitrefill-esim-germany', 'name: Bitrefill eSIM Germany', 'country_code: DE', 'in_stock: true', 'recipient_type: mixed',
    'packages[1]{package_value,package_currency,payment_price,payment_currency}:', '  "10GB, 30 Days",USD,"13.25",USDC'].join('\n');
  const rpc = (text: string, isError = false) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text }] } }),
    { status: 200, headers: { 'content-type': 'application/json' } });

  /** A synthetic Bitrefill behind the real transports: nothing here leaves the process. */
  function bitrefill() {
    const asked: string[] = [];
    let invoices = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) === BITREFILL_MCP_TOKEN_URL_V1) {
        asked.push('token');
        return new Response(JSON.stringify({ access_token: 'synthetic-guest-token-0123456789', expires_in: 21_600 }), { status: 200 });
      }
      const call = (JSON.parse(String(init.body)) as { params: { name: string; arguments: Record<string, unknown> } }).params;
      asked.push(call.name);
      if (call.name === 'get-product-details') return call.arguments.product_id === 'bitrefill-esim-germany' ? rpc(PRODUCT) : rpc('product_not_found: no such product', true);
      if (call.name === 'get-invoice-by-id') return rpc(JSON.stringify({ invoice_status: 'unpaid' }));
      assert.equal(call.name, 'buy-products');
      return rpc(JSON.stringify({ response: { invoice_id: `0000000${++invoices}-0df7-4f44-bc72-c1c6ad8b7b34`, invoice_access_token: 'access-token-0123456789', expiration_minutes: 15,
        payment_info: { address: PAY_TO, altcoinPrice: '13.25', contractAddress: USDC } } }));
    }) as typeof fetch;
    return { asked, fetchImpl, count: (name: string) => asked.filter((entry) => entry === name).length };
  }

  function site(owner: string | null) {
    const a = app(owner);
    a.use('/api/public/still', publicStillRouter);
    return a;
  }

  it('anyone naming products that do not exist cannot stop a wallet from opening an invoice', async () => {
    const mock = bitrefill();
    let at = NOW.getTime();
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: mock.fetchImpl, now: () => at });
    const guest = createBitrefillGuestCheckoutV1({ fetchImpl: mock.fetchImpl, now: () => at });
    resetStillCardCachesV1();
    // This address's own limit is out of the way, so what is measured is Bitrefill's window.
    Object.assign(publicStillRuntimeV1, { spend: () => catalog, limiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 10_000 }), now: () => new Date(at) });
    Object.assign(stillSpendRuntimeV1, { catalog: () => catalog, checkout: () => guest });
    const probe = (index: number) => request(site(null)).get('/api/public/still/spend/product').query({ id: `x-${index}` });
    const first = [];
    for (let index = 0; index < 40; index++) first.push((await probe(index)).status);
    // One token and thirteen names reached Bitrefill: the ordinary fourteen. The rest were refused here.
    assert.equal(mock.count('get-product-details'), 13);
    assert.deepEqual([first.filter((status) => status === 404).length, first.filter((status) => status === 503).length], [13, 27]);
    // A name Bitrefill does not have is not asked for again.
    for (let index = 0; index < 13; index++) assert.equal((await probe(index)).status, 404);
    assert.equal(mock.count('get-product-details'), 13);
    // In that same minute two wallets open invoices: their quotes come from the six kept for buying.
    for (const owner of [WALLET, OTHER]) {
      const answer = await request(site(owner)).post('/api/still/spend/orders').send(ORDER);
      assert.deepEqual([answer.status, answer.body.order?.priceAtomic], [200, '13250000'], JSON.stringify(answer.body));
    }
    assert.deepEqual([mock.count('get-product-details'), mock.count('buy-products')], [15, 2]);
    // A minute later the names forgotten by nobody are still not asked for, and new ones are.
    at += 60_001;
    assert.equal((await probe(0)).status, 404);
    assert.equal((await probe(100)).status, 404);
    assert.equal(mock.count('get-product-details'), 16);
    resetStillCardCachesV1();
  });

  it('two wallets reading their invoices without pause cannot stop a third from buying and paying', async () => {
    const mock = bitrefill();
    let at = NOW.getTime();
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: mock.fetchImpl, now: () => at });
    const guest = createBitrefillGuestCheckoutV1({ fetchImpl: mock.fetchImpl, now: () => at });
    // The worst case: no reading kept and no limit of the wallet's own, so every read asks Bitrefill.
    const flood = createSpendInvoiceReadsV1({ displayTtlMs: 0, displayPerMinute: 1_000 });
    Object.assign(stillSpendRuntimeV1, { catalog: () => catalog, checkout: () => guest, invoiceReads: flood });
    Object.assign(rwaLendingRuntimeV1, { spendCheckout: () => guest, spendInvoiceReads: flood });
    const mine: Record<string, string> = {};
    for (const owner of [WALLET, OTHER]) mine[owner] = (await request(site(owner)).post('/api/still/spend/orders').send(ORDER)).body.order.orderId;
    at += 60_001;
    const before = mock.asked.length;
    const polls = [];
    for (let index = 0; index < 20; index++) for (const owner of [WALLET, OTHER]) polls.push(await request(site(owner)).get(`/api/still/spend/orders/${mine[owner]}`));
    // Six of the forty reached Bitrefill: the ordinary part of its ten. Every page still has an answer.
    assert.equal(mock.asked.length - before, 6);
    assert.ok(polls.every((poll) => poll.status === 200));
    assert.equal(polls.filter((poll) => poll.body.statusError === 'bitrefill_rate_limited').length, 34);
    assert.ok(polls.slice(12).every((poll) => poll.body.status?.status === 'unpaid'), 'a full window leaves the last reading standing');
    // The third wallet, in that same minute: a new invoice, then the review that pays it from its own USDC.
    const third = await request(site(THIRD)).post('/api/still/spend/orders').send(ORDER);
    assert.equal(third.status, 200, JSON.stringify(third.body));
    const review = await request(site(THIRD)).post(`/api/still/spend/orders/${third.body.order.orderId}/wallet`);
    assert.deepEqual([review.status, review.body.state], [200, 'ready'], JSON.stringify(review.body));
    // And a loan already under way reads its invoice before its next step.
    const order = orders.get({ tenantId: `eip155:8453:${THIRD}`, walletAddress: THIRD }, third.body.order.orderId)!;
    assert.equal((await flood.step({ order, checkout: guest })).ok, true);
    assert.equal(mock.asked.length - before, 10);
  });

  it('with the page as it is, the same two wallets ask Bitrefill twice', async () => {
    const mock = bitrefill();
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: mock.fetchImpl });
    const guest = createBitrefillGuestCheckoutV1({ fetchImpl: mock.fetchImpl });
    Object.assign(stillSpendRuntimeV1, { catalog: () => catalog, checkout: () => guest });
    const mine: Record<string, string> = {};
    for (const owner of [WALLET, OTHER]) mine[owner] = (await request(site(owner)).post('/api/still/spend/orders').send(ORDER)).body.order.orderId;
    for (let index = 0; index < 20; index++) for (const owner of [WALLET, OTHER]) assert.equal((await request(site(owner)).get(`/api/still/spend/orders/${mine[owner]}`)).body.statusError, null);
    assert.equal(mock.count('get-invoice-by-id'), 2);
  });
});

// Audit MCP-3 (2026-11-10): an assistant names the email Bitrefill sends a gift card's code to, and the
// number it tops up, and the person signed a review that showed neither.
describe('where the purchase goes, shown before it is paid', () => {
  const TOP_UP: SpendProductV1 = { id: 'airtel-india', name: 'Airtel India', country: 'IN', inStock: true, recipientType: 'phone_number', url: null,
    packages: [{ value: '10', faceCurrency: 'INR', priceUsdc: '0.11' }] };

  it('the loan’s review and the wallet’s payment both carry the email and the number of the open invoice', async () => {
    Object.assign(stillSpendRuntimeV1, { catalog: () => ({ search: async () => ({ ok: true, value: [] }), product: async () => ({ ok: true, value: TOP_UP }) }) });
    const opened = await request(app()).post('/api/still/spend/orders').send({ productId: TOP_UP.id, packageValue: '10', email: 'buyer@example.com', phone: '+91 98765 43210' });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const where = { email: 'buyer@example.com', phone: '+919876543210' };
    assert.deepEqual(opened.body.order.deliverTo, where);
    const paying = await request(app()).post(`/api/still/spend/orders/${INVOICE}/wallet`);
    assert.deepEqual([paying.body.state, paying.body.deliverTo], ['ready', where]);
    const intent = await request(app()).post('/api/route-intelligence/rwa/borrow/intent')
      .send({ collateralTokenAddress: STOCK, borrowAmountAtomic: '110000', collateralSupplyAtomic: '0', spendOrderId: INVOICE });
    const review = await request(app()).get(`/api/route-intelligence/rwa/lending/review/${String(intent.body.reviewUrl).slice('/lending/'.length)}`);
    assert.deepEqual([review.body.state, review.body.deliverTo], ['ready', where]);
    // It is not among the facts the review is bound by, nor in any stored record: only the open order holds it.
    assert.equal(JSON.stringify(review.body.facts).includes('buyer@example.com'), false);
    assert.equal(JSON.stringify(await loans.listByPaymentOrder({ owner: { tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET }, orderId: INVOICE })).includes('buyer@example.com'), false);
    // Another wallet sees nothing of it.
    assert.equal((await request(app(OTHER)).post(`/api/still/spend/orders/${INVOICE}/wallet`)).body.deliverTo, undefined);
  });

  it('a loan with no purchase carries none', async () => {
    const intent = await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send({ collateralTokenAddress: STOCK, borrowAmountAtomic: '1000000', collateralSupplyAtomic: '0' });
    const review = await request(app()).get(`/api/route-intelligence/rwa/lending/review/${String(intent.body.reviewUrl).slice('/lending/'.length)}`);
    assert.deepEqual([review.body.state, review.body.deliverTo], ['ready', undefined]);
  });

  it('inside an assistant’s card only the ends of each are shown', () => {
    assert.deepEqual(spendDeliveryMaskedV1({ email: 'buyer@example.com', phone: '+919876543210' }), { email: 'b…r@example.com', phone: '+…3210' });
    assert.deepEqual(spendDeliveryMaskedV1({ email: 'jo@example.com', phone: null }), { email: 'j…@example.com', phone: null });
    assert.deepEqual(spendDeliveryMaskedV1({ email: 'x@example.com', phone: null }), { email: 'x…@example.com', phone: null });
  });
});

describe('a loan in steps that stopped before it paid', () => {
  const row = (over: Record<string, unknown>) => ({ state: 'failed', errorCode: 'loan_steps_stopped', verification: { stoppedAt: 3 },
    run: { delivery: 'sequential', calls: [0, 1, 2, 3] }, ...over }) as never;

  it('is the only loan that leaves its invoice to the wallet: stopped on record, read from Base, short of the last step', () => {
    assert.equal(loanStoppedBeforePaymentV1(row({})), true);
    assert.equal(loanStoppedBeforePaymentV1(row({ verification: { stoppedAt: 0 } })), true);
    for (const held of [{ state: 'submitted' }, { state: 'unknown' }, { state: 'awaiting_wallet' }, { state: 'confirmed', errorCode: null },
      { errorCode: 'loan_step_reverted' }, { verification: null }, { verification: {} }, { verification: { stoppedAt: 4 } }, { verification: { stoppedAt: '3' } },
      { run: { calls: [0, 1, 2, 3] } }]) {
      assert.equal(loanStoppedBeforePaymentV1(row(held)), false, JSON.stringify(held));
    }
  });

  it('lets the wallet review and arm a payment of the same invoice, and no other loan state does', async () => {
    assert.equal((await request(app()).post('/api/still/spend/orders').send(ORDER)).status, 200);
    let rows: unknown[] = [row({})];
    Object.assign(stillSpendRuntimeV1, { loans: async () => ({ listByPaymentOrder: async () => rows }) });
    const path = `/api/still/spend/orders/${INVOICE}/wallet`;
    const review = (await request(app()).post(path)).body;
    assert.equal(review.state, 'ready');
    assert.deepEqual(statusReads, ['payment']);
    rows = [row({ state: 'unknown' })];
    assert.deepEqual((await request(app()).post(`${path}/arm`).send({ callsHash: review.callsHash, signingTermsHash: review.signingTermsHash })).body,
      { error: 'spend_invoice_has_attempt' });
    rows = [row({})];
    assert.equal((await request(app()).post(`${path}/arm`).send({ callsHash: review.callsHash, signingTermsHash: review.signingTermsHash })).status, 200);
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
