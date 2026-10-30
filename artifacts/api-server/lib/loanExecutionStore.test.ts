import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashApprovedCallsV1 } from '@mioagent/route-domain';
import { MemoryLoanExecutionStoreV1, type LoanExecutionStoreV1, type LoanOwnerV1 } from './loanExecutionStore.js';
import { loanReadyFixture, LOAN_OWNER_FIXTURE as OWNER, LOAN_OTHER_WALLET_FIXTURE as OTHER, LOAN_NOW_FIXTURE as NOW, LOAN_TX_FIXTURE as TX } from './loanExecutionTestFixtures.js';

const otherOwner: LoanOwnerV1 = { walletAddress: OTHER, tenantId: `eip155:8453:${OTHER}` };
async function ready(store: LoanExecutionStoreV1, draftId = 'fixture-draft-1') { return store.putReady({ owner: OWNER, draftId, run: loanReadyFixture(), now: NOW }); }

describe('owned lending execution locks', () => {
  it('reuses a draft id, refreshes an unarmed review, and keeps caller mutations out', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const first = await ready(store);
    first.run.facts.debtBeforeAssets = '999';
    const nextRun = loanReadyFixture({ expiresAt: new Date(NOW.getTime() + 50_000).toISOString() });
    const next = await store.putReady({ owner: OWNER, draftId: first.draftId, run: nextRun, now: new Date(NOW.getTime() + 1000) });
    assert.equal(next.executionId, first.executionId); assert.equal(next.run.facts.debtBeforeAssets, '3000000'); assert.equal(next.version, 1);
    assert.equal(next.run.expiresAt, nextRun.expiresAt);
  });
  it('an existing signed question cannot acquire another token, amount, mode, budget or pledge', async () => {
    for (const field of ['collateralTokenAddress', 'amountMode', 'requestedAssets', 'maximumDebitAssets', 'collateralSupplyAssets'] as const) {
      const store = new MemoryLoanExecutionStoreV1(); const first = await ready(store); const changed = loanReadyFixture();
      if (field === 'amountMode') changed.facts.amountMode = 'all';
      else changed.facts[field] = field === 'collateralTokenAddress' ? OWNER.walletAddress : '999';
      await assert.rejects(store.putReady({ owner: OWNER, draftId: first.draftId, run: changed, now: NOW }), /question_changed/);
    }
    const store = new MemoryLoanExecutionStoreV1(); const first = await ready(store); const native = loanReadyFixture();
    native.facts.nativeFunding = {
      maximumNativeAssets: '10', reserveAssets: '500000000000000',
      balanceBeforeAssets: '20', balanceAfterAssets: '10',
      authorizedBefore: false, feeQuoteState: 'wallet_quote_required',
    };
    await assert.rejects(store.putReady({ owner: OWNER, draftId: first.draftId, run: native, now: NOW }), /question_changed/);
  });
  it('arms one exact version once across simultaneous clicks', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const record = await ready(store);
    const results = await Promise.all([1, 2, 3].map(() => store.arm({ owner: OWNER, executionId: record.executionId, callsHash: record.run.callsHash, signingTermsHash: record.run.signingTermsHash, now: NOW })));
    assert.equal(results.filter(result => result.ok).length, 1);
    const stored = await store.get({ owner: OWNER, executionId: record.executionId }); assert.equal(stored!.state, 'awaiting_wallet');
  });
  it('refuses old-tab confirmation when the facts changed while the calldata stayed the same', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const first = await ready(store); const freshRun = loanReadyFixture();
    freshRun.facts.debtAfterAssets = '1100000'; freshRun.signingTermsHash = `0x${'8'.repeat(64)}`;
    const updated = await store.putReady({ owner: OWNER, draftId: first.draftId, run: freshRun, now: NOW });
    assert.equal(updated.run.callsHash, first.run.callsHash);
    assert.deepEqual(await store.arm({ owner: OWNER, executionId: first.executionId, callsHash: first.run.callsHash, signingTermsHash: first.run.signingTermsHash, now: NOW }), { ok: false, refusal: 'execution_not_ready' });
    assert((await store.arm({ owner: OWNER, executionId: updated.executionId, callsHash: updated.run.callsHash, signingTermsHash: updated.run.signingTermsHash, now: NOW })).ok);
  });
  it('prevents a second active draft for the same wallet and market', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const first = await ready(store); const second = await ready(store, 'second-draft');
    const results = await Promise.all([first, second].map(row => store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW })));
    assert.equal(results.filter(result => result.ok).length, 1); assert.equal(results.filter(result => !result.ok && result.refusal === 'execution_active').length, 1);
  });
  it('serializes all Aave stock reserves because they share a spoke debt', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const make = (marketId: string) => {
      const run = loanReadyFixture(); run.facts.venue = 'aave-v4'; run.facts.marketId = marketId; return run;
    };
    const a = await store.putReady({ owner: OWNER, draftId: 'stock-a', run: make('aave-v4:NVDAc'), now: NOW });
    const b = await store.putReady({ owner: OWNER, draftId: 'stock-b', run: make('aave-v4:AAPLc'), now: NOW });
    assert((await store.arm({ owner: OWNER, executionId: a.executionId, callsHash: a.run.callsHash, signingTermsHash: a.run.signingTermsHash, now: NOW })).ok);
    assert.deepEqual(await store.arm({ owner: OWNER, executionId: b.executionId, callsHash: b.run.callsHash, signingTermsHash: b.run.signingTermsHash, now: NOW }), { ok: false, refusal: 'execution_active' });
  });
  it('checks ownership on every read and mutation', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const row = await ready(store);
    assert.equal(await store.get({ owner: otherOwner, executionId: row.executionId }), null);
    assert.equal((await store.arm({ owner: otherOwner, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW })).ok, false);
    const armed = await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW }); assert(armed.ok);
    assert.equal(await store.recordSubmission({ owner: otherOwner, executionId: row.executionId, attemptId: armed.attemptId, outcome: 'unknown', now: NOW }), null);
  });
  it('does not overwrite active ready calls or permit an expired/changed hash', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const row = await ready(store);
    assert.equal((await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: `0x${'8'.repeat(64)}`, signingTermsHash: row.run.signingTermsHash, now: NOW })).ok, false);
    assert.equal((await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: new Date(row.run.expiresAt) })).ok, false);
    const armed = await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW }); assert(armed.ok);
    const changed = loanReadyFixture(); changed.calls = changed.calls.map(call => ({ ...call, data: '0x99999999' })); changed.callsHash = hashApprovedCallsV1(changed.calls);
    const prior = await store.putReady({ owner: OWNER, draftId: row.draftId, run: changed, now: NOW });
    assert.equal(prior.state, 'awaiting_wallet'); assert.equal(prior.run.callsHash, row.run.callsHash);
  });
  it('allows retry only after the exact pending wallet attempt was explicitly rejected', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const row = await ready(store);
    const first = await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW }); assert(first.ok);
    assert.equal((await store.recordSubmission({ owner: OWNER, executionId: row.executionId, attemptId: first.attemptId, outcome: 'rejected', now: NOW }))!.state, 'ready');
    const second = await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW }); assert(second.ok); assert.notEqual(second.attemptId, first.attemptId);
    assert.equal(await store.recordSubmission({ owner: OWNER, executionId: row.executionId, attemptId: first.attemptId, outcome: 'rejected', now: NOW }), null);
  });
  it('unknown submission stays locked across late rejection, another draft and ready refresh', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const row = await ready(store);
    const armed = await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW }); assert(armed.ok);
    assert.equal((await store.recordSubmission({ owner: OWNER, executionId: row.executionId, attemptId: armed.attemptId, outcome: 'unknown', now: NOW }))!.state, 'unknown');
    assert.equal(await store.recordSubmission({ owner: OWNER, executionId: row.executionId, attemptId: armed.attemptId, outcome: 'rejected', now: NOW }), null);
    assert.equal((await ready(store)).state, 'unknown'); const next = await ready(store, 'another-draft');
    assert.equal((await store.arm({ owner: OWNER, executionId: next.executionId, callsHash: next.run.callsHash, signingTermsHash: next.run.signingTermsHash, now: NOW })).ok, false);
  });
  it('batch hints do not mean confirmed, and conflicting hints remain unknown', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const row = await ready(store);
    const armed = await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW }); assert(armed.ok);
    const submit = (batchId: string) => store.recordSubmission({ owner: OWNER, executionId: row.executionId, attemptId: armed.attemptId, outcome: 'submitted', batchId, now: NOW });
    assert.equal((await submit('hint-a'))!.state, 'submitted'); assert.equal((await submit('hint-b'))!.state, 'unknown');
    assert.equal((await submit('hint-a'))!.state, 'unknown');
  });
  it('CAS rejects a stale verification and refuses completion without chain proof', async () => {
    const store = new MemoryLoanExecutionStoreV1(); const row = await ready(store);
    const armed = await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW }); assert(armed.ok);
    const input = { owner: OWNER, executionId: row.executionId, expectedVersion: armed.execution.version, state: 'confirmed' as const, transactionHash: TX, proof: { receiptFingerprint: 'fixture' }, errorCode: null, now: NOW };
    const results = await Promise.all([store.recordVerification(input), store.recordVerification(input)]); assert.equal(results.filter(Boolean).length, 1);
    await assert.rejects(store.recordVerification({ ...input, transactionHash: null }), /verification_invalid/);
    await assert.rejects(store.recordVerification({ ...input, proof: null }), /verification_invalid/);
  });
});
