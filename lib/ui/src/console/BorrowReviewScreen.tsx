import React, { type ReactNode } from 'react';

void React;

import type { BorrowReviewLineV1, BorrowReviewV1 } from './borrowReviewView';

// ---------------------------------------------------------------------------
// The borrow review, written once and mounted by both consoles.
//
// A person reaches this screen two ways and must be told the same thing on
// each: from the console, having typed an amount, or from a link an assistant
// produced. The figures are always the ones this request measured — the link
// carries the question and no number, so there is nothing stale on it to show.
//
// WHAT THIS SCREEN IS FOR
//
// Not "is this a good idea". Miorail has no opinion about that and the screen
// never implies one: no colour says approve, no word says safe, and nothing
// here is a recommendation. What it does is put four things in front of a
// reader that a lending venue's own interface generally does not:
//
//   * the position AFTER, beside the position before, computed by mirroring
//     the contract that decides liquidation rather than by repeating a venue's
//     headline;
//   * how far the collateral price may fall before somebody else closes this
//     position, and what that costs on top of the debt;
//   * every contract the batch touches, with Miorail's own reading of each
//     call and an explicit "not read" where there is none — including the
//     authorisation that OUTLIVES the borrow;
//   * the block it was all measured at, said plainly, once.
//
// A REFUSAL IS THE WHOLE SCREEN
//
// When the verdict is `refused`, there is no confirm button and no projected
// position — only the sentence and the rows that support it. A refusal with a
// disabled button beside it still reads as "nearly".
// ---------------------------------------------------------------------------

/** One prepared call, as the server read it. */
export interface BorrowReviewStepV1 {
  index: number;
  to: string;
  selector: string;
  /** The venue's own words. A label, never evidence. */
  venueDescription: string | null;
  readByMiorail: boolean;
  reading: string;
}

export interface BorrowReviewScreenModelV1 {
  loading: boolean;
  /** A read that failed, in the reader's words. Null when it did not. */
  readError: string | null;
  review: BorrowReviewV1 | null;
  /** Empty on a refusal: there is nothing prepared to show. */
  steps: readonly BorrowReviewStepV1[];
  /** What the simulation established. Null when nothing was executed. */
  measured: { blockNumber: number; arrivedAtomic: string; provider: string } | null;
  wallet: {
    /** Absent when there is nothing to hand over. */
    onOpen?: (() => void) | null;
    pending: boolean;
    error: string | null;
    /** What the wallet returned. Miorail did not sign it. */
    batchId: string | null;
  };
}

function line(label: string, value: BorrowReviewLineV1): ReactNode {
  return (
    <div className="cr-facts" key={label}>
      <p className="cr-name">{label}</p>
      <p className="cr-v mono">{value.collateral}</p>
      <p className="cr-v mono">{value.debt}</p>
      <p className="cr-v mono">{value.health}</p>
      <p className="cr-v mono">{value.liquidationPrice}</p>
    </div>
  );
}

export function BorrowReviewScreen({ model }: { model: BorrowReviewScreenModelV1 }): ReactNode {
  if (model.loading) return <p className="lnote">Measuring this market and this wallet’s position in it…</p>;
  if (model.readError) return <p className="cr-verdict bad">{model.readError}</p>;
  if (!model.review) return <p className="lnote">There is nothing to review.</p>;

  const review = model.review;
  const refused = review.verdict === 'refused';

  return (
    <div className="mr">
      <p className="cr-top">{review.title}</p>
      <p className="cr-name">{review.market.pair}</p>
      <p className="lnote mono">{review.market.id}</p>

      {/* The venue's standing for THIS market, never for the asset, and never
          as a colour: a curated market and one anybody deployed are different
          facts, and a green dot says neither of them. */}
      <p className="lnote">{review.market.standing}</p>
      <div className="cr-chips">
        <span className="pill">{review.market.lltv} LLTV</span>
        <span className="pill">{review.market.rate}</span>
      </div>

      <p className="cr-verdict">{review.ask}</p>

      <div className="mr-board">
        <div className="cr-facts">
          <p className="cr-name">&nbsp;</p>
          <p className="k">Collateral</p>
          <p className="k">Debt</p>
          <p className="k">Health</p>
          <p className="k">Liquidates at</p>
        </div>
        {line('Now', review.before)}
        {/* Absent on a refusal. A projected position printed beside a refusal
            is an invitation to look past it. */}
        {review.after ? line('After this borrow', review.after) : null}
      </div>

      {refused ? (
        <p className="cr-verdict bad">{review.refusal}</p>
      ) : (
        review.warnings.map((warning) => (
          <p className="cr-verdict" key={warning}>
            {warning}
          </p>
        ))
      )}

      <p className="lnote">{review.measuredAt}</p>

      {model.measured ? (
        <p className="lnote">
          These calls were executed once against Base state at block {model.measured.blockNumber.toLocaleString('en-US')}, and{' '}
          {model.measured.arrivedAtomic} base units of the loan asset reached this wallet. That measurement is what this
          review rests on — not what the calldata says it does.
        </p>
      ) : null}

      {model.steps.length > 0 ? (
        <details className="mr-compact">
          <summary>What the venue prepared, and what Miorail could read of it</summary>
          {model.steps.map((step) => (
            <div className="mr-attribution" key={step.index}>
              <p className="mr-attribution-k mono">{step.to}</p>
              <p className="mono d">{step.selector}</p>
              {step.venueDescription ? (
                <p className="lnote">The venue calls this: “{step.venueDescription}”.</p>
              ) : null}
              <p className={step.readByMiorail ? 'cr-verdict' : 'cr-verdict d'}>{step.reading}</p>
            </div>
          ))}
          <p className="lnote">
            A call Miorail did not read is carried as unread rather than described from its label. Its effect is the one
            measured above.
          </p>
        </details>
      ) : null}

      <details className="mr-compact">
        <summary>What this review does not answer</summary>
        {review.notStated.map((note) => (
          <p className="lnote" key={note}>
            {note}
          </p>
        ))}
      </details>

      <p className="lnote">
        Miorail never signs and never broadcasts. It holds no key. The calls above were written by the venue and
        measured here; only your own wallet can send them.
      </p>

      {refused || !model.wallet.onOpen ? null : model.wallet.batchId ? (
        <div className="mr-clearance">
          <p className="cr-verdict good">Submitted from your wallet.</p>
          <code className="mr-clearance-token mono">{model.wallet.batchId}</code>
          <p className="lnote">
            That is the batch your wallet returned. Miorail did not sign it and did not broadcast it — your wallet did.
          </p>
        </div>
      ) : (
        <div className="card-actions">
          <button
            type="button"
            className="btn lg"
            disabled={model.wallet.pending}
            title="Hands the exact calls measured above to your wallet, untouched. Your wallet decides."
            onClick={model.wallet.onOpen}
          >
            {model.wallet.pending ? 'Waiting for your wallet…' : 'Open in your wallet'}
          </button>
          {model.wallet.error ? <p className="cr-verdict bad">{model.wallet.error}</p> : null}
        </div>
      )}
    </div>
  );
}
