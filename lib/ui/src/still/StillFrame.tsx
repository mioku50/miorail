import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { MIORAIL_SOURCE_URL_V1 } from '../console/ConsoleShell';
import { skyStateV1, type SkyEarningsV1, type SkyStateV1 } from './skyState';

void React;

// ---------------------------------------------------------------------------
// Still's frame: the five places a person goes, and the market clock.
//
// Home · Assets · Agent · Stocks · More (operator, 2026-10-26). Everything
// else Miorail does is under More: still a page with its own path, one tap
// away. A bar at the bottom on a phone, a rail on the left on a desk.
//
// The palette is the market's: night while Still's closed-market limits hold,
// day otherwise. The clock re-reads itself every half minute, so the frame
// turns to night at 20:00 New York without a reload.
// ---------------------------------------------------------------------------

export type StillTabV1 = 'home' | 'assets' | 'agent' | 'stocks' | 'more';

export const STILL_TABS_V1: ReadonlyArray<{ id: StillTabV1; label: string; path: string }> = [
  { id: 'home', label: 'Home', path: '/' },
  { id: 'assets', label: 'Assets', path: '/assets' },
  { id: 'agent', label: 'Agent', path: '/agent' },
  { id: 'stocks', label: 'Stocks', path: '/stocks' },
  { id: 'more', label: 'More', path: '/more' },
];

/** Which tab a path belongs to. Every path Miorail had before lives under More. */
export function stillTabForPathV1(path: string): StillTabV1 {
  const clean = path.split(/[?#]/)[0] ?? '/';
  if (clean === '/' || clean === '') return 'home';
  if (clean === '/assets' || clean.startsWith('/assets/')) return 'assets';
  if (clean === '/agent' || clean.startsWith('/agent/')) return 'agent';
  if (['/stocks', '/market', '/action', '/borrow'].some((p) => clean === p || clean.startsWith(`${p}/`))) return 'stocks';
  return 'more';
}

/** Single-page navigation, provided by the app. Without it a link loads the page. */
export const StillNavigateContext = createContext<((path: string) => void) | null>(null);

export function StillLink({ href, className, children, ...rest }: { href: string; className?: string; children: ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const navigate = useContext(StillNavigateContext);
  return (
    <a
      href={href}
      className={className}
      {...rest}
      onClick={(event) => {
        rest.onClick?.(event);
        if (event.defaultPrevented || !navigate || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (!href.startsWith('/')) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

const ICONS_V1: Record<StillTabV1, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  assets: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  agent: (
    <>
      <path d="M4 5h16v11H10l-5 4v-4H4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),
  stocks: (
    <>
      <path d="M7 3v18M17 3v18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="4.5" y="8" width="5" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="14.5" y="6" width="5" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  more: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
};

/** The brand mark: a small mobile, a holding on the left and what you owe on the right. */
export function StillGlyph({ size = 1 }: { size?: number }) {
  return (
    <svg width={30 * size} height={26 * size} viewBox="0 0 30 26" aria-hidden="true" className="still-glyph">
      <line x1="15" y1="0" x2="15" y2="7" className="sm-wire" strokeWidth="2" />
      <line x1="3" y1="7" x2="27" y2="7" className="sm-wire" strokeWidth="2" />
      <line x1="7" y1="7" x2="7" y2="11" className="sm-wire" strokeWidth="1.5" />
      <circle cx="7" cy="17" r="6" className="still-glyph-stock" />
      <line x1="23.5" y1="7" x2="23.5" y2="11" className="sm-wire" strokeWidth="1.5" />
      <rect x="20" y="11" width="7" height="7" className="sm-loan" />
    </svg>
  );
}

/** The market clock, small: what the sky says, for pages without the full sky. */
export function StillClockPill({ sky }: { sky: SkyStateV1 }) {
  if (sky.phase === 'night') {
    return (
      <span className="still-pill">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="#F6F1D3" /></svg>
        Market closed
      </span>
    );
  }
  if (sky.phase === 'day') {
    return (
      <span className="still-pill">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#FFD36B" /><circle cx="12" cy="12" r="5.5" fill="#FFB703" /></svg>
        Market open
      </span>
    );
  }
  return (
    <span className="still-pill">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15h18M6 19h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M8 15a4 4 0 0 1 8 0" fill="none" stroke="#FFB703" strokeWidth="1.8" /></svg>
      After hours
    </span>
  );
}

/** The sky now, re-read every half minute, with the earnings windows the page read. */
export function useStillSkyV1(input?: { earnings?: readonly SkyEarningsV1[]; unread?: readonly string[] }): SkyStateV1 {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return skyStateV1({ now, earnings: input?.earnings, unread: input?.unread });
}

export function StillFrame({ tab, sky, children, wide }: { tab: StillTabV1; sky: SkyStateV1; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    // The console's pages read the same palette through data-theme; still.css
    // sets the color scheme from it.
    const root = document.documentElement;
    root.classList.add('still-host');
    document.body.classList.add('still-host');
    root.dataset.theme = sky.phase === 'night' ? 'dark' : 'light';
    root.style.setProperty('--sm-ground-host', sky.phase === 'night' ? '#0B0F2E' : '#F6F9FF');
    return () => {
      root.classList.remove('still-host');
      document.body.classList.remove('still-host');
    };
  }, [sky.phase]);
  return (
    <div className="still still-frame" data-sky={sky.phase === 'night' ? 'night' : 'day'}>
      <nav className="still-nav" aria-label="Main">
        <StillLink href="/" className="still-brand" aria-label="Still home">
          <StillGlyph />
          <span>Still</span>
        </StillLink>
        {STILL_TABS_V1.map((item) => (
          <StillLink key={item.id} href={item.path} aria-current={item.id === tab ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" aria-hidden="true">{ICONS_V1[item.id]}</svg>
            {item.label}
          </StillLink>
        ))}
        <div className="still-rail-foot">
          <a href="/metrics">Public metrics</a>
          {/* AGPL-3.0 section 13: the running service offers its source. */}
          <a href={MIORAIL_SOURCE_URL_V1} target="_blank" rel="noopener noreferrer">Source (AGPL-3.0)</a>
        </div>
      </nav>
      <main className={`still-main${wide ? ' wide' : ''}`}>{children}</main>
    </div>
  );
}

export function StillHeader({ title, trail, sky, extra }: { title: string; trail?: string | null; sky: SkyStateV1; extra?: ReactNode }) {
  return (
    <div className="still-head">
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {trail ? <div className="still-trail">{trail}</div> : null}
      </div>
      <div className="still-head-tools">
        {extra}
        <StillClockPill sky={sky} />
      </div>
    </div>
  );
}
