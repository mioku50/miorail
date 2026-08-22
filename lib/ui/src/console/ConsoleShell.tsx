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
 */
export const MIORAIL_SOURCE_URL_V1 = 'https://github.com/mioku50/miorail';

export interface ConsoleFooterModelV1 {
  adaptersLabel: string;
  sourcesLabel: string;
  spendLabel: string;
  blockNumber: string | null;
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
  const { header, left, footer } = props;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const railNav = left.nav ?? header.nav ?? [];
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
      <div className={`mio-console app${drawerOpen ? ' drawer-open' : ''}`}>
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
            <span className="logo">
              <svg width="13" height="13" viewBox="0 0 20 20" aria-hidden="true">
                <rect x="3" y="2.5" width="2.4" height="15" rx="1.2" />
                <rect x="14.6" y="2.5" width="2.4" height="15" rx="1.2" />
                <rect x="3" y="6.4" width="14" height="2" rx="1" opacity=".5" />
                <rect x="3" y="11.6" width="14" height="2" rx="1" opacity=".5" />
              </svg>
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
          <div className="hstat">
            <span>
              Block <b className="mono">{header.blockNumber ?? '—'}</b>
            </span>
            <span>
              Gas <b className="mono">{header.gasLabel ?? '—'}</b>
            </span>
          </div>
          {/* `netchip` so the phone breakpoint can drop THIS chip specifically.
              Targeting it by "the chip without .mono" also hid the "not
              connected" chip, which is the one message that must survive. */}
          <span className="chip netchip">
            <span className={`dot${header.connected ? '' : ' off'}`} />
            {header.networkLabel}
          </span>
          {header.walletLabel ? (
            <span className="chip mono">{header.walletLabel}</span>
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

        <aside className="left" aria-label="Navigation and sessions">
          {/* T70 §3 — the drawer's navigation IS the product's five sections.
              On a phone this rail is the only place they appear, so it carries
              Settings too; the header bar has room for four. */}
          {railNav.length > 0 && (
            <nav className="railnav" aria-label="Sections">
              {railNav.map((item) =>
                item.available ? (
                  <button
                    key={item.id}
                    type="button"
                    className={`item${item.active ? ' on' : ''}`}
                    aria-current={item.active ? 'page' : undefined}
                    onClick={() => {
                      header.onNavigate?.(item.id);
                      setDrawerOpen(false);
                    }}
                  >
                    <span className="t">{item.label}</span>
                  </button>
                ) : (
                  <div key={item.id} className="item off">
                    <span className="t">{item.label}</span>
                    {/* Explained, not merely dimmed. */}
                    <span className="m">{item.unavailableReason}</span>
                  </div>
                ),
              )}
            </nav>
          )}

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
            <p className="empty">No proofs yet. They appear here after your first signed route.</p>
          ) : (
            left.proofs.map((item) => <RailItem key={item.id} item={item} onSelect={props.onSelectProof} />)
          )}

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

        <aside className="right" aria-label="Live data">
          {props.right}
        </aside>

        <footer>
          <span className="g">
            <span className="dot" />
            {CONSOLE_COPY_V1.readOnly}
          </span>
          <span className="g">
            Adapters <span className="v mono">{footer.adaptersLabel}</span>
          </span>
          <span className="g">
            Sources <span className="v mono">{footer.sourcesLabel}</span>
          </span>
          <span className="g">
            Spend <span className="v mono">{footer.spendLabel}</span>
          </span>
          <span className="g">
            Block <span className="v mono">{footer.blockNumber ?? '—'}</span>
          </span>
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
