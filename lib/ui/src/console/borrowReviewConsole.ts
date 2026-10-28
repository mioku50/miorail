import { useCallback, useEffect, useRef, useState } from 'react';

import { useBorrowReview } from '@mioagent/api-client-react';

import type { BorrowReviewScreenModelV1, BorrowReviewStepV1 } from './BorrowReviewScreen';
import type { BorrowReviewV1 } from './borrowReviewView';
import { handOffFreshBorrowV1, hasBorrowSigningTermsV1, type FreshBorrowReviewV1 } from './borrowReviewFreshness';
import {
  borrowSubmissionKeyV1, borrowSubmissionLockCopyV1, borrowSubmissionMarkerV1, borrowUserRejectedV1,
  BorrowSubmissionLockedErrorV1, BorrowSubmissionStorageErrorV1, submitBorrowOnceV1,
  type BorrowSubmissionMarkerV1,
} from './borrowSubmissionGuard';

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

export function useBorrowReviewConsoleV1(input: {
  draft: string | null;
  walletAddress?: string | null;
  /** The host's wallet. Returns the batch id, or null without a submission
   * handle. Throwing may mean a decline or an uncertain transport outcome. */
  sendCalls: (batch: { calls: { to: string; value: string; data: string }[] }) => Promise<string | null>;
}): { model: BorrowReviewScreenModelV1; body: BorrowReviewWireV1 | null } {
  const review = useBorrowReview(input.draft);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [submission, setSubmission] = useState<{ identity: string; marker: BorrowSubmissionMarkerV1 | null }>({ identity: '', marker: null });
  const opening = useRef(false);
  const confirmedTermsHash = useRef<string | null>(null);
  const identity = `${input.draft ?? ''}:${input.walletAddress?.toLowerCase() ?? ''}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => {
    let active = true;
    confirmedTermsHash.current = null;
    setWalletError(null);
    setBatchId(null);
    void borrowSubmissionKeyV1(input.draft ?? '', input.walletAddress).then(key => {
      if (active) setSubmission({ identity, marker: key ? borrowSubmissionMarkerV1(window.sessionStorage, key) : null });
    }).catch(() => {
      // Storage is checked again before entering the wallet boundary. A failed
      // read here never substitutes a successful acquisition there.
      if (active) setSubmission({ identity, marker: null });
    });
    return () => { active = false; };
  }, [identity, input.draft, input.walletAddress]);

  const body = (review.data ?? null) as BorrowReviewWireV1 | null;
  const signable = hasBorrowSigningTermsV1(body);

  const onOpen = useCallback(async () => {
    if (!signable || opening.current || batchId || (submission.identity === identity && submission.marker)) return;
    opening.current = true;
    setWalletBusy(true);
    setWalletError(null);
    let handedToWallet = false;
    try {
      const result = await handOffFreshBorrowV1({
        seen: body,
        confirmedTermsHash: confirmedTermsHash.current,
        refresh: async () => {
          const answer = await review.refetch({ throwOnError: true });
          if (answer.error) throw answer.error;
          return (answer.data ?? {}) as BorrowReviewWireV1;
        },
        send: async (calls) => {
          let key: string | null;
          try { key = await borrowSubmissionKeyV1(input.draft ?? '', input.walletAddress); }
          catch { throw new BorrowSubmissionStorageErrorV1(); }
          if (!key) throw new Error('Your wallet is not connected');
          if (currentIdentity.current !== identity) throw new Error('The wallet or review changed');
          let storage: Storage;
          try { storage = window.sessionStorage; } catch { throw new BorrowSubmissionStorageErrorV1(); }
          try {
            return await submitBorrowOnceV1({ key, storage, send: () => {
              handedToWallet = true;
              return input.sendCalls({ calls });
            } });
          } finally {
            if (currentIdentity.current === identity) {
              try { setSubmission({ identity, marker: borrowSubmissionMarkerV1(storage, key) }); }
              catch { setSubmission({ identity, marker: 'unknown' }); }
            }
          }
        },
        current: () => currentIdentity.current === identity,
      });
      if (currentIdentity.current !== identity) return;
      if (result.state === 'review_changed') {
        confirmedTermsHash.current = result.termsHash;
        setWalletError(result.message);
      } else {
        confirmedTermsHash.current = null;
        if (result.state === 'refused') setWalletError(result.message);
        else if (result.batchId) setBatchId(result.batchId);
        else setWalletError('Your wallet did not return a batch ID. The submission result is unknown. Check its activity; Miorail will not send this review again.');
      }
    } catch (error) {
      if (currentIdentity.current !== identity) return;
      confirmedTermsHash.current = null;
      setWalletError(error instanceof BorrowSubmissionLockedErrorV1 || error instanceof BorrowSubmissionStorageErrorV1 ? error.message
        : handedToWallet || /wallet is not connected/i.test(error instanceof Error ? error.message : '')
          ? borrowWalletFailureCopyV1(error) : borrowReviewFailureCopyV1(error));
    } finally {
      opening.current = false;
      setWalletBusy(false);
    }
  }, [batchId, body, identity, input, review, signable, submission]);

  return {
    body,
    model: {
      loading: review.isPending && typeof input.draft === 'string' && input.draft.length > 0,
      readError: review.error ? borrowReviewFailureCopyV1(review.error)
        : body?.state === 'ready' && !signable ? 'This review did not establish fresh signing terms. Measure again before opening your wallet.'
          : body?.state === 'refused' && !body.review ? body.detail || 'The server refused this review. Nothing was prepared.' : null,
      review: body?.review ?? null,
      steps: body?.steps ?? [],
      measured: body?.state === 'ready' ? body.measured ?? null : null,
      wallet: {
        // No calls means no button: a refusal with a disabled button beside it
        // still reads as "nearly".
        onOpen: signable && !(submission.identity === identity && submission.marker) ? onOpen : null,
        pending: walletBusy,
        error: walletError,
        batchId,
        submissionLock: submission.identity === identity && submission.marker ? borrowSubmissionLockCopyV1(submission.marker) : null,
      },
    },
  };
}
