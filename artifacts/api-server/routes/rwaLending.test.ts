import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import { STOCKS, ADDRESSES } from '@mioagent/still-engine/registry';
import { rwaLendingRouter, rwaLendingRuntimeV1 } from './rwaLending.js';
import { rwaBorrowRouter, rwaBorrowRuntimeV1 } from './rwaBorrow.js';
import { MemoryLoanExecutionStoreV1 } from '../lib/loanExecutionStore.js';
import { issueLendingDraftV1, type LendingQuestionV1 } from '../lib/lendingDraft.js';
import type { LendingRunV1 } from '../lib/lendingReview.js';

const wallet = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
const now = new Date('2026-10-29T03:00:00Z'), secret = 'lending-route-fixture-secret-never-production';
const token = STOCKS[5]!.token.toLowerCase();
const original = { ...rwaLendingRuntimeV1 }, originalBorrow = { ...rwaBorrowRuntimeV1 };
let store: MemoryLoanExecutionStoreV1, simulations: number;
function app(owner: string | null = wallet) {
  const a = express(); a.use(express.json());
  a.use((req, _res, next) => { if (owner) Object.defineProperty(req, 'session', { value: { user: { id: `eip155:8453:${owner}`, address: owner, chainId: 8453 } } }); next(); });
  a.use('/api/route-intelligence', rwaBorrowRouter, rwaLendingRouter); return a;
}
const base = '/api/route-intelligence/rwa';
function ready(question: LendingQuestionV1): Extract<LendingRunV1, { state: 'ready' }> {
  const calls: ExecutionCallV1[] = [{ index: 0, callType: 'other', to: ADDRESSES.aaveSpoke.toLowerCase() as `0x${string}`, valueWei: '0', data: '0x12345678', asset: null, amountAtomic: null, recipient: null, spender: null }];
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'11'.repeat(32)}`, expiresAt: new Date(now.getTime() + 30000).toISOString(), atomicRequired: true,
    steps: [{ index: 0, to: calls[0]!.to, reading: 'Synthetic fixture only' }], measured: { blockNumber: 53100000, provider: 'fixture', loanDeltaAssets: '-1000000' },
    facts: { operation: question.operation, venue: 'aave-v4', collateralTokenAddress: question.collateralTokenAddress, collateralSymbol: 'NVDAc', collateralDecimals: 8,
      marketId: ADDRESSES.aaveSpoke.toLowerCase(), amountMode: question.operation === 'borrow' ? 'assets' : question.amountMode,
      requestedAssets: question.operation === 'borrow' ? question.borrowAssets : question.repayAssets, maximumDebitAssets: question.operation === 'borrow' ? '0' : question.maximumAssets,
      collateralSupplyAssets: question.operation === 'borrow' ? question.collateralSupplyAssets : '0', debtBeforeAssets: '10000000', debtAfterAssets: '9000000',
      collateralBeforeAssets: '100000000', collateralAfterAssets: '100000000', debtBeforeShares: '10000000', debtAfterShares: '9000000', blockNumber: 53100000, warnings: [] } };
}
function draft(question: LendingQuestionV1) { return issueLendingDraftV1({ tenantId: `eip155:8453:${wallet}`, walletAddress: wallet, question, secret, now }).draft; }
const repayQuestion: LendingQuestionV1 = { operation: 'repay', collateralTokenAddress: token, amountMode: 'assets', repayAssets: '1000000', maximumAssets: '1000000' };
beforeEach(() => {
  store = new MemoryLoanExecutionStoreV1(); simulations = 0;
  Object.assign(rwaLendingRuntimeV1, { ...original, store: async () => store, secret: () => secret, now: () => now,
    runAave: async ({ question }: { question: LendingQuestionV1 }) => { simulations++; return ready(question); },
    readBatchHashes: async () => null, reader: () => ({ getTransaction: async () => null, getTransactionReceipt: async () => null }) });
  Object.assign(rwaBorrowRuntimeV1, { ...originalBorrow, secret: () => secret, now: () => now });
});
afterEach(() => { Object.assign(rwaLendingRuntimeV1, original); Object.assign(rwaBorrowRuntimeV1, originalBorrow); });
describe('session-owned lending HTTP boundary', () => {
  it('requires the exact session before reading or creating an intent', async () => {
    assert.equal((await request(app(null)).get(`${base}/repay/capacity?token=${token}`)).status, 401);
    assert.equal((await request(app(null)).post(`${base}/repay/intent`).send({})).status, 401);
    assert.equal(simulations, 0);
  });
  it('creates only a signed question and rejects hidden wallet/calls fields', async () => {
    const body = { collateralTokenAddress: token, amountMode: 'all', repayAmountAtomic: null, maximumUsdcAtomic: '3000000' };
    const r = await request(app()).post(`${base}/repay/intent`).send(body);
    assert.equal(r.status, 200); assert.match(r.body.reviewUrl, /^\/lending\/miorail-lending-v1\./); assert.equal(r.body.calls, undefined); assert.equal(simulations, 0);
    for (const extra of [{ walletAddress: other }, { calls: [] }, { price: '0.5' }, { venue: 'anywhere' }]) assert.equal((await request(app()).post(`${base}/repay/intent`).send({ ...body, ...extra })).status, 400);
  });
  it('binds exact partial or all repayment to an explicit positive budget', async () => {
    for (const patch of [{ maximumUsdcAtomic: '0' }, { repayAmountAtomic: '1.0' }, { maximumUsdcAtomic: '1' }, { amountMode: 'all' }]) {
      const r = await request(app()).post(`${base}/repay/intent`).send({ collateralTokenAddress: token, amountMode: 'assets', repayAmountAtomic: '1000000', maximumUsdcAtomic: '1000000', ...patch });
      assert.equal(r.status, 400);
    }
  });
  it('opens only the draft owner and carries no calls on refusal', async () => {
    const signed = draft(repayQuestion);
    assert.equal((await request(app(other)).get(`${base}/lending/review/${signed}`)).status, 403); assert.equal(simulations, 0);
    rwaLendingRuntimeV1.runAave = async () => ({ state: 'refused', refusal: 'aave_unread', detail: 'No reading was established.' });
    const r = await request(app()).get(`${base}/lending/review/${signed}`);
    assert.equal(r.body.state, 'refused'); assert.equal(r.body.calls, undefined); assert.equal(r.body.executionId, undefined);
  });
  it('persists an immutable attempt before the wallet and never treats a batch hint as success', async () => {
    const signed = draft(repayQuestion), read = await request(app()).get(`${base}/lending/review/${signed}`);
    assert.equal(read.status, 200); assert.equal(read.body.state, 'ready'); assert(read.body.executionId);
    const path = `${base}/lending/executions/${read.body.executionId}`;
    assert.equal((await request(app(other)).post(`${path}/arm`).send({ callsHash: read.body.callsHash, signingTermsHash: read.body.signingTermsHash })).status, 409);
    const armed = await request(app()).post(`${path}/arm`).send({ callsHash: read.body.callsHash, signingTermsHash: read.body.signingTermsHash }); assert.equal(armed.status, 200);
    assert.equal((await request(app()).post(`${path}/arm`).send({ callsHash: read.body.callsHash, signingTermsHash: read.body.signingTermsHash })).status, 409);
    const repeated = await request(app()).get(`${base}/lending/review/${signed}`); assert.equal(repeated.body.state, 'refused'); assert.equal(repeated.body.calls, undefined);
    const submitted = await request(app()).post(`${path}/submission`).send({ attemptId: armed.body.attemptId, outcome: 'submitted', batchId: 'fixture-batch' });
    assert.equal(submitted.body.state, 'submitted');
    const status = await request(app()).get(path); assert.equal(status.body.state, 'submitted'); assert.equal(status.body.verification, null);
    assert.equal((await request(app(other)).get(path)).status, 404);
  });
  it('does not accept status or a receipt supplied by the browser', async () => {
    const read = await request(app()).get(`${base}/lending/review/${draft(repayQuestion)}`), path = `${base}/lending/executions/${read.body.executionId}`;
    const arm = await request(app()).post(`${path}/arm`).send({ callsHash: read.body.callsHash, signingTermsHash: read.body.signingTermsHash });
    const r = await request(app()).post(`${path}/submission`).send({ attemptId: arm.body.attemptId, outcome: 'submitted', batchId: 'fixture', status: 'confirmed' }); assert.equal(r.status, 400);
    assert.equal((await request(app()).get(path)).body.state, 'awaiting_wallet');
  });
  it('stock borrowing entry creates the same owned review without a provider or wallet action', async () => {
    const r = await request(app()).post(`${base}/borrow/intent`).send({ collateralTokenAddress: token, borrowAmountAtomic: '3000000', collateralSupplyAtomic: '100000000' });
    assert.equal(r.status, 200); assert.match(r.body.reviewUrl, /^\/lending\/miorail-lending-v1\./); assert.equal(simulations, 0);
    assert.equal((await request(app()).get(`${base}/lending/review/${r.body.reviewUrl.split('/').at(-1)}`)).body.facts.operation, 'borrow');
  });
  it('native ETH borrowing entry creates a v2 draft and routes its review to the native Morpho runner', async () => {
    const weth = ADDRESSES.weth.toLowerCase();
    let nativeAsked: unknown = null;
    rwaLendingRuntimeV1.runNativeBorrow = async input => {
      nativeAsked = input;
      return ready({ operation: 'borrow', collateralTokenAddress: weth, borrowAssets: input.borrowAssets.toString(),
        collateralSupplyAssets: input.supplyAssets.toString(), nativeFundingAssets: input.supplyAssets.toString() });
    };
    const r = await request(app()).post(`${base}/borrow/intent`)
      .send({ collateralTokenAddress: weth, borrowAmountAtomic: '3000000', collateralSupplyAtomic: '10000000000000000', nativeFundingAtomic: '10000000000000000' });
    assert.equal(r.status, 200); assert.match(r.body.reviewUrl, /^\/lending\/miorail-lending-v2\./);
    const rev = await request(app()).get(`${base}/lending/review/${r.body.reviewUrl.split('/').at(-1)}`);
    assert.equal(rev.status, 200); assert.equal(rev.body.state, 'ready');
    assert.deepEqual(nativeAsked, { walletAddress: wallet, supplyAssets: 10_000_000_000_000_000n, borrowAssets: 3_000_000n });
  });
  it('an expired question permits only an owned existing submission read, never another preparation', async () => {
    const signed = draft(repayQuestion), read = await request(app()).get(`${base}/lending/review/${signed}`);
    await request(app()).post(`${base}/lending/executions/${read.body.executionId}/arm`).send({ callsHash: read.body.callsHash, signingTermsHash: read.body.signingTermsHash }).expect(200);
    const before = simulations;
    rwaLendingRuntimeV1.now = () => new Date(now.getTime() + 600000);
    const expired = await request(app()).get(`${base}/lending/review/${signed}`);
    assert.equal(expired.body.state, 'refused'); assert.equal(expired.body.executionState, 'awaiting_wallet'); assert.equal(expired.body.calls, undefined);
    assert.equal(expired.body.executionId, read.body.executionId); assert.equal(simulations, before);
    assert.equal((await request(app(other)).get(`${base}/lending/review/${signed}`)).status, 403);
  });
  it('a changed balance or unavailable provider cannot hide an existing submission behind a new preparation', async () => {
    const signed = draft(repayQuestion), read = await request(app()).get(`${base}/lending/review/${signed}`);
    await request(app()).post(`${base}/lending/executions/${read.body.executionId}/arm`).send({ callsHash: read.body.callsHash, signingTermsHash: read.body.signingTermsHash }).expect(200);
    const before = simulations;
    rwaLendingRuntimeV1.runAave = async () => { throw new Error('an existing attempt must be readable without another simulation'); };
    const repeated = await request(app()).get(`${base}/lending/review/${signed}`);
    assert.equal(repeated.body.executionState, 'awaiting_wallet'); assert.equal(repeated.body.executionId, read.body.executionId);
    assert.equal(repeated.body.calls, undefined); assert.equal(simulations, before);
  });
  it('a manual transaction hash stays an unverified hint until the ordinary chain verifier matches it', async () => {
    const read = await request(app()).get(`${base}/lending/review/${draft(repayQuestion)}`), path = `${base}/lending/executions/${read.body.executionId}`;
    await request(app()).post(`${path}/arm`).send({ callsHash: read.body.callsHash, signingTermsHash: read.body.signingTermsHash }).expect(200);
    const hint = `0x${'55'.repeat(32)}`;
    await request(app(other)).post(`${path}/transaction`).send({ transactionHash: hint }).expect(409);
    const saved = await request(app()).post(`${path}/transaction`).send({ transactionHash: hint });
    assert.equal(saved.body.state, 'unknown'); assert.equal(saved.body.transactionHash, hint);
    const checked = await request(app()).get(path); assert.equal(checked.body.state, 'unknown'); assert.equal(checked.body.verification, null);
    assert.equal(simulations, 1);
  });
  it('rejects malformed execution and attempt identifiers before reaching PostgreSQL', async () => {
    rwaLendingRuntimeV1.store = async () => { throw new Error('malformed identifier must not reach the store'); };
    await request(app()).get(`${base}/lending/executions/not-a-uuid`).expect(400);
    await request(app()).post(`${base}/lending/executions/not-a-uuid/arm`).send({ callsHash: `0x${'11'.repeat(32)}`, signingTermsHash: `0x${'22'.repeat(32)}` }).expect(400);
  });
});
