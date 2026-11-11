import { ENTRY_POINT_ADDRESSES_V1 } from '@mioagent/route-proof';

import type { HashV1 } from '@mioagent/route-domain';

import type { BaseChainReaderV1 } from './baseReceiptReader.js';
import { bindLoanTransactionV1, refreshLoanExecutionV1, type LoanExecutionStatusDepsV1 } from './loanExecutionStatus.js';
import { LOAN_WALLET_SENT_NOTHING_V1, type LoanExecutionV1, type LoanOwnerV1 } from './loanExecutionStore.js';

// ---------------------------------------------------------------------------
// A loan or repayment sent as one batch that the wallet never sent
// (audit LEND-1, 2026-11-10).
//
// An armed attempt holds its market (on Aave V4, the whole stocks spoke) until
// Base shows how it ended. When the wallet never sent it, Base shows nothing,
// ever: the tab closed while the wallet asked, or the wallet answered with an
// error that proves nothing either way. From then on every next loan and
// repayment in that market was refused, and nothing could end it.
//
// Its owner may now release it. Never Still by itself, and never on the
// owner's word alone: an unchanged count does not prove a transaction is not
// still on its way, so the release is asked for by the person who knows what
// their wallet did, and granted only when
//   - the review's own time ran out ten minutes ago or more;
//   - reading it once more from Base finds no transaction for it;
//   - the wallet has sent nothing since the block the review was read at: a
//     plain or EIP-7702 account by its transaction count, with nothing waiting
//     at the node; a smart account by its nonce at every EntryPoint Still
//     accepts (key 0, the only one Base Account has used in a Still loan);
//   - the wallet's own service does not say the batch is still on its way.
// Anything unread refuses and records nothing. A transaction that lands after
// all is taken back by its hash (routes/rwaLending.ts), and only if it is
// exactly this review's.
// ---------------------------------------------------------------------------

export { LOAN_WALLET_SENT_NOTHING_V1 };
/** After the review's own time ran out: a wallet still asking has long since been answered or closed. */
export const LOAN_RELEASE_WAIT_MS_V1 = 10 * 60_000;

export type LoanReleaseRefusalV1 = 'lending_attempt_changed' | 'loan_release_too_early' | 'loan_release_wallet_unread'
  | 'loan_release_later_transaction' | 'loan_release_transaction_pending';

const DETAIL_V1: Record<LoanReleaseRefusalV1, string> = {
  lending_attempt_changed: 'This review is not waiting on your wallet any more, so there is nothing to release. Check its onchain result.',
  loan_release_too_early: 'A review can be released ten minutes after its own time ran out; until then your wallet may still send it. Nothing was changed.',
  loan_release_wallet_unread: 'Still could not read from Base what your wallet has sent since this review, so nothing was changed. Try again in a minute.',
  loan_release_later_transaction: 'Your wallet sent a transaction after this review. Still cannot tell from Base whether it was this one, so the review was not released. If it was, paste its hash below.',
  loan_release_transaction_pending: 'Your wallet has a transaction that is still on its way. Cancel it in the wallet, or wait until it lands, then try again. Nothing was changed.',
};
export const loanReleaseDetailV1 = (refusal: LoanReleaseRefusalV1): string => DETAIL_V1[refusal];

const WAITING_V1 = ['awaiting_wallet', 'submitted', 'unknown'];

/** Whether this attempt is one its owner can ask to release, and from when. Null for anything else: a
 * loan in steps has its own stop, and a settled one has nothing to release. */
export function loanReleaseStandingV1(record: LoanExecutionV1, now: Date): { offered: boolean; from: string } | null {
  if (record.run.delivery === 'sequential' || !WAITING_V1.includes(record.state) || record.errorCode === 'conflicting_batch_hints') return null;
  const from = Date.parse(record.run.expiresAt) + LOAN_RELEASE_WAIT_MS_V1;
  return Number.isFinite(from) ? { offered: now.getTime() >= from, from: new Date(from).toISOString() } : null;
}

/** What Base says the wallet has sent since the review's block: nothing (with the count that shows it), or why that cannot be said. */
async function sentNothingSinceV1(record: LoanExecutionV1, reader: BaseChainReaderV1):
  Promise<{ ok: true; proof: Record<string, unknown> } | { ok: false; refusal: LoanReleaseRefusalV1 }> {
  const unread = { ok: false as const, refusal: 'loan_release_wallet_unread' as const };
  const wallet = record.walletAddress, block = BigInt(record.run.measured.blockNumber);
  const kind = reader.getAccountKind ? await reader.getAccountKind(wallet) : null;
  if (kind === null) return unread;
  if (kind === 'contract') {
    if (!reader.getEntryPointNonce) return unread;
    const nonces: Array<{ entryPoint: string; nonce: string }> = [];
    for (const entryPoint of ENTRY_POINT_ADDRESSES_V1) {
      const [then, now] = await Promise.all([reader.getEntryPointNonce(entryPoint, wallet, block), reader.getEntryPointNonce(entryPoint, wallet, 'latest')]);
      if (then === null || now === null || now < then) return unread;
      if (now > then) return { ok: false, refusal: 'loan_release_later_transaction' };
      nonces.push({ entryPoint, nonce: then.toString() });
    }
    return { ok: true, proof: { account: kind, operationNonces: nonces } };
  }
  if (!reader.getTransactionCountAt || !reader.getTransactionCount) return unread;
  const [then, latest, pending] = await Promise.all([reader.getTransactionCountAt(wallet, block), reader.getTransactionCount(wallet, 'latest'), reader.getTransactionCount(wallet, 'pending')]);
  if (then === null || latest === null || pending === null || latest < then || pending < latest) return unread;
  if (latest > then) return { ok: false, refusal: 'loan_release_later_transaction' };
  if (pending > latest) return { ok: false, refusal: 'loan_release_transaction_pending' };
  return { ok: true, proof: { account: kind, transactionCount: then } };
}

/** Releases an attempt its wallet never sent, for its owner, when Base bears that out. It sends nothing;
 * a refusal records nothing. An attempt Base settles while it is read is answered as settled. */
export async function releaseUnsentLoanExecutionV1(input: { owner: LoanOwnerV1; executionId: string },
  deps: LoanExecutionStatusDepsV1 & { readBatchStatus?: (batchId: string) => Promise<number | null> }):
  Promise<{ ok: true; record: LoanExecutionV1 } | { ok: false; refusal: LoanReleaseRefusalV1; detail: string } | null> {
  const refuse = (refusal: LoanReleaseRefusalV1) => ({ ok: false as const, refusal, detail: DETAIL_V1[refusal] });
  const first = await deps.store.get(input);
  if (!first) return null;
  if (first.state === 'failed' && first.errorCode === LOAN_WALLET_SENT_NOTHING_V1) return { ok: true, record: first };
  const standing = loanReleaseStandingV1(first, deps.now());
  if (!standing) return refuse('lending_attempt_changed');
  if (!standing.offered) return refuse('loan_release_too_early');
  // Read once more, as its page does: a transaction Base shows settles it, and then nothing is released.
  const record = await refreshLoanExecutionV1({ ...input, refresh: true }, deps);
  if (!record) return null;
  if (record.state === 'confirmed' || record.state === 'failed') return { ok: true, record };
  if (!loanReleaseStandingV1(record, deps.now())) return refuse('lending_attempt_changed');
  const sent = await sentNothingSinceV1(record, deps.reader);
  if (!sent.ok) return refuse(sent.refusal);
  // The wallet's own word, where it gave a handle its service knows: a batch still on its way is not released.
  let walletStatus: number | null = null;
  if (record.batchId && deps.readBatchStatus) {
    walletStatus = await deps.readBatchStatus(record.batchId).catch(() => null);
    if (walletStatus !== null && walletStatus < 200) return refuse('loan_release_transaction_pending');
    // Included, or reverted onchain: the wallet says a transaction exists, whatever the count read above said.
    if (walletStatus !== null && (walletStatus < 400 || walletStatus >= 500)) return refuse('loan_release_later_transaction');
  }
  const released = await deps.store.recordVerification({ ...input, expectedVersion: record.version, state: 'failed', transactionHash: null,
    proof: { callsHash: record.run.callsHash, releasedBy: 'person', reviewBlock: String(record.run.measured.blockNumber), ...sent.proof,
      ...(walletStatus === null ? {} : { walletStatus }) },
    errorCode: LOAN_WALLET_SENT_NOTHING_V1, now: deps.now() });
  return released ? { ok: true, record: released } : refuse('lending_attempt_changed');
}

/** Whether a transaction is exactly a released review's own calls from its wallet, landed on Base: the only
 * thing that takes a released review back, so a wrong paste never holds the market again. */
export async function releasedLoanLandedV1(record: LoanExecutionV1, hash: HashV1, reader: BaseChainReaderV1): Promise<boolean> {
  if (record.state !== 'failed' || record.errorCode !== LOAN_WALLET_SENT_NOTHING_V1) return false;
  try {
    const [receipt, transaction] = await Promise.all([reader.getTransactionReceipt(hash), reader.getTransaction(hash)]);
    if (!receipt || !transaction || receipt.transactionHash.toLowerCase() !== hash) return false;
    return bindLoanTransactionV1({ execution: record, receipt, transaction }).state !== 'unknown';
  } catch {
    return false;
  }
}
