'use client';

import { useState } from 'react';

import { loopBrandByIdV1, loopBrandProductsV1, type LoopBrandIdV1 } from '@mioagent/still-engine/loops';

import type { LendingLoopWireV1 } from '../console/lendingReviewView';
import { StillIconV1 } from './icons';

export { loopBrandByIdV1, loopBrandProductsV1, type LoopBrandIdV1 };

/** Where a brand's row on /loops goes: Spend, on that brand's own cards in the reader's country. */
export const stillLoopSpendHrefV1 = (brand: LoopBrandIdV1): string => `/spend?card=${brand}`;

// ---------------------------------------------------------------------------
// A numbered Loop on the loan's own result: its number, Bitrefill's word on
// the card, and the owner's one choice, the wall. Nothing goes public until
// they press it; the wall shows the number, the brand, the card, the price to
// the dollar and the day, never the wallet or the transaction.
// ---------------------------------------------------------------------------

/** As the server's table says them (lib/still-engine/src/loops.ts); the article is the one a reader says. */
export const LOOP_BRAND_WORDS_V1: Readonly<Record<LendingLoopWireV1['brand'], { name: string; card: string; article: 'A' | 'An' }>> = {
  apple: { name: 'Apple', card: 'Apple gift card', article: 'An' },
  amazon: { name: 'Amazon', card: 'Amazon gift card', article: 'An' },
  google: { name: 'Google', card: 'Google Play card', article: 'A' },
  meta: { name: 'Meta', card: 'Meta Quest card', article: 'A' },
  microsoft: { name: 'Microsoft', card: 'Xbox card', article: 'An' },
};

/** "Apple stock stayed. An Apple gift card arrived." */
export function loopSentenceV1(brand: LendingLoopWireV1['brand']): string {
  const words = LOOP_BRAND_WORDS_V1[brand];
  return `${words.name} stock stayed. ${words.article} ${words.card} arrived.`;
}

/** What a post says beside a Loop's card; the card says the rest. */
export function loopShareTextV1(loop: Pick<LendingLoopWireV1, 'loopNo' | 'brand'>): string {
  return `Loop #${loop.loopNo}: ${loopSentenceV1(loop.brand)} Borrowed on Base through Still, nothing sold.`;
}

const UNDELIVERED_V1: Record<NonNullable<LendingLoopWireV1['undelivered']>, string> = {
  blocked: 'blocked the order',
  denied: 'declined the order',
  payment_error: 'could not match the payment',
};

export interface StillLoopOfferModelV1 {
  loop: LendingLoopWireV1;
  /** Puts it on the wall. Resolves with the name shown, null for "Loop #N"; rejects when the wall could not take it. */
  onWall: (showName: boolean) => Promise<{ label: string | null }>;
  /** False where a list of Loops says what the wall shows once, under them all. */
  note?: boolean;
  /** In a chat the wall takes the number only: a Basename is put on it from /loops (audit MCP-2). */
  numberOnly?: boolean;
  /** Takes it off the wall again; offered only where the page can (Still's own /loops). */
  offWall?: () => Promise<void>;
}

export function StillLoopOffer({ model }: { model: StillLoopOfferModelV1 }) {
  const { loop } = model;
  const brand = LOOP_BRAND_WORDS_V1[loop.brand];
  const [showName, setShowName] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'failed'>(loop.onWall ? 'done' : 'idle');
  // Known only from this page's own press: after a reload the wall's name is not in what this page reads (audit UI-4).
  const [label, setLabel] = useState<{ value: string | null } | null>(null);
  const [nameMissing, setNameMissing] = useState(false);
  const put = () => {
    setState('sending');
    model.onWall(showName).then(
      (answer) => {
        setLabel({ value: answer.label });
        setNameMissing(showName && answer.label === null);
        setState('done');
      },
      () => setState('failed'),
    );
  };
  return (
    <section className="still-section still-extras still-loop" aria-label={`Loop #${loop.loopNo}`}>
      {/* Its own card, as the order above it has: the moment the stock stayed and the card arrived (2026-11-19). */}
      <div className="still-extra still-loop-card" data-complete={loop.complete ? 'yes' : 'no'}>
        <span className="still-extra-icon"><StillIconV1 name="giftcard" /></span>
        <div className="still-extra-body">
          <h2 className="still-loop-head">Loop #{loop.loopNo}</h2>
          {loop.complete ? (
            <p className="still-loop-line">{loopSentenceV1(loop.brand)}</p>
          ) : loop.undelivered ? (
            <p className="still-warn">
              Bitrefill {UNDELIVERED_V1[loop.undelivered]}, so the card did not arrive and this Loop does not count. Bitrefill’s support handles the refund.
            </p>
          ) : (
            <p className="still-extra-note">It counts once Bitrefill says the card arrived.</p>
          )}
          {loop.team ? <p className="still-extra-note">A Still team Loop: shown as the team’s and not counted.</p> : null}
          {loop.complete && !loop.team ? (
            state === 'done' ? (
              <>
                <p className="still-extra-note still-loop-walled" role="status">
                  On the Loop wall{label === null ? '' : label.value ? ` as ${label.value}` : ` as Loop #${loop.loopNo}`}.
                  {nameMissing ? ' Your wallet has no Basename to show, so the wall shows the number.' : ''}
                </p>
                {model.offWall ? (
                  <button type="button" className="still-btn sec" onClick={() => {
                    setState('sending');
                    model.offWall!().then(() => { setLabel(null); setNameMissing(false); setState('idle'); }, () => setState('failed'));
                  }}>Take it off the wall</button>
                ) : null}
              </>
            ) : (
              <div className="still-share still-loop-actions">
                <button type="button" className="still-btn" disabled={state === 'sending'} onClick={put}>
                  {state === 'sending' ? 'Putting it on the wall…' : 'Put it on the Loop wall'}
                </button>
                {model.numberOnly ? (
                  <span className="still-note still-loop-name">As Loop #{loop.loopNo}. To show your Basename instead, put it on the wall from Still’s Loops page.</span>
                ) : (
                  <label className="still-note still-loop-name">
                    <input type="checkbox" checked={showName} onChange={(event) => setShowName(event.target.checked)} /> Show my Basename
                  </label>
                )}
              </div>
            )
          ) : null}
          {state === 'failed' ? <p className="still-warn" role="status">The wall could not take it just now. Try again in a minute.</p> : null}
        </div>
      </div>
      {model.note === false ? null : (
        <p className="still-note">
          The wall shows the number, the brand, the card, the price to the dollar and the day: never your wallet or the transaction. While loans on Base
          are few, someone could still match those to your loan, and so to your wallet: put it on the wall only if that is fine with you.
          Not affiliated with {brand.name}.
        </p>
      )}
    </section>
  );
}
