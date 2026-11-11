import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import type { VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import type { BaseChainReaderV1, BaseTransactionSourceV1 } from './baseReceiptReader.js';
import type { LendingQuestionV1 } from './lendingDraft.js';
import type { LendingRunV1 } from './lendingReview.js';
import type { LoanExecutionStatusDepsV1 } from './loanExecutionStatus.js';
import { settledFingerprintV1, type LoanExecutionV1, type LoanOwnerV1 } from './loanExecutionStore.js';
import { sameCallDataV1 } from './sponsoredGas.js';

// ---------------------------------------------------------------------------
// A loan in steps, for a wallet that cannot send a batch.
//
// Rabby has no wallet_sendCalls, and Coinbase Wallet with an imported key
// refuses one, so an Aave V4 loan or repayment goes to them as the same
// approved calls, one transaction each (operator, 2026-11-01: «если это не
// сломает текущий флоу»; the batch path is untouched). Three rules hold:
// - each step is the wallet's own transaction carrying exactly approved call
//   `index`, landed after the review;
// - before the next step, the review runs again from the chain as it is now,
//   and its fresh calls must equal the calls still to send;
// - confirmed means every step landed and the effects of all of them together
//   are the loan's, read from the receipts and the position at the last one.
// The hashes travel as one viem EIP-5792 fallback batch id, as swaps in steps
// do, so the batch poller and the store need nothing new.
// ---------------------------------------------------------------------------

/** A payment step needs this much of Bitrefill's price hold left to land in. */
export const PAYMENT_LAND_MARGIN_MS_V1 = 30_000;

/** A loan in steps stopped on purpose: what landed is submitted and the rest will never be sent. */
export const LOAN_STEPS_STOPPED_V1 = 'loan_steps_stopped';

const FALLBACK_MAGIC_V1 = '5792579257925792579257925792579257925792579257925792579257925792';

/** viem's fallback batch id: the transaction hashes, the chain id, the marker. */
export function sequentialBatchIdV1(hashes: readonly string[], chainId = 8453): string {
  return `0x${hashes.map((hash) => hash.slice(2).toLowerCase()).join('')}${chainId.toString(16).padStart(64, '0')}${FALLBACK_MAGIC_V1}`;
}

/** The transaction hashes of a fallback batch id on Base, in order, or null when it is not one. */
export function sequentialHashesV1(batchId: string): HashV1[] | null {
  const id = batchId.toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(id) || !id.endsWith(FALLBACK_MAGIC_V1)) return null;
  const body = id.slice(2, -FALLBACK_MAGIC_V1.length);
  if (body.length < 128 || body.length % 64 !== 0 || body.length > 64 * 17) return null;
  const words = body.match(/.{64}/g)!;
  if (BigInt(`0x${words.pop()!}`) !== 8453n) return null;
  return words.map((word) => `0x${word}` as HashV1);
}

export type LoanStepBindingV1 =
  | { state: 'matched' }
  | { state: 'failed'; errorCode: 'loan_step_reverted' }
  | { state: 'unknown'; errorCode: 'loan_step_out_of_range' | 'loan_step_not_matched' | 'loan_step_predates_review' };

/** One step: the wallet's own transaction, exactly approved call `index`, landed after the review. */
export function bindLoanStepV1(input: { execution: LoanExecutionV1; index: number; transaction: BaseTransactionSourceV1; receipt: VerifiedReceiptSourceV1 }): LoanStepBindingV1 {
  const call = input.execution.run.calls[input.index];
  if (!call) return { state: 'unknown', errorCode: 'loan_step_out_of_range' };
  const { transaction: tx, receipt } = input;
  if (tx.from.toLowerCase() !== input.execution.walletAddress.toLowerCase() || tx.to?.toLowerCase() !== call.to.toLowerCase() ||
      tx.value !== BigInt(call.valueWei) || !sameCallDataV1(tx.input, call.data) ||
      (receipt.from != null && receipt.from.toLowerCase() !== tx.from.toLowerCase())) return { state: 'unknown', errorCode: 'loan_step_not_matched' };
  if (receipt.blockNumber < BigInt(input.execution.run.facts.blockNumber)) return { state: 'unknown', errorCode: 'loan_step_predates_review' };
  return receipt.status === 'success' ? { state: 'matched' } : { state: 'failed', errorCode: 'loan_step_reverted' };
}

/** The question of the calls still to send: the approved one, less a pledge already supplied.
 * Taking a stock back asks the same question again: once the repayment has
 * landed no debt is left, so its fresh review is the withdrawal alone. */
export function remainingQuestionV1(record: LoanExecutionV1, landed: number): LendingQuestionV1 {
  const f = record.run.facts;
  if (f.operation === 'repay') {
    return { operation: 'repay', collateralTokenAddress: f.collateralTokenAddress, amountMode: f.amountMode,
      repayAssets: f.amountMode === 'assets' ? f.requestedAssets : null, maximumAssets: f.maximumDebitAssets,
      ...(f.collateralReturnAssets !== undefined ? { returnCollateral: true as const } : {}) };
  }
  const supplied = record.run.calls.slice(0, landed).some((call) => call.callType === 'deposit');
  return { operation: 'borrow', collateralTokenAddress: f.collateralTokenAddress, borrowAssets: f.requestedAssets!,
    collateralSupplyAssets: supplied ? '0' : f.collateralSupplyAssets };
}

/** Bitrefill's invoice as it stands now, for a loan that pays it (Still Spend). */
export type LoanStepInvoiceReadV1 = { ok: true; status: string } | { ok: false; refusal: 'spend_pay_off' | 'spend_order_unread' | 'spend_invoice_unread' };

const INVOICE_UNREAD_V1: Record<'spend_pay_off' | 'spend_order_unread' | 'spend_invoice_unread', string> = {
  spend_pay_off: 'Paying from Still was turned off on this server',
  spend_order_unread: 'Still no longer holds this Bitrefill invoice (it expired, or the server restarted)',
  spend_invoice_unread: 'Bitrefill’s invoice could not be read just now',
};

/**
 * Before the next step: the same review, from the chain as it is now. It must
 * be ready, and its fresh calls must be exactly the approved calls not yet
 * sent; anything else stops the steps, and the person is told why.
 *
 * A loan that pays a Bitrefill invoice reads the invoice before every step: a
 * loan is not taken for an invoice that no longer waits. The payment goes
 * last; when only the payment is left the loan has landed and a fresh review
 * would borrow again, so the invoice, the exact transfer and the time left on
 * Bitrefill's price are what is checked.
 */
export async function recheckLoanStepsV1(input: {
  record: LoanExecutionV1;
  landed: number;
  review: (question: LendingQuestionV1) => Promise<LendingRunV1>;
  invoice?: () => Promise<LoanStepInvoiceReadV1>;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; refusal: string; detail: string }> {
  const remaining = input.record.run.calls.slice(input.landed);
  if (remaining.length === 0) return { ok: true };
  const payment = input.record.run.facts.payment;
  if (payment) {
    const last = remaining.length === 1;
    const tail = last ? 'so the payment was not sent.' : 'so nothing more was sent.';
    if (last) {
      const call = remaining[0]!;
      if (call.callType !== 'transfer' || call.to.toLowerCase() !== ADDRESSES.usdc.toLowerCase() || call.recipient?.toLowerCase() !== payment.payTo.toLowerCase() ||
          call.amountAtomic !== payment.assets) {
        return { ok: false, refusal: 'spend_payment_step_mismatch', detail: 'The last step is not exactly the payment you approved, so it was not sent.' };
      }
      if (Date.parse(payment.expiresAt) - (input.now ?? new Date()).getTime() < PAYMENT_LAND_MARGIN_MS_V1) {
        return { ok: false, refusal: 'spend_invoice_expiring', detail: `Bitrefill’s hold on this price is ending, ${tail}` };
      }
    }
    const read: LoanStepInvoiceReadV1 = input.invoice ? await input.invoice() : { ok: false, refusal: 'spend_invoice_unread' };
    // With only the payment left the loan has landed: an invoice Bitrefill could not show just now is still
    // open, and the wallet's own USDC may pay it (loanStoppedBeforePaymentV1 below).
    if (!read.ok) return { ok: false, refusal: read.refusal, detail: `${INVOICE_UNREAD_V1[read.refusal]}, ${tail}${
      last && read.refusal === 'spend_invoice_unread' ? ' Your wallet can still pay this invoice from its own USDC while Bitrefill holds the price.' : ''}` };
    if (read.status !== 'unpaid') return { ok: false, refusal: 'spend_invoice_not_unpaid', detail: `Bitrefill reports this invoice as ${read.status.replace(/_/g, ' ')}, ${tail}` };
    if (last) return { ok: true };
  }
  const fresh = await input.review(remainingQuestionV1(input.record, input.landed));
  if (fresh.state !== 'ready') return { ok: false, refusal: fresh.refusal, detail: fresh.detail };
  const same = fresh.calls.length === remaining.length && fresh.calls.every((call, index) => {
    const approved = remaining[index]!;
    return call.to.toLowerCase() === approved.to.toLowerCase() && call.data.toLowerCase() === approved.data.toLowerCase() && call.valueWei === approved.valueWei;
  });
  return same ? { ok: true } : { ok: false, refusal: 'lending_steps_changed',
    detail: 'Checked again from the chain, the next steps differ from the ones you approved, so they were not sent.' };
}

function stepsFingerprintV1(receipts: readonly VerifiedReceiptSourceV1[]): string {
  return stableHashV1('loan-steps-receipts/v1', receipts.map((receipt) => ({ transactionHash: receipt.transactionHash.toLowerCase(),
    blockNumber: receipt.blockNumber.toString(), status: receipt.status,
    logs: receipt.logs.map((log) => ({ address: log.address.toLowerCase(), topics: log.topics.map((topic) => topic.toLowerCase()), data: log.data.toLowerCase() })) })));
}

type LandedStepV1 = { hash: HashV1; transaction: BaseTransactionSourceV1; receipt: VerifiedReceiptSourceV1 };
/** What Base says of the steps Still knows of: each read and bound in order, or where that ended. */
type LandedStepsReadV1 =
  | { state: 'read'; hashes: HashV1[]; steps: LandedStepV1[]; fingerprint: string }
  | { state: 'unread' }
  | { state: 'unavailable' }
  | { state: 'unknown'; hash: HashV1; errorCode: string }
  | { state: 'failed'; hash: HashV1; hashes: HashV1[]; index: number; blockNumber: bigint };

async function readLandedStepsV1(record: LoanExecutionV1, reader: BaseChainReaderV1): Promise<LandedStepsReadV1> {
  const recorded = record.batchId ? sequentialHashesV1(record.batchId) : [];
  // A hash the person pasted from their wallet is read as the next step, bound by the same exact-call,
  // sender and ordering checks as a step Still recorded itself.
  const hint = record.transactionHash;
  const hashes = recorded && hint && !recorded.includes(hint) && recorded.length < record.run.calls.length ? [...recorded, hint] : recorded;
  if (!hashes || hashes.length === 0 || hashes.length > record.run.calls.length) return { state: 'unread' };
  const steps: LandedStepV1[] = [];
  for (const [index, hash] of hashes.entries()) {
    let receipt: VerifiedReceiptSourceV1 | null, transaction: BaseTransactionSourceV1 | null;
    try { [receipt, transaction] = await Promise.all([reader.getTransactionReceipt(hash), reader.getTransaction(hash)]); }
    catch { return { state: 'unavailable' }; }
    if (!receipt || !transaction || receipt.transactionHash.toLowerCase() !== hash) return { state: 'unavailable' };
    const bound = bindLoanStepV1({ execution: record, index, transaction, receipt });
    if (bound.state === 'unknown') return { state: 'unknown', hash, errorCode: bound.errorCode };
    if (bound.state === 'failed') return { state: 'failed', hash, hashes, index, blockNumber: receipt.blockNumber };
    steps.push({ hash, transaction, receipt });
  }
  return { state: 'read', hashes, steps, fingerprint: stepsFingerprintV1(steps.map((step) => step.receipt)) };
}

/** A loan in steps that was stopped before its last step and read as such from Base: the rest is never
 * asked of the wallet again. For a Still Spend loan the last step is the payment, so this loan did not pay
 * its invoice and never will; the person may hold the loan's USDC with nothing bought, and their wallet
 * may pay the same invoice (audit SPEND-2). */
export function loanStoppedBeforePaymentV1(row: Pick<LoanExecutionV1, 'state' | 'errorCode' | 'run' | 'verification'>): boolean {
  const stoppedAt = row.verification?.stoppedAt;
  return row.run.delivery === 'sequential' && row.state === 'failed' && row.errorCode === LOAN_STEPS_STOPPED_V1 &&
    typeof stoppedAt === 'number' && Number.isInteger(stoppedAt) && stoppedAt >= 0 && stoppedAt < row.run.calls.length;
}

/** Reads a loan sent in steps from the chain. Steps still being sent are not judged. */
export async function refreshSequentialLoanExecutionV1(input: { owner: LoanOwnerV1; executionId: string }, record: LoanExecutionV1, deps: LoanExecutionStatusDepsV1): Promise<LoanExecutionV1> {
  if (record.state === 'awaiting_wallet') return record;
  const set = async (state: 'confirmed' | 'failed' | 'unknown', transactionHash: HashV1 | null, proof: Record<string, unknown> | null, errorCode: string | null) =>
    await deps.store.recordVerification({ ...input, expectedVersion: record.version, state, transactionHash, proof, errorCode, now: deps.now() })
      ?? { ...record, state: 'unknown' as const, errorCode: 'loan_execution_changed_while_reading' };
  // Stopped on purpose (declined in the wallet, or refused before it was asked): the rest was never sent,
  // so what landed decides, and a reading that fails keeps the record as it is rather than losing that.
  const stopped = record.errorCode === LOAN_STEPS_STOPPED_V1;
  const read = await readLandedStepsV1(record, deps.reader);
  // A result already read from Base is not read into doubt (audit LEND-4): with the steps' fingerprint on
  // record, only steps that read differently now unsettle it, and steps that cannot be read change nothing.
  const settled = settledFingerprintV1(record);
  if (settled) {
    const contradicted = (read.state === 'read' && read.fingerprint !== settled.fingerprint) || (read.state === 'failed' && record.state === 'confirmed');
    return contradicted ? set('unknown', settled.hash, null, 'loan_receipt_changed') : record;
  }
  if (read.state === 'unread') return set('unknown', record.transactionHash, null, 'loan_steps_unread');
  if (read.state === 'unavailable') return stopped ? record : set('unknown', record.transactionHash, null, 'loan_receipt_unavailable');
  if (read.state === 'unknown') return set('unknown', read.hash, null, read.errorCode);
  if (read.state === 'failed') {
    return set('failed', read.hash, { callsHash: record.run.callsHash, steps: read.hashes, failedStep: read.index, blockNumber: read.blockNumber.toString() }, 'loan_step_reverted');
  }
  const { hashes, steps, fingerprint } = read;
  if (record.verification?.receiptFingerprint && record.verification.receiptFingerprint !== fingerprint) return set('unknown', steps.at(-1)!.hash, null, 'loan_receipt_changed');
  // Stopped part way: what landed is kept, and no loan or repayment is claimed. Stopped on purpose, that is
  // final and holds nothing; otherwise a later step may still be on its way, and the market stays held.
  if (steps.length < record.run.calls.length) {
    // The block of the last step that landed says when the position last moved (positionMovedSinceReviewV1).
    const landed = { callsHash: record.run.callsHash, steps: hashes, stepsLanded: steps.length, receiptFingerprint: fingerprint,
      blockNumber: steps.at(-1)!.receipt.blockNumber.toString() };
    // Stopped by its owner: that, and the transaction count the stop was checked at, stay with it.
    const byOwner = record.verification?.stoppedBy === 'person' ? { stoppedBy: 'person', nonceAfter: record.verification.nonceAfter } : {};
    return stopped ? set('failed', steps.at(-1)!.hash, { ...landed, stoppedAt: steps.length, ...byOwner }, LOAN_STEPS_STOPPED_V1)
      : set('unknown', steps.at(-1)!.hash, landed, 'loan_steps_incomplete');
  }
  const last = steps.at(-1)!;
  let effect: Awaited<ReturnType<LoanExecutionStatusDepsV1['verifyEffectPosition']>>;
  try {
    effect = await deps.verifyEffectPosition({ execution: record, transaction: last.transaction, receipt: last.receipt,
      logs: steps.flatMap((step) => step.receipt.logs), operationNonce: null });
  } catch { return set('unknown', last.hash, null, 'loan_effect_read_unavailable'); }
  if (effect.state !== 'matched') return set('unknown', last.hash, null, effect.errorCode);
  return set('confirmed', last.hash, { receiptFingerprint: fingerprint, blockNumber: last.receipt.blockNumber.toString(), callsHash: record.run.callsHash,
    operationNonce: null, steps: hashes, effect: effect.proof }, null);
}

// ---------------------------------------------------------------------------
// Stopping a loan in steps where it stands (re-audit R3, 2026-11-04).
//
// A step can land while its answer never reaches Still: the page stops, and the
// loan holds its market, so Repay is refused, until every step is read. Its
// owner may stop it after the steps that landed (operator, 2026-11-04: «да
// делать так»). Base is read again, and the wallet's own transaction count
// must show that nothing was sent after the last landed step and nothing waits
// to land; only then is the loan stopped there, as final as a step declined in
// the wallet. A step the wallet still sends afterwards is taken back by its
// hash (nextStoppedStepLandedV1).
// ---------------------------------------------------------------------------

export type LoanStepsStopRefusalV1 = 'lending_attempt_changed' | 'loan_steps_unread' | 'loan_receipt_unavailable' | 'loan_step_not_matched' |
  'loan_step_reverted' | 'loan_receipt_changed' | 'loan_steps_complete' | 'loan_steps_count_unread' | 'loan_steps_later_transaction' | 'loan_steps_transaction_pending';

/** What a refusal to stop tells the person; nothing was recorded. */
export function loanStepsStopDetailV1(refusal: LoanStepsStopRefusalV1, landed: number, total: number, noun: 'loan' | 'repayment' = 'loan'): string {
  const next = `step ${landed + 1} of ${total}`;
  switch (refusal) {
    case 'lending_attempt_changed': return `This ${noun} is no longer waiting on its steps, so there is nothing to stop. Check its onchain result.`;
    case 'loan_steps_unread': return `Still has no step of this ${noun} recorded as landed. If your wallet sent step 1, paste its hash below first.`;
    case 'loan_receipt_unavailable': return 'Base could not be read just now, so nothing was changed. Try again in a minute.';
    case 'loan_steps_count_unread': return 'Your wallet’s transaction count could not be read from Base just now, so nothing was changed. Try again in a minute.';
    case 'loan_step_not_matched': return `A transaction recorded for this ${noun} is not one of its steps, so Still cannot say where it stopped. Paste the hash of the last step that landed.`;
    case 'loan_step_reverted': return `A step of this ${noun} failed onchain. Check the onchain result: it is read as failed, and nothing needs stopping.`;
    case 'loan_receipt_changed': return 'Base no longer shows the steps as Still read them before. Check the onchain result first.';
    case 'loan_steps_complete': return `Every step of this ${noun} landed, so there is nothing to stop. Check the onchain result.`;
    case 'loan_steps_later_transaction': return `Your wallet sent another transaction after step ${landed}. Still cannot tell from Base whether it was ${next}, so this ${noun} was not stopped. If it was, paste its hash below.`;
    case 'loan_steps_transaction_pending': return `Your wallet has a transaction waiting to land on Base, so this ${noun} was not stopped. Wait until it lands, then check the onchain result.`;
  }
}

/** Where a loan in steps stands for its owner: the steps read as landed, and whether it can be stopped there. */
export function loanStepsStandingV1(record: LoanExecutionV1): { landed: number; total: number; stoppable: boolean } | null {
  if (record.run.delivery !== 'sequential') return null;
  const total = record.run.calls.length, read = record.verification?.stepsLanded;
  const landed = typeof read === 'number' && Number.isSafeInteger(read) && read >= 0 && read <= total ? read
    : record.state === 'confirmed' ? total : record.batchId ? sequentialHashesV1(record.batchId)?.length ?? 0 : 0;
  const waiting = ['awaiting_wallet', 'submitted', 'unknown'].includes(record.state) && record.errorCode !== 'conflicting_batch_hints';
  return { landed, total, stoppable: waiting && landed >= 1 && landed < total };
}

/** Stops a loan in steps after the steps that landed, when Base shows the wallet sent nothing since and has
 * nothing waiting. It sends nothing; a refusal records nothing. */
export async function stopSequentialLoanExecutionV1(input: { owner: LoanOwnerV1; executionId: string }, deps: LoanExecutionStatusDepsV1):
  Promise<{ ok: true; record: LoanExecutionV1 } | { ok: false; refusal: LoanStepsStopRefusalV1; detail: string } | null> {
  const record = await deps.store.get(input);
  if (!record) return null;
  const total = record.run.calls.length;
  const refuse = (refusal: LoanStepsStopRefusalV1, landed: number) => ({ ok: false as const, refusal,
    detail: loanStepsStopDetailV1(refusal, landed, total, record.run.facts.operation === 'repay' ? 'repayment' : 'loan') });
  if (record.run.delivery !== 'sequential') return refuse('lending_attempt_changed', 0);
  if (record.state === 'failed' && record.errorCode === LOAN_STEPS_STOPPED_V1) return { ok: true, record };
  // What the steps are is read from Base now, not from what Still last recorded of them.
  if (!['awaiting_wallet', 'submitted', 'unknown'].includes(record.state) || record.errorCode === 'conflicting_batch_hints') return refuse('lending_attempt_changed', 0);
  const read = await readLandedStepsV1(record, deps.reader);
  if (read.state === 'unread') return refuse('loan_steps_unread', 0);
  if (read.state === 'unavailable') return refuse('loan_receipt_unavailable', 0);
  if (read.state === 'unknown') return refuse('loan_step_not_matched', 0);
  if (read.state === 'failed') return refuse('loan_step_reverted', read.index);
  const landed = read.steps.length;
  if (record.verification?.receiptFingerprint && record.verification.receiptFingerprint !== read.fingerprint) return refuse('loan_receipt_changed', landed);
  if (landed >= total) return refuse('loan_steps_complete', landed);
  // The wallet's own count: the last landed step was its transaction number `nonce`, so with nothing sent
  // since, it has sent nonce + 1, and the node holds nothing more pending.
  const nonce = read.steps.at(-1)!.transaction.nonce;
  let latest: number | null = null, pending: number | null = null;
  try {
    const reader = deps.reader;
    if (reader.getTransactionCount) [latest, pending] = await Promise.all([reader.getTransactionCount(record.walletAddress, 'latest'), reader.getTransactionCount(record.walletAddress, 'pending')]);
  } catch { /* unread below */ }
  if (nonce === undefined || !Number.isSafeInteger(nonce) || latest === null || pending === null || latest < nonce + 1 || pending < latest) return refuse('loan_steps_count_unread', landed);
  if (latest > nonce + 1) return refuse('loan_steps_later_transaction', landed);
  if (pending > latest) return refuse('loan_steps_transaction_pending', landed);
  const last = read.steps.at(-1)!;
  const stopped = await deps.store.recordVerification({ ...input, expectedVersion: record.version, state: 'failed', transactionHash: last.hash,
    proof: { callsHash: record.run.callsHash, steps: read.hashes, stepsLanded: landed, receiptFingerprint: read.fingerprint, stoppedAt: landed,
      stoppedBy: 'person', nonceAfter: latest, blockNumber: last.receipt.blockNumber.toString() }, errorCode: LOAN_STEPS_STOPPED_V1, batchId: sequentialBatchIdV1(read.hashes), now: deps.now() });
  return stopped ? { ok: true, record: stopped } : refuse('lending_attempt_changed', landed);
}

/** A step of a stopped loan that the wallet sent after all: taken back only when this hash is exactly the
 * next step, landed after the review, so a wrong paste never holds the market again. The steps the stop
 * read stay recorded with it. */
export async function nextStoppedStepLandedV1(record: LoanExecutionV1, hash: HashV1, reader: BaseChainReaderV1): Promise<{ batchId: string } | null> {
  const read = record.verification?.steps;
  if (record.run.delivery !== 'sequential' || record.state !== 'failed' || record.errorCode !== LOAN_STEPS_STOPPED_V1 ||
      !Array.isArray(read) || read.length === 0 || read.length >= record.run.calls.length ||
      read.some((step) => typeof step !== 'string' || !/^0x[0-9a-f]{64}$/.test(step)) || read.includes(hash)) return null;
  let receipt: VerifiedReceiptSourceV1 | null, transaction: BaseTransactionSourceV1 | null;
  try { [receipt, transaction] = await Promise.all([reader.getTransactionReceipt(hash), reader.getTransaction(hash)]); }
  catch { return null; }
  if (!receipt || !transaction || receipt.transactionHash.toLowerCase() !== hash) return null;
  const bound = bindLoanStepV1({ execution: record, index: read.length, transaction, receipt });
  return bound.state === 'unknown' ? null : { batchId: sequentialBatchIdV1(read as HashV1[]) };
}
