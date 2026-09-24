import React from 'react';

import { GIFT_SHARE_WARNING_V1, type PublicGiftPageViewV1 } from './giftView';

// ---------------------------------------------------------------------------
// Growth plan step 4: a gift on the proof screen, and the page it is shared as.
//
// X and Farcaster are the two buttons that matter (the operator's call,
// 2026-09-23), so they are the large ones; copying the link is the small one.
// Both open the network's own composer in a new tab — nothing is posted from
// here, and the person edits the text before it goes anywhere.
// ---------------------------------------------------------------------------

export interface GiftShareModelV1 {
  /** The gift link, once the giver created it. */
  url: string | null;
  pending: boolean;
  error: string | null;
  onCreate: () => void;
  xHref: string | null;
  farcasterHref: string | null;
  onCopy: () => void;
  copied: boolean;
}

export interface ProofGiftModelV1 {
  title: string;
  detail: string;
  delivered: boolean;
  /** Null until the receipt shows the transfer: an undelivered gift has
   * nothing to announce. */
  share: GiftShareModelV1 | null;
}

function XMark() {
  return (
    <svg className="share-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

/** Farcaster's arch, drawn plainly. */
function FarcasterMark() {
  return (
    <svg className="share-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 3h16v3.2h-1.6V21h-4.3v-6.3a2.1 2.1 0 0 0-4.2 0V21H5.6V6.2H4z" />
    </svg>
  );
}

export function GiftShareButtons({ x, farcaster }: { x: string; farcaster: string }) {
  return (
    <div className="gift-share-row">
      <a className="btn lg share-x" href={x} target="_blank" rel="noopener noreferrer">
        <XMark />
        Post on X
      </a>
      <a className="btn lg share-fc" href={farcaster} target="_blank" rel="noopener noreferrer">
        <FarcasterMark />
        Cast on Farcaster
      </a>
    </div>
  );
}

export function GiftProofPanel({ gift }: { gift: ProofGiftModelV1 }) {
  const share = gift.share;
  const ready = share && share.url && share.xHref && share.farcasterHref ? share : null;
  return (
    <section className="panel gift-proof" data-delivered={gift.delivered ? 'true' : 'false'} aria-label="Gift">
      <div className="ph">
        <h3>{gift.title}</h3>
      </div>
      <div className="pb">
        <p className="gift-detail">{gift.detail}</p>
        {ready ? (
          <>
            <GiftShareButtons x={ready.xHref!} farcaster={ready.farcasterHref!} />
            <div className="gift-link">
              <span className="mono">{ready.url}</span>
              <button type="button" className="btn sec" onClick={ready.onCopy}>
                {ready.copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </>
        ) : share ? (
          <>
            <p className="lnote">{GIFT_SHARE_WARNING_V1}</p>
            <div className="gift-share-row">
              <button type="button" className="btn lg" onClick={share.onCreate} disabled={share.pending}>
                {share.pending ? 'Creating the gift link…' : 'Share this gift on X or Farcaster'}
              </button>
            </div>
            {share.error ? (
              <p className="empty" role="alert">
                {share.error}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

/** The public gift page's body. Every figure on it comes from the bundle the
 * page verified; the two names are labels that fall back to addresses. */
export function PublicGiftCard({ view }: { view: PublicGiftPageViewV1 }) {
  return (
    <>
      <section className="panel gift-card" aria-label="Gift">
        <div className="pb">
          <p className="eyebrow">A gift on Base</p>
          <h1 className="gift-headline">{view.headline}</h1>
          <div className="amtrow">
            <span className="amount mono">{view.amount}</span>
            <span className="unit">{view.unit}</span>
          </div>
          <p className="gift-what">{view.what}</p>
          <span className={`pill ${view.status.tone}`}>{view.status.label}</span>
          <p className="gift-detail gift-note">{view.note}</p>
          <div className="gift-actions">
            {view.stockHref ? (
              <a className="btn lg" href={view.stockHref}>
                {view.stockLabel}
              </a>
            ) : null}
            <a className="btn sec lg" href={view.identityHref}>
              Is this the real contract?
            </a>
          </div>
          <p className="lnote">{view.giveBack}</p>
        </div>
      </section>

      {view.share ? (
        <section className="panel" aria-label="Share this gift">
          <div className="ph">
            <h3>Share this gift</h3>
          </div>
          <div className="pb">
            <GiftShareButtons x={view.share.x} farcaster={view.share.farcaster} />
          </div>
        </section>
      ) : null}

      <section className="panel" aria-label="The record">
        <div className="ph">
          <h3>The record</h3>
          <span className="rt">
            <a className="btn sec" href={view.proofHref}>
              Full proof
            </a>
          </span>
        </div>
        <div className="pb">
          <dl className="gift-rows">
            {view.rows.map((row) => (
              <React.Fragment key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  {row.href ? (
                    <a href={row.href} target="_blank" rel="noopener noreferrer">
                      {row.value}
                    </a>
                  ) : (
                    row.value
                  )}
                  {row.detail ? <span className="gift-sub mono">{row.detail}</span> : null}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      </section>
    </>
  );
}
