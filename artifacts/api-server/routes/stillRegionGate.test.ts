import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import type { BitrefillGuestCheckoutV1, SpendProductV1 } from '@mioagent/commerce-engine';
import { STILL_ELIGIBILITY_VERSION_V1 } from '@mioagent/still-engine/eligibility';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';
import { InMemoryRateLimiter } from '@mioagent/utils';

import { MemoryLoanExecutionStoreV1 } from '../lib/loanExecutionStore.js';
import type { LendingPaymentV1, LendingQuestionV1 } from '../lib/lendingDraft.js';
import type { LendingRunV1 } from '../lib/lendingReview.js';
import { createSpendOrderStoreV1, type SpendOrderStoreV1 } from '../lib/stillSpendOrders.js';
import type { SpendWalletRunV1 } from '../lib/stillSpendWallet.js';
import { MemorySpendWalletStoreV1 } from '../lib/stillSpendWalletStore.js';
import { stillRegionRuntimeV1 } from '../lib/stillRegion.js';
import { syntheticRegionTableV1 } from '../lib/stillRegionTable.fixture.js';
import { rwaBorrowRouter, rwaBorrowRuntimeV1 } from './rwaBorrow.js';
import { rwaLendingRouter, rwaLendingRuntimeV1 } from './rwaLending.js';
import { stillSpendRouter, stillSpendRuntimeV1 } from './stillSpend.js';
import { publicStillEligibilityRouter, stillEligibilityRouter } from './stillEligibility.js';

// Still is not offered in the United States or to US persons (operator,
// 2026-11-10). At the HTTP boundary, with the real check and a synthetic
// address table (8.x is US, 9.x Puerto Rico, 11.x Germany; 10.x and 127.x are
// private): a new loan or purchase from the United States gets no calls, a
// sign-in that has not confirmed it is not a US person confirms first, and a
// repayment is never asked anything. Every run and every invoice is synthetic.
const WALLET = '0x1111111111111111111111111111111111111111';
const PAY_TO = '0x3333333333333333333333333333333333333333';
const INVOICE = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34';
const NOW = new Date('2026-11-10T12:00:00Z'), SECRET = 'region-route-fixture-secret-never-production';
const STOCK = STOCKS[0]!.token.toLowerCase();
const GERMANY = '11.2.3.4', USA = '8.8.8.8';
const ESIM: SpendProductV1 = { id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', country: 'DE', inStock: true, recipientType: 'mixed', url: null,
  packages: [{ value: '10GB, 30 Days', faceCurrency: 'USD', priceUsdc: '13.25' }] };

const originals = { spend: { ...stillSpendRuntimeV1 }, borrow: { ...rwaBorrowRuntimeV1 }, lending: { ...rwaLendingRuntimeV1 }, region: { ...stillRegionRuntimeV1 } };
let session: Record<string, unknown>, ip: string | undefined, orders: SpendOrderStoreV1, loans: MemoryLoanExecutionStoreV1, wallets: MemorySpendWalletStoreV1;
let runs: string[], walletRuns: number;

function run(question: LendingQuestionV1): Extract<LendingRunV1, { state: 'ready' }> {
  const calls: ExecutionCallV1[] = [{ index: 0, callType: 'other', to: ADDRESSES.aaveSpoke.toLowerCase() as `0x${string}`, valueWei: '0', data: '0x12345678', asset: null, amountAtomic: null, recipient: null, spender: null }];
  const borrow = question.operation === 'borrow', assets = borrow ? question.borrowAssets : question.maximumAssets;
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'11'.repeat(32)}`, expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    atomicRequired: true, steps: [{ index: 0, to: calls[0]!.to, reading: 'Synthetic fixture only' }], measured: { blockNumber: 53_100_000, provider: 'fixture', loanDeltaAssets: assets },
    facts: { operation: question.operation, venue: 'aave-v4', collateralTokenAddress: question.collateralTokenAddress, collateralSymbol: 'AAPLc', collateralDecimals: 18,
      marketId: ADDRESSES.aaveSpoke.toLowerCase(), amountMode: 'assets', requestedAssets: assets, maximumDebitAssets: borrow ? '0' : assets, collateralSupplyAssets: borrow ? question.collateralSupplyAssets : '0',
      debtBeforeAssets: '0', debtAfterAssets: assets, collateralBeforeAssets: '0', collateralAfterAssets: '0', debtBeforeShares: '0', debtAfterShares: '1', blockNumber: 53_100_000, warnings: [] } };
}
function walletRun(payment: LendingPaymentV1): SpendWalletRunV1 {
  const calls: ExecutionCallV1[] = [{ index: 0, callType: 'transfer', to: ADDRESSES.usdc.toLowerCase() as `0x${string}`, valueWei: '0', data: '0xa9059cbb',
    asset: null, amountAtomic: payment.assets, recipient: payment.payTo as `0x${string}`, spender: null }];
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'44'.repeat(32)}`, expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    steps: [{ index: 0, to: calls[0]!.to, reading: 'Pay Bitrefill' }],
    facts: { payment, usdcBeforeAtomic: '20000000', usdcAfterAtomic: '6750000', blockNumber: 53_100_000, warnings: [] } };
}
function checkout(): BitrefillGuestCheckoutV1 {
  return {
    async createInvoice(input) {
      return { ok: true, value: { invoiceId: INVOICE, accessToken: 'access-token-0123456789', payTo: PAY_TO, amountAtomic: input.quotedAtomic,
        expiresAt: new Date(input.now.getTime() + 15 * 60_000).toISOString(), paymentLink: `https://www.bitrefill.com/invoice/${INVOICE}?token=t` } };
    },
    async readInvoice() { return { ok: true, value: { status: 'unpaid', accessLink: null, esimInstallLink: null } }; },
  };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    Object.defineProperty(req, 'session', { configurable: true, value: session });
    Object.defineProperty(req, 'ip', { configurable: true, value: ip });
    next();
  });
  a.use('/api/public/still', publicStillEligibilityRouter);
  a.use('/api/still/spend', stillSpendRouter);
  a.use('/api/still', stillEligibilityRouter);
  a.use('/api/route-intelligence', rwaBorrowRouter, rwaLendingRouter);
  return a;
}
const confirm = () => request(app()).post('/api/still/eligibility').send({ version: STILL_ELIGIBILITY_VERSION_V1 });
const borrowLink = async () => (await request(app()).post('/api/route-intelligence/rwa/borrow/intent')
  .send({ collateralTokenAddress: STOCK, borrowAmountAtomic: '5000000', collateralSupplyAtomic: '1000000000000000000' })).body.reviewUrl.slice('/lending/'.length) as string;
const review = (link: string) => request(app()).get(`/api/route-intelligence/rwa/lending/review/${link}`);

beforeEach(() => {
  session = { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 }, save(callback: (error?: unknown) => void) { callback(); } };
  ip = GERMANY; runs = []; walletRuns = 0;
  orders = createSpendOrderStoreV1({ now: () => NOW });
  loans = new MemoryLoanExecutionStoreV1();
  wallets = new MemorySpendWalletStoreV1();
  const table = syntheticRegionTableV1();
  Object.assign(stillRegionRuntimeV1, { enabled: () => true, table: () => table, now: () => NOW.getTime() });
  Object.assign(stillSpendRuntimeV1, { ...originals.spend, orders, enabled: () => true, now: () => NOW, checkout,
    walletLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 12 }), walletStatusLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 30 }),
    catalog: () => ({ search: async () => ({ ok: true, value: [] }), product: async () => ({ ok: true, value: ESIM }) }),
    walletPayments: async () => wallets, loans: async () => loans,
    prepareWallet: async ({ payment }: { payment: LendingPaymentV1 }) => { walletRuns++; return walletRun(payment); } });
  Object.assign(rwaBorrowRuntimeV1, { ...originals.borrow, secret: () => SECRET, now: () => NOW, spendOrders: orders, spendEnabled: () => true });
  Object.assign(rwaLendingRuntimeV1, { ...originals.lending, store: async () => loans, secret: () => SECRET, now: () => NOW,
    spendOrders: orders, spendEnabled: () => true, spendCheckout: checkout, walletPayments: async () => wallets,
    runAave: async ({ question }: { question: LendingQuestionV1 }) => { runs.push(question.operation); return run(question); } });
});
afterEach(() => {
  Object.assign(stillSpendRuntimeV1, originals.spend);
  Object.assign(rwaBorrowRuntimeV1, originals.borrow);
  Object.assign(rwaLendingRuntimeV1, originals.lending);
  Object.assign(stillRegionRuntimeV1, originals.region);
});

describe('the confirmation a sign-in gives', () => {
  it('reads the region the server sees, and records the confirmation for this sign-in only', async () => {
    const before = await request(app()).get('/api/public/still/eligibility');
    assert.equal(before.status, 200);
    assert.equal(before.headers['cache-control'], 'private, no-store');
    assert.deepEqual([before.body.gate, before.body.region, before.body.confirmed, before.body.signedIn], ['on', { state: 'allowed', country: 'DE', reason: null }, false, true]);
    assert.equal((await confirm()).status, 200);
    assert.deepEqual(Object.keys(session.stillEligibility as object).sort(), ['confirmedAt', 'version', 'wallet']);
    assert.equal((await request(app()).get('/api/public/still/eligibility')).body.confirmed, true);
  });

  it('records nothing from the United States, for another sentence, or without a sign-in', async () => {
    ip = USA;
    const us = await confirm();
    assert.equal(us.status, 403);
    assert.equal(us.body.error, 'region_restricted');
    assert.equal(session.stillEligibility, undefined);
    ip = GERMANY;
    assert.equal((await request(app()).post('/api/still/eligibility').send({ version: 'not-us-person-2026-01-01' })).status, 400);
    session = { save(callback: () => void) { callback(); } };
    assert.equal((await confirm()).status, 401);
  });
});

describe('a new loan', () => {
  it('is not linked from the United States or Puerto Rico; elsewhere the link needs no confirmation yet', async () => {
    for (const from of [USA, '9.1.1.1']) {
      ip = from;
      const refused = await request(app()).post('/api/route-intelligence/rwa/borrow/intent')
        .send({ collateralTokenAddress: STOCK, borrowAmountAtomic: '5000000', collateralSupplyAtomic: '1000000000000000000' });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, 'region_restricted');
      assert.equal(refused.body.reviewUrl, undefined);
    }
    ip = GERMANY;
    assert.match(await borrowLink(), /^miorail-lending-v\d\./);
  });

  it('gets its calls only after this sign-in confirms, and never from the United States', async () => {
    const link = await borrowLink();
    const unconfirmed = await review(link);
    assert.deepEqual([unconfirmed.body.state, unconfirmed.body.refusal], ['refused', 'eligibility_required']);
    assert.equal(unconfirmed.body.calls, undefined);
    assert.deepEqual(runs, []);
    await confirm();
    ip = USA;
    const us = await review(link);
    assert.deepEqual([us.body.state, us.body.refusal], ['refused', 'region_restricted']);
    assert.deepEqual(runs, []);
    ip = GERMANY;
    const ready = await review(link);
    assert.equal(ready.body.state, 'ready');
    assert.deepEqual(runs, ['borrow']);
  });

  it('is not armed from the United States after a review elsewhere', async () => {
    await confirm();
    const ready = (await review(await borrowLink())).body;
    const arm = () => request(app()).post(`/api/route-intelligence/rwa/lending/executions/${ready.executionId}/arm`)
      .send({ callsHash: ready.callsHash, signingTermsHash: ready.signingTermsHash });
    ip = USA;
    const us = await arm();
    assert.equal(us.status, 403);
    assert.equal(us.body.error, 'region_restricted');
    ip = GERMANY;
    assert.equal((await arm()).status, 200);
  });

  it('is not reviewed for a request with no address of its own, such as Still’s card in a chat', async () => {
    await confirm();
    const link = await borrowLink();
    ip = undefined;
    const card = await review(link);
    assert.deepEqual([card.body.state, card.body.refusal], ['refused', 'region_unchecked']);
    assert.match(card.body.detail, /in your own browser/);
  });

  it('is not reviewed through the old Morpho routes from the United States', async () => {
    ip = USA;
    const old = await request(app()).post('/api/route-intelligence/rwa/borrow/review').send({ collateralTokenAddress: STOCK, borrowAmountAtomic: '5000000' });
    assert.equal(old.status, 403);
    assert.equal(old.body.code, 'region_restricted');
  });
});

describe('a repayment', () => {
  it('is asked nothing: from the United States, unconfirmed, it is reviewed as before', async () => {
    ip = USA;
    const intent = await request(app()).post('/api/route-intelligence/rwa/repay/intent')
      .send({ collateralTokenAddress: STOCK, amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '6000000', returnCollateral: true });
    assert.equal(intent.status, 200);
    const ready = await review(intent.body.reviewUrl.slice('/lending/'.length));
    assert.equal(ready.body.state, 'ready');
    assert.deepEqual(runs, ['repay']);
    const arm = await request(app()).post(`/api/route-intelligence/rwa/lending/executions/${ready.body.executionId}/arm`)
      .send({ callsHash: ready.body.callsHash, signingTermsHash: ready.body.signingTermsHash });
    assert.equal(arm.status, 200);
  });
});

describe('a Spend purchase', () => {
  const ORDER = { productId: 'bitrefill-esim-germany', packageValue: '10GB, 30 Days', email: 'buyer@example.com' };

  it('opens no invoice from the United States', async () => {
    ip = USA;
    const r = await request(app()).post('/api/still/spend/orders').send(ORDER);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'region_restricted');
    assert.equal(orders.get({ tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET }, INVOICE), null);
  });

  it('pays from the wallet only after this sign-in confirms', async () => {
    assert.equal((await request(app()).post('/api/still/spend/orders').send(ORDER)).status, 200);
    const first = await request(app()).post(`/api/still/spend/orders/${INVOICE}/wallet`).send({});
    assert.deepEqual([first.body.state, first.body.refusal], ['refused', 'eligibility_required']);
    assert.equal(walletRuns, 0);
    await confirm();
    const ready = await request(app()).post(`/api/still/spend/orders/${INVOICE}/wallet`).send({});
    assert.equal(ready.body.state, 'ready');
    assert.equal(walletRuns, 1);
    ip = USA;
    const arm = await request(app()).post(`/api/still/spend/orders/${INVOICE}/wallet/arm`).send({ callsHash: ready.body.callsHash, signingTermsHash: ready.body.signingTermsHash });
    assert.equal(arm.status, 403);
    assert.equal(arm.body.error, 'region_restricted');
  });
});
