import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { hashApprovedCallsV1, type ExecutionCallV1, type HashV1 } from '@mioagent/route-domain';
import type { VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import type { BitrefillGuestCheckoutV1, SpendInvoiceStatusNameV1 } from '@mioagent/commerce-engine';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';

import type { BaseTransactionSourceV1 } from '../lib/baseReceiptReader.js';
import type { LendingQuestionV1 } from '../lib/lendingDraft.js';
import type { LendingRunV1 } from '../lib/lendingReview.js';
import { MemoryLoanExecutionStoreV1 } from '../lib/loanExecutionStore.js';
import type { LendingPaymentV1 } from '../lib/lendingDraft.js';
import { createSpendOrderStoreV1 } from '../lib/stillSpendOrders.js';
import { sequentialHashesV1 } from '../lib/lendingSteps.js';
import { rwaBorrowRouter, rwaBorrowRuntimeV1 } from './rwaBorrow.js';
import { rwaLendingRouter, rwaLendingRuntimeV1 } from './rwaLending.js';

// A stock loan from a wallet without batches, at the HTTP boundary: the review
// grants steps, each landed step is read from the chain, and the review runs
// again before the next one. Every chain answer here is synthetic.
const WALLET = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-11-01T12:00:00Z'), SECRET = 'steps-route-fixture-secret-never-production';
const STOCK = STOCKS[0]!.token.toLowerCase() as `0x${string}`, SPOKE = ADDRESSES.aaveSpoke.toLowerCase() as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as HashV1;
const APPROVE: ExecutionCallV1 = { index: 0, callType: 'approval', to: STOCK, valueWei: '0', data: '0x095ea7b3aa', asset: null, amountAtomic: '1000000', recipient: null, spender: SPOKE };
const SUPPLY: ExecutionCallV1 = { index: 1, callType: 'deposit', to: SPOKE, valueWei: '0', data: '0x12345601', asset: null, amountAtomic: '1000000', recipient: null, spender: null };
const BORROW: ExecutionCallV1 = { index: 2, callType: 'other', to: SPOKE, valueWei: '0', data: '0x12345602', asset: null, amountAtomic: '180000', recipient: null, spender: null };

const originals = { borrow: { ...rwaBorrowRuntimeV1 }, lending: { ...rwaLendingRuntimeV1 } };
let store: MemoryLoanExecutionStoreV1, chain: { allowance: boolean; supplied: boolean; overLimit: boolean };
let asked: Array<{ question: LendingQuestionV1; delivery?: string }>, sent: Map<string, { tx: BaseTransactionSourceV1; receipt: VerifiedReceiptSourceV1 }>;

/** The runner as the chain stands: in steps, what already landed is not asked again. */
function review(input: { question: LendingQuestionV1; delivery?: 'atomic' | 'sequential' }): LendingRunV1 {
  asked.push({ question: input.question, ...(input.delivery ? { delivery: input.delivery } : {}) });
  if (chain.overLimit) return { state: 'refused', refusal: 'aave_over_still_limit', detail: 'The requested loan exceeds the measured Still allowance.' };
  const q = input.question, sequential = input.delivery === 'sequential';
  if (q.operation !== 'borrow') throw new Error('borrow only');
  const supply = q.collateralSupplyAssets !== '0';
  const planned = sequential ? [...(supply && !chain.allowance ? [APPROVE] : []), ...(supply ? [SUPPLY] : []), BORROW] : [APPROVE, SUPPLY, BORROW, APPROVE];
  const calls = planned.map((call, index) => ({ ...call, index }));
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${(sequential ? '22' : '11').repeat(32)}`,
    expiresAt: new Date(NOW.getTime() + 30_000).toISOString(), ...(sequential ? { atomicRequired: false as const, delivery: 'sequential' as const } : { atomicRequired: true as const }),
    steps: calls.map(call => ({ index: call.index, to: call.to, reading: 'Synthetic fixture only' })), measured: { blockNumber: 53_000_000, provider: 'fixture', loanDeltaAssets: '180000' },
    facts: { operation: 'borrow', venue: 'aave-v4', collateralTokenAddress: q.collateralTokenAddress, collateralSymbol: 'AAPLc', collateralDecimals: 18, marketId: SPOKE,
      amountMode: 'assets', requestedAssets: q.borrowAssets, maximumDebitAssets: '0', collateralSupplyAssets: q.collateralSupplyAssets, debtBeforeAssets: '0', debtAfterAssets: q.borrowAssets,
      collateralBeforeAssets: '0', collateralAfterAssets: '0', debtBeforeShares: '0', debtAfterShares: '1', blockNumber: 53_000_000, warnings: [] } };
}

/** The wallet sends call `call` as transaction `n`, and it lands. */
function land(n: number, call: ExecutionCallV1, patch: Partial<BaseTransactionSourceV1> = {}) {
  sent.set(hash(n), { tx: { from: WALLET, to: call.to, value: 0n, input: call.data, ...patch },
    receipt: { transactionHash: hash(n), status: 'success', blockNumber: 53_000_010n + BigInt(n), gasUsed: 1n, effectiveGasPriceWei: 1n, logs: [], from: WALLET } });
  if (call === APPROVE) chain.allowance = true;
  if (call === SUPPLY) { chain.supplied = true; chain.allowance = false; }
}

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    Object.defineProperty(req, 'session', { value: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } } });
    next();
  });
  a.use('/api/route-intelligence', rwaBorrowRouter, rwaLendingRouter);
  return a;
}

beforeEach(() => {
  store = new MemoryLoanExecutionStoreV1(); chain = { allowance: false, supplied: false, overLimit: false }; asked = []; sent = new Map();
  Object.assign(rwaBorrowRuntimeV1, { ...originals.borrow, secret: () => SECRET, now: () => NOW });
  Object.assign(rwaLendingRuntimeV1, { ...originals.lending, store: async () => store, secret: () => SECRET, now: () => NOW, stepReadDelayMs: 0,
    runAave: async (input: { question: LendingQuestionV1; delivery?: 'atomic' | 'sequential' }) => review(input),
    reader: () => ({
      async getTransactionReceipt(h: HashV1) { return sent.get(h)?.receipt ?? null; },
      async getTransaction(h: HashV1) { return sent.get(h)?.tx ?? null; },
    }) });
});
afterEach(() => {
  Object.assign(rwaBorrowRuntimeV1, originals.borrow);
  Object.assign(rwaLendingRuntimeV1, originals.lending);
});

async function draft(collateralTokenAddress: string = STOCK, supply = '1000000') {
  const r = await request(app()).post('/api/route-intelligence/rwa/borrow/intent')
    .send({ collateralTokenAddress, borrowAmountAtomic: '180000', collateralSupplyAtomic: supply });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return String(r.body.reviewUrl).slice('/lending/'.length);
}
const steps = (id: string, body: Record<string, unknown>) => request(app()).post(`/api/route-intelligence/rwa/lending/executions/${id}/steps`).send(body);

describe('a review grants steps only to an Aave V4 loan, and says so', () => {
  it('asks the runner for steps and hands back a review that is not atomic', async () => {
    const link = await draft();
    const r = await request(app()).get(`/api/route-intelligence/rwa/lending/review/${link}`).query({ delivery: 'sequential' });
    assert.equal(r.body.state, 'ready');
    assert.deepEqual([r.body.atomicRequired, r.body.delivery, r.body.calls.length], [false, 'sequential', 3]);
    assert.equal(asked[0]!.delivery, 'sequential');
    // Without the query, the same link is one batch, as before.
    const batch = await request(app()).get(`/api/route-intelligence/rwa/lending/review/${link}`);
    assert.deepEqual([batch.body.atomicRequired, batch.body.delivery, batch.body.calls.length], [true, undefined, 4]);
  });
  it('refuses steps for a crypto loan, which goes only as one transaction for now', async () => {
    const link = await draft(CRYPTO[0]!.token, '0');
    const r = await request(app()).get(`/api/route-intelligence/rwa/lending/review/${link}`).query({ delivery: 'sequential' });
    assert.deepEqual([r.body.state, r.body.refusal], ['refused', 'lending_steps_unavailable']);
    assert.match(r.body.detail, /Nothing was sent/);
    assert.equal(asked.length, 0);
  });
});

describe('each step is read from the chain, and the review runs again before the next', () => {
  async function start() {
    const link = await draft();
    const ready = (await request(app()).get(`/api/route-intelligence/rwa/lending/review/${link}`).query({ delivery: 'sequential' })).body;
    const armed = await request(app()).post(`/api/route-intelligence/rwa/lending/executions/${ready.executionId}/arm`)
      .send({ callsHash: ready.callsHash, signingTermsHash: ready.signingTermsHash });
    assert.equal(armed.status, 200);
    return { id: ready.executionId as string, attemptId: armed.body.attemptId as string };
  }

  it('goes on step by step while the fresh review asks exactly what is left, and submits after the last', async () => {
    const { id, attemptId } = await start();
    land(1, APPROVE);
    const first = (await steps(id, { attemptId, index: 0, transactionHash: hash(1) })).body;
    assert.deepEqual([first.state, first.index, sequentialHashesV1(first.batchId)], ['next', 1, [hash(1)]]);
    land(2, SUPPLY);
    const second = (await steps(id, { attemptId, index: 1, transactionHash: hash(2) })).body;
    assert.deepEqual([second.state, second.index, sequentialHashesV1(second.batchId)], ['next', 2, [hash(1), hash(2)]]);
    // After the supply landed, the fresh review asked the loan without a new pledge.
    const lastAsked = asked.at(-1)!.question;
    assert.equal(lastAsked.operation === 'borrow' ? lastAsked.collateralSupplyAssets : null, '0');
    land(3, BORROW);
    const last = await steps(id, { attemptId, index: 2, transactionHash: hash(3) });
    assert.equal(last.body.state, 'submitted');
    assert.deepEqual(sequentialHashesV1(last.body.batchId), [hash(1), hash(2), hash(3)]);
    assert.equal((await store.get({ owner: { tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET }, executionId: id }))!.state, 'submitted');
  });

  it('stops when the review again refuses, and keeps what landed for the chain read', async () => {
    const { id, attemptId } = await start();
    land(1, APPROVE);
    chain.overLimit = true;
    const stopped = await steps(id, { attemptId, index: 0, transactionHash: hash(1) });
    assert.deepEqual([stopped.body.state, stopped.body.refusal], ['stopped', 'aave_over_still_limit']);
    const record = await store.get({ owner: { tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET }, executionId: id });
    assert.deepEqual([record!.state, sequentialHashesV1(record!.batchId!)], ['submitted', [hash(1)]]);
  });

  it('refuses a transaction that is not this step’s call, a step out of order, and a stale attempt', async () => {
    const { id, attemptId } = await start();
    land(1, SUPPLY);
    assert.deepEqual((await steps(id, { attemptId, index: 0, transactionHash: hash(1) })).body, { error: 'loan_step_not_matched' });
    land(2, APPROVE);
    assert.equal((await steps(id, { attemptId, index: 1, transactionHash: hash(2) })).status, 409);
    assert.equal((await steps(id, { attemptId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', index: 0, transactionHash: hash(2) })).body.error, 'lending_attempt_changed');
    // A hash the chain does not know yet is no step.
    assert.equal((await steps(id, { attemptId, index: 0, transactionHash: hash(9) })).body.error, 'lending_step_unread');
  });

  it('a step that failed onchain stops the rest', async () => {
    const { id, attemptId } = await start();
    land(1, APPROVE);
    sent.get(hash(1))!.receipt.status = 'reverted';
    const r = await steps(id, { attemptId, index: 0, transactionHash: hash(1) });
    assert.deepEqual([r.body.state, r.body.refusal], ['stopped', 'loan_step_reverted']);
  });
});

describe('a Spend loan goes in steps too, and pays Bitrefill last, only while the invoice waits', () => {
  const ORDER_ID = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34';
  const PAY_TO = '0x3333333333333333333333333333333333333333' as `0x${string}`;
  const TRANSFER: ExecutionCallV1 = { index: 3, callType: 'transfer', to: ADDRESSES.usdc.toLowerCase() as `0x${string}`, valueWei: '0', data: '0xa9059cbb33',
    asset: null, amountAtomic: '180000', recipient: PAY_TO, spender: null };
  let invoiceStatus: SpendInvoiceStatusNameV1, reads: number;

  beforeEach(() => {
    invoiceStatus = 'unpaid'; reads = 0;
    const orders = createSpendOrderStoreV1({ now: () => NOW });
    orders.put({ orderId: ORDER_ID, tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET, productId: 'bitrefill-esim-germany', productName: 'Bitrefill eSIM Germany',
      packageValue: '1GB, 7 Days', faceCurrency: 'USD', priceAtomic: '180000', payTo: PAY_TO, refillTo: null, createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(), accessToken: 'access-token-0123456789', paymentLink: null });
    const checkout = (): BitrefillGuestCheckoutV1 => ({
      async createInvoice() { throw new Error('no invoice is opened here'); },
      async readInvoice() { reads++; return { ok: true, value: { status: invoiceStatus, accessLink: null, esimInstallLink: null } }; },
    });
    Object.assign(rwaBorrowRuntimeV1, { spendOrders: orders, spendEnabled: () => true });
    Object.assign(rwaLendingRuntimeV1, { spendOrders: orders, spendEnabled: () => true, spendCheckout: checkout,
      // The payment, appended as the real one does: last, and keeping the loan's delivery.
      attachPayment: async ({ run, payment }: { run: LendingRunV1; payment: LendingPaymentV1 }) => {
        if (run.state !== 'ready') return run;
        const calls = [...run.calls, { ...TRANSFER, index: run.calls.length }];
        return { ...run, calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'33'.repeat(32)}`, facts: { ...run.facts, payment },
          steps: [...run.steps, { index: run.calls.length, to: TRANSFER.to, reading: 'Pay Bitrefill' }] };
      } });
  });

  async function start() {
    const r = await request(app()).post('/api/route-intelligence/rwa/borrow/intent')
      .send({ collateralTokenAddress: STOCK, borrowAmountAtomic: '180000', collateralSupplyAtomic: '1000000', spendOrderId: ORDER_ID });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ready = (await request(app()).get(`/api/route-intelligence/rwa/lending/review/${String(r.body.reviewUrl).slice('/lending/'.length)}`).query({ delivery: 'sequential' })).body;
    assert.equal(ready.state, 'ready', JSON.stringify(ready));
    assert.deepEqual([ready.atomicRequired, ready.delivery, ready.calls.length, ready.facts.payment.payTo], [false, 'sequential', 4, PAY_TO]);
    const armed = await request(app()).post(`/api/route-intelligence/rwa/lending/executions/${ready.executionId}/arm`)
      .send({ callsHash: ready.callsHash, signingTermsHash: ready.signingTermsHash });
    assert.equal(armed.status, 200);
    return { id: ready.executionId as string, attemptId: armed.body.attemptId as string };
  }

  it('reviews the loan steps with the payment attached, reads the invoice before paying, and submits after the payment', async () => {
    const { id, attemptId } = await start();
    land(1, APPROVE);
    assert.equal((await steps(id, { attemptId, index: 0, transactionHash: hash(1) })).body.state, 'next');
    land(2, SUPPLY);
    assert.equal((await steps(id, { attemptId, index: 1, transactionHash: hash(2) })).body.state, 'next');
    const readsBefore = reads;
    land(3, BORROW);
    const pay = (await steps(id, { attemptId, index: 2, transactionHash: hash(3) })).body;
    assert.deepEqual([pay.state, pay.index], ['next', 3]);
    // Before the payment only the invoice is read: a fresh review would have borrowed again.
    assert.equal(reads, readsBefore + 1);
    assert.equal(asked.length, 3);
    land(4, TRANSFER);
    const done = (await steps(id, { attemptId, index: 3, transactionHash: hash(4) })).body;
    assert.equal(done.state, 'submitted');
    assert.deepEqual(sequentialHashesV1(done.batchId), [hash(1), hash(2), hash(3), hash(4)]);
  });

  it('does not pay an invoice Bitrefill no longer waits for, and keeps the loan that landed', async () => {
    const { id, attemptId } = await start();
    land(1, APPROVE); await steps(id, { attemptId, index: 0, transactionHash: hash(1) });
    land(2, SUPPLY); await steps(id, { attemptId, index: 1, transactionHash: hash(2) });
    invoiceStatus = 'denied';
    land(3, BORROW);
    const stopped = (await steps(id, { attemptId, index: 2, transactionHash: hash(3) })).body;
    assert.deepEqual([stopped.state, stopped.refusal], ['stopped', 'spend_invoice_not_unpaid']);
    assert.match(stopped.detail, /^Bitrefill reports this invoice as denied, so the payment was not sent\.$/);
    const record = await store.get({ owner: { tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET }, executionId: id });
    assert.deepEqual([record!.state, sequentialHashesV1(record!.batchId!)], ['submitted', [hash(1), hash(2), hash(3)]]);
  });

  it('takes no loan for an invoice that stopped waiting before the borrow', async () => {
    const { id, attemptId } = await start();
    land(1, APPROVE);
    invoiceStatus = 'payment_detected';
    const stopped = (await steps(id, { attemptId, index: 0, transactionHash: hash(1) })).body;
    assert.deepEqual([stopped.state, stopped.refusal, stopped.detail], ['stopped', 'spend_invoice_not_unpaid', 'Bitrefill reports this invoice as payment detected, so nothing more was sent.']);
  });

  it('still refuses steps for a payment from a crypto loan', async () => {
    const r = await request(app()).post('/api/route-intelligence/rwa/borrow/intent')
      .send({ collateralTokenAddress: CRYPTO[0]!.token, borrowAmountAtomic: '180000', collateralSupplyAtomic: '0', spendOrderId: ORDER_ID });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const refused = (await request(app()).get(`/api/route-intelligence/rwa/lending/review/${String(r.body.reviewUrl).slice('/lending/'.length)}`).query({ delivery: 'sequential' })).body;
    assert.deepEqual([refused.state, refused.refusal], ['refused', 'lending_steps_unavailable']);
    assert.match(refused.detail, /Choose a stock/);
  });
});
