import React, { useState, type ReactNode } from 'react';
import type { MirrorReport } from '@mioagent/still-engine/report';
import { formatCents } from '@mioagent/still-engine/format';

import { type ComingUpV1, type HomeViewV1, type MobileInputV1 } from './homeView';
import { SkyLayer } from './Sky';
import { STILL_SHARES_V1, skyCaptionV1, type SkyStateV1 } from './skyState';
import { STILL_ASSISTANTS_V1, StillGlyph, StillLink } from './StillFrame';
import { StillMobile } from './StillMobile';
import type { TelegramAlertsModelV1 } from '../console/TelegramAlertsStrip';
import { composerLinksV1 } from '../console/composerLinks';
import { ShareLinkV1 } from '../console/shareHost';

void React;

// ---------------------------------------------------------------------------
// Home: Berlin's visual sky, the US market clock and modelled borrowing room.
//
// Signed in, it reads the wallet's own Mirror. Signed out, it is Still's front
// door: what any Base wallet could borrow without selling, by address or name,
// the check stills.lat has answered since 2026-10-25. It never shows example
// numbers as if they were someone's.
// ---------------------------------------------------------------------------

function heroLabelV1(sky: SkyStateV1, mobile: MobileInputV1 | null): string {
  const time = `Berlin at ${sky.clock}. New York at ${sky.marketClock}: ${sky.marketPhase === 'open' ? 'the market is open' : sky.marketPhase === 'closed' ? 'Wall Street is closed' : sky.marketPhase === 'before_open' ? 'before the open' : 'after hours'}`;
  if (!mobile || mobile.holdings.length === 0) return `${time}. No reviewed holdings are shown in the diagram yet.`;
  const names = mobile.holdings.map((h) => h.label).join(', ');
  const loan = mobile.loan && mobile.loan.owedCents > 0 ? `hold up a ${mobile.loan.owedLabel ?? formatCents(BigInt(mobile.loan.owedCents))} loan on the right` : 'are shown as reviewed holdings';
  const room = mobile.loan ? `; the dashed square is ${formatCents(BigInt(Math.max(0, mobile.loan.limitCents - mobile.loan.owedCents)))} of modelled room` : '';
  return `${time}. ${names} on the left ${loan}${room}.`;
}

export function StillHero({ sky, mobile }: { sky: SkyStateV1; mobile: MobileInputV1 | null }) {
  const hours = sky.daylightLabels;
  return (
    <div className="still-hero" data-phase={sky.phase}>
      <svg className="still-sky-scene" viewBox="0 0 390 310" role="img" aria-label={heroLabelV1(sky, mobile)}>
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
      <div className="mono still-clock">BERLIN · {sky.clock}</div>
      <div className="still-note">US market · New York</div>
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
      <div className="still-eyebrow">Coming up · New York time</div>
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
  /** Alerts in Telegram, where a bot exists. */
  telegram?: TelegramAlertsModelV1 | null;
  /** The wallet's name, or its address: what a shared card names. */
  subject?: string | null;
}

/**
 * A wallet's card, for X or Farcaster. The link is stills.lat/w/<wallet>: its
 * head carries the card, which names the wallet, so the row says so.
 */
export function StillShareRowV1({ subject, label }: { subject: string; label: string }) {
  const links = composerLinksV1({
    url: `https://stills.lat/w/${encodeURIComponent(subject)}`,
    text: 'Spend without selling: modelled borrowing room on Still, read from Base.',
  });
  return (
    <div className="still-share">
      <span className="still-note">{label}</span>
      <ShareLinkV1 href={links.x} className="still-share-link">Post on X</ShareLinkV1>
      <ShareLinkV1 href={links.farcaster} className="still-share-link">Cast on Farcaster</ShareLinkV1>
    </div>
  );
}

/** An assistant asking: a speech bubble with a spark. */
function AssistantIconV1() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 6.6l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" />
    </svg>
  );
}

/** Telegram's paper plane, drawn plainly. */
function TelegramIconV1() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.5 4.2L3.6 10.8c-.8.3-.8 1.4 0 1.7l4.2 1.4 1.6 5c.2.7 1.1.9 1.6.4l2.4-2.2 4.3 3.1c.6.4 1.4.1 1.6-.6l2.8-13.4c.2-.9-.7-1.6-1.6-1.1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.8 13.9l9.6-6.3-7.2 7.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Two quiet doors at the foot of Home: Still in an assistant, and alerts in
 * Telegram. Neither is the page's subject, so each is one line and one action.
 */
export function StillExtras({ telegram }: { telegram?: TelegramAlertsModelV1 | null }) {
  const view = telegram?.view ?? null;
  return (
    <div className="still-section still-extras">
      <StillLink href={STILL_ASSISTANTS_V1.path} className="still-extra">
        <span className="still-extra-icon"><AssistantIconV1 /></span>
        <span className="still-extra-body">
          <span className="still-extra-title">Still in your assistant</span>
          <span className="still-extra-note">Claude, ChatGPT, Cursor or Codex read the same numbers. Your wallet signs every step.</span>
        </span>
        <span className="still-extra-go" aria-hidden="true">›</span>
      </StillLink>
      {telegram && view ? (
        <div className="still-extra" aria-label="Telegram alerts">
          <span className="still-extra-icon"><TelegramIconV1 /></span>
          <span className="still-extra-body">
            <span className="still-extra-title">{view.state === 'linked' ? 'Telegram alerts are on' : 'Alerts in Telegram'}</span>
            <span className="still-extra-note">{view.note}</span>
            {view.error ? <span className="still-extra-note" role="status">{view.error}</span> : null}
          </span>
          {view.link ? (
            <a className="still-extra-action" href={view.link.href} target="_blank" rel="noreferrer">{view.link.label}</a>
          ) : view.action ? (
            <button
              type="button"
              className="still-extra-action"
              disabled={view.action.busy}
              onClick={view.action.kind === 'disconnect' ? telegram.onDisconnect : telegram.onConnect}
            >
              {view.action.busy ? `${view.action.label}…` : view.action.kind === 'connect' ? 'Connect' : view.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function StillHomeSignedIn({ model }: { model: StillHomeModelV1 }) {
  const { sky, view } = model;
  return (
    <div className="still-home-layout">
      <div className="still-home-scene">
      <StillHero sky={sky} mobile={view?.mobile ?? null} />
      <StillSkyCaption sky={sky} />
      </div>
      <div className="still-home-content">
      {view ? (
        <>
          <div className="still-section">
            <h1 className="still-word">{view.stateWord}</h1>
            <div className="still-sub">{view.stateLine}</div>
          </div>
          <div className="still-section">
            <div className="still-eyebrow">Live borrowing limit</div>
            <div className="still-live-limit">Not checked</div>
            <p className="still-note">Get money checks your selected stock collateral through Aave V4, or cbBTC and WETH through Morpho. Read the live limit for your exact choice.</p>
            {view.owed ? (
              <div className="still-owed">
                <span className="sw" aria-hidden="true" />
                <span><strong>{view.owed.amount}</strong> <span className="still-note">· {view.owed.detail}</span></span>
              </div>
            ) : null}
          </div>
          {view.failed.length > 0 ? (
            <p className="still-section still-warn">Not read this time: {view.failed.join(', ')}. The modelled amount is a floor from the reads that succeeded.</p>
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
          <StillLink href="/borrow" className="still-btn">Get money</StillLink>
          <StillLink href="/assets" className="still-btn sec">Your assets</StillLink>
          <StillLink href="/agent" className="still-btn sec">Ask Still</StillLink>
        </> : null}
      </div>
      {view ? (
        <details className="still-section still-modelled-room">
          <summary aria-label={view.available ? `${view.available.atLeast ? 'At least ' : ''}${view.available.dollars}${view.available.cents} modelled borrowing room` : 'Modelled borrowing room not read'}>
            Modelled borrowing room{view.available ? <> · {view.available.atLeast ? 'at least ' : ''}{view.available.dollars}{view.available.cents}</> : ' · Not read'}
          </summary>
          <p className="still-note">Calculated from your reviewed assets, including stock collateral. This is a modelled figure, not a current loan quote. Get money establishes a separate limit for the exact collateral you choose.</p>
          {model.reading ? <div className="mono still-clock">READ FROM BASE · BLOCK {Number(model.reading.block).toLocaleString('en-US')}</div> : null}
          {model.subject ? <StillShareRowV1 subject={model.subject} label="Share this wallet’s card:" /> : null}
        </details>
      ) : null}
      {view ? <StillComingUp items={view.comingUp} /> : null}
      {/* The doors stay when the wallet could not be read: they do not need it. */}
      {view || model.loading || model.failed ? <StillExtras telegram={model.telegram} /> : null}
      </div>
    </div>
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
    <div className="still-home-layout still-home-public">
      <div className="still-home-scene">
      <StillHero sky={sky} mobile={result?.view.mobile ?? null} />
      <StillSkyCaption sky={sky} />
      </div>
      <div className="still-home-content">
      <div className="still-section">
        <h1 className="still-word">Spend without selling.</h1>
        <div className="still-sub">Explore modelled borrowing room for the reviewed stocks and crypto in a Base wallet. Read from Base itself.</div>
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
          <div className="still-eyebrow">{result.report.subject.name ?? `${result.report.subject.address.slice(0, 6)}…${result.report.subject.address.slice(-4)}`} · modelled borrowing room</div>
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
          <p className="still-note">This model includes stock collateral. Get money checks reviewed stocks through Aave V4 and cbBTC/WETH through Morpho; the live allowance must be read for your exact collateral choice.</p>
          <div className="mono still-clock" style={{ marginTop: 8 }}>
            READ FROM BASE · BLOCK {Number(result.report.reading.block).toLocaleString('en-US')}
          </div>
          <StillShareRowV1 subject={result.report.subject.name ?? result.report.subject.address} label="Share this check:" />
        </div>
      ) : null}
      <div className="still-btns">
        <a href={model.signInHref} className="still-btn">Sign in</a>
      </div>
      <p className="still-section still-note">
        Still models up to {STILL_SHARES_V1.full}% of each protocol’s limit, and {STILL_SHARES_V1.closed}% for stocks while Wall Street is closed. A live loan needs a fresh review and your wallet approval.
        Not offered to US persons.
      </p>
      <StillExtras />
      </div>
    </div>
  );
}
