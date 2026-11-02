import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import type { VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import type { BaseTransactionSourceV1 } from './baseReceiptReader.js';
import type { LendingQuestionV1 } from './lendingDraft.js';
import type { LendingRunV1 } from './lendingReview.js';
import type { LoanExecutionStatusDepsV1 } from './loanExecutionStatus.js';
import type { LoanExecutionV1, LoanOwnerV1 } from './loanExecutionStore.js';
import { stripErc8021SuffixV1 } from './sponsoredGas.js';

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
      tx.value !== BigInt(call.valueWei) || stripErc8021SuffixV1(tx.input) !== stripErc8021SuffixV1(call.data) ||
      (receipt.from != null && receipt.from.toLowerCase() !== tx.from.toLowerCase())) return { state: 'unknown', errorCode: 'loan_step_not_matched' };
  if (receipt.blockNumber < BigInt(input.execution.run.facts.blockNumber)) return { state: 'unknown', errorCode: 'loan_step_predates_review' };
  return receipt.status === 'success' ? { state: 'matched' } : { state: 'failed', errorCode: 'loan_step_reverted' };
}

/** The question of the calls still to send: the approved one, less a pledge already supplied. */
export function remainingQuestionV1(record: LoanExecutionV1, landed: number): LendingQuestionV1 {
  const f = record.run.facts;
  if (f.operation === 'repay') {
    return { operation: 'repay', collateralTokenAddress: f.collateralTokenAddress, amountMode: f.amountMode,
      repayAssets: f.amountMode === 'assets' ? f.requestedAssets : null, maximumAssets: f.maximumDebitAssets };
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
    if (!read.ok) return { ok: false, refusal: read.refusal, detail: `${INVOICE_UNREAD_V1[read.refusal]}, ${tail}` };
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

/** Reads a loan sent in steps from the chain. Steps still being sent are not judged. */
export async function refreshSequentialLoanExecutionV1(input: { owner: LoanOwnerV1; executionId: string }, record: LoanExecutionV1, deps: LoanExecutionStatusDepsV1): Promise<LoanExecutionV1> {
  if (record.state === 'awaiting_wallet') return record;
  const set = async (state: 'confirmed' | 'failed' | 'unknown', transactionHash: HashV1 | null, proof: Record<string, unknown> | null, errorCode: string | null) =>
    await deps.store.recordVerification({ ...input, expectedVersion: record.version, state, transactionHash, proof, errorCode, now: deps.now() })
      ?? { ...record, state: 'unknown' as const, errorCode: 'loan_execution_changed_while_reading' };
  // Stopped on purpose (declined in the wallet, or refused before it was asked): the rest was never sent,
  // so what landed decides, and a reading that fails keeps the record as it is rather than losing that.
  const stopped = record.errorCode === LOAN_STEPS_STOPPED_V1;
  const recorded = record.batchId ? sequentialHashesV1(record.batchId) : [];
  // A hash the person pasted from their wallet is read as the next step, bound by the same exact-call,
  // sender and ordering checks as a step Still recorded itself.
  const hint = record.transactionHash;
  const hashes = recorded && hint && !recorded.includes(hint) && recorded.length < record.run.calls.length ? [...recorded, hint] : recorded;
  if (!hashes || hashes.length === 0 || hashes.length > record.run.calls.length) return set('unknown', record.transactionHash, null, 'loan_steps_unread');
  const steps: Array<{ hash: HashV1; transaction: BaseTransactionSourceV1; receipt: VerifiedReceiptSourceV1 }> = [];
  for (const [index, hash] of hashes.entries()) {
    let receipt: VerifiedReceiptSourceV1 | null, transaction: BaseTransactionSourceV1 | null;
    try { [receipt, transaction] = await Promise.all([deps.reader.getTransactionReceipt(hash), deps.reader.getTransaction(hash)]); }
    catch { return stopped ? record : set('unknown', record.transactionHash, null, 'loan_receipt_unavailable'); }
    if (!receipt || !transaction || receipt.transactionHash.toLowerCase() !== hash) return stopped ? record : set('unknown', record.transactionHash, null, 'loan_receipt_unavailable');
    const bound = bindLoanStepV1({ execution: record, index, transaction, receipt });
    if (bound.state === 'unknown') return set('unknown', hash, null, bound.errorCode);
    if (bound.state === 'failed') {
      return set('failed', hash, { callsHash: record.run.callsHash, steps: hashes, failedStep: index, blockNumber: receipt.blockNumber.toString() }, bound.errorCode);
    }
    steps.push({ hash, transaction, receipt });
  }
  const fingerprint = stepsFingerprintV1(steps.map((step) => step.receipt));
  if (record.verification?.receiptFingerprint && record.verification.receiptFingerprint !== fingerprint) return set('unknown', steps.at(-1)!.hash, null, 'loan_receipt_changed');
  // Stopped part way: what landed is kept, and no loan or repayment is claimed. Stopped on purpose, that is
  // final and holds nothing; otherwise a later step may still be on its way, and the market stays held.
  if (steps.length < record.run.calls.length) {
    const landed = { callsHash: record.run.callsHash, steps: hashes, stepsLanded: steps.length, receiptFingerprint: fingerprint };
    return stopped ? set('failed', steps.at(-1)!.hash, { ...landed, stoppedAt: steps.length }, LOAN_STEPS_STOPPED_V1)
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
