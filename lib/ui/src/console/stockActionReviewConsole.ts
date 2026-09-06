import { useCallback, useMemo, useRef, useState } from 'react';

import {
  useStockActionConfirm,
  useStockActionRelease,
  useStockActionReview,
  useStockActionSellTerms,
} from '@mioagent/api-client-react';

import type { StockActionReviewModelV1 } from './StockActionReviewScreen';
import {
  stockSellAmountV1,
  stockSellConfirmAllowedV1,
  stockSellTermsStateV1,
  tokenDecimalV1,
  type StockHoldingV1,
} from './stockSellAmount';

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
  holding?: StockHoldingV1 | null;
  /** What the board below is, on a sell, and why it is not the sale's terms. */
  sizeContext?: {
    boardSizeBasis?: string;
    boardRequestedCashAtomic?: string;
    saleSizeBasis?: string;
    termsEstablished?: boolean;
    detail?: string;
  } | null;
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

/** What the reviewed routers said about one exact token amount. */
export interface StockSellTermsWireV1 {
  status?: 'established' | 'no_route' | 'not_established';
  code?: string;
  sizeMeasured?: boolean;
  tokenAmountAtomic?: string | null;
  tokenDecimals?: number;
  destinationDecimals?: number;
  returnedAtomic?: string | null;
  sources?: { source?: string; status?: string; errorCode?: string | null }[];
  observedAt?: string | null;
  expiresAt?: string | null;
}

/**
 * Why the terms for an exact amount could not be established.
 *
 * The two causes are kept apart on purpose and always will be: routers that
 * answered and refused this size is a fact about the MARKET, and a measurement
 * that did not complete is a fact about MIORAIL. Collapsing them would let our
 * outage be read as a verdict on somebody's position.
 */
export function stockSellTermsFailureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('stock_action_sell_size_unroutable')) {
    return 'The reviewed routers were asked to sell this exact amount and none of them offered a route for it. That is about this size right now — a smaller amount may route. Nothing was confirmed.';
  }
  if (message.includes('stock_sell_terms_measurement_failed') || message.includes('stock_sell_terms_not_measured')) {
    return 'Miorail could not establish what the reviewed routers do at this exact amount. That is a statement about Miorail, never about the market or your position. Nothing was confirmed — try again.';
  }
  if (message.includes('stock_action_sell_exceeds_balance')) {
    return 'That is more of this token than the wallet holds at the block just read. Nothing was measured.';
  }
  if (message.includes('stock_action_sell_requires_exact_size')) {
    return 'Enter an exact token amount. A cash equivalent does not set the amount to sell.';
  }
  if (/stock_action_(?:balance|token_decimals)_unread|market_reality_chain_unavailable/.test(message)) {
    return 'The server could not read the current token balance, so it measured nothing. Refresh this review and try again.';
  }
  return 'These terms could not be established on this server. Nothing was measured, nothing was confirmed, and this is not a statement about the security.';
}

/** Why a confirmation did not happen. The issuer refusal is first because it is
 * the one cause that is not about Miorail at all. */
export function stockConfirmFailureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('issuer_transfer_policy_denied')) {
    return 'The token’s own policy registry refuses this wallet for this action, so no clearance was issued. That is the issuer’s rule, read on chain — Miorail does not set it and cannot lift it.';
  }
  if (message.includes('stock_action_sell_exceeds_balance')) {
    return 'The wallet balance changed or is below the amount entered. Refresh this review and confirm an available token amount.';
  }
  if (message.includes('stock_action_sell_size_unroutable') || message.includes('stock_sell_terms_')) {
    return stockSellTermsFailureCopyV1(error);
  }
  if (message.includes('stock_action_sell_requires_exact_size')) {
    return 'Enter and confirm an exact token amount. A cash equivalent does not set the amount to sell.';
  }
  if (/stock_action_(?:balance|token_decimals)_unread|market_reality_chain_unavailable/.test(message)) {
    return 'The server could not read the current token balance. Refresh the review before confirming again.';
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
    return 'This clearance does not contain a confirmed token amount. Open the sell review and confirm the exact amount again.';
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
  /**
   * Record what the wallet did, through the ONE submission route this codebase
   * has. Optional so a host that cannot record still opens a wallet — refusing
   * to transact over a bookkeeping failure would be the worse trade.
   */
  recordSubmission?: (input: {
    routeRunId: string;
    blueprintId: string;
    approvedCallsHash: string;
    batchId: string;
  }) => Promise<unknown>;
}): { model: StockActionReviewModelV1; body: StockActionReviewWireV1 | null } {
  const review = useStockActionReview(input.draft);
  const confirm = useStockActionConfirm();
  const sellTerms = useStockActionSellTerms();
  const release = useStockActionRelease();
  const [walletError, setWalletError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [sellInput, setSellInput] = useState({ draft: input.draft, value: '' });
  const openingWallet = useRef(false);
  const [walletBusy, setWalletBusy] = useState(false);

  const body = (review.data ?? null) as StockActionReviewWireV1 | null;
  const confirmed = (confirm.variables?.draft === input.draft ? confirm.data ?? null : null) as { clearance?: string; expiresAt?: string } | null;
  const sellValue = sellInput.draft === input.draft ? sellInput.value : '';
  const isSell = body?.question?.direction === 'sell';
  const sell = stockSellAmountV1(sellValue, body?.holding);

  // ---------------------------------------------------------------------
  // Phase 17.9 — the terms belong to ONE amount, and the amount can change.
  //
  // Keyed off the mutation's own variables rather than mirrored into state:
  // the only question that matters is whether the terms on screen were
  // established for the number currently in the box, and a copy of the amount
  // kept beside the result is a second place for it to be wrong. Edit the
  // amount and the match simply stops holding, which is exactly the truth —
  // those terms are for a different size.
  // ---------------------------------------------------------------------
  const termsFor =
    sellTerms.variables?.draft === input.draft ? (sellTerms.variables?.tokenAmountAtomic ?? null) : null;
  const termsWire = ((sellTerms.data as { terms?: StockSellTermsWireV1 } | undefined)?.terms ??
    null) as StockSellTermsWireV1 | null;
  const termsState = stockSellTermsStateV1({
    amountAtomic: sell.atomic,
    askedFor: termsFor,
    pending: sellTerms.isPending,
    status: termsWire?.status ?? null,
  });
  const termsEstablished = stockSellConfirmAllowedV1(termsState, sell.atomic);
  const onEstablishTerms = useCallback(() => {
    if (!input.draft || !sell.atomic || sellTerms.isPending) return;
    sellTerms.mutate({ draft: input.draft, tokenAmountAtomic: sell.atomic });
  }, [input.draft, sell.atomic, sellTerms]);

  const onOpen = useCallback(async () => {
    const clearance = confirmed?.clearance;
    if (!clearance || openingWallet.current) return;
    openingWallet.current = true;
    setWalletBusy(true);
    setWalletError(null);
    try {
      const released = (await release.mutateAsync({
        clearance,
        // One handle for the whole attempt, so a retry re-plans the same intent
        // rather than becoming a second purchase.
        requestId: `stock-action:${(input.draft ?? 'draft').slice(-24)}`,
      })) as {
        action?: { calls?: unknown[]; atomicRequired?: boolean };
        routeRunId?: string;
        blueprintId?: string;
        approvedCallsHash?: string;
      };
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
        return;
      }
      // -------------------------------------------------------------------
      // Tell the server what the wallet did.
      //
      // This is the step that was missing: the batch id used to land in the
      // state above and go nowhere, so a trade that reached the chain left no
      // record anywhere in the app — route history sat at `ready`, the proof
      // was never opened, and asking an assistant what happened returned "not
      // found" about a purchase that had settled.
      //
      // It is a report of the WALLET'S BEHAVIOUR, not a result. Nothing here
      // claims the entry happened; only reconciliation reading the chain does
      // that. A failure to record must not read as a failure to trade, so it
      // is surfaced as its own sentence and never as a wallet error.
      // -------------------------------------------------------------------
      try {
        await input.recordSubmission?.({
          routeRunId: String(released.routeRunId ?? ''),
          blueprintId: String(released.blueprintId ?? ''),
          approvedCallsHash: String(released.approvedCallsHash ?? ''),
          batchId: id,
        });
      } catch {
        setWalletError(
          'Your wallet submitted the batch, and this server could not write down that it did. The batch is real — check your wallet activity. Do not send it again.',
        );
      }
    } catch (error) {
      setWalletError(stockReleaseFailureCopyV1(error));
    } finally {
      openingWallet.current = false;
      setWalletBusy(false);
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
      sellAmount: isSell ? {
        value: sellValue,
        balance: sell.balance,
        atomic: sell.atomic,
        error: sell.error,
        onChange: (value: string) => setSellInput({ draft: input.draft, value }),
        onUseBalance: () => setSellInput({ draft: input.draft, value: sell.balance ?? '' }),
      } : null,
      /**
       * What the reviewed routers do at the exact amount in the box.
       *
       * Null on a buy. On a sell it is never absent: before anything is asked
       * it says so, which is the whole point — the reader must be able to see
       * that the figures on the board are not yet about their size.
       */
      sellTerms: isSell ? {
        state: termsState,
        /** Enabled only when there is an amount to ask about. */
        canEstablish: Boolean(sell.atomic) && !sellTerms.isPending,
        boardDetail: body?.sizeContext?.detail ?? null,
        boardRequestedCashAtomic: body?.sizeContext?.boardRequestedCashAtomic ?? null,
        returned:
          termsEstablished && termsWire?.returnedAtomic && Number.isInteger(termsWire.destinationDecimals)
            ? tokenDecimalV1(termsWire.returnedAtomic, termsWire.destinationDecimals!)
            : null,
        sources: (termsWire?.sources ?? []).map((source) => ({
          source: String(source.source ?? ''),
          status: String(source.status ?? ''),
        })),
        observedAt: termsWire?.observedAt ?? null,
        expiresAt: termsWire?.expiresAt ?? null,
        error: sellTerms.error ? stockSellTermsFailureCopyV1(sellTerms.error) : null,
        onEstablish: onEstablishTerms,
      } : null,
      confirm: {
        pending: confirm.isPending,
        error: confirm.error ? stockConfirmFailureCopyV1(confirm.error) : null,
        clearance: confirmed?.clearance ?? null,
        expiresAt: confirmed?.expiresAt ?? null,
        tokenAmount: isSell && confirmed && confirm.variables?.tokenAmountAtomic && Number.isInteger(body?.holding?.decimals)
          ? `${tokenDecimalV1(confirm.variables.tokenAmountAtomic, body!.holding!.decimals!)} tokens (${confirm.variables.tokenAmountAtomic} base units)` : null,
        // A sell may be confirmed only once the routers have answered about
        // THIS amount. The server refuses the same way and does not trust this
        // — the gate exists so the reader is never offered a button whose
        // meaning the page cannot yet state.
        disabled: isSell && (!sell.atomic || !termsEstablished),
        onConfirm: () => {
          if (isSell && (!sell.atomic || !termsEstablished)) return;
          confirm.mutate({ draft: input.draft ?? '', ...(isSell ? { tokenAmountAtomic: sell.atomic! } : {}) });
        },
      },
      wallet: {
        pending: release.isPending || walletBusy,
        error: walletError,
        batchId,
        onOpen: () => void onOpen(),
      },
    }),
    [review.isLoading, review.error, body, confirm, confirmed, release.isPending, walletBusy, walletError, batchId, onOpen, input, isSell, sellValue, sell.atomic, sell.balance, sell.error, sellTerms.isPending, sellTerms.error, termsWire, termsState, termsEstablished, onEstablishTerms],
  );

  return { model, body };
}
