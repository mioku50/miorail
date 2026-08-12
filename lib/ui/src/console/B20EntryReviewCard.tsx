import type { ReactElement } from 'react';
// Reused, not redefined: a second `shortAddressV1` in this package would mean
// two truncation rules and two ways an address could read differently.
import { shortAddressV1 } from './B20WatchScreen';
import { ageLabelV1 } from './consoleState';

// ---------------------------------------------------------------------------
// T68F-B §5/§13 — the Review screen, shared by the interface and the miniapp.
//
// ONE component, because two implementations of "may I show a submit button?"
// drift, and they always drift the same way: one of them offers a second Buy
// for a transaction already in flight. Every state decision here comes from the
// server's projection (`status.state`, `status.canSubmit`, `status.canRefresh`)
// — this file renders them and does not re-derive them.
//
// What it must never do: call the token safe, promise a future exit, or let a
// wallet open from anywhere except the explicit action below.
// ---------------------------------------------------------------------------

/** The server's Review projection. Structurally typed so the miniapp and the
 * interface can pass their own generated types without a shared dependency on
 * either one's client. */
export interface EntryReviewLikeV1 {
  planId: string;
  spend: { asset: string; amountAtomic: string; decimals: 6 };
  receive: {
    tokenAddress: string;
    tokenName: string | null;
    tokenSymbol: string | null;
    tokenDecimals: number | null;
    expectedOutputAtomic: string;
    minimumOutputAtomic: string;
  };
  provider: { providerId: string; providerName: string; sourceKey: string };
  approval: { required: boolean; amountAtomic: string | null };
  clearanceCreatedAt: string;
  clearanceExpiresAt: string;
  certificationBlockNumber: string;
  prepareControlBlockNumber: string | null;
  prepareSimulationBlockNumber: string;
  certificationRoundTripBps: number;
  coverage: 'complete' | 'partial';
  viableRouteConfirmed: boolean;
  bestRouteConfirmed: boolean;
  exitNotice: string;
  expiresAt: string;
  executionAvailable: boolean;
  executionUnavailableReason: string | null;
}

export interface EntryStatusLikeV1 {
  state: string;
  terminalOutcome: string | null;
  batchId: string | null;
  errorCode: string | null;
  actualReceivedAtomic: string | null;
  actualSpentAtomic: string | null;
  confirmedBlockNumber: string | null;
  transactionHashes: string[];
  canSubmit: boolean;
  canRefresh: boolean;
}

/** Atomic base units to a readable decimal string. No BigInt literals: this
 * package is shared with the miniapp, which targets below ES2020. */
export function formatAtomicV1(atomic: string, decimals: number, maxFraction = 4): string {
  if (!/^\d+$/.test(atomic)) return atomic;
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '').slice(0, maxFraction);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}


/**
 * The headline for a state.
 *
 * `entry_reverted` deliberately does NOT say the token is unsafe. The batch was
 * simulated and did not revert then; a revert now is a fact about this attempt
 * against this pool at this block, and stating more than that would be a claim
 * nobody measured.
 */
export const ENTRY_STATE_COPY_V1: Record<string, { title: string; detail: string }> = {
  preparing: {
    title: 'Preparing the entry',
    detail: 'Re-reading the controls, re-quoting the cleared route and simulating the exact calls.',
  },
  review: {
    title: 'Review the entry',
    detail: 'Nothing has been sent. Your wallet opens only when you confirm below.',
  },
  expired: {
    title: 'This plan expired',
    detail:
      'Pools move, so a prepared entry is short-lived by design. Nothing was sent — run the opportunity check again.',
  },
  awaiting_wallet_approval: {
    title: 'Waiting for your wallet',
    detail: 'Approve or reject the request in your wallet. Nothing is sent until you approve it.',
  },
  user_rejected: {
    title: 'You rejected the request',
    detail: 'Nothing was sent and nothing was spent. You can review the entry again below.',
  },
  submitted: {
    title: 'Submitted',
    detail: 'Your wallet accepted the batch. Waiting for the chain to report what happened.',
  },
  reconciling: {
    title: 'Checking what happened',
    detail: 'The batch is onchain. Confirming what your wallet actually spent and received.',
  },
  entry_succeeded: {
    title: 'Entry executed',
    detail: 'Your wallet spent USDC and received the token. The exit was simulated only.',
  },
  entry_reverted: {
    title: 'The entry reverted',
    detail:
      'The batch reached the chain and did not execute. Nothing was acquired. This is a fact about this attempt, not a verdict on the token or the route.',
  },
  submitted_unknown: {
    title: 'Status unresolved',
    detail:
      'Your wallet accepted the batch, but its result cannot be determined right now. Refresh the status — do not submit again, because a transaction may still be in flight.',
  },
  reconciliation_required: {
    title: 'Needs reconciliation',
    detail:
      'The batch confirmed, but what moved does not match the plan. Nothing here is being reported as a completed entry.',
  },
};

/** Why reconciliation refused, in words. A code alone tells a user nothing. */
export const ENTRY_ERROR_COPY_V1: Record<string, string> = {
  wrong_token_received: 'A different token arrived than the one that was cleared.',
  another_recipient: 'The token went to a different address than your wallet.',
  spend_above_profile: 'More USDC left the wallet than the position you approved.',
  output_below_minimum: 'Less arrived than the minimum your slippage tolerance allowed.',
  no_token_received: 'No token arrived. An approval on its own is not an entry.',
  no_quote_asset_spent: 'No USDC left the wallet, so nothing was bought.',
  asset_changes_unavailable: 'The asset movements for this batch could not be read.',
  transaction_hashes_unavailable: 'The wallet did not expose a transaction hash that can be checked on Base.',
  receipt_status_conflict: 'Two verified receipt reads disagree. This proof is locked for manual review.',
  non_atomic_batch_result: 'The supposedly atomic batch returned mixed receipt statuses and needs manual review.',
  status_provider_unavailable: 'The wallet status service could not be reached.',
  status_unknown: 'The wallet could not say what happened to this batch.',
  wallet_request_failed: 'The wallet request could not be opened.',
};

export interface B20EntryReviewCardPropsV1 {
  review: EntryReviewLikeV1;
  status: EntryStatusLikeV1;
  routeProof?: {
    proofId: string;
    proofHash: string;
    finalStatus: string;
    reconciliationState: string;
    approvedCallsHash: string;
    transactionHashes: string[];
  } | null;
  now: Date;
  /** Opens the wallet. Absent means no execution path is wired in this build,
   * and then NO control is rendered — not a disabled one. A greyed-out button
   * is one refactor away from being enabled by accident, and this is the button
   * that spends money. */
  onConfirm?: () => void;
  onRefresh?: () => void;
  onBack?: () => void;
  busy?: boolean;
}

export function B20EntryReviewCard(props: B20EntryReviewCardPropsV1): ReactElement {
  const { review, status, now } = props;
  const copy = ENTRY_STATE_COPY_V1[status.state] ?? ENTRY_STATE_COPY_V1.review!;
  const symbol = review.receive.tokenSymbol ?? 'token';
  const tokenDecimals = review.receive.tokenDecimals ?? 18;
  // The server decides. This component never re-derives whether a wallet may
  // be opened, and the handler must exist for the control to render at all.
  const showConfirm = status.canSubmit && review.executionAvailable && Boolean(props.onConfirm);
  const showRefresh = status.canRefresh && Boolean(props.onRefresh);

  return (
    <div className="panel" data-entry-state={status.state}>
      <div className="ph">
        <h3>{copy.title}</h3>
        <span className="sub">{review.provider.providerName}</span>
        <span className="rt">
          {showConfirm && (
            <button type="button" className="btn" disabled={props.busy} onClick={props.onConfirm}>
              {props.busy ? 'Opening wallet…' : 'Confirm in wallet'}
            </button>
          )}
          {showRefresh && (
            <button type="button" className="btn sec" disabled={props.busy} onClick={props.onRefresh}>
              {status.batchId ? 'Check proof' : 'Refresh status'}
            </button>
          )}
          {props.onBack && (
            <button type="button" className="btn sec" onClick={props.onBack}>
              Back
            </button>
          )}
        </span>
      </div>
      <div className="pb">
        <p className="note">{copy.detail}</p>

        <div>
          <div className="kv">
            <span className="k">Spend</span>
            <b>{formatAtomicV1(review.spend.amountAtomic, 6, 2)} USDC</b>
          </div>
          <div className="kv">
            <span className="k">Receive</span>
            <b>
              {review.receive.tokenName ?? 'Unnamed token'}
              {review.receive.tokenSymbol ? ` (${review.receive.tokenSymbol})` : ''}
            </b>
          </div>
          <div className="kv">
            <span className="k">Token address</span>
            <b className="mono" title={review.receive.tokenAddress}>
              {shortAddressV1(review.receive.tokenAddress)}
            </b>
          </div>
          <div className="kv">
            <span className="k">Expected output</span>
            <b>
              {formatAtomicV1(review.receive.expectedOutputAtomic, tokenDecimals)} {symbol}
            </b>
          </div>
          <div className="kv">
            <span className="k">Minimum output</span>
            <b>
              {formatAtomicV1(review.receive.minimumOutputAtomic, tokenDecimals)} {symbol}
            </b>
          </div>
          <div className="kv">
            <span className="k">Approval</span>
            <b>
              {review.approval.required && review.approval.amountAtomic
                ? `${formatAtomicV1(review.approval.amountAtomic, 6, 2)} USDC — exactly this position`
                : 'Existing allowance used'}
            </b>
          </div>
          <div className="kv">
            <span className="k">Provider</span>
            <b>{review.provider.providerName}</b>
          </div>
          <div className="kv">
            <span className="k">Cleared route</span>
            <b className="mono" title={review.provider.sourceKey}>
              {review.provider.sourceKey}
            </b>
          </div>
          <div className="kv">
            <span className="k">Round trip, certified</span>
            <b>{(review.certificationRoundTripBps / 100).toFixed(2)}% immediate cost</b>
          </div>
          <div className="kv">
            <span className="k">Clearance</span>
            <b>{ageLabelV1((now.getTime() - Date.parse(review.clearanceCreatedAt)) / 1000)} old</b>
          </div>
          <div className="kv">
            <span className="k">Clearance expires</span>
            <b>{review.clearanceExpiresAt}</b>
          </div>
          <div className="kv">
            <span className="k">Certification block</span>
            <b className="mono">{review.certificationBlockNumber}</b>
          </div>
          <div className="kv">
            <span className="k">Control block</span>
            <b className="mono">{review.prepareControlBlockNumber ?? 'not reported'}</b>
          </div>
          <div className="kv">
            <span className="k">Simulation block</span>
            <b className="mono">{review.prepareSimulationBlockNumber}</b>
          </div>
          <div className="kv">
            <span className="k">Coverage</span>
            <b>{review.coverage === 'complete' ? 'Every candidate route checked' : 'Partial sweep'}</b>
          </div>
          <div className="kv">
            <span className="k">Exit</span>
            <b>
              {review.viableRouteConfirmed
                ? 'A route out was confirmed by simulation'
                : 'Not confirmed'}
            </b>
          </div>
          {!review.bestRouteConfirmed && (
            <div className="kv">
              <span className="k">Best route</span>
              {/* Stated, not omitted. "Viable" and "best" are different claims,
                  and a partial sweep can only support the first. */}
              <b>Not confirmed — a cheaper route may exist and was not measured</b>
            </div>
          )}
        </div>

        {/* Mandatory, and never abbreviated. */}
        <p className="note warn">{review.exitNotice}</p>

        {status.state === 'entry_succeeded' && status.actualReceivedAtomic && (
          <p className="note">
            Received {formatAtomicV1(status.actualReceivedAtomic, tokenDecimals)} {symbol} for{' '}
            {formatAtomicV1(status.actualSpentAtomic ?? '0', 6, 2)} USDC
            {status.confirmedBlockNumber ? ` at block ${status.confirmedBlockNumber}` : ''}.
          </p>
        )}
        {status.errorCode && ENTRY_ERROR_COPY_V1[status.errorCode] && (
          <p className="note">{ENTRY_ERROR_COPY_V1[status.errorCode]}</p>
        )}
        {status.batchId && (
          <p className="lnote mono">Wallet batch {shortAddressV1(status.batchId)}</p>
        )}
        {props.routeProof && (
          <div className="cardrow" data-b20-route-proof={props.routeProof.finalStatus}>
            <div className="kv">
              <span className="k">Route Proof</span>
              <b className="mono" title={props.routeProof.proofId}>{shortAddressV1(props.routeProof.proofId)}</b>
            </div>
            <div className="kv">
              <span className="k">Proof status</span>
              <b>{props.routeProof.finalStatus} · {props.routeProof.reconciliationState}</b>
            </div>
            <div className="kv">
              <span className="k">Approved calls hash</span>
              <b className="mono" title={props.routeProof.approvedCallsHash}>
                {shortAddressV1(props.routeProof.approvedCallsHash)}
              </b>
            </div>
            {props.routeProof.transactionHashes.map((hash) => (
              <div className="kv" key={hash}>
                <span className="k">Transaction</span>
                <b className="mono" title={hash}>{shortAddressV1(hash)}</b>
              </div>
            ))}
          </div>
        )}
        {!review.executionAvailable && (
          <p className="note">
            This build cannot submit the plan. The plan itself is sound — nothing about the token or
            the route was rejected.
          </p>
        )}
      </div>
    </div>
  );
}
