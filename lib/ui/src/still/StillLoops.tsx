import React, { useState } from 'react';

import type { SkyStateV1 } from './skyState';
import { StillHeader, StillLink } from './StillFrame';
import { LOOP_BRAND_WORDS_V1 } from './StillLoop';

void React;

// ---------------------------------------------------------------------------
// /loops: Loops in public. The week's count, how to make one, and the wall of
// Loops their owners chose to show. It names no wallet and no transaction.
// ---------------------------------------------------------------------------

export const STILL_LOOPS_V1 = { label: 'Loops', path: '/loops' } as const;

type BrandV1 = keyof typeof LOOP_BRAND_WORDS_V1;
const BRANDS_V1 = Object.keys(LOOP_BRAND_WORDS_V1) as BrandV1[];
const COLLATERAL_V1: Readonly<Record<BrandV1, string>> = { apple: 'AAPLc', amazon: 'AMZNc', google: 'GOOGLc', meta: 'METAc', microsoft: 'MSFTc' };
const VIA_V1 = ['web', 'claude', 'chatgpt', 'grok', 'assistant'] as const;
const VIA_WORDS_V1: Readonly<Record<(typeof VIA_V1)[number], string | null>> = {
  web: null, claude: 'Done in Claude', chatgpt: 'Done in ChatGPT', grok: 'Done in Grok', assistant: 'Done with an AI assistant',
};

export interface StillLoopsWallItemV1 {
  loopNo: number; brand: BrandV1; productName: string; packageLabel: string; priceUsdc: string; venueName: string;
  via: (typeof VIA_V1)[number]; day: string; label: string | null;
}
export interface StillLoopsViewV1 {
  weekStartsAt: string;
  counts: { total: number; week: number; viaAssistant: number; byBrand: Record<BrandV1, number> };
  wall: StillLoopsWallItemV1[];
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/** The public answer as the server sends it, or null: a shape it does not send is read as nothing. */
export function stillLoopsViewV1(value: unknown): StillLoopsViewV1 | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const counts = v.counts as Record<string, unknown> | undefined;
  const byBrand = counts?.byBrand as Record<string, unknown> | undefined;
  if (v.outcome !== 'loops' || !text(v.weekStartsAt, 40) || !counts || !count(counts.total) || !count(counts.week) || !count(counts.viaAssistant)
    || !byBrand || !BRANDS_V1.every((brand) => count(byBrand[brand])) || !Array.isArray(v.wall)) return null;
  const wall: StillLoopsWallItemV1[] = [];
  for (const raw of v.wall.slice(0, 100)) {
    const r = raw as Record<string, unknown>;
    if (!r || !Number.isSafeInteger(r.loopNo) || !BRANDS_V1.includes(r.brand as BrandV1) || !text(r.productName, 120) || !text(r.packageLabel, 84)
      || !text(r.priceUsdc, 14) || !text(r.venueName, 40) || !VIA_V1.includes(r.via as (typeof VIA_V1)[number]) || !text(r.day, 10)
      || !(r.label === null || text(r.label, 80))) continue;
    wall.push({ loopNo: r.loopNo as number, brand: r.brand as BrandV1, productName: r.productName, packageLabel: r.packageLabel, priceUsdc: r.priceUsdc,
      venueName: r.venueName, via: r.via as StillLoopsWallItemV1['via'], day: r.day, label: r.label as string | null });
  }
  return { weekStartsAt: v.weekStartsAt, counts: { total: counts.total, week: counts.week, viaAssistant: counts.viaAssistant,
    byBrand: Object.fromEntries(BRANDS_V1.map((brand) => [brand, byBrand[brand] as number])) as Record<BrandV1, number> }, wall };
}

/** What a reader can ask their assistant, word for word. */
export const STILL_LOOP_PROMPT_V1 = 'Use my Apple stock on Still to get me a €25 Apple gift card.';

export interface StillLoopsModelV1 {
  sky: SkyStateV1;
  /** The public answer; null while Loops are off; undefined while it is read. */
  view: StillLoopsViewV1 | null | undefined;
  failed: boolean;
}

function CopyPromptV1() {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <div className="still-copy">
      <span className="v">{STILL_LOOP_PROMPT_V1}</span>
      <button type="button" aria-label="Copy the request" onClick={() => {
        const write = globalThis.navigator?.clipboard?.writeText(STILL_LOOP_PROMPT_V1);
        if (!write) return setState('failed');
        void write.then(() => setState('done'), () => setState('failed'));
      }}>{state === 'done' ? 'Copied' : state === 'failed' ? 'Select and copy' : 'Copy'}</button>
    </div>
  );
}

export function StillLoops({ model }: { model: StillLoopsModelV1 }) {
  const view = model.view;
  return (
    <div className="still-loops-page">
      <StillHeader title={STILL_LOOPS_V1.label} sky={model.sky}
        lede="Borrow against a company’s stock, get that company’s card, keep the stock." />
      {model.failed ? (
        <p className="still-section still-warn" role="status">The Loops could not be read just now. This is our failure, not a fact about them.</p>
      ) : view === undefined ? (
        <p className="still-section still-note" role="status">Reading the Loops…</p>
      ) : view === null ? (
        <p className="still-section still-note" role="status">Loops are not open yet.</p>
      ) : (
        <>
          <div className="still-section still-safety-figures" aria-label="Loops so far">
            <div className="still-safety-figure"><span className="n">{view.counts.week}</span><span className="t">this week</span></div>
            <div className="still-safety-figure"><span className="n">{view.counts.total}</span><span className="t">in all</span></div>
            <div className="still-safety-figure"><span className="n">{view.counts.viaAssistant}</span><span className="t">done with an AI assistant</span></div>
          </div>
          <section className="still-section" aria-labelledby="still-loops-how">
            <h2 id="still-loops-how" className="still-more-group-head">How a Loop is made</h2>
            <ul className="still-rows">
              {BRANDS_V1.map((brand) => (
                <li key={brand} className="still-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="name">{LOOP_BRAND_WORDS_V1[brand].name}</div>
                    <div className="line">{LOOP_BRAND_WORDS_V1[brand].article} {LOOP_BRAND_WORDS_V1[brand].card}, paid by a loan against {COLLATERAL_V1[brand]}</div>
                  </div>
                  <div className="val"><StillLink href="/spend" className="still-btn sec">Spend</StillLink></div>
                </li>
              ))}
            </ul>
            <p className="still-note">Or ask your assistant with Still connected, in its own words or in these:</p>
            <CopyPromptV1 />
            <p className="still-note"><StillLink href="/assistants">Connect Still to Claude, ChatGPT, Grok, Cursor or Codex</StillLink></p>
          </section>
          <section className="still-section" aria-labelledby="still-loops-wall">
            <h2 id="still-loops-wall" className="still-more-group-head">The wall</h2>
            {view.wall.length === 0 ? (
              <p className="still-note">No Loop is on the wall yet. A Loop goes on it only when its owner puts it there.</p>
            ) : (
              <ul className="still-rows">
                {view.wall.map((item) => (
                  <li key={item.loopNo} className="still-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="name">Loop #{item.loopNo}{item.label ? ` · ${item.label}` : ''}</div>
                      <div className="line">{LOOP_BRAND_WORDS_V1[item.brand].name} stock stayed. {item.productName} ({item.packageLabel}) arrived.</div>
                      <div className="line still-note">{[`about $${item.priceUsdc}`, item.venueName, VIA_WORDS_V1[item.via], item.day].filter(Boolean).join(' · ')}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <div className="still-section still-borrow-foot">
        <p className="still-note">
          Loans have interest and can be liquidated if prices fall: see the rate and the limits before you sign. Still is not a lender, and the wall names
          no wallet and no transaction. Not offered to US persons. Not affiliated with Apple, Amazon, Google, Meta, Microsoft or Bitrefill.
        </p>
        <StillLink href="/safety">How Still keeps a loan safe</StillLink>
      </div>
    </div>
  );
}
