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
import { bindLoanStepV1, loanStepsStandingV1, nextStoppedStepLandedV1, recheckLoanStepsV1, refreshSequentialLoanExecutionV1, remainingQuestionV1, sequentialBatchIdV1,
  sequentialHashesV1, stopSequentialLoanExecutionV1 } from './lendingSteps.js';
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
  it('asks a repayment that takes the stock back the same again: once repaid, its fresh review is the withdrawal alone', async () => {
    const { record } = await armed();
    Object.assign(record.run.facts, { operation: 'repay', amountMode: 'all', requestedAssets: null, maximumDebitAssets: '2000000', collateralReturnAssets: '1000000' });
    assert.deepEqual(remainingQuestionV1(record, 2), { operation: 'repay', collateralTokenAddress: STOCK, amountMode: 'all', repayAssets: null, maximumAssets: '2000000', returnCollateral: true });
    delete record.run.facts.collateralReturnAssets;
    assert.equal('returnCollateral' in remainingQuestionV1(record, 2), false);
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
    // Stopped on purpose: what landed is final, and nothing holds the market any longer.
    const partial = await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: record.executionId }, stopped, deps(store, receipts, {}));
    assert.deepEqual([partial.state, partial.errorCode, (partial.verification as { stepsLanded: number; stoppedAt: number }).stepsLanded,
      (partial.verification as { stoppedAt: number }).stoppedAt], ['failed', 'loan_steps_stopped', 2, 2]);

    const second = await armed();
    for (const index of [0, 1]) await second.store.recordStep({ owner: OWNER, executionId: second.record.executionId, attemptId: second.attemptId, index, transactionHash: hash(index + 1), stop: index === 1, now: NOW });
    receipts.set(hash(2), receipt(2, { status: 'reverted' }));
    const reverted = await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: second.record.executionId },
      (await second.store.get({ owner: OWNER, executionId: second.record.executionId }))!, deps(second.store, receipts, {}));
    assert.deepEqual([reverted.state, reverted.errorCode, (reverted.verification as { failedStep: number }).failedStep], ['failed', 'loan_step_reverted', 1]);
  });

  it('a later step the wallet may have sent keeps the market held; one never sent frees it for a repayment', async () => {
    const receipts = new Map([1, 2, 3].map((n) => [hash(n), receipt(n)] as const));
    // The wallet did not answer for step 3: the two that landed are submitted, and nothing is claimed about the third.
    const uncertain = await armed();
    for (const index of [0, 1]) await uncertain.store.recordStep({ owner: OWNER, executionId: uncertain.record.executionId, attemptId: uncertain.attemptId, index, transactionHash: hash(index + 1), now: NOW });
    await uncertain.store.recordSubmission({ owner: OWNER, executionId: uncertain.record.executionId, attemptId: uncertain.attemptId, outcome: 'submitted',
      batchId: sequentialBatchIdV1([hash(1), hash(2)]), now: NOW });
    const held = await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: uncertain.record.executionId },
      (await uncertain.store.get({ owner: OWNER, executionId: uncertain.record.executionId }))!, deps(uncertain.store, receipts, {}));
    assert.deepEqual([held.state, held.errorCode], ['unknown', 'loan_steps_incomplete']);

    // The person declined step 3 (the payment, in a Spend loan): the steps that landed are the result, and Repay arms.
    const declined = await armed();
    for (const index of [0, 1]) await declined.store.recordStep({ owner: OWNER, executionId: declined.record.executionId, attemptId: declined.attemptId, index, transactionHash: hash(index + 1), now: NOW });
    const stopped = await declined.store.recordSubmission({ owner: OWNER, executionId: declined.record.executionId, attemptId: declined.attemptId, outcome: 'stopped',
      batchId: sequentialBatchIdV1([hash(1), hash(2)]), now: NOW });
    assert.deepEqual([stopped?.state, stopped?.errorCode], ['submitted', 'loan_steps_stopped']);
    const final = await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: declined.record.executionId }, stopped!, deps(declined.store, receipts, {}));
    assert.deepEqual([final.state, final.errorCode, final.transactionHash], ['failed', 'loan_steps_stopped', hash(2)]);
    const repay = loanReadyFixture();
    const repayRun = { ...repay, facts: { ...repay.facts, operation: 'repay' as const, venue: 'aave-v4' as const, marketId: SPOKE } };
    const ready = await declined.store.putReady({ owner: OWNER, draftId: 'repay-after-stop', run: repayRun, now: NOW });
    const arm = await declined.store.arm({ owner: OWNER, executionId: ready.executionId, callsHash: ready.run.callsHash, signingTermsHash: ready.run.signingTermsHash, now: NOW });
    assert.equal(arm.ok, true);
    // While a stopped record could not yet be read, it is kept as it is rather than losing that it stopped.
    const unread = await armed();
    await unread.store.recordStep({ owner: OWNER, executionId: unread.record.executionId, attemptId: unread.attemptId, index: 0, transactionHash: hash(1), stop: true, now: NOW });
    const waiting = (await unread.store.get({ owner: OWNER, executionId: unread.record.executionId }))!;
    const kept = await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: unread.record.executionId }, waiting, deps(unread.store, new Map(), {}));
    assert.deepEqual([kept.state, kept.errorCode, kept.version], ['submitted', 'loan_steps_stopped', waiting.version]);
  });

  it('a hash pasted from the wallet is read as the next step, under the same checks as a recorded one', async () => {
    const { store, record, attemptId } = await armed();
    assert.ok(await store.recordStep({ owner: OWNER, executionId: record.executionId, attemptId, index: 0, transactionHash: hash(1), now: NOW }));
    // Step 2 landed, and its answer never reached Still; the person pastes its hash.
    const before = (await store.get({ owner: OWNER, executionId: record.executionId }))!;
    const hinted = await store.recordVerification({ owner: OWNER, executionId: record.executionId, expectedVersion: before.version, state: 'unknown',
      transactionHash: hash(2), proof: null, errorCode: 'loan_transaction_hint_unverified', now: NOW });
    let reads = 0;
    const receipts = new Map([1, 2].map((n) => [hash(n), receipt(n)] as const));
    const counting = deps(store, receipts, {});
    const reader = counting.reader;
    counting.reader = { ...reader, async getTransactionReceipt(h) { reads += 1; return reader.getTransactionReceipt(h); } } as LoanExecutionStatusDepsV1['reader'];
    const read = await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: record.executionId }, hinted!, counting);
    assert.equal(reads, 2);
    assert.deepEqual([read.state, read.errorCode, (read.verification as { stepsLanded: number }).stepsLanded], ['unknown', 'loan_steps_incomplete', 2]);
    // A hash that is not the next approved call is not adopted as one.
    const wrong = await armed();
    const fresh = (await wrong.store.get({ owner: OWNER, executionId: wrong.record.executionId }))!;
    await wrong.store.recordSubmission({ owner: OWNER, executionId: wrong.record.executionId, attemptId: wrong.attemptId, outcome: 'unknown', now: NOW });
    const unknown = (await wrong.store.get({ owner: OWNER, executionId: wrong.record.executionId }))!;
    const pasted = await wrong.store.recordVerification({ owner: OWNER, executionId: wrong.record.executionId, expectedVersion: unknown.version, state: 'unknown',
      transactionHash: hash(3), proof: null, errorCode: 'loan_transaction_hint_unverified', now: NOW });
    assert.ok(fresh && pasted);
    const refused = await refreshSequentialLoanExecutionV1({ owner: OWNER, executionId: wrong.record.executionId }, pasted!, deps(wrong.store, new Map([[hash(3), receipt(3)]]), {}));
    assert.equal(refused.state, 'unknown');
    assert.notEqual(refused.errorCode, 'loan_steps_incomplete');
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

describe('a loan in steps left part way is stopped by its owner only when Base shows the wallet sent nothing since (re-audit R3)', () => {
  // Step n is the wallet's own transaction number 6 + n; `count` is what Base says the wallet has sent so far.
  type CountV1 = { latest: number | null; pending: number | null } | null;
  function stopDeps(store: MemoryLoanExecutionStoreV1, count: CountV1, receipts: Map<string, VerifiedReceiptSourceV1>): LoanExecutionStatusDepsV1 {
    return {
      store, now: () => NOW, readBatchHashes: async () => null,
      reader: {
        async getTransactionReceipt(h) { return receipts.get(h) ?? null; },
        async getTransaction(h) { const n = Number(BigInt(h)); return n >= 1 && n <= 3 ? tx(n - 1, { nonce: 6 + n }) : n === 4 ? tx(0, { nonce: 10 }) : null; },
        ...(count ? { async getTransactionCount(_address: string, tag: 'latest' | 'pending') { return tag === 'latest' ? count.latest : count.pending; } } : {}),
      } as LoanExecutionStatusDepsV1['reader'],
      verifyEffectPosition: async () => ({ state: 'matched', proof: { operation: 'borrow' } }),
    };
  }
  const receipts = new Map([1, 2, 3, 4].map((n) => [hash(n), receipt(n)] as const));
  const at = (record: LoanExecutionV1) => ({ owner: OWNER, executionId: record.executionId });
  async function twoLanded() {
    const armedLoan = await armed();
    for (const index of [0, 1]) {
      assert.ok(await armedLoan.store.recordStep({ owner: OWNER, executionId: armedLoan.record.executionId, attemptId: armedLoan.attemptId, index, transactionHash: hash(index + 1), now: NOW }));
    }
    return armedLoan;
  }
  const proofOf = (record: LoanExecutionV1) => {
    const proof = record.verification as { stepsLanded?: number; stoppedAt?: number; stoppedBy?: string; nonceAfter?: number } | null;
    return [proof?.stepsLanded, proof?.stoppedAt, proof?.stoppedBy, proof?.nonceAfter];
  };

  it('stops after the steps that landed, keeps them, frees the market, and stays stopped when read again', async () => {
    const { store, record } = await twoLanded();
    // Step 2 was recorded and the page never asked for step 3: the loan still waits on its wallet, holding the market.
    const waiting = (await store.get(at(record)))!;
    assert.equal(waiting.state, 'awaiting_wallet');
    assert.deepEqual(loanStepsStandingV1(waiting), { landed: 2, total: 3, stoppable: true });
    // Step 2 was the wallet's transaction 8; with nothing sent since, it has sent 9 and holds nothing pending.
    const result = await stopSequentialLoanExecutionV1(at(record), stopDeps(store, { latest: 9, pending: 9 }, receipts));
    assert.ok(result?.ok);
    const stopped = result.record;
    assert.deepEqual([stopped.state, stopped.errorCode, stopped.transactionHash, sequentialHashesV1(stopped.batchId!)], ['failed', 'loan_steps_stopped', hash(2), [hash(1), hash(2)]]);
    assert.deepEqual(proofOf(stopped), [2, 2, 'person', 9]);
    assert.deepEqual(loanStepsStandingV1(stopped), { landed: 2, total: 3, stoppable: false });
    // Read again from Base (the page's Check), it stays stopped by its owner; pressed again, it is the same stop.
    const reread = await refreshSequentialLoanExecutionV1(at(record), stopped, stopDeps(store, null, receipts));
    assert.deepEqual([reread.state, reread.errorCode, ...proofOf(reread)], ['failed', 'loan_steps_stopped', 2, 2, 'person', 9]);
    const again = await stopSequentialLoanExecutionV1(at(record), stopDeps(store, { latest: 12, pending: 12 }, receipts));
    assert.ok(again?.ok);
    assert.equal(again.record.version, reread.version);
    // Repay arms in the same market now.
    const repay = loanReadyFixture();
    const ready = await store.putReady({ owner: OWNER, draftId: 'repay-after-person-stop', run: { ...repay, facts: { ...repay.facts, operation: 'repay', venue: 'aave-v4', marketId: SPOKE } }, now: NOW });
    assert.equal((await store.arm({ owner: OWNER, executionId: ready.executionId, callsHash: ready.run.callsHash, signingTermsHash: ready.run.signingTermsHash, now: NOW })).ok, true);
  });

  it('refuses while Base shows a later transaction, one waiting, or cannot say, and changes nothing', async () => {
    const { store, record } = await twoLanded();
    const before = (await store.get(at(record)))!;
    const cases: Array<[CountV1, string]> = [
      [{ latest: 10, pending: 10 }, 'loan_steps_later_transaction'],
      [{ latest: 9, pending: 10 }, 'loan_steps_transaction_pending'],
      // A node behind the last step, a count it could not read, a reader that cannot count.
      [{ latest: 8, pending: 8 }, 'loan_steps_count_unread'],
      [{ latest: null, pending: 9 }, 'loan_steps_count_unread'],
      [null, 'loan_steps_count_unread'],
    ];
    for (const [count, refusal] of cases) {
      const result = await stopSequentialLoanExecutionV1(at(record), stopDeps(store, count, receipts));
      assert.deepEqual(result && !result.ok ? result.refusal : 'stopped', refusal);
    }
    const later = await stopSequentialLoanExecutionV1(at(record), stopDeps(store, { latest: 11, pending: 11 }, receipts));
    assert.equal(later && !later.ok ? later.detail : null,
      'Your wallet sent another transaction after step 2. Still cannot tell from Base whether it was step 3 of 3, so this loan was not stopped. If it was, paste its hash below.');
    const after = (await store.get(at(record)))!;
    assert.deepEqual([after.state, after.version, after.verification], ['awaiting_wallet', before.version, null]);
  });

  it('stops after a step whose hash was pasted, and keeps that step with the ones Still recorded', async () => {
    const { store, record, attemptId } = await armed();
    assert.ok(await store.recordStep({ owner: OWNER, executionId: record.executionId, attemptId, index: 0, transactionHash: hash(1), now: NOW }));
    // Step 2 landed, and its answer never reached Still (re-audit R3's own case): the person pastes its hash.
    const sending = (await store.get(at(record)))!;
    const hinted = await store.recordVerification({ owner: OWNER, executionId: record.executionId, expectedVersion: sending.version, state: 'unknown',
      transactionHash: hash(2), proof: null, errorCode: 'loan_transaction_hint_unverified', now: NOW });
    const read = await refreshSequentialLoanExecutionV1(at(record), hinted!, stopDeps(store, null, receipts));
    assert.deepEqual([read.state, read.errorCode], ['unknown', 'loan_steps_incomplete']);
    assert.deepEqual(loanStepsStandingV1(read), { landed: 2, total: 3, stoppable: true });
    const result = await stopSequentialLoanExecutionV1(at(record), stopDeps(store, { latest: 9, pending: 9 }, receipts));
    assert.ok(result?.ok);
    assert.deepEqual([result.record.transactionHash, sequentialHashesV1(result.record.batchId!)], [hash(2), [hash(1), hash(2)]]);
  });

  it('refuses a loan with no step recorded, one whose every step landed, a hash that is not its step, and a batch', async () => {
    const count = { latest: 9, pending: 9 };
    const refusalOf = async (store: MemoryLoanExecutionStoreV1, record: LoanExecutionV1) => {
      const result = await stopSequentialLoanExecutionV1(at(record), stopDeps(store, count, receipts));
      return result && !result.ok ? result.refusal : result ? 'stopped' : 'missing';
    };
    const none = await armed();
    assert.equal(await refusalOf(none.store, none.record), 'loan_steps_unread');
    const all = await armed();
    for (const index of [0, 1, 2]) await all.store.recordStep({ owner: OWNER, executionId: all.record.executionId, attemptId: all.attemptId, index, transactionHash: hash(index + 1), now: NOW });
    assert.equal(await refusalOf(all.store, all.record), 'loan_steps_complete');
    const wrong = await armed();
    await wrong.store.recordStep({ owner: OWNER, executionId: wrong.record.executionId, attemptId: wrong.attemptId, index: 0, transactionHash: hash(1), now: NOW });
    const sending = (await wrong.store.get(at(wrong.record)))!;
    await wrong.store.recordVerification({ owner: OWNER, executionId: wrong.record.executionId, expectedVersion: sending.version, state: 'unknown',
      transactionHash: hash(3), proof: null, errorCode: 'loan_transaction_hint_unverified', now: NOW });
    assert.equal(await refusalOf(wrong.store, wrong.record), 'loan_step_not_matched');
    const store = new MemoryLoanExecutionStoreV1();
    const batch = await store.putReady({ owner: OWNER, draftId: 'batch', run: loanReadyFixture(), now: NOW });
    assert.equal(await refusalOf(store, batch), 'lending_attempt_changed');
    assert.equal(await stopSequentialLoanExecutionV1({ owner: OWNER, executionId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34' }, stopDeps(store, count, receipts)), null);
  });

  it('takes back a step the wallet sent after the stop only when it is exactly the next one, landed', async () => {
    const { store, record } = await twoLanded();
    const result = await stopSequentialLoanExecutionV1(at(record), stopDeps(store, { latest: 9, pending: 9 }, receipts));
    assert.ok(result?.ok);
    const stopped = await refreshSequentialLoanExecutionV1(at(record), result.record, stopDeps(store, null, receipts));
    const reader = stopDeps(store, null, receipts).reader;
    assert.deepEqual(await nextStoppedStepLandedV1(stopped, hash(3), reader), { batchId: sequentialBatchIdV1([hash(1), hash(2)]) });
    // A step already in place, a hash Base does not know, and step 1's call sent again are not step 3.
    for (const h of [hash(2), hash(9), hash(4)]) assert.equal(await nextStoppedStepLandedV1(stopped, h, reader), null);
    // A loan that was not stopped has nothing to take back this way.
    const incomplete = await twoLanded();
    assert.equal(await nextStoppedStepLandedV1((await incomplete.store.get(at(incomplete.record)))!, hash(3), reader), null);
  });
});
