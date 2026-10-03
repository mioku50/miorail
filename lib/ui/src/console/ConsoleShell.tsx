import React, { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CONSOLE_COPY_V1 } from './consoleState';
import type { ConsoleNavItemV1, ConsoleSectionV1, PaidEvidenceStripV1 } from './navigation';

void React;

// ---------------------------------------------------------------------------
// The console shell: 246 | 1fr | 330 with a 52px header and a 34px status bar,
// each column scrolling independently. This is the app's ROOT layout, mounted
// above the router — not another page inside the old chrome.
// ---------------------------------------------------------------------------

export type ConsoleThemeV1 = 'dark' | 'light';
const THEME_STORAGE_KEY_V1 = 'miorail-theme';

function readStoredTheme(): ConsoleThemeV1 {
  if (typeof window === 'undefined') return 'dark';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY_V1);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* storage can be blocked; dark is the default either way */
  }
  return 'dark';
}

/**
 * Theme controller. Writes `data-theme` on <html> (what console.css switches
 * on) and mirrors the legacy `.light` class so the old Tailwind surfaces stay
 * correct during the rollback window. Applied synchronously on mount, so the
 * stored choice survives a reload without a flash of the wrong palette.
 */
export function useConsoleTheme(): { theme: ConsoleThemeV1; setTheme: (next: ConsoleThemeV1) => void } {
  const [theme, setThemeState] = useState<ConsoleThemeV1>(readStoredTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle('light', theme === 'light');
    root.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY_V1, theme);
    } catch {
      /* non-fatal */
    }
  }, [theme]);

  const setTheme = useCallback((next: ConsoleThemeV1) => setThemeState(next), []);
  return { theme, setTheme };
}

/** Takes the viewport while the console is mounted, and gives it back on unmount. */
function useConsoleHostClass(): void {
  useEffect(() => {
    document.documentElement.classList.add('mio-console-host');
    document.body.classList.add('mio-console-host');
    return () => {
      document.documentElement.classList.remove('mio-console-host');
      document.body.classList.remove('mio-console-host');
    };
  }, []);
}

/**
 * The Basename the signed-in wallet calls itself, for the header — or null.
 *
 * Read once per page load and kept for the rest of it, so moving between
 * sections asks nothing again. The server looks up only the session's own
 * wallet and keeps a name only when it resolves forward to that same address;
 * anything else is null, and the header keeps the address it already shows.
 */
const WALLET_BASENAME_CACHE_V1 = new Map<string, Promise<string | null>>();

function useWalletBasenameV1(walletLabel: string | null): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    setName(null);
    if (!walletLabel || typeof fetch !== 'function') return;
    let live = true;
    let pending = WALLET_BASENAME_CACHE_V1.get(walletLabel);
    if (!pending) {
      pending = fetch('/api/auth/basename', { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? (response.json() as Promise<{ basename?: unknown }>) : null))
        .then((body) =>
          typeof body?.basename === 'string' && /^[^\s]{1,255}\.base\.eth$/.test(body.basename) ? body.basename : null,
        )
        .catch(() => null);
      WALLET_BASENAME_CACHE_V1.set(walletLabel, pending);
    }
    void pending.then((value) => {
      if (live) setName(value);
    });
    return () => {
      live = false;
    };
  }, [walletLabel]);
  return name;
}

/** The one Miorail mark: the same drawing as the browser tab's icon. */
export function MiorailMarkV1({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path d="M10 50V14l22 22 22-22v36" stroke="#3D46F2" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 22 2 18M10 30H1M10 38l-8 4M54 22l8-4M54 30h9M54 38l8 4" stroke="#F27EE0" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export interface ConsoleSessionItemV1 {
  id: string;
  title: string;
  tag: { label: string; tone: 'g' | 'b' | 'n' };
  meta: string;
  active?: boolean;
}

export interface ConsoleLeftRailModelV1 {
  sessions: ConsoleSessionItemV1[];
  sessionCount: string;
  proofs: ConsoleSessionItemV1[];
  proofCount: string;
  /**
   * T70 §2 — the one-line form of Budget & payments. The full panel lives on
   * Settings; what stays here is a status and a way to reach it.
   *
   * `limits`, the usage bars and the adapter list are gone from this rail
   * entirely — they moved to Settings under §3. They were the two largest
   * blocks in the mobile drawer and neither is something a user acts on.
   */
  paidEvidence?: PaidEvidenceStripV1 | null;
  onOpenSettings?: () => void;
  /**
   * T70 §3 — the rail's navigation. Five entries: the four in the header plus
   * Settings, which the header has no room for. On a phone this rail IS the
   * drawer, so it is the only place Settings can be reached.
   */
  nav?: readonly ConsoleNavItemV1[];
}

/**
 * T70 §8 — the primary navigation, from the shared section table.
 *
 * The shell no longer accepts a hand-written tab list. Both surfaces build this
 * with `consoleNavModelV1`, which is the only way the web console and Base App
 * can be guaranteed to use the same words in the same order.
 */
export interface ConsoleHeaderModelV1 {
  crumb: string[];
  /** Absent on surfaces outside the primary navigation. */
  nav?: readonly ConsoleNavItemV1[];
  onNavigate?: (section: ConsoleSectionV1) => void;
  blockNumber: string | null;
  gasLabel: string | null;
  /** Why block and gas are absent, when they are. A bare dash beside a rail
   * that shows a stored block number reads as "our data is broken"; it usually
   * means one live probe was declined this second. */
  chainUnavailableReason?: string | null;
  /**
   * False when this reader cannot read the server's chain conditions at all —
   * signed out, `/status` answers 401. Block and Gas are then left out rather
   * than printed as dashes: a visitor on production, 2026-09-23, saw "chain
   * unknown · Block — · Gas —" above a board of real measurements, which reads
   * as a broken feed and is only a closed door. Absent means read, or still
   * being read, and renders as before.
   */
  chainRead?: boolean;
  networkLabel: string;
  connected: boolean;
  walletLabel: string | null;
}

/**
 * Where this program's source lives.
 *
 * A constant rather than configuration: AGPL §13 obliges the OPERATOR of a
 * network service to offer the Corresponding Source, and a settable link is
 * one a deployment can quietly point somewhere else while still shipping this
 * licence. A fork that moves its source changes this line, in a diff.
 *
 * Deliberately the CURRENT repository name. GitHub redirects an old name to a
 * new one and not the other way round, so this keeps working across a rename;
 * pointing it at the intended future name would 404 until the day of.
 */
export const MIORAIL_SOURCE_URL_V1 = 'https://github.com/mioku50/mioagent';

/**
 * What pages still hand the status bar. Since 2026-10-03 the bar renders none
 * of these counters — Settings carries network status — and the field stays so
 * no page has to change for a bar that only got quieter.
 */
export interface ConsoleFooterModelV1 {
  adaptersLabel: string;
  sourcesLabel: string;
  spendLabel: string;
  blockNumber: string | null;
  /** See `ConsoleHeaderModelV1.chainRead`. */
  chainRead?: boolean;
}

export interface ConsoleShellProps {
  header: ConsoleHeaderModelV1;
  left: ConsoleLeftRailModelV1;
  footer: ConsoleFooterModelV1;
  right: ReactNode;
  children: ReactNode;
  theme: ConsoleThemeV1;
  onThemeChange: (theme: ConsoleThemeV1) => void;
  onNewGoal: () => void;
  onSelectSession: (id: string) => void;
  onSelectProof: (id: string) => void;
  /** Narrow-viewport fold of the right rail into the centre column. */
  railFold?: ReactNode;
}

function RailNavItem({ item, onNavigate }: { item: ConsoleNavItemV1; onNavigate: (id: ConsoleSectionV1) => void }) {
  return item.available ? (
    <button
      type="button"
      className={`item${item.active ? ' on' : ''}`}
      aria-current={item.active ? 'page' : undefined}
      onClick={() => onNavigate(item.id)}
    >
      <span className="t">{item.label}</span>
    </button>
  ) : (
    <div className="item off">
      <span className="t">{item.label}</span>
      <span className="m">{item.unavailableReason}</span>
    </div>
  );
}

function RailItem({ item, onSelect }: { item: ConsoleSessionItemV1; onSelect: (id: string) => void }) {
  return (
    <button type="button" className={`item${item.active ? ' on' : ''}`} onClick={() => onSelect(item.id)}>
      <span className="t">{item.title}</span>
      <span className="m">
        <span className={`tag ${item.tag.tone}`}>{item.tag.label}</span>
        {item.meta}
      </span>
    </button>
  );
}

export function ConsoleShell(props: ConsoleShellProps) {
  const { header, left } = props;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const railNav = left.nav ?? header.nav ?? [];
  const activeSection = railNav.find((item) => item.active)?.id ?? null;
  const basename = useWalletBasenameV1(header.walletLabel);
  const mainNav = railNav.filter((item) => item.group !== 'more');
  const moreNav = railNav.filter((item) => item.group === 'more');
  // Open by itself when the reader is on one of its pages, so the drawer never
  // hides where they are; otherwise one tap away.
  const moreActive = moreNav.some((item) => item.active);
  const showExecutionRail = activeSection === 'routes' || activeSection === 'activity';
  useConsoleHostClass();

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <>
      <div className="mio-glow" />
      <div className={`mio-console app${drawerOpen ? ' drawer-open' : ''}${props.right ? '' : ' no-right'}`}>
        <header>
          <button
            type="button"
            className="drawerbtn"
            aria-label={drawerOpen ? 'Close session list' : 'Open session list'}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            ☰
          </button>
          <div className="brand">
            {/* One mark everywhere. The header drew two rails and two ties,
                which read as an "H", while the browser tab showed an M. */}
            <span className="logo mark">
              <MiorailMarkV1 size={24} />
            </span>
            Miorail
          </div>
          {/* The section pills that used to sit here are gone.
              They listed three of the six sections the left rail lists, and the
              rail is on screen at every width — as a column above 900px and as
              the drawer below it. So the header showed a second, shorter copy
              of the same navigation, and on Discover it put the active pill
              directly beside a breadcrumb reading the same word: "Discover
              Discover".

              `header.nav` is still accepted and still used: `railNav` falls
              back to it when a page passes no rail nav of its own. What was
              removed is the duplicate rendering, not the navigation. */}
          <nav className="crumb" aria-label="Breadcrumb">
            {header.crumb.map((entry, index) => (
              <React.Fragment key={entry}>
                {index > 0 && <span className="sep">/</span>}
                {index === header.crumb.length - 1 ? <b>{entry}</b> : <span>{entry}</span>}
              </React.Fragment>
            ))}
          </nav>
          <div className="hspace" />
          {/* Block and gas left the header (2026-10-03). They answer how the
              chain is doing, which is Settings' question; a reader here is
              asking about a stock. Network status keeps both. */}
          {/* `netchip` so the phone breakpoint can drop THIS chip specifically.
              Targeting it by "the chip without .mono" also hid the "not
              connected" chip, which is the one message that must survive. */}
          <span className="chip netchip">
            <span className={`dot${header.connected ? '' : ' off'}`} />
            {header.networkLabel}
          </span>
          {header.walletLabel ? (
            basename ? (
              <span className="chip" title={header.walletLabel}>
                {basename}
              </span>
            ) : (
              <span className="chip mono">{header.walletLabel}</span>
            )
          ) : (
            <span className="chip">not connected</span>
          )}
          <div className="themetog" role="group" aria-label="Theme">
            <button type="button" className={props.theme === 'dark' ? 'on' : ''} onClick={() => props.onThemeChange('dark')} aria-pressed={props.theme === 'dark'}>
              Dark
            </button>
            <button type="button" className={props.theme === 'light' ? 'on' : ''} onClick={() => props.onThemeChange('light')} aria-pressed={props.theme === 'light'}>
              Base
            </button>
          </div>
        </header>

        <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />

        <aside className="left" aria-label="Navigation">
          {/* T70 §3 — the drawer's navigation IS the product's five sections.
              On a phone this rail is the only place they appear, so it carries
              Settings too; the header bar has room for four. */}
          {railNav.length > 0 && (
            <nav className="railnav" aria-label="Sections">
              {mainNav.map((item) => (
                <RailNavItem
                  key={item.id}
                  item={item}
                  onNavigate={(id) => {
                    header.onNavigate?.(id);
                    setDrawerOpen(false);
                  }}
                />
              ))}
              {/* Four pages lead (operator, 2026-10-03); the rest are a tap
                  away, never removed. */}
              {moreNav.length > 0 ? (
                <details className="railmore" open={moreActive}>
                  <summary className="railgroup">More</summary>
                  {moreNav.map((item) => (
                    <RailNavItem
                      key={item.id}
                      item={item}
                      onNavigate={(id) => {
                        header.onNavigate?.(id);
                        setDrawerOpen(false);
                      }}
                    />
                  ))}
                </details>
              ) : null}
            </nav>
          )}

          {showExecutionRail ? (
            <>
              <button type="button" className="newgoal" onClick={props.onNewGoal}>
                + New goal
              </button>

              <div className="sechead">
                <span>Active session</span>
                <span className="mono">{left.sessionCount}</span>
              </div>
              {left.sessions.length === 0 ? (
                <p className="empty">No active session yet — start one above.</p>
              ) : (
                left.sessions.map((item) => <RailItem key={item.id} item={item} onSelect={props.onSelectSession} />)
              )}

              <div className="sechead">
                <span>Recent proofs</span>
                <span className="mono">{left.proofCount}</span>
              </div>
              {left.proofs.length === 0 ? (
                <p className="empty">None among your recent runs. A proof opens when a route is handed to your wallet.</p>
              ) : (
                left.proofs.map((item) => <RailItem key={item.id} item={item} onSelect={props.onSelectProof} />)
              )}
            </>
          ) : null}

          {/* T70 §2 — what is left of Budget & payments outside Settings: a
              status, what still works, and a way through. The panel itself, the
              usage bars and the adapter list are on Settings now. */}
          {left.paidEvidence && (
            <div className="minipanel">
              <div className="row">
                <span>{left.paidEvidence.label}</span>
                {left.paidEvidence.settingsAvailable && left.onOpenSettings && (
                  <button type="button" className="btn sec" onClick={left.onOpenSettings}>
                    Settings
                  </button>
                )}
              </div>
              <div className="row">
                <span className="v">{left.paidEvidence.detail}</span>
              </div>
              {/* No fake configure button while the permission flow does not
                  exist — the sentence is the honest control. */}
              {left.paidEvidence.permissionNotice && (
                <p className="lnote">{left.paidEvidence.permissionNotice}</p>
              )}
            </div>
          )}
        </aside>

        <main>
          {props.children}
          {props.railFold && <div className="railfold">{props.railFold}</div>}
        </main>

        {props.right ? <aside className="right" aria-label="Live data">{props.right}</aside> : null}

        <footer>
          <span className="g">
            <span className="dot" />
            <span className="t">{CONSOLE_COPY_V1.readOnly}</span>
          </span>
          {/* Adapters, sources, spend and the block left the status bar
              (2026-10-03): four system counters on every page, read by
              nobody deciding anything there. Settings keeps them. */}
          <span className="sp" />
          <a className="metriclink" href="/metrics">Public metrics</a>
          {/* AGPL-3.0 §13: anyone interacting with this program over a network
              must be offered its Corresponding Source. A licence file in the
              repository does not discharge that — the offer has to be reachable
              from the running service, which is here. */}
          <a
            className="metriclink"
            href={MIORAIL_SOURCE_URL_V1}
            target="_blank"
            rel="noopener noreferrer"
          >
            Source (AGPL-3.0)
          </a>
        </footer>
      </div>
    </>
  );
}
