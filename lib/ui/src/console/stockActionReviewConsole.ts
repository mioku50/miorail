import { useCallback, useMemo, useState } from 'react';

import {
  useStockActionConfirm,
  useStockActionRelease,
  useStockActionReview,
} from '@mioagent/api-client-react';

import type { StockActionReviewModelV1 } from './StockActionReviewScreen';

// ---------------------------------------------------------------------------
// Phase 17.7 — the review's reads and refusals, shared.
//
// Everything here is surface-independent: the same three server calls, the same
// sentences for the same failures. What stays outside is the wallet — `lib/ui`
// has no wagmi dependency, and which wallet is reachable is a fact about the
// host, not about the review.
//
// The host therefore supplies ONE function: given the calls the server
// released, get them signed. It returns the batch id the wallet named, or null
// when the wallet accepted and named nothing — which is not a success, because
// there would be no handle to follow it up with.
// ---------------------------------------------------------------------------

export interface StockActionReviewWireV1 {
  outcome?: 'review' | 'refused';
  reason?: string;
  detail?: string;
  evidenceState?: string;
  representation?: { tokenAddress?: string; caip10?: string; issuerId?: string };
  question?: { direction?: 'buy' | 'sell'; requestedCashAtomic?: string; destination?: 'USDC' | 'ETH' };
  reality?: unknown;
  transferEligibility?: never;
  transferGate?: { state?: string; detail?: string; direction?: string } | null;
}

/** Why the review itself could not be read. */
export function stockReviewFailureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('stock_action_draft_expired')) {
    return 'This review link has expired. Drafts are deliberately short-lived, because a review that opens later is about a different market — ask Miorail to prepare it again.';
  }
  if (message.includes('stock_action_draft_wrong_wallet')) {
    return 'This review link belongs to a different wallet. Miorail will not open one account’s review under another’s session.';
  }
  if (message.includes('stock_action_draft_bad_signature') || message.includes('malformed')) {
    return 'This is not a review link this server issued.';
  }
  if (message.includes('authentication_required') || /\b401\b/.test(message)) {
    return 'Your session is not valid for this server, so nothing was read. Signing in again is the fix.';
  }
  return 'This review could not be read on this server. Nothing here is a statement about the security.';
}

/** Why a confirmation did not happen. The issuer refusal is first because it is
 * the one cause that is not about Miorail at all. */
export function stockConfirmFailureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('issuer_transfer_policy_denied')) {
    return 'The token’s own policy registry refuses this wallet for this action, so no clearance was issued. That is the issuer’s rule, read on chain — Miorail does not set it and cannot lift it.';
  }
  if (message.includes('route_policy_changed')) {
    return 'The reviewed measurement basis changed while this page was open, so these are no longer the terms you read. Nothing was confirmed — ask again for a current answer.';
  }
  if (message.includes('stock_action_draft_expired')) {
    return 'This review link expired before it was confirmed. Drafts are deliberately short-lived, because a review confirmed later is a review of a different market.';
  }
  if (message.includes('zero_supply') || message.includes('representation_not_reviewed')) {
    return 'This exact representation is no longer one this answer can carry, so nothing was confirmed and nothing was substituted for it.';
  }
  return 'This could not be confirmed on this server. Nothing was recorded, nothing is executable, and this is not a statement about the security.';
}

/** Why the batch was not offered to the wallet. */
export function stockReleaseFailureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/reject|denied|user cancel/i.test(message)) {
    return 'You declined the batch in your wallet. Nothing was submitted, and nothing changed.';
  }
  if (message.includes('stock_action_refresh_required')) {
    return 'The market moved after you confirmed, so Miorail will not offer the request it planned a moment ago. Nothing was submitted — review the current terms again.';
  }
  if (message.includes('stock_action_blocked')) {
    return 'Miorail’s Safety Kernel refused this plan, so nothing executable was produced and your wallet was never asked.';
  }
  if (message.includes('stock_action_route_unavailable')) {
    return 'No route was found for this exact confirmed question through the reviewed sources. Nothing was prepared.';
  }
  if (message.includes('stock_action_sell_requires_exact_size')) {
    return 'A reviewed sell is "cash worth", which is not a token amount until something prices it — and that price lives about twenty seconds. Selling by exact token amount is not offered on this surface.';
  }
  if (message.includes('clearance') && message.includes('expired')) {
    return 'This clearance expired. It authorises one exact action for a few minutes only — confirm again for a fresh one.';
  }
  return 'The batch could not be prepared on this server. Nothing was submitted, and this is not a statement about the security.';
}

export function useStockActionReviewConsoleV1(input: {
  draft: string | null;
  /** The host's wallet. Returns the batch id, or null when the wallet accepted
   * and named nothing. Throwing is how a decline arrives. */
  sendCalls: (batch: { calls: unknown[]; atomicRequired: boolean }) => Promise<string | null>;
}): { model: StockActionReviewModelV1; body: StockActionReviewWireV1 | null } {
  const review = useStockActionReview(input.draft);
  const confirm = useStockActionConfirm();
  const release = useStockActionRelease();
  const [walletError, setWalletError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);

  const body = (review.data ?? null) as StockActionReviewWireV1 | null;
  const confirmed = (confirm.data ?? null) as { clearance?: string; expiresAt?: string } | null;

  const onOpen = useCallback(async () => {
    setWalletError(null);
    const clearance = confirmed?.clearance;
    if (!clearance) return;
    try {
      const released = (await release.mutateAsync({
        clearance,
        // One handle for the whole attempt, so a retry re-plans the same intent
        // rather than becoming a second purchase.
        requestId: `stock-action:${(input.draft ?? 'draft').slice(-24)}`,
      })) as { action?: { calls?: unknown[]; atomicRequired?: boolean } };
      const calls = released.action?.calls;
      if (!Array.isArray(calls) || calls.length === 0) {
        setWalletError('The server returned no calls for this clearance, so nothing was offered to your wallet.');
        return;
      }
      const id = await input.sendCalls({
        calls,
        atomicRequired: released.action?.atomicRequired !== false,
      });
      setBatchId(id);
      if (!id) {
        setWalletError('Your wallet accepted the batch without returning an id, so its outcome cannot be followed up here.');
      }
    } catch (error) {
      setWalletError(stockReleaseFailureCopyV1(error));
    }
  }, [confirmed?.clearance, input, release]);

  const model = useMemo<StockActionReviewModelV1>(
    () => ({
      loading: review.isLoading,
      readError: review.error ? stockReviewFailureCopyV1(review.error) : null,
      refusedDetail: body?.detail ?? null,
      outcome: body?.outcome ?? null,
      evidenceState: body?.evidenceState ?? null,
      caip10: body?.representation?.caip10 ?? null,
      transferEligibility: (body?.transferEligibility ?? null) as never,
      transferGate: body?.transferGate ?? null,
      confirm: {
        pending: confirm.isPending,
        error: confirm.error ? stockConfirmFailureCopyV1(confirm.error) : null,
        clearance: confirmed?.clearance ?? null,
        expiresAt: confirmed?.expiresAt ?? null,
        onConfirm: () => confirm.mutate(input.draft ?? ''),
      },
      wallet: {
        pending: release.isPending,
        error: walletError,
        batchId,
        onOpen: () => void onOpen(),
      },
    }),
    [review.isLoading, review.error, body, confirm, confirmed, release.isPending, walletError, batchId, onOpen, input],
  );

  return { model, body };
}
