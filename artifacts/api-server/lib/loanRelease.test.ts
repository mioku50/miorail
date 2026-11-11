import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import type { VerifiedReceiptSourceV1 } from '@mioagent/route-proof';

import type { BaseChainReaderV1, BaseTransactionSourceV1 } from './baseReceiptReader.js';
import type { LoanExecutionStatusDepsV1 } from './loanExecutionStatus.js';
import { MemoryLoanExecutionStoreV1 } from './loanExecutionStore.js';
import { loanReadyFixture, LOAN_NOW_FIXTURE as NOW, LOAN_OWNER_FIXTURE as OWNER, LOAN_TX_FIXTURE as TX, LOAN_WALLET_FIXTURE as WALLET } from './loanExecutionTestFixtures.js';
import { LOAN_RELEASE_WAIT_MS_V1, LOAN_WALLET_SENT_NOTHING_V1, loanReleaseStandingV1, releaseUnsentLoanExecutionV1, releasedLoanLandedV1 } from './loanRelease.js';

// Audit LEND-1 (2026-11-10): an attempt the wallet never sent held its market for ever. Its owner may
// release it, and only when Base bears out that the wallet sent nothing. Everything here is synthetic.
const EXPIRES = NOW.getTime() + 30_000, FROM = EXPIRES + LOAN_RELEASE_WAIT_MS_V1;
const ENTRY_POINTS = ['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', '0x0000000071727de22e5e9d8baf0edac6f37da032', '0x4337084d9e255ff0702461cf8895ce9e3b5ff108'];

interface ChainV1 {
  kind: 'eoa' | 'eip7702' | 'contract' | null;
  then: number | null; latest: number | null; pending: number | null;
  /** A smart account's next nonce at each EntryPoint: as of the review, and now. */
  nonceThen: bigint | null; nonceNow: bigint | null;
  walletStatus: number | null;
  receipt: VerifiedReceiptSourceV1 | null; transaction: BaseTransactionSourceV1 | null;
}
const QUIET: ChainV1 = { kind: 'eoa', then: 41, latest: 41, pending: 41, nonceThen: 7n, nonceNow: 7n, walletStatus: null, receipt: null, transaction: null };

function deps(store: MemoryLoanExecutionStoreV1, chain: ChainV1, at: number) {
  const asked: string[] = [];
  const reader: BaseChainReaderV1 = {
    async getTransactionReceipt() { asked.push('receipt'); return chain.receipt; },
    async getTransaction() { asked.push('transaction'); return chain.transaction; },
    async getAccountKind() { return chain.kind; },
    async getTransactionCountAt(_address, block) { asked.push(`count@${block}`); return chain.then; },
    async getTransactionCount(_address, tag) { return tag === 'latest' ? chain.latest : chain.pending; },
    async getEntryPointNonce(entryPoint, _sender, when) { asked.push(`nonce:${entryPoint}:${when}`); return when === 'latest' ? chain.nonceNow : chain.nonceThen; },
    async findOwnTransactionsAfter() { return []; },
  };
  const all: LoanExecutionStatusDepsV1 & { readBatchStatus: (batchId: string) => Promise<number | null> } = {
    store, reader, readBatchHashes: async () => null, readBatchStatus: async () => chain.walletStatus,
    verifyEffectPosition: async () => ({ state: 'matched', proof: {} }), now: () => new Date(at),
  };
  return { deps: all, asked };
}

/** An attempt as the tab left it: armed, and with what the wallet answered, if anything. */
async function attempt(left: 'awaiting_wallet' | 'unknown' | 'submitted' = 'awaiting_wallet', run = loanReadyFixture()) {
  const store = new MemoryLoanExecutionStoreV1();
  const ready = await store.putReady({ owner: OWNER, draftId: 'release-draft', run, now: NOW });
  const armed = await store.arm({ owner: OWNER, executionId: ready.executionId, callsHash: run.callsHash, signingTermsHash: run.signingTermsHash, now: NOW });
  assert(armed.ok);
  if (left !== 'awaiting_wallet') {
    assert(await store.recordSubmission({ owner: OWNER, executionId: ready.executionId, attemptId: armed.attemptId, outcome: left,
      ...(left === 'submitted' ? { batchId: 'synthetic-batch-handle' } : {}), now: NOW }));
  }
  return { store, id: { owner: OWNER, executionId: ready.executionId } };
}
/** The next review of the same market, armed: possible only once nothing holds it. */
async function nextArms(store: MemoryLoanExecutionStoreV1): Promise<boolean> {
  const run = loanReadyFixture({ signingTermsHash: `0x${'8'.repeat(64)}`, expiresAt: new Date(FROM + 30_000).toISOString() });
  const next = await store.putReady({ owner: OWNER, draftId: 'release-draft-next', run, now: new Date(FROM) });
  return (await store.arm({ owner: OWNER, executionId: next.executionId, callsHash: run.callsHash, signingTermsHash: run.signingTermsHash, now: new Date(FROM) })).ok;
}

describe('releasing an attempt the wallet never sent', () => {
  it('holds the market until its owner releases it, and Base shows the wallet sent nothing since the review', async () => {
    for (const left of ['awaiting_wallet', 'unknown', 'submitted'] as const) {
      const { store, id } = await attempt(left);
      assert.equal(await nextArms(store), false, `${left} holds its market`);
      const { deps: d, asked } = deps(store, QUIET, FROM);
      const released = await releaseUnsentLoanExecutionV1(id, d);
      assert.ok(released?.ok, left);
      assert.deepEqual([released.record.state, released.record.errorCode, released.record.transactionHash], ['failed', LOAN_WALLET_SENT_NOTHING_V1, null]);
      // What bore it out stays with the record: who asked, the review's block and the count that did not move.
      assert.deepEqual(released.record.verification, { callsHash: released.record.run.callsHash, releasedBy: 'person', reviewBlock: '53000000', account: 'eoa', transactionCount: 41 });
      assert.ok(asked.includes('count@53000000'));
      assert.equal(await nextArms(store), true, `${left}: the market is free again`);
      // Asked again, the same answer and nothing new.
      const again = await releaseUnsentLoanExecutionV1(id, d);
      assert.ok(again?.ok && again.record.version === released.record.version);
    }
  });

  it('is offered ten minutes after the review’s own time ran out, and not a moment before', async () => {
    const { store, id } = await attempt();
    const record = (await store.get(id))!;
    assert.deepEqual(loanReleaseStandingV1(record, new Date(FROM - 1)), { offered: false, from: new Date(FROM).toISOString() });
    assert.deepEqual(loanReleaseStandingV1(record, new Date(FROM)), { offered: true, from: new Date(FROM).toISOString() });
    const early = await releaseUnsentLoanExecutionV1(id, deps(store, QUIET, FROM - 1).deps);
    assert.deepEqual([early?.ok, early && !early.ok && early.refusal], [false, 'loan_release_too_early']);
    assert.equal((await store.get(id))!.state, 'awaiting_wallet');
  });

  it('refuses, and changes nothing, when the wallet sent something since, has something waiting, or could not be read', async () => {
    const cases: Array<[Partial<ChainV1>, string]> = [
      [{ latest: 42, pending: 42 }, 'loan_release_later_transaction'],
      [{ pending: 42 }, 'loan_release_transaction_pending'],
      [{ kind: 'eip7702', latest: 43, pending: 43 }, 'loan_release_later_transaction'],
      [{ kind: null }, 'loan_release_wallet_unread'],
      [{ then: null }, 'loan_release_wallet_unread'],
      [{ latest: null }, 'loan_release_wallet_unread'],
      [{ pending: null }, 'loan_release_wallet_unread'],
      // A count lower than at the review is a node that is behind, not a wallet that sent nothing.
      [{ latest: 40, pending: 40 }, 'loan_release_wallet_unread'],
    ];
    for (const [patch, refusal] of cases) {
      const { store, id } = await attempt('unknown');
      const result = await releaseUnsentLoanExecutionV1(id, deps(store, { ...QUIET, ...patch }, FROM).deps);
      assert.deepEqual([result?.ok, result && !result.ok && result.refusal], [false, refusal], JSON.stringify(patch));
      assert.ok(result && !result.ok && result.detail.length > 40);
      const after = (await store.get(id))!;
      assert.deepEqual([after.state, after.errorCode], ['unknown', null], JSON.stringify(patch));
      assert.equal(await nextArms(store), false);
    }
  });

  it('reads a smart account by its nonce at every EntryPoint, and by its wallet’s own word for the batch', async () => {
    const smart: ChainV1 = { ...QUIET, kind: 'contract', then: 1, latest: 1, pending: 1 };
    const { store, id } = await attempt('submitted');
    const { deps: d, asked } = deps(store, { ...smart, walletStatus: 400 }, FROM);
    const released = await releaseUnsentLoanExecutionV1(id, d);
    assert.ok(released?.ok);
    assert.deepEqual(released.record.verification, { callsHash: released.record.run.callsHash, releasedBy: 'person', reviewBlock: '53000000', account: 'contract',
      operationNonces: ENTRY_POINTS.map((entryPoint) => ({ entryPoint, nonce: '7' })), walletStatus: 400 });
    for (const entryPoint of ENTRY_POINTS) assert.ok(asked.includes(`nonce:${entryPoint}:53000000`) && asked.includes(`nonce:${entryPoint}:latest`));
    // The account's own transaction count says nothing about a smart account, and is not asked.
    assert.equal(asked.some((entry) => entry.startsWith('count@')), false);

    const cases: Array<[Partial<ChainV1>, string]> = [
      [{ nonceNow: 8n }, 'loan_release_later_transaction'],
      [{ nonceNow: null }, 'loan_release_wallet_unread'],
      [{ nonceThen: null }, 'loan_release_wallet_unread'],
      // The wallet's service: still on its way, included, or reverted onchain.
      [{ walletStatus: 100 }, 'loan_release_transaction_pending'],
      [{ walletStatus: 200 }, 'loan_release_later_transaction'],
      [{ walletStatus: 500 }, 'loan_release_later_transaction'],
    ];
    for (const [patch, refusal] of cases) {
      const held = await attempt('submitted');
      const result = await releaseUnsentLoanExecutionV1(held.id, deps(held.store, { ...smart, ...patch }, FROM).deps);
      assert.deepEqual([result?.ok, result && !result.ok && result.refusal], [false, refusal], JSON.stringify(patch, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
      assert.equal((await held.store.get(held.id))!.state, 'submitted');
    }
    // A wallet whose service does not know the batch is read from Base alone.
    const silent = await attempt('submitted');
    assert.ok((await releaseUnsentLoanExecutionV1(silent.id, deps(silent.store, smart, FROM).deps))?.ok);
  });

  it('is not for a loan in steps, a settled one, another wallet’s, or one that does not exist', async () => {
    const steps = await attempt('awaiting_wallet', loanReadyFixture({ atomicRequired: false, delivery: 'sequential' } as never));
    assert.equal(loanReleaseStandingV1((await steps.store.get(steps.id))!, new Date(FROM)), null);
    const stepped = await releaseUnsentLoanExecutionV1(steps.id, deps(steps.store, QUIET, FROM).deps);
    assert.deepEqual([stepped?.ok, stepped && !stepped.ok && stepped.refusal], [false, 'lending_attempt_changed']);
    const { store, id } = await attempt();
    assert.equal(await releaseUnsentLoanExecutionV1({ owner: OWNER, executionId: 'no-such-execution' }, deps(store, QUIET, FROM).deps), null);
    const other = { walletAddress: `0x${'2'.repeat(40)}`, tenantId: `eip155:8453:0x${'2'.repeat(40)}` };
    assert.equal(await releaseUnsentLoanExecutionV1({ owner: other, executionId: id.executionId }, deps(store, QUIET, FROM).deps), null);
    assert.equal((await store.get(id))!.state, 'awaiting_wallet');
  });
});

describe('a released review whose transaction landed after all', () => {
  const EXECUTE = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);
  const own = (calls = loanReadyFixture().calls): BaseTransactionSourceV1 => ({ from: WALLET, to: WALLET, value: 0n, nonce: 41,
    input: encodeFunctionData({ abi: EXECUTE, functionName: 'executeBatch', args: [calls.map((call) => ({ target: call.to as Address, value: BigInt(call.valueWei), data: call.data as Hex }))] }) });
  const landed: VerifiedReceiptSourceV1 = { transactionHash: TX, status: 'success', blockNumber: 53000900n, gasUsed: 1n, effectiveGasPriceWei: 1n, logs: [], from: WALLET };

  it('is taken back only by a transaction that is exactly its own calls from its wallet', async () => {
    const { store, id } = await attempt('unknown');
    const released = await releaseUnsentLoanExecutionV1(id, deps(store, QUIET, FROM).deps);
    assert.ok(released?.ok);
    const reader = (chain: Partial<ChainV1>) => deps(store, { ...QUIET, ...chain }, FROM).deps.reader;
    assert.equal(await releasedLoanLandedV1(released.record, TX, reader({ receipt: landed, transaction: own() })), true);
    // Another wallet's, other calls, a hash Base does not know, or a review that was never released.
    assert.equal(await releasedLoanLandedV1(released.record, TX, reader({ receipt: landed, transaction: { ...own(), from: `0x${'2'.repeat(40)}` } })), false);
    assert.equal(await releasedLoanLandedV1(released.record, TX, reader({ receipt: landed, transaction: own(loanReadyFixture().calls.slice(0, 1)) })), false);
    assert.equal(await releasedLoanLandedV1(released.record, TX, reader({})), false);
    const held = await attempt('unknown');
    assert.equal(await releasedLoanLandedV1((await held.store.get(held.id))!, TX, reader({ receipt: landed, transaction: own() })), false);
  });
});
