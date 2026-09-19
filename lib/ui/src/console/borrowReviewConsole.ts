import { useCallback, useRef, useState } from 'react';

import { useBorrowReview } from '@mioagent/api-client-react';

import type { BorrowReviewScreenModelV1, BorrowReviewStepV1 } from './BorrowReviewScreen';
import type { BorrowReviewV1 } from './borrowReviewView';

// ---------------------------------------------------------------------------
// The borrow review's read and its refusals, shared by both consoles.
//
// Everything here is surface-independent: one server call, one set of
// sentences. What stays outside is the wallet — `lib/ui` has no wagmi
// dependency, and which wallet is reachable is a fact about the host.
//
// The host supplies ONE function: given the calls the server measured, get them
// signed. It returns the batch id the wallet named, or null when the wallet
// accepted and named nothing — which is not a success, because there would be
// no handle to follow it up with.
// ---------------------------------------------------------------------------

export interface BorrowReviewWireV1 {
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
  if (/user rejected|denied|rejected the request/i.test(message)) {
    return 'You declined in your wallet. Nothing was sent.';
  }
  return 'Your wallet did not accept the batch. Nothing was sent, and nothing about the market changed.';
}

export function useBorrowReviewConsoleV1(input: {
  draft: string | null;
  /** The host's wallet. Returns the batch id, or null when the wallet accepted
   * and named nothing. Throwing is how a decline arrives. */
  sendCalls: (batch: { calls: { to: string; value: string; data: string }[] }) => Promise<string | null>;
}): { model: BorrowReviewScreenModelV1; body: BorrowReviewWireV1 | null } {
  const review = useBorrowReview(input.draft);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const opening = useRef(false);

  const body = (review.data ?? null) as BorrowReviewWireV1 | null;
  const calls = body?.state === 'ready' ? body.calls ?? [] : [];

  const onOpen = useCallback(async () => {
    if (calls.length === 0 || opening.current) return;
    opening.current = true;
    setWalletBusy(true);
    setWalletError(null);
    try {
      const id = await input.sendCalls({ calls });
      if (id) setBatchId(id);
      else setWalletError('Your wallet accepted the batch and did not name it, so there is nothing to follow it up with.');
    } catch (error) {
      setWalletError(borrowWalletFailureCopyV1(error));
    } finally {
      opening.current = false;
      setWalletBusy(false);
    }
  }, [calls, input]);

  return {
    body,
    model: {
      loading: review.isPending && typeof input.draft === 'string' && input.draft.length > 0,
      readError: review.error ? borrowReviewFailureCopyV1(review.error) : null,
      review: body?.review ?? null,
      steps: body?.steps ?? [],
      measured: body?.state === 'ready' ? body.measured ?? null : null,
      wallet: {
        // No calls means no button: a refusal with a disabled button beside it
        // still reads as "nearly".
        onOpen: calls.length > 0 ? onOpen : null,
        pending: walletBusy,
        error: walletError,
        batchId,
      },
    },
  };
}
