import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashApprovedCallsV1, type ExecutionCallV1, type HashV1 } from '@mioagent/route-domain';
import type { VerifiedReceiptLogV1, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';
import type { BaseTransactionSourceV1 } from './baseReceiptReader.js';
import type { LendingQuestionV1 } from './lendingDraft.js';
import type { LendingRunV1 } from './lendingReview.js';
import type { LoanExecutionStatusDepsV1 } from './loanExecutionStatus.js';
import { MemoryLoanExecutionStoreV1, type LoanExecutionV1 } from './loanExecutionStore.js';
import { bindLoanStepV1, recheckLoanStepsV1, refreshSequentialLoanExecutionV1, remainingQuestionV1, sequentialBatchIdV1, sequentialHashesV1 } from './lendingSteps.js';
import { loanReadyFixture, LOAN_OWNER_FIXTURE as OWNER, LOAN_WALLET_FIXTURE as WALLET, LOAN_NOW_FIXTURE as NOW } from './loanExecutionTestFixtures.js';

// A stock loan in steps, made up for these tests: approve, supply, borrow.
// No wallet, network or protocol is touched.
const STOCK = STOCKS[0]!.token.toLowerCase() as `0x${string}`;
const SPOKE = ADDRESSES.aaveSpoke.toLowerCase() as `0x${string}`;
const CALLS: ExecutionCallV1[] = [
  { index: 0, callType: 'approval', to: STOCK, valueWei: '0', data: '0x095ea7b3aa', asset: null, amountAtomic: '1000000', recipient: null, spender: SPOKE },
  { index: 1, callType: 'deposit', to: SPOKE, valueWei: '0', data: '0x12345601', asset: null, amountAtomic: '1000000', recipient: null, spender: null },
  { index: 2, callType: 'other', to: SPOKE, valueWei: '0', data: '0x12345602', asset: null, amountAtomic: '180000', recipient: null, spender: null },
];
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as HashV1;
// Rabby appends Still's ERC-8021 suffix to each step's calldata.
const SUFFIX = `${Buffer.from('bc_z2uuo4dt').toString('hex')}0b0080218021802180218021802180218021`;

function sequentialRun(): Extract<LendingRunV1, { state: 'ready' }> {
  const base = loanReadyFixture();
  return { ...base, atomicRequired: false, delivery: 'sequential', calls: CALLS, callsHash: hashApprovedCallsV1(CALLS),
    facts: { ...base.facts, operation: 'borrow', venue: 'aave-v4', collateralTokenAddress: STOCK, marketId: SPOKE, amountMode: 'assets',
      requestedAssets: '180000', maximumDebitAssets: '0', collateralSupplyAssets: '1000000', blockNumber: 53_000_000 } };
}
function tx(index: number, patch: Partial<BaseTransactionSourceV1> = {}): BaseTransactionSourceV1 {
  return { from: WALLET, to: CALLS[index]!.to, value: 0n, input: `${CALLS[index]!.data}${SUFFIX}`, ...patch };
}
function receipt(n: number, patch: Partial<VerifiedReceiptSourceV1> = {}, logs: VerifiedReceiptLogV1[] = []): VerifiedReceiptSourceV1 {
  return { transactionHash: hash(n), status: 'success', blockNumber: 53_000_010n + BigInt(n), gasUsed: 50_000n, effectiveGasPriceWei: 1n, logs, from: WALLET, ...patch };
}
async function armed(): Promise<{ store: MemoryLoanExecutionStoreV1; record: LoanExecutionV1; attemptId: string }> {
  const store = new MemoryLoanExecutionStoreV1();
  const ready = await store.putReady({ owner: OWNER, draftId: 'draft-steps', run: sequentialRun(), now: NOW });
  const arm = await store.arm({ owner: OWNER, executionId: ready.executionId, callsHash: ready.run.callsHash, signingTermsHash: ready.run.signingTermsHash, now: NOW });
  assert.ok(arm.ok);
  return { store, record: arm.ok ? arm.execution : ready, attemptId: arm.ok ? arm.attemptId : '' };
}

describe('the hashes of a loan in steps travel as one viem fallback batch id', () => {
  it('round-trips on Base and refuses any other chain or shape', () => {
    const id = sequentialBatchIdV1([hash(1), hash(2)]);
    assert.deepEqual(sequentialHashesV1(id), [hash(1), hash(2)]);
    assert.equal(sequentialHashesV1(sequentialBatchIdV1([hash(1)], 1)), null);
    assert.equal(sequentialHashesV1(`0x${'ab'.repeat(32)}`), null);
    assert.equal(sequentialHashesV1('not-hex'), null);
  });
});

describe('a step binds only to the wallet’s own transaction carrying exactly its approved call', () => {
  it('matches the exact call with Still’s suffix, and fails a reverted one', async () => {
    const { record } = await armed();
    assert.deepEqual(bindLoanStepV1({ execution: record, index: 1, transaction: tx(1), receipt: receipt(1) }), { state: 'matched' });
    assert.deepEqual(bindLoanStepV1({ execution: record, index: 1, transaction: tx(1), receipt: receipt(1, { status: 'reverted' }) }), { state: 'failed', errorCode: 'loan_step_reverted' });
  });
  it('refuses another sender, target, value, calldata, step, or a transaction older than the review', async () => {
    const { record } = await armed();
    for (const [transaction, index] of [
      [tx(1, { from: `0x${'2'.repeat(40)}` }), 1], [tx(1, { to: STOCK }), 1], [tx(1, { value: 1n }), 1],
      [tx(1, { input: '0x12345699' }), 1], [tx(1), 2],
    ] as const) assert.equal(bindLoanStepV1({ execution: record, index, transaction, receipt: receipt(1) }).state, 'unknown');
    assert.deepEqual(bindLoanStepV1({ execution: record, index: 1, transaction: tx(1), receipt: receipt(1, { blockNumber: 52_999_999n }) }),
      { state: 'unknown', errorCode: 'loan_step_predates_review' });
    assert.equal(bindLoanStepV1({ execution: record, index: 3, transaction: tx(1), receipt: receipt(1) }).state, 'unknown');
  });
});

describe('before each next step, the review runs again and must ask exactly what is left', () => {
  it('asks the loan less a pledge already supplied', async () => {
    const { record } = await armed();
    assert.deepEqual(remainingQuestionV1(record, 1), { operation: 'borrow', collateralTokenAddress: STOCK, borrowAssets: '180000', collateralSupplyAssets: '1000000' });
    assert.deepEqual(remainingQuestionV1(record, 2), { operation: 'borrow', collateralTokenAddress: STOCK, borrowAssets: '180000', collateralSupplyAssets: '0' });
  });
  it('goes on only when the fresh calls equal the remaining approved ones', async () => {
    const { record } = await armed();
    const asked: LendingQuestionV1[] = [];
    const answer = (calls: ExecutionCallV1[]): LendingRunV1 => ({ ...sequentialRun(), calls: calls.map((call, index) => ({ ...call, index })) });
    const same = await recheckLoanStepsV1({ record, landed: 1, review: async (question) => { asked.push(question); return answer(CALLS.slice(1)); } });
    assert.deepEqual(same, { ok: true });
    assert.equal(asked.length, 1);
    const changed = await recheckLoanStepsV1({ record, landed: 1, review: async () => answer([CALLS[1]!, { ...CALLS[2]!, data: '0x12345603' }]) });
    assert.equal(!changed.ok && changed.refusal, 'lending_steps_changed');
    const refused = await recheckLoanStepsV1({ record, landed: 2, review: async () => ({ state: 'refused', refusal: 'aave_over_still_limit', detail: 'Over the limit.' }) });
    assert.deepEqual(refused, { ok: false, refusal: 'aave_over_still_limit', detail: 'Over the limit.' });
  });
});

describe('a loan in steps is confirmed from the chain only when every step landed and the effects agree', () => {
  function deps(store: MemoryLoanExecutionStoreV1, receipts: Map<string, VerifiedReceiptSourceV1>, seen: { logs?: readonly VerifiedReceiptLogV1[]; block?: bigint }): LoanExecutionStatusDepsV1 {
    return {
      store, now: () => NOW, readBatchHashes: async () => null,
      reader: {
        async getTransactionReceipt(h) { return receipts.get(h) ?? null; },
        async getTransaction(h) { const n = Number(BigInt(h)); return n >= 1 && n <= 3 ? tx(n - 1) : null; },
      } as LoanExecutionStatusDepsV1['reader'],
      verifyEffectPosition: async ({ logs, receipt: last }) => { seen.logs = logs; seen.block = last.blockNumber; return { state: 'matched', proof: { operation: 'borrow' } }; },
    };
  }
  const log = (n: number): VerifiedReceiptLogV1 => ({ address: SPOKE, topics: [hash(100 + n)], data: '0x' });

  it('reads every step in order and judges the effects of all of them together', async () => {
    const { store, record, attemptId } = await armed();
    for (const index of [0, 1, 2]) assert.ok(await store.recordStep({ owner: OWNER, executionId: record.executionId, attemptId, index, transactionHash: hash(index + 1), now: NOW }));
    const receipts = new Map([1, 2, 3].map((n) => [hash(n), receipt(n, {}, [log(n)])] as const));
    const seen: { logs?: readonly VerifiedReceiptLogV1[]; block?: bigint } = {};
    const current = (await store.get({ owner: OWNER, executionId: record.executionId }))!;
    assert.equal(current.state, 'submitted');
    const confirmed = await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: record.executionId }, current, deps(store, receipts, seen));
    assert.equal(confirmed.state, 'confirmed');
    assert.equal(confirmed.transactionHash, hash(3));
    assert.deepEqual(seen.logs, [log(1), log(2), log(3)]);
    assert.equal(seen.block, 53_000_013n);
    assert.deepEqual((confirmed.verification as { steps: string[] }).steps, [hash(1), hash(2), hash(3)]);
  });

  it('says a stopped sequence landed part way, and a reverted step failed; steps still being sent are not judged', async () => {
    const { store, record, attemptId } = await armed();
    assert.ok(await store.recordStep({ owner: OWNER, executionId: record.executionId, attemptId, index: 0, transactionHash: hash(1), now: NOW }));
    const sending = (await store.get({ owner: OWNER, executionId: record.executionId }))!;
    assert.equal(sending.state, 'awaiting_wallet');
    const receipts = new Map([1, 2, 3].map((n) => [hash(n), receipt(n)] as const));
    assert.equal((await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: record.executionId }, sending, deps(store, receipts, {}))).state, 'awaiting_wallet');
    assert.ok(await store.recordStep({ owner: OWNER, executionId: record.executionId, attemptId, index: 1, transactionHash: hash(2), stop: true, now: NOW }));
    const stopped = (await store.get({ owner: OWNER, executionId: record.executionId }))!;
    const partial = await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: record.executionId }, stopped, deps(store, receipts, {}));
    assert.deepEqual([partial.state, partial.errorCode, (partial.verification as { stepsLanded: number }).stepsLanded], ['unknown', 'loan_steps_incomplete', 2]);

    const second = await armed();
    for (const index of [0, 1]) await second.store.recordStep({ owner: OWNER, executionId: second.record.executionId, attemptId: second.attemptId, index, transactionHash: hash(index + 1), stop: index === 1, now: NOW });
    receipts.set(hash(2), receipt(2, { status: 'reverted' }));
    const reverted = await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: second.record.executionId },
      (await second.store.get({ owner: OWNER, executionId: second.record.executionId }))!, deps(second.store, receipts, {}));
    assert.deepEqual([reverted.state, reverted.errorCode, (reverted.verification as { failedStep: number }).failedStep], ['failed', 'loan_step_reverted', 1]);
  });

  it('records each step once, in order, for its own attempt only', async () => {
    const { store, record, attemptId } = await armed();
    const step = (index: number, n: number, attempt = attemptId) => store.recordStep({ owner: OWNER, executionId: record.executionId, attemptId: attempt, index, transactionHash: hash(n), now: NOW });
    assert.equal(await step(1, 2), null);
    assert.ok(await step(0, 1));
    assert.equal(await step(0, 1), null);
    assert.equal(await step(1, 1), null);
    assert.equal(await step(1, 2, 'another-attempt'), null);
    const second = await step(1, 2);
    assert.deepEqual(sequentialHashesV1(second!.batchId!), [hash(1), hash(2)]);
  });

  it('keeps steps to Aave V4 without native ETH or a payment, and a batch a batch', async () => {
    const store = new MemoryLoanExecutionStoreV1();
    const run = sequentialRun();
    await assert.rejects(store.putReady({ owner: OWNER, draftId: 'morpho', run: { ...run, facts: { ...run.facts, venue: 'morpho' } }, now: NOW }));
    await assert.rejects(store.putReady({ owner: OWNER, draftId: 'paying', now: NOW, run: { ...run, facts: { ...run.facts, payment: {
      merchant: 'bitrefill', orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: `0x${'3'.repeat(40)}`, assets: '180000', productName: 'x', packageValue: '1', faceCurrency: null,
      expiresAt: '2026-10-29T03:45:00.000Z' } } } }));
    await assert.rejects(store.putReady({ owner: OWNER, draftId: 'mixed', now: NOW, run: { ...run, atomicRequired: true } as unknown as typeof run }));
    // A batch run never takes a step.
    const batch = await store.putReady({ owner: OWNER, draftId: 'batch', run: loanReadyFixture(), now: NOW });
    const arm = await store.arm({ owner: OWNER, executionId: batch.executionId, callsHash: batch.run.callsHash, signingTermsHash: batch.run.signingTermsHash, now: NOW });
    assert.ok(arm.ok);
    assert.equal(arm.ok && await store.recordStep({ owner: OWNER, executionId: batch.executionId, attemptId: arm.attemptId, index: 0, transactionHash: hash(1), now: NOW }), null);
  });
});
