import type { BorrowReviewStepV1 } from './BorrowReviewScreen';
import type { BorrowReviewV1 } from './borrowReviewView';
import type { FreshBorrowReviewV1 } from './borrowReviewFreshness';
import { borrowUserRejectedV1 } from './borrowSubmissionGuard';

// ---------------------------------------------------------------------------
// The borrow review's read and its refusals, shared by both consoles.
//
// Everything here is surface-independent: one server call, one set of
// sentences. What stays outside is the wallet — `lib/ui` has no wagmi
// dependency, and which wallet is reachable is a fact about the host.
//
// The host supplies ONE function: given the calls the server measured, get them
// signed. It returns the batch id the wallet named, or null when no submission
// handle was established. Neither a missing id nor a timeout proves a failure.
// ---------------------------------------------------------------------------

export interface BorrowReviewWireV1 extends FreshBorrowReviewV1 {
  state?: 'ready' | 'refused';
  stage?: string | null;
  refusal?: string | null;
  detail?: string | null;
  marketId?: string | null;
  review?: BorrowReviewV1 | null;
  steps?: BorrowReviewStepV1[];
  calls?: { to: string; value: string; data: string }[];
  callsHash?: string;
  measured?: { blockNumber: number; arrivedAtomic: string; provider: string } | null;
  borrowDraftId?: string | null;
}

/** Why the review itself could not be read. Each one is a different fact, and
 * the reader is told which. */
export function borrowReviewFailureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('borrow_draft_expired')) {
    return 'This review link has expired. It is deliberately short-lived, because a borrow review that opens later is about a different market — ask Miorail to measure it again.';
  }
  if (message.includes('borrow_draft_wrong_wallet')) {
    return 'This review was prepared for a different wallet. Miorail will not show one wallet’s position to another, and there is no setting that changes that.';
  }
  if (message.includes('borrow_draft_signature_invalid') || message.includes('borrow_draft_malformed')) {
    return 'This link is not one Miorail produced. Nothing was measured and nothing is being offered.';
  }
  if (message.includes('borrow_secret_unavailable')) {
    return 'Miorail cannot open review links right now. That is a fault here, not a finding about this market.';
  }
  if (message.includes('authentication_required')) {
    return 'Sign in with the wallet this review was prepared for. A borrow review is about one wallet’s own position.';
  }
  return 'This review could not be read. Nothing was measured, which is not the same as nothing being available.';
}

/** The wallet failed, in the reader's words — and never as a claim about the
 * market. A decline is the ordinary case and reads as one. */
export function borrowWalletFailureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (borrowUserRejectedV1(error)) {
    return 'You declined in your wallet. Nothing was sent.';
  }
  if (/connector not connected|no connector|wallet.*not connected/i.test(message)) {
    return 'Your wallet is not connected. Connect it before opening this review in your wallet.';
  }
  return 'Your wallet did not return a submission result. Check its activity before trying again; Miorail cannot confirm whether anything was sent.';
}

// The hook that read a borrow review from '/rwa/borrow/review' and sent its calls was removed on 2026-11-11
// with those routes (audit LEND-6): they handed out calls with no record of the attempt. Every review, an
// old assistant link among them, is the owned lending review (useLendingReviewConsole.ts). What stays here
// is the wire shape and the two sets of sentences, which the borrow screen's tests still read.
