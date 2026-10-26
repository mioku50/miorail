import React, { useState, type ReactNode } from 'react';
import type { MirrorReport } from '@mioagent/still-engine/report';
import { formatCents } from '@mioagent/still-engine/format';

import { type ComingUpV1, type HomeViewV1, type MobileInputV1 } from './homeView';
import { SkyLayer } from './Sky';
import { STILL_SHARES_V1, skyCaptionV1, type SkyStateV1 } from './skyState';
import { STILL_ASSISTANTS_V1, StillGlyph, StillLink } from './StillFrame';
import { StillMobile } from './StillMobile';

void React;

// ---------------------------------------------------------------------------
// Home: the sky over New York, your mobile under it, and what you can spend.
//
// Signed in, it reads the wallet's own Mirror. Signed out, it is Still's front
// door: what any Base wallet could borrow without selling, by address or name,
// the check stills.lat has answered since 2026-10-25. It never shows example
// numbers as if they were someone's.
// ---------------------------------------------------------------------------

const TIME_V1 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

function sessionLabelsV1(sky: SkyStateV1): { open: string; close: string } {
  if (!sky.session) return { open: '9:30', close: '4:00' };
  const label = (iso: string) => TIME_V1.format(new Date(iso)).replace(/ [AP]M$/, '');
  return { open: label(sky.session.openAt), close: label(sky.session.closeAt) };
}

function heroLabelV1(sky: SkyStateV1, mobile: MobileInputV1 | null): string {
  const time = sky.phase === 'day' ? `New York at ${sky.clock}: the market is open` : sky.phase === 'night' ? `New York at ${sky.clock}: Wall Street is closed` : `New York at ${sky.clock}: after hours`;
  if (!mobile || mobile.holdings.length === 0) return `${time}. Nothing hangs from the mobile yet.`;
  const names = mobile.holdings.map((h) => h.label).join(', ');
  const loan = mobile.loan && mobile.loan.owedCents > 0 ? `hold up a ${formatCents(BigInt(mobile.loan.owedCents))} loan on the right` : 'hang with nothing borrowed';
  const room = mobile.loan ? `; the dashed square is ${formatCents(BigInt(Math.max(0, mobile.loan.limitCents - mobile.loan.owedCents)))} of room` : '';
  return `${time}. ${names} on the left ${loan}${room}.`;
}

export function StillHero({ sky, mobile }: { sky: SkyStateV1; mobile: MobileInputV1 | null }) {
  const hours = sessionLabelsV1(sky);
  return (
    <div className="still-hero" data-phase={sky.phase}>
      <svg viewBox="0 0 390 310" role="img" aria-label={heroLabelV1(sky, mobile)}>
        <SkyLayer phase={sky.phase} sunShare={sky.sunShare} openLabel={hours.open} closeLabel={hours.close} clouds={sky.clouds.length} />
        {mobile ? <StillMobile input={mobile} /> : null}
      </svg>
      <StillLink href="/" className="still-brand" aria-label="Still home">
        <StillGlyph />
        <span>Still</span>
      </StillLink>
    </div>
  );
}

export function StillSkyCaption({ sky }: { sky: SkyStateV1 }) {
  const caption = skyCaptionV1(sky);
  return (
    <div className="still-section">
      <div className="mono still-clock">NEW YORK · {sky.clock}</div>
      <div style={{ fontWeight: 500, fontSize: 18, marginTop: 2 }}>{caption.headline}</div>
      {caption.detail ? <div className="still-note" style={{ marginTop: 2 }}>{caption.detail}</div> : null}
    </div>
  );
}

const COMING_ICONS_V1: Record<ComingUpV1['icon'], ReactNode> = {
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="currentColor" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="5" fill="#FFB703" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="#FFB703" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  dividend: (
    <>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="var(--sm-blue)" strokeWidth="1.8" />
      <path d="M12 8v8M8 12h8" stroke="var(--sm-blue)" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  earnings: <path d="M5 16a4 4 0 0 1 1-7.9A6 6 0 0 1 17.6 9 3.5 3.5 0 0 1 18 16z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
};

export function StillComingUp({ items }: { items: ComingUpV1[] }) {
  if (items.length === 0) return null;
  return (
    <div className="still-section">
      <div className="still-eyebrow">Coming up</div>
      <ul className="still-coming">
        {items.map((item, index) => (
          <li key={`${item.icon}-${index}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true">{COMING_ICONS_V1[item.icon]}</svg>
            <span>
              <span className="when">{item.when}</span> {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface StillHomeModelV1 {
  sky: SkyStateV1;
  /** The wallet's own Home, or null before it was read. */
  view: HomeViewV1 | null;
  /** The reading's block and time, for the caption under the numbers. */
  reading: MirrorReport['reading'] | null;
  loading: boolean;
  /** Why the wallet could not be read. Never a claim about the wallet. */
  failed: string | null;
  onRetry: () => void;
}

export function StillHomeSignedIn({ model }: { model: StillHomeModelV1 }) {
  const { sky, view } = model;
  return (
    <>
      <StillHero sky={sky} mobile={view?.mobile ?? null} />
      <StillSkyCaption sky={sky} />
      {view ? (
        <>
          <div className="still-section">
            <h1 className="still-word">{view.stateWord}</h1>
            <div className="still-sub">{view.stateLine}</div>
          </div>
          <div className="still-section">
            <div className="still-eyebrow">Available to spend</div>
            {view.available ? (
              <div className="still-big" aria-label={`${view.available.atLeast ? 'At least ' : ''}${view.available.dollars}${view.available.cents} available`}>
                {view.available.atLeast ? <span className="still-sub" style={{ marginTop: 14, marginRight: 8 }}>at least</span> : null}
                <span className="d">{view.available.dollars}</span>
                <span className="c">{view.available.cents}</span>
              </div>
            ) : (
              <div className="still-sub">Not read this time.</div>
            )}
            {view.owed ? (
              <div className="still-owed">
                <span className="sw" aria-hidden="true" />
                <span><strong>{view.owed.amount}</strong> <span className="still-note">· {view.owed.detail}</span></span>
              </div>
            ) : null}
            {model.reading ? (
              <div className="mono still-clock" style={{ marginTop: 8 }}>
                READ FROM BASE · BLOCK {Number(model.reading.block).toLocaleString('en-US')}
              </div>
            ) : null}
          </div>
          {view.failed.length > 0 ? (
            <p className="still-section still-warn">Not read this time: {view.failed.join(', ')}. The amount is what could be proven, a floor.</p>
          ) : null}
        </>
      ) : (
        <h1 className="visually-hidden">Still</h1>
      )}
      {view ? null : model.loading ? (
        <p className="still-section still-note" role="status">Reading your wallet on Base…</p>
      ) : model.failed ? (
        <div className="still-section">
          <p className="still-warn" role="status">Your wallet could not be read just now. This is our failure, not a fact about your wallet.</p>
          <button type="button" className="still-btn sec" onClick={model.onRetry}>Read again</button>
        </div>
      ) : null}
      <div className="still-btns">
        {view ? <>
          <StillLink href="/assets" className="still-btn sec">Your assets</StillLink>
          <StillLink href="/agent" className="still-btn sec">Ask Still</StillLink>
        </> : null}
        <StillLink href={STILL_ASSISTANTS_V1.path} className="still-btn sec">{STILL_ASSISTANTS_V1.label}</StillLink>
      </div>
      {view ? <StillComingUp items={view.comingUp} /> : null}
    </>
  );
}

export interface StillCheckModelV1 {
  sky: SkyStateV1;
  /** The last checked wallet's Home, or null. */
  result: { view: HomeViewV1; report: MirrorReport } | null;
  checking: boolean;
  /** A refusal or a failure, in words: a name nobody uses, an address that is not one, our failure. */
  message: string | null;
  onCheck: (subject: string) => void;
  signInHref: string;
}

export function StillHomeSignedOut({ model }: { model: StillCheckModelV1 }) {
  const [subject, setSubject] = useState('');
  const { sky, result } = model;
  return (
    <>
      <StillHero sky={sky} mobile={result?.view.mobile ?? null} />
      <StillSkyCaption sky={sky} />
      <div className="still-section">
        <h1 className="still-word">Spend without selling.</h1>
        <div className="still-sub">See what the stocks and crypto in a Base wallet could lend you, without selling a share. Read from Base itself.</div>
      </div>
      <form
        className="still-section still-field"
        onSubmit={(event) => {
          event.preventDefault();
          if (subject.trim()) model.onCheck(subject.trim());
        }}
      >
        <label className="visually-hidden" htmlFor="still-subject">Wallet address or name</label>
        <input
          id="still-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="0x… or name.base.eth"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="still-btn" disabled={model.checking || !subject.trim()}>
          {model.checking ? 'Reading…' : 'Check'}
        </button>
      </form>
      {model.message ? <p className="still-section still-note" role="status">{model.message}</p> : null}
      {result ? (
        <div className="still-section">
          <div className="still-eyebrow">{result.report.subject.name ?? `${result.report.subject.address.slice(0, 6)}…${result.report.subject.address.slice(-4)}`} could spend</div>
          {result.view.available ? (
            <div className="still-big">
              {result.view.available.atLeast ? <span className="still-sub" style={{ marginTop: 14, marginRight: 8 }}>at least</span> : null}
              <span className="d">{result.view.available.dollars}</span>
              <span className="c">{result.view.available.cents}</span>
            </div>
          ) : (
            <div className="still-sub">Not read this time.</div>
          )}
          <div className="still-sub">{result.view.stateWord} {result.view.stateLine}</div>
          <div className="mono still-clock" style={{ marginTop: 8 }}>
            READ FROM BASE · BLOCK {Number(result.report.reading.block).toLocaleString('en-US')}
          </div>
        </div>
      ) : null}
      <div className="still-btns">
        <a href={model.signInHref} className="still-btn">Sign in</a>
        <StillLink href={STILL_ASSISTANTS_V1.path} className="still-btn sec">{STILL_ASSISTANTS_V1.label}</StillLink>
      </div>
      <p className="still-section still-note">
        Still lends up to {STILL_SHARES_V1.full}% of each protocol’s limit, and {STILL_SHARES_V1.closed}% for stocks while Wall Street is closed. It never signs for you.
        Not offered to US persons.
      </p>
    </>
  );
}
