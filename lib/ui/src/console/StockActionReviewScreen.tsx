import React, { type ReactNode } from 'react';

void React;

import { STOCK_ISSUER_NOTICE_V1, transferGateViewV1 } from './marketRealityView';
import {
  TRANSFER_POLICY_FOOTNOTE_V1,
  transferPolicyViewV1,
  type TransferPolicyLineV1,
  type TransferPolicyWireV1,
} from './transferPolicyView';

// ---------------------------------------------------------------------------
// Phase 17.7 — one review screen, two surfaces.
//
// The review lived entirely inside the web interface, so the Base App — the
// surface where a wallet is ALREADY in the reader's hand — had no way to
// confirm a draft or sign what it authorised. An assistant could prepare an
// action for somebody sitting in Base App and there was nowhere for them to
// finish it.
//
// The fix is the one this codebase already uses for the board: the projection
// moves here and both surfaces mount it. The parts that genuinely differ stay
// outside — the shell, navigation, and the wallet call itself, because
// `lib/ui` has no wagmi dependency and a wallet is a property of the host, not
// of the screen.
//
// What must never differ is what a reader is TOLD: which terms, which refusal,
// what a clearance is, and what pressing a button does and does not do. All of
// that is here, written once.
// ---------------------------------------------------------------------------

/** What the reader is told about freshness, in the words the rest of Stocks
 * uses. An expired quote is a legitimate state to review in; it is never
 * described as a current one. */
export const STOCK_REVIEW_EVIDENCE_COPY_V1: Readonly<Record<string, string>> = {
  fresh_quote:
    'A router quote for this exact question is open right now. It lives about twenty seconds.',
  expired_quote:
    'The router quote this was prepared beside has expired. Nothing from the conversation was carried over — measure again for a current answer.',
  no_quote:
    'No router quote is open for this exact question. Measure to establish one before going further.',
};

export interface StockActionReviewModelV1 {
  loading: boolean;
  /** A read that failed, in the reader's words. Null when it did not. */
  readError: string | null;
  /** The server refused this draft outright. */
  refusedDetail: string | null;
  outcome: 'review' | 'refused' | null;
  evidenceState: string | null;
  caip10: string | null;
  transferEligibility: TransferPolicyWireV1 | null;
  transferGate: { state?: string; detail?: string; direction?: string } | null;
  confirm: {
    pending: boolean;
    /** Why the confirmation failed, already in reader copy. */
    error: string | null;
    clearance: string | null;
    expiresAt: string | null;
    onConfirm: () => void;
  };
  /**
   * The wallet step, owned by the host.
   *
   * `lib/ui` has no wagmi dependency and should not gain one: which wallet is
   * reachable is a fact about the surface. What the screen owns is every
   * sentence around it.
   */
  wallet: {
    pending: boolean;
    /** The reader-facing sentence, including a decline, which is not a failure. */
    error: string | null;
    /** Set only once a wallet returned a batch id. */
    batchId: string | null;
    onOpen: () => void;
  };
}

export function StockActionReviewScreen({
  model,
  board,
}: {
  model: StockActionReviewModelV1;
  /** The comparison board. A prop rather than a model field: it needs reads
   * the host already holds, and threading it through the model would make the
   * shared hook depend on the host's own queries. */
  board?: ReactNode;
}) {
  const transferPolicy = transferPolicyViewV1(model.transferEligibility);
  const transferGate = transferGateViewV1(model.transferGate);
  const confirmed = model.confirm.clearance;

  return (
    <section className="mr" aria-label="Stock action review">
      <h3>Review before anything is signed</h3>
      <p className="lnote">
        An assistant prepared this review. It was told which representation and which question —
        never what they cost. Everything below was established on this server just now, under your
        own session.
      </p>

      {model.loading ? <p className="empty">Establishing the current terms…</p> : null}
      {model.readError ? <p className="lnote warn">{model.readError}</p> : null}

      {model.outcome === 'refused' ? (
        <>
          <p className="cr-verdict">{model.refusedDetail ?? 'This review cannot continue.'}</p>
          <p className="lnote">
            Nothing was prepared and nothing is executable. Ask Miorail again for a current answer.
          </p>
        </>
      ) : null}

      {model.outcome === 'review' ? (
        <>
          <p className="cr-verdict">
            {STOCK_REVIEW_EVIDENCE_COPY_V1[model.evidenceState ?? 'no_quote'] ??
              STOCK_REVIEW_EVIDENCE_COPY_V1.no_quote}
          </p>
          {/* The exact address, spelled out. A review that named a ticker would
              be a review of whichever contract the reader assumed. */}
          <p className="lnote mono">{model.caip10}</p>

          {/* The token's own rules about moving it, read on chain. Everything
              else here is about the market; these rules can deny one address
              while the market is perfectly healthy. Rendered only when the
              chain answered: a missing verdict prints nothing rather than
              reassurance. */}
          {transferPolicy ? (
            <>
              <p className="lnote">{transferPolicy.title}</p>
              {transferPolicy.lines.map((line: TransferPolicyLineV1) => (
                <p
                  key={line.text}
                  className={line.tone === 'neutral' ? 'cr-verdict' : `cr-verdict ${line.tone}`}
                >
                  {line.text}
                </p>
              ))}
              <p className="lnote">{TRANSFER_POLICY_FOOTNOTE_V1}</p>
            </>
          ) : null}

          {transferGate ? (
            <div className="mr-gate">
              <span className="pill cr-status" data-tone={transferGate.tone}>
                {transferGate.label}
              </span>
              <p className="mr-gate-detail">{transferGate.detail}</p>
            </div>
          ) : null}

          <p className="lnote">
            Miorail never signs and never broadcasts. It builds the calls and hands them to your
            wallet — only your own Base Account can move anything.
          </p>

          {/* Absent when the issuer's own registry refused: the server would
              refuse anyway, and offering a button that cannot work is worse
              than saying why. */}
          {transferGate?.blocking ? (
            <p className="cr-verdict bad">
              Nothing can be confirmed for this wallet while the issuer’s policy refuses it.
            </p>
          ) : confirmed ? (
            <div className="mr-clearance">
              <p className="cr-verdict good">
                Confirmed. This authorises one exact action and expires shortly.
              </p>
              <p className="mr-gate-detail">
                You can sign here, or hand the clearance back to the assistant that prepared the
                review. Either way the batch is built by this server and approved in your own Base
                Account — the clearance is not a signature and not a transaction.
              </p>
              {model.wallet.batchId ? (
                <>
                  <p className="cr-verdict good">Submitted from your Base Account.</p>
                  <code className="mr-clearance-token mono">{model.wallet.batchId}</code>
                  <p className="lnote">
                    That is the batch your wallet returned. Miorail did not sign it and did not
                    broadcast it — your Base Account did.
                  </p>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn lg"
                    disabled={model.wallet.pending}
                    title="Asks the server for the exact calls, then hands them to your wallet untouched. Your Base Account decides."
                    onClick={model.wallet.onOpen}
                  >
                    {model.wallet.pending ? 'Waiting for your wallet…' : 'Open in your Base Account'}
                  </button>
                  {model.wallet.error ? (
                    <p className="cr-verdict bad">{model.wallet.error}</p>
                  ) : null}
                  <p className="lnote">
                    Miorail builds the calls, re-runs every check including the Safety Kernel, and
                    hands them to your wallet unchanged. It holds no key, signs nothing and
                    broadcasts nothing — you approve the batch, or you decline it.
                  </p>
                </>
              )}
              <details className="mr-compact">
                <summary>The clearance, for an assistant</summary>
                <code className="mr-clearance-token mono">{confirmed}</code>
                <p className="lnote">Expires {model.confirm.expiresAt}</p>
              </details>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="btn lg"
                disabled={model.confirm.pending}
                title="Records that you agreed to these exact terms. Nothing is signed, submitted, or broadcast here."
                onClick={model.confirm.onConfirm}
              >
                {model.confirm.pending ? 'Confirming…' : 'Confirm these terms'}
              </button>
              {model.confirm.error ? (
                <p className="cr-verdict bad">{model.confirm.error}</p>
              ) : null}
              <p className="lnote">
                Confirming records that a person, in their own session, agreed to terms this server
                established just now. It signs nothing, submits nothing and opens no wallet.
              </p>
            </>
          )}

          {/* The board comes AFTER the decision. On a page reviewing ONE exact
              address the comparison is supporting evidence: a reader who has
              read the terms should not have to walk past three other issuers to
              reach the action they came for. */}
          {board}
          <p className="mr-issuer-note">{STOCK_ISSUER_NOTICE_V1}</p>
        </>
      ) : null}
    </section>
  );
}
