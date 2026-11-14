import crypto from 'node:crypto';
import { ENTRY_POINT_ADDRESSES_V1 } from '@mioagent/route-proof';

import type { HashV1 } from '@mioagent/route-domain';

import type { BaseChainReaderV1 } from './baseReceiptReader.js';
import { LOAN_RELEASE_SEARCH_LIMIT_V1, attemptOnBaseSinceV1, bindLoanTransactionV1, refreshLoanExecutionV1, type LoanExecutionStatusDepsV1 } from './loanExecutionStatus.js';
import { LOAN_WALLET_SENT_NOTHING_V1, type LoanExecutionV1, type LoanOwnerV1 } from './loanExecutionStore.js';
import { loanStepsStandingV1 } from './lendingSteps.js';

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
//   - none of the wallet's transactions since the block the review was read
//     at is this review's: a plain or EIP-7702 account by its transaction
//     count, each later transaction read and bound against the review's calls;
//     a smart account by its nonce at every EntryPoint Still accepts (key 0,
//     the only one Base Account has used in a Still loan), each later
//     operation read the same way (audit LL-2, 2026-11-14: any other
//     transaction of the wallet since the review made the release refuse for
//     ever, the same lock the release was made for);
//   - the wallet's own service does not say the batch is on its way or sent,
//     and, for a smart account's batch, answers at all (audit LL-1);
//   - two readings a minute apart find the same (operator, 2026-11-11: «two
//     equal latest nonce reads a minute apart»; audit LL-1: since Denim a
//     node's `pending` is its latest block, so one reading cannot see a
//     transaction the wallet is sending as the person presses). The first
//     press answers "checking" with a signed note of what it read; the page
//     presses again a minute later, and only an equal second reading releases.
// A loan in steps of which no step landed is released the same way, its step 1
// being the transaction that would have been found (audit LL-2).
// Anything unread refuses and records nothing. A transaction that lands after
// all is taken back by its hash (routes/rwaLending.ts), and only if it is
// exactly this review's; for a day after the release Still also reads it from
// Base by itself (loanExecutionStatus.ts).
// ---------------------------------------------------------------------------

export { LOAN_RELEASE_SEARCH_LIMIT_V1, LOAN_WALLET_SENT_NOTHING_V1 };
/** After the review's own time ran out: a wallet still asking has long since been answered or closed. */
export const LOAN_RELEASE_WAIT_MS_V1 = 10 * 60_000;
/** The second of two equal readings comes this long after the first (operator, 2026-11-11). */
export const LOAN_RELEASE_AGAIN_MS_V1 = 60_000;
/** A first reading is good this long; after it the release starts over. */
export const LOAN_RELEASE_CHECK_LIFETIME_MS_V1 = 10 * 60_000;

export type LoanReleaseRefusalV1 = 'lending_attempt_changed' | 'loan_release_too_early' | 'loan_release_wallet_unread'
  | 'loan_release_later_transaction' | 'loan_release_transaction_pending' | 'loan_release_found_transaction'
  | 'loan_release_wallet_busy' | 'loan_release_has_transaction' | 'loan_release_use_stop';

const DETAIL_V1: Record<LoanReleaseRefusalV1, string> = {
  lending_attempt_changed: 'This review is not waiting on your wallet any more, so there is nothing to release. Check its onchain result.',
  loan_release_too_early: 'A review can be released ten minutes after its own time ran out; until then your wallet may still send it. Nothing was changed.',
  loan_release_wallet_unread: 'Still could not read from Base what your wallet has sent since this review, so nothing was changed. Try again in a minute.',
  loan_release_later_transaction: 'Your wallet’s own service says it sent this batch, so the review was not released. Check its onchain result, or paste its hash below.',
  loan_release_transaction_pending: 'Your wallet has a transaction that is still on its way. Cancel it in the wallet, or wait until it lands, then try again. Nothing was changed.',
  loan_release_found_transaction: 'Still found this review’s own transaction on Base, sent after the review, so it was not released: its result is read from that transaction now.',
  loan_release_wallet_busy: `Your wallet sent more than ${LOAN_RELEASE_SEARCH_LIMIT_V1} transactions since this review, more than Still reads one by one, so it was not released. If your wallet sent this review, paste its hash below.`,
  loan_release_has_transaction: 'Still found this review’s transaction on Base, so there is nothing to release: its result is read from that transaction. Check the onchain result.',
  loan_release_use_stop: 'A step of this loan landed, so it is stopped where it stands rather than released: use Stop here, which checks Base the same way.',
};
export const loanReleaseDetailV1 = (refusal: LoanReleaseRefusalV1): string => DETAIL_V1[refusal];

const WAITING_V1 = ['awaiting_wallet', 'submitted', 'unknown'];
/** A hash on the record that is not this review's (a wrong paste): it does not stand in the way of a release. */
const UNBOUND_HASH_V1 = ['loan_receipt_not_matched', 'loan_step_not_matched', 'loan_transaction_hint_unverified'];

/** Why an attempt is not one its owner can release, or null when it is. */
function notReleasableV1(record: LoanExecutionV1): LoanReleaseRefusalV1 | null {
  if (!WAITING_V1.includes(record.state) || record.errorCode === 'conflicting_batch_hints') return 'lending_attempt_changed';
  // A loan in steps of which a step landed has its own stop (lendingSteps.ts).
  if (record.run.delivery === 'sequential' && (loanStepsStandingV1(record)?.landed ?? 0) > 0) return 'loan_release_use_stop';
  // A transaction Still found and bound to this review: it was sent, and its result is read from it (audit LL-5).
  if (record.transactionHash && !UNBOUND_HASH_V1.includes(record.errorCode ?? '')) return 'loan_release_has_transaction';
  return null;
}

/** Whether this attempt is one its owner can ask to release, and from when. Null for anything else: a
 * loan in steps that has a landed step has its own stop, one whose transaction Still found has nothing to
 * release, and a settled one has nothing to release. */
export function loanReleaseStandingV1(record: LoanExecutionV1, now: Date): { offered: boolean; from: string } | null {
  if (notReleasableV1(record)) return null;
  const from = Date.parse(record.run.expiresAt) + LOAN_RELEASE_WAIT_MS_V1;
  return Number.isFinite(from) ? { offered: now.getTime() >= from, from: new Date(from).toISOString() } : null;
}

/** What Base says the wallet has sent since the review's block: nothing (with the count that shows it), or why that cannot be said. */
export async function sentNothingSinceV1(record: LoanExecutionV1, reader: BaseChainReaderV1):
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

// The first of the two readings travels as a signed note, so the second, a minute later, is checked against
// exactly what the first read: no table, no migration, and nothing the page can make up.
const checkKey = (secret: string) => crypto.createHmac('sha256', secret).update('miorail-loan-release-check/v1').digest();
interface ReleaseCheckV1 { executionId: string; wallet: string; reading: string; at: string }
export function signReleaseCheckV1(check: ReleaseCheckV1, secret: string): string {
  const body = Buffer.from(JSON.stringify(check)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', checkKey(secret)).update(body).digest('base64url')}`;
}
export function readReleaseCheckV1(token: unknown, secret: string): ReleaseCheckV1 | null {
  if (typeof token !== 'string' || token.length > 2000 || secret.length < 16) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
  const wanted = Buffer.from(crypto.createHmac('sha256', checkKey(secret)).update(body).digest('base64url')), got = Buffer.from(mac);
  if (wanted.length !== got.length || !crypto.timingSafeEqual(wanted, got)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ReleaseCheckV1;
    return value && typeof value.executionId === 'string' && typeof value.wallet === 'string' && typeof value.reading === 'string' &&
      typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) ? value : null;
  } catch { return null; }
}

export type LoanReleaseAnswerV1 =
  | { ok: true; record: LoanExecutionV1 }
  | { ok: 'checking'; check: string; checkAgainAt: string; record: LoanExecutionV1 }
  | { ok: false; refusal: LoanReleaseRefusalV1; detail: string; record?: LoanExecutionV1 };

/** Releases an attempt its wallet never sent, for its owner, when Base bears that out twice, a minute apart.
 * It sends nothing; a refusal records nothing. An attempt Base settles while it is read is answered as
 * settled, and one whose own transaction the search finds is read from it. */
export async function releaseUnsentLoanExecutionV1(input: { owner: LoanOwnerV1; executionId: string; check?: string | null },
  deps: LoanExecutionStatusDepsV1 & { readBatchStatus?: (batchId: string) => Promise<number | null>; secret: string; againMs?: number }):
  Promise<LoanReleaseAnswerV1 | null> {
  const refuse = (refusal: LoanReleaseRefusalV1, record?: LoanExecutionV1) => ({ ok: false as const, refusal, detail: DETAIL_V1[refusal], ...(record ? { record } : {}) });
  const ids = { owner: input.owner, executionId: input.executionId };
  const first = await deps.store.get(ids);
  if (!first) return null;
  if (first.state === 'failed' && first.errorCode === LOAN_WALLET_SENT_NOTHING_V1) return { ok: true, record: first };
  const blocked = notReleasableV1(first);
  if (blocked) return refuse(blocked);
  if (!loanReleaseStandingV1(first, deps.now())!.offered) return refuse('loan_release_too_early');
  // Read once more, as its page does: a transaction Base shows settles it, and then nothing is released.
  const record = await refreshLoanExecutionV1({ ...ids, refresh: true }, deps);
  if (!record) return null;
  if (record.state === 'confirmed' || record.state === 'failed') return { ok: true, record };
  const again = notReleasableV1(record);
  if (again) return refuse(again);
  const sequential = record.run.delivery === 'sequential';
  const base = await attemptOnBaseSinceV1(record, deps.reader, { afterBlock: BigInt(record.run.measured.blockNumber), stepIndex: sequential ? 0 : null });
  if (base.state === 'unread') return refuse('loan_release_wallet_unread');
  if (base.state === 'busy') return refuse('loan_release_wallet_busy');
  if (base.state === 'pending') return refuse('loan_release_transaction_pending');
  if (base.state === 'found') {
    // Its own transaction: kept as the hint it is, and read from Base now, by the ordinary binding.
    const hinted = await deps.store.recordVerification({ ...ids, expectedVersion: record.version, state: 'unknown', transactionHash: base.hash, proof: null,
      errorCode: 'loan_transaction_hint_unverified', now: deps.now() });
    const read = hinted ? await refreshLoanExecutionV1({ ...ids, refresh: true }, deps).catch(() => hinted) : null;
    return refuse('loan_release_found_transaction', read ?? hinted ?? record);
  }
  // The wallet's own word, where it gave a handle its service knows: a batch on its way or sent is not
  // released, and for a smart account, whose handle is the service's, no word is no release (audit LL-1).
  let walletStatus: number | null = null;
  if (record.batchId && !sequential && deps.readBatchStatus) {
    walletStatus = await deps.readBatchStatus(record.batchId).catch(() => null);
    if (walletStatus === null && base.proof.account === 'contract') return refuse('loan_release_wallet_unread');
    if (walletStatus !== null && walletStatus < 200) return refuse('loan_release_transaction_pending');
    // Included, or reverted onchain: the wallet says a transaction exists, whatever the reading above said.
    if (walletStatus !== null && (walletStatus < 400 || walletStatus >= 500)) return refuse('loan_release_later_transaction');
  }
  const now = deps.now(), againMs = deps.againMs ?? LOAN_RELEASE_AGAIN_MS_V1;
  const note = readReleaseCheckV1(input.check, deps.secret);
  const firstAt = note && note.executionId === record.executionId && note.wallet === record.walletAddress && note.reading === base.reading
    ? Date.parse(note.at) : NaN;
  const age = now.getTime() - firstAt;
  // No first reading yet, or one that read differently or lapsed: this reading is the first, and the next
  // press, a minute from now, is the second.
  if (!(age >= 0 && age <= LOAN_RELEASE_CHECK_LIFETIME_MS_V1)) {
    return { ok: 'checking', check: signReleaseCheckV1({ executionId: record.executionId, wallet: record.walletAddress, reading: base.reading, at: now.toISOString() }, deps.secret),
      checkAgainAt: new Date(now.getTime() + againMs).toISOString(), record };
  }
  if (age < againMs) return { ok: 'checking', check: input.check!, checkAgainAt: new Date(firstAt + againMs).toISOString(), record };
  const released = await deps.store.recordVerification({ ...ids, expectedVersion: record.version, state: 'failed', transactionHash: null,
    proof: { callsHash: record.run.callsHash, releasedBy: 'person', reviewBlock: String(record.run.measured.blockNumber), ...base.proof,
      firstReadAt: new Date(firstAt).toISOString(), secondReadAt: now.toISOString(), ...(walletStatus === null ? {} : { walletStatus }) },
    errorCode: LOAN_WALLET_SENT_NOTHING_V1, now });
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

// ---------------------------------------------------------------------------
// A new loan is not sent on a review the wallet has since moved past
// (audit WAL-6 and LEND-3, 2026-11-10).
//
// Base Account answers "declined" (4001) however its window closed, even after
// the person confirmed in it; Still then makes the review ready again, and a
// second press could send the same loan beside the first, which was on its way
// all along. And any transaction of the wallet after the block a review was
// read at may have changed what that review says.
//
// So before a new loan is armed, Base is asked once whether the wallet has
// sent anything since the review's block. Yes, or one still waiting: the loan
// is not armed, the wallet is not asked, and the page prepares the review
// again. Base not answering is not a yes: the arm goes on, as before. A
// repayment is never asked this.
// ---------------------------------------------------------------------------
export async function walletMovedSinceReviewV1(record: LoanExecutionV1, reader: BaseChainReaderV1): Promise<boolean> {
  if (record.run.facts.operation !== 'borrow') return false;
  try {
    const sent = await sentNothingSinceV1(record, reader);
    return !sent.ok && sent.refusal !== 'loan_release_wallet_unread';
  } catch {
    return false;
  }
}
