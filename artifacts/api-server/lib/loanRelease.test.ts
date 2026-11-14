import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import type { HashV1 } from '@mioagent/route-domain';
import type { VerifiedReceiptSourceV1 } from '@mioagent/route-proof';

import type { BaseChainReaderV1, BaseTransactionSourceV1 } from './baseReceiptReader.js';
import { LOAN_RELEASED_WATCH_MS_V1, refreshLoanExecutionV1, type LoanExecutionStatusDepsV1 } from './loanExecutionStatus.js';
import { MemoryLoanExecutionStoreV1, type LoanExecutionV1 } from './loanExecutionStore.js';
import { loanReadyFixture, LOAN_NOW_FIXTURE as NOW, LOAN_OWNER_FIXTURE as OWNER, LOAN_TX_FIXTURE as TX, LOAN_USDC_FIXTURE as USDC, LOAN_WALLET_FIXTURE as WALLET } from './loanExecutionTestFixtures.js';
import { LOAN_RELEASE_AGAIN_MS_V1, LOAN_RELEASE_SEARCH_LIMIT_V1, LOAN_RELEASE_WAIT_MS_V1, LOAN_WALLET_SENT_NOTHING_V1, loanReleaseStandingV1, readReleaseCheckV1,
  releaseUnsentLoanExecutionV1, releasedLoanLandedV1, signReleaseCheckV1, type LoanReleaseAnswerV1 } from './loanRelease.js';

// Audit LEND-1 (2026-11-10): an attempt the wallet never sent held its market for ever. Its owner may
// release it, and only when Base bears out that the wallet sent nothing of it, twice, a minute apart
// (audits LL-1 and LL-2, 2026-11-14). Everything here is synthetic.
const EXPIRES = NOW.getTime() + 30_000, FROM = EXPIRES + LOAN_RELEASE_WAIT_MS_V1, AGAIN = FROM + LOAN_RELEASE_AGAIN_MS_V1;
const ENTRY_POINTS = ['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', '0x0000000071727de22e5e9d8baf0edac6f37da032', '0x4337084d9e255ff0702461cf8895ce9e3b5ff108'];
const SECRET = 'release-check-secret-for-tests-only';
const OTHER_TX = `0x${'6'.repeat(64)}` as HashV1;
const EXECUTE = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);

interface ChainV1 {
  kind: 'eoa' | 'eip7702' | 'contract' | null;
  then: number | null; latest: number | null; pending: number | null;
  /** A smart account's next nonce at each EntryPoint: as of the review, and now. */
  nonceThen: bigint | null; nonceNow: bigint | null;
  walletStatus: number | null;
  /** The wallet's transactions (or a smart account's operations) after the review, as the search finds them. */
  later: { hashes: HashV1[]; complete: boolean } | null;
  /** What Base holds for each hash. */
  transactions: Record<string, { receipt: VerifiedReceiptSourceV1; transaction: BaseTransactionSourceV1 }>;
}
const QUIET: ChainV1 = { kind: 'eoa', then: 41, latest: 41, pending: 41, nonceThen: 7n, nonceNow: 7n, walletStatus: null, later: { hashes: [], complete: true }, transactions: {} };

const receiptOf = (hash: HashV1, block = 53000900n): VerifiedReceiptSourceV1 => ({ transactionHash: hash, status: 'success', blockNumber: block, gasUsed: 1n, effectiveGasPriceWei: 1n, logs: [], from: WALLET });
/** The review's own batch, sent by the wallet through its smart wallet shape. */
const ownBatch = (calls = loanReadyFixture().calls): BaseTransactionSourceV1 => ({ from: WALLET, to: WALLET, value: 0n, nonce: 41,
  input: encodeFunctionData({ abi: EXECUTE, functionName: 'executeBatch', args: [calls.map((call) => ({ target: call.to as Address, value: BigInt(call.valueWei), data: call.data as Hex }))] }) });
/** Something else the wallet did: a swap, a repayment on the protocol's own site. */
const unrelated: BaseTransactionSourceV1 = { from: WALLET, to: `0x${'7'.repeat(40)}`, value: 0n, input: '0xdeadbeef', nonce: 41 };
/** Step 1 of a loan in steps: the approval, as a plain transaction. */
const stepOne: BaseTransactionSourceV1 = { from: WALLET, to: USDC, value: 0n, input: '0x095ea7b3', nonce: 41 };

function deps(store: MemoryLoanExecutionStoreV1, chain: ChainV1, at: number) {
  const asked: string[] = [];
  const read = (hash: HashV1) => chain.transactions[hash] ?? null;
  const reader: BaseChainReaderV1 = {
    async getTransactionReceipt(hash) { asked.push('receipt'); return read(hash)?.receipt ?? null; },
    async getTransaction(hash) { asked.push('transaction'); return read(hash)?.transaction ?? null; },
    async getAccountKind() { return chain.kind; },
    async getTransactionCountAt(_address, block) { asked.push(`count@${block}`); return chain.then; },
    async getTransactionCount(_address, tag) { return tag === 'latest' ? chain.latest : chain.pending; },
    async getEntryPointNonce(entryPoint, _sender, when) { asked.push(`nonce:${entryPoint}:${when}`); return when === 'latest' ? chain.nonceNow : chain.nonceThen; },
    async findOwnTransactionsAfter() { return []; },
    async listOwnTransactionsAfter(_address, afterBlock, limit) { asked.push(`list@${afterBlock}:${limit}`); return chain.later; },
    async listOwnOperationsAfter(entryPoint, _sender, afterBlock) { asked.push(`operations:${entryPoint}@${afterBlock}`); return chain.later; },
  };
  const all: LoanExecutionStatusDepsV1 & { readBatchStatus: (batchId: string) => Promise<number | null>; secret: string } = {
    store, reader, readBatchHashes: async () => null, readBatchStatus: async () => chain.walletStatus, secret: SECRET,
    verifyEffectPosition: async () => ({ state: 'matched', proof: {} }), now: () => new Date(at),
  };
  return { deps: all, asked };
}

/** An attempt as the tab left it: armed, and with what the wallet answered, if anything. */
async function attempt(left: 'awaiting_wallet' | 'unknown' | 'submitted' = 'awaiting_wallet', run = loanReadyFixture(), draftId = 'release-draft', store = new MemoryLoanExecutionStoreV1()) {
  const ready = await store.putReady({ owner: OWNER, draftId, run, now: NOW });
  const armed = await store.arm({ owner: OWNER, executionId: ready.executionId, callsHash: run.callsHash, signingTermsHash: run.signingTermsHash, now: NOW });
  assert(armed.ok);
  if (left !== 'awaiting_wallet') {
    assert(await store.recordSubmission({ owner: OWNER, executionId: ready.executionId, attemptId: armed.attemptId, outcome: left,
      ...(left === 'submitted' ? { batchId: 'synthetic-batch-handle' } : {}), now: NOW }));
  }
  return { store, id: { owner: OWNER, executionId: ready.executionId } };
}
/** The next review of the same market, armed: possible only once nothing holds it. */
async function nextArms(store: MemoryLoanExecutionStoreV1, at = AGAIN): Promise<boolean> {
  const run = loanReadyFixture({ signingTermsHash: `0x${'8'.repeat(64)}`, expiresAt: new Date(at + 30_000).toISOString() });
  const next = await store.putReady({ owner: OWNER, draftId: `release-draft-next-${at}`, run, now: new Date(at) });
  return (await store.arm({ owner: OWNER, executionId: next.executionId, callsHash: run.callsHash, signingTermsHash: run.signingTermsHash, now: new Date(at) })).ok;
}
const refusal = (answer: LoanReleaseAnswerV1 | null) => answer && answer.ok === false ? answer.refusal : answer?.ok;
/** Both presses: the first reading at FROM, the second a minute later with its note. */
async function releaseTwice(store: MemoryLoanExecutionStoreV1, id: { owner: typeof OWNER; executionId: string }, chain: ChainV1, second: ChainV1 = chain) {
  const first = await releaseUnsentLoanExecutionV1(id, deps(store, chain, FROM).deps);
  assert.equal(first?.ok, 'checking', JSON.stringify(first && first.ok === false ? first.refusal : first?.ok));
  const check = first.ok === 'checking' ? first.check : null;
  return releaseUnsentLoanExecutionV1({ ...id, check }, deps(store, second, AGAIN).deps);
}

describe('releasing an attempt the wallet never sent', () => {
  it('releases only on a second reading a minute after the first, equal to it, and records nothing before (audit LL-1)', async () => {
    for (const left of ['awaiting_wallet', 'unknown', 'submitted'] as const) {
      const { store, id } = await attempt(left);
      assert.equal(await nextArms(store), false, `${left} holds its market`);
      const before = (await store.get(id))!;
      const first = await releaseUnsentLoanExecutionV1(id, deps(store, QUIET, FROM).deps);
      assert.equal(first?.ok, 'checking');
      if (first?.ok !== 'checking') continue;
      assert.equal(first.checkAgainAt, new Date(AGAIN).toISOString());
      assert.deepEqual(readReleaseCheckV1(first.check, SECRET), { executionId: id.executionId, wallet: WALLET, reading: 'count:41', at: new Date(FROM).toISOString() });
      assert.equal((await store.get(id))!.version, before.version, 'the first reading writes nothing');
      // Pressed again too soon, the same note and the same time to wait.
      const soon = await releaseUnsentLoanExecutionV1({ ...id, check: first.check }, deps(store, QUIET, AGAIN - 1).deps);
      assert.deepEqual(soon?.ok === 'checking' && [soon.check, soon.checkAgainAt], [first.check, first.checkAgainAt]);
      const released = await releaseUnsentLoanExecutionV1({ ...id, check: first.check }, deps(store, QUIET, AGAIN).deps);
      assert.ok(released?.ok === true, left);
      assert.deepEqual([released.record.state, released.record.errorCode, released.record.transactionHash], ['failed', LOAN_WALLET_SENT_NOTHING_V1, null]);
      // What bore it out stays with the record: who asked, the review's block, the count, and both readings.
      assert.deepEqual(released.record.verification, { callsHash: released.record.run.callsHash, releasedBy: 'person', reviewBlock: '53000000', account: 'eoa',
        transactionCount: 41, firstReadAt: new Date(FROM).toISOString(), secondReadAt: new Date(AGAIN).toISOString() });
      assert.equal(await nextArms(store), true, `${left}: the market is free again`);
      const again = await releaseUnsentLoanExecutionV1(id, deps(store, QUIET, AGAIN).deps);
      assert.ok(again?.ok === true && again.record.version === released.record.version);
    }
  });

  it('starts over when the second reading differs, or the note is not its own, lapsed or forged', async () => {
    const { store, id } = await attempt('unknown');
    const first = await releaseUnsentLoanExecutionV1(id, deps(store, QUIET, FROM).deps);
    assert(first?.ok === 'checking');
    // The wallet sent something else in that minute: not this review, but not the same reading either.
    const moved: ChainV1 = { ...QUIET, latest: 42, pending: 42, later: { hashes: [OTHER_TX], complete: true },
      transactions: { [OTHER_TX]: { receipt: receiptOf(OTHER_TX), transaction: unrelated } } };
    const changed = await releaseUnsentLoanExecutionV1({ ...id, check: first.check }, deps(store, moved, AGAIN).deps);
    assert.equal(changed?.ok, 'checking');
    assert.notEqual(changed?.ok === 'checking' && changed.check, first.check);
    assert.equal(changed?.ok === 'checking' && changed.checkAgainAt, new Date(AGAIN + LOAN_RELEASE_AGAIN_MS_V1).toISOString());
    // A note for another attempt, one signed with another secret, a lapsed one, or garbage: a first reading, never a release.
    const notes = [
      signReleaseCheckV1({ executionId: 'another-execution', wallet: WALLET, reading: 'count:41', at: new Date(FROM).toISOString() }, SECRET),
      signReleaseCheckV1({ executionId: id.executionId, wallet: WALLET, reading: 'count:41', at: new Date(FROM).toISOString() }, 'another-secret-of-sixteen-chars'),
      signReleaseCheckV1({ executionId: id.executionId, wallet: WALLET, reading: 'count:41', at: new Date(AGAIN - 11 * 60_000).toISOString() }, SECRET),
      'not-a-note', `${first.check}x`,
    ];
    for (const check of notes) {
      const answer = await releaseUnsentLoanExecutionV1({ ...id, check }, deps(store, QUIET, AGAIN).deps);
      assert.equal(answer?.ok, 'checking', check.slice(0, 20));
      assert.equal((await store.get(id))!.state, 'unknown');
    }
  });

  it('is offered ten minutes after the review’s own time ran out, and not a moment before', async () => {
    const { store, id } = await attempt();
    const record = (await store.get(id))!;
    assert.deepEqual(loanReleaseStandingV1(record, new Date(FROM - 1)), { offered: false, from: new Date(FROM).toISOString() });
    assert.deepEqual(loanReleaseStandingV1(record, new Date(FROM)), { offered: true, from: new Date(FROM).toISOString() });
    const early = await releaseUnsentLoanExecutionV1(id, deps(store, QUIET, FROM - 1).deps);
    assert.equal(refusal(early), 'loan_release_too_early');
    assert.equal((await store.get(id))!.state, 'awaiting_wallet');
  });

  it('releases past the wallet’s other transactions since the review, each read and none of them this one (audit LL-2)', async () => {
    const { store, id } = await attempt('unknown');
    const busy: ChainV1 = { ...QUIET, latest: 43, pending: 43, later: { hashes: [OTHER_TX, `0x${'9'.repeat(64)}` as HashV1], complete: true },
      transactions: { [OTHER_TX]: { receipt: receiptOf(OTHER_TX), transaction: unrelated },
        [`0x${'9'.repeat(64)}`]: { receipt: receiptOf(`0x${'9'.repeat(64)}` as HashV1), transaction: { ...unrelated, nonce: 42 } } } };
    const { asked } = deps(store, busy, FROM);
    const released = await releaseTwice(store, id, busy);
    assert.ok(released?.ok === true);
    assert.deepEqual([released.record.verification?.transactionCountNow, released.record.verification?.otherTransactions], [43, [OTHER_TX, `0x${'9'.repeat(64)}`]]);
    assert.equal(await nextArms(store), true);
    void asked;
  });

  it('finds its own transaction among them instead, and reads the attempt from it', async () => {
    const { store, id } = await attempt('unknown');
    const sent: ChainV1 = { ...QUIET, latest: 42, pending: 42, later: { hashes: [TX], complete: true },
      transactions: { [TX]: { receipt: receiptOf(TX), transaction: ownBatch() } } };
    const answer = await releaseUnsentLoanExecutionV1(id, deps(store, sent, FROM).deps);
    assert.equal(refusal(answer), 'loan_release_found_transaction');
    assert.ok(answer?.ok === false && answer.detail.length > 40);
    const after = (await store.get(id))!;
    assert.deepEqual([after.state, after.transactionHash], ['confirmed', TX]);
  });

  it('refuses, and changes nothing, when the wallet is unread, has something waiting, or sent more than Still reads', async () => {
    const cases: Array<[Partial<ChainV1>, string]> = [
      [{ pending: 42 }, 'loan_release_transaction_pending'],
      [{ kind: null }, 'loan_release_wallet_unread'],
      [{ then: null }, 'loan_release_wallet_unread'],
      [{ latest: null }, 'loan_release_wallet_unread'],
      [{ pending: null }, 'loan_release_wallet_unread'],
      // A count lower than at the review is a node that is behind, not a wallet that sent nothing.
      [{ latest: 40, pending: 40 }, 'loan_release_wallet_unread'],
      // Moved, and the search could not be read, or did not reach the head yet.
      [{ latest: 42, pending: 42, later: null }, 'loan_release_wallet_unread'],
      [{ latest: 42, pending: 42, later: { hashes: [], complete: false } }, 'loan_release_wallet_unread'],
      // A later transaction Base cannot show right now.
      [{ latest: 42, pending: 42, later: { hashes: [OTHER_TX], complete: true } }, 'loan_release_wallet_unread'],
      [{ latest: 60, pending: 60, later: { hashes: Array.from({ length: LOAN_RELEASE_SEARCH_LIMIT_V1 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, 'a')}` as HashV1), complete: false },
        transactions: Object.fromEntries(Array.from({ length: LOAN_RELEASE_SEARCH_LIMIT_V1 }, (_, i) => {
          const h = `0x${(i + 1).toString(16).padStart(64, 'a')}` as HashV1; return [h, { receipt: receiptOf(h), transaction: unrelated }];
        })) }, 'loan_release_wallet_busy'],
    ];
    for (const [patch, wanted] of cases) {
      const { store, id } = await attempt('unknown');
      const result = await releaseUnsentLoanExecutionV1(id, deps(store, { ...QUIET, ...patch }, FROM).deps);
      assert.equal(refusal(result), wanted, JSON.stringify(Object.keys(patch)));
      assert.ok(result && result.ok === false && result.detail.length > 40);
      const after = (await store.get(id))!;
      assert.deepEqual([after.state, after.errorCode], ['unknown', null]);
      assert.equal(await nextArms(store), false);
    }
  });

  it('reads a smart account by its nonce at every EntryPoint, each later operation, and its wallet’s own word for the batch', async () => {
    const smart: ChainV1 = { ...QUIET, kind: 'contract', then: 1, latest: 1, pending: 1 };
    const { store, id } = await attempt('submitted');
    const released = await releaseTwice(store, id, { ...smart, walletStatus: 400 });
    assert.ok(released?.ok === true);
    assert.deepEqual(released.record.verification, { callsHash: released.record.run.callsHash, releasedBy: 'person', reviewBlock: '53000000', account: 'contract',
      operationNonces: ENTRY_POINTS.map((entryPoint) => ({ entryPoint, nonce: '7' })), firstReadAt: new Date(FROM).toISOString(),
      secondReadAt: new Date(AGAIN).toISOString(), walletStatus: 400 });
    // Another operation of the account since the review, not this batch: read, and released past (audit LL-2).
    const other = await attempt('submitted');
    const moved: ChainV1 = { ...smart, walletStatus: 400, nonceNow: 8n, later: { hashes: [OTHER_TX], complete: true },
      transactions: { [OTHER_TX]: { receipt: receiptOf(OTHER_TX), transaction: { ...unrelated, from: `0x${'a'.repeat(40)}`, to: ENTRY_POINTS[0]! } } } };
    const past = await releaseTwice(other.store, other.id, moved);
    assert.ok(past?.ok === true);
    assert.deepEqual(past.record.verification?.otherTransactions, [OTHER_TX]);
    const cases: Array<[Partial<ChainV1>, string]> = [
      [{ nonceNow: null }, 'loan_release_wallet_unread'],
      [{ nonceThen: null }, 'loan_release_wallet_unread'],
      [{ nonceNow: 8n, later: null }, 'loan_release_wallet_unread'],
      // The wallet's service: still on its way, included, reverted onchain, or no answer at all for a smart account's batch.
      [{ walletStatus: 100 }, 'loan_release_transaction_pending'],
      [{ walletStatus: 200 }, 'loan_release_later_transaction'],
      [{ walletStatus: 500 }, 'loan_release_later_transaction'],
      [{ walletStatus: null }, 'loan_release_wallet_unread'],
    ];
    for (const [patch, wanted] of cases) {
      const held = await attempt('submitted');
      const result = await releaseUnsentLoanExecutionV1(held.id, deps(held.store, { ...smart, walletStatus: 400, ...patch }, FROM).deps);
      assert.equal(refusal(result), wanted, JSON.stringify(patch, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
      assert.equal((await held.store.get(held.id))!.state, 'submitted');
    }
  });

  it('releases a loan in steps of which no step landed, and finds step 1 if the wallet sent it (audit LL-2)', async () => {
    const run = loanReadyFixture({ atomicRequired: false, delivery: 'sequential' } as never);
    const { store, id } = await attempt('awaiting_wallet', run);
    assert.deepEqual(loanReleaseStandingV1((await store.get(id))!, new Date(FROM)), { offered: true, from: new Date(FROM).toISOString() });
    const released = await releaseTwice(store, id, QUIET);
    assert.ok(released?.ok === true);
    assert.equal(await nextArms(store), true);
    // Step 1 went after all: it is found, kept as the hint it is, and read as the loan's first step.
    const sent = await attempt('awaiting_wallet', run, 'release-draft-steps');
    const chain: ChainV1 = { ...QUIET, latest: 42, pending: 42, later: { hashes: [TX], complete: true }, transactions: { [TX]: { receipt: receiptOf(TX), transaction: stepOne } } };
    const found = await releaseUnsentLoanExecutionV1(sent.id, deps(sent.store, chain, FROM).deps);
    assert.equal(refusal(found), 'loan_release_found_transaction');
    const after = (await sent.store.get(sent.id))!;
    assert.deepEqual([after.state, after.errorCode, after.transactionHash], ['unknown', 'loan_steps_incomplete', TX]);
    // With that step on record, the loan is stopped where it stands, not released.
    assert.equal(loanReleaseStandingV1(after, new Date(FROM)), null);
    assert.equal(refusal(await releaseUnsentLoanExecutionV1(sent.id, deps(sent.store, chain, FROM).deps)), 'loan_release_use_stop');
  });

  it('is not offered for an attempt whose transaction Still found, and is for one whose pasted hash was not its own (audit LL-5)', async () => {
    const { store, id } = await attempt('unknown');
    const found = await store.recordVerification({ ...id, expectedVersion: (await store.get(id))!.version, state: 'unknown', transactionHash: TX, proof: null,
      errorCode: 'loan_effect_read_unavailable', now: NOW });
    assert(found);
    assert.equal(loanReleaseStandingV1(found, new Date(FROM)), null);
    assert.equal(refusal(await releaseUnsentLoanExecutionV1(id, deps(store, QUIET, FROM).deps)), 'loan_release_has_transaction');
    const pasted = await store.recordVerification({ ...id, expectedVersion: found.version, state: 'unknown', transactionHash: OTHER_TX, proof: null,
      errorCode: 'loan_receipt_not_matched', now: NOW });
    assert(pasted);
    assert.deepEqual(loanReleaseStandingV1(pasted, new Date(FROM)), { offered: true, from: new Date(FROM).toISOString() });
  });

  it('is not for a settled one, another wallet’s, or one that does not exist', async () => {
    const { store, id } = await attempt();
    assert.equal(await releaseUnsentLoanExecutionV1({ owner: OWNER, executionId: 'no-such-execution' }, deps(store, QUIET, FROM).deps), null);
    const other = { walletAddress: `0x${'2'.repeat(40)}`, tenantId: `eip155:8453:0x${'2'.repeat(40)}` };
    assert.equal(await releaseUnsentLoanExecutionV1({ owner: other, executionId: id.executionId }, deps(store, QUIET, FROM).deps), null);
    assert.equal((await store.get(id))!.state, 'awaiting_wallet');
  });
});

describe('a released review whose transaction landed after all', () => {
  it('is taken back only by a transaction that is exactly its own calls from its wallet', async () => {
    const { store, id } = await attempt('unknown');
    const released = await releaseTwice(store, id, QUIET);
    assert.ok(released?.ok === true);
    const reader = (transaction: BaseTransactionSourceV1 | null) => deps(store, { ...QUIET, transactions: transaction ? { [TX]: { receipt: receiptOf(TX), transaction } } : {} }, AGAIN).deps.reader;
    assert.equal(await releasedLoanLandedV1(released.record, TX, reader(ownBatch())), true);
    // Another wallet's, other calls, a hash Base does not know, or a review that was never released.
    assert.equal(await releasedLoanLandedV1(released.record, TX, reader({ ...ownBatch(), from: `0x${'2'.repeat(40)}` })), false);
    assert.equal(await releasedLoanLandedV1(released.record, TX, reader(ownBatch(loanReadyFixture().calls.slice(0, 1)))), false);
    assert.equal(await releasedLoanLandedV1(released.record, TX, reader(null)), false);
    const held = await attempt('unknown');
    assert.equal(await releasedLoanLandedV1((await held.store.get(held.id))!, TX, reader(ownBatch())), false);
  });

  it('is read from Base for a day after its release, and recorded as what landed (audit LL-1)', async () => {
    const { store, id } = await attempt('unknown');
    assert.ok((await releaseTwice(store, id, QUIET))?.ok === true);
    const landed: ChainV1 = { ...QUIET, latest: 42, pending: 42, later: { hashes: [TX], complete: true }, transactions: { [TX]: { receipt: receiptOf(TX), transaction: ownBatch() } } };
    // A day and a minute later it is left as it was.
    const late = await refreshLoanExecutionV1({ ...id, refresh: true }, deps(store, landed, AGAIN + LOAN_RELEASED_WATCH_MS_V1 + 60_000).deps);
    assert.deepEqual([late?.state, late?.errorCode], ['failed', LOAN_WALLET_SENT_NOTHING_V1]);
    // Within the day, the loan is found and read as confirmed: final, so it holds nothing, and a new review sees it.
    const read = await refreshLoanExecutionV1({ ...id, refresh: true }, deps(store, landed, AGAIN + 60_000).deps);
    assert.deepEqual([read?.state, read?.transactionHash, read?.errorCode], ['confirmed', TX, null]);
    // Nothing of it on Base: it stays released, and nothing is written.
    const quiet = await attempt('unknown', loanReadyFixture(), 'release-draft-quiet');
    assert.ok((await releaseTwice(quiet.store, quiet.id, QUIET))?.ok === true);
    const version = (await quiet.store.get(quiet.id))!.version;
    const unchanged = await refreshLoanExecutionV1({ ...quiet.id, refresh: true }, deps(quiet.store, QUIET, AGAIN + 60_000).deps);
    assert.deepEqual([unchanged?.state, unchanged?.version], ['failed', version]);
  });

  it('does not take a transaction already recorded for another attempt of the same calls', async () => {
    const store = new MemoryLoanExecutionStoreV1();
    const a = await attempt('unknown', loanReadyFixture(), 'release-draft-a', store);
    assert.ok((await releaseTwice(store, a.id, QUIET))?.ok === true);
    // Loan B, with the same calls, landed as TX and was recorded as B's.
    const runB = loanReadyFixture({ signingTermsHash: `0x${'8'.repeat(64)}`, expiresAt: new Date(AGAIN + 30_000).toISOString() });
    const b = await store.putReady({ owner: OWNER, draftId: 'release-draft-b', run: runB, now: new Date(AGAIN) });
    const armedB = await store.arm({ owner: OWNER, executionId: b.executionId, callsHash: runB.callsHash, signingTermsHash: runB.signingTermsHash, now: new Date(AGAIN) });
    assert(armedB.ok);
    const bRecord = (await store.get({ owner: OWNER, executionId: b.executionId }))!;
    assert(await store.recordVerification({ owner: OWNER, executionId: b.executionId, expectedVersion: bRecord.version, state: 'confirmed', transactionHash: TX,
      proof: { receiptFingerprint: 'fixture', blockNumber: '53000900', callsHash: runB.callsHash }, errorCode: null, now: new Date(AGAIN) }));
    const landed: ChainV1 = { ...QUIET, latest: 42, pending: 42, later: { hashes: [TX], complete: true }, transactions: { [TX]: { receipt: receiptOf(TX), transaction: ownBatch() } } };
    const read = await refreshLoanExecutionV1({ ...a.id, refresh: true }, deps(store, landed, AGAIN + 60_000).deps);
    assert.deepEqual([read?.state, read?.errorCode], ['failed', LOAN_WALLET_SENT_NOTHING_V1]);
  });
});

/** Keeps the type of a record in scope for helpers above. */
export type { LoanExecutionV1 };
