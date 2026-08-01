import React, { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CONSOLE_COPY_V1 } from './consoleState';

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

export interface ConsoleLimitsV1 {
  dailyLabel: string;
  dailyPercent: number;
  intelligenceLabel: string;
  intelligencePercent: number;
}

export interface ConsoleLeftRailModelV1 {
  sessions: ConsoleSessionItemV1[];
  sessionCount: string;
  proofs: ConsoleSessionItemV1[];
  proofCount: string;
  limits: ConsoleLimitsV1 | null;
  limitsUnavailableReason: string | null;
  /** T67E §2.1 — Budget & payments opens from the panels that already show a
   * number worth changing. It is not a nav entry: there is no top-level
   * "x402", "Spend Permission" or "Payments protocol". */
  onOpenBudget?: () => void;
  // `usable` (present since T64.3.1) means switched on; `live` means it
  // answered. A configured adapter is not dimmed like a disabled one, and only
  // one that answered gets the green tick.
  adapters: { rows: { name: string; label: string; live: boolean; usable?: boolean }[]; summary: string };
}

/**
 * T67E — the three top-level surfaces.
 *
 * Routes is the flow, B20 is what the tokens you hold have done, Proofs is the
 * public history. Budget & payments is deliberately NOT here: it is a drawer,
 * because it is something you adjust in the middle of a flow rather than a
 * place you go.
 */
export interface ConsoleTabV1 {
  id: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}

export interface ConsoleHeaderModelV1 {
  crumb: string[];
  /** Absent on surfaces that are not one of the three tabs. */
  tabs?: readonly ConsoleTabV1[];
  blockNumber: string | null;
  gasLabel: string | null;
  networkLabel: string;
  connected: boolean;
  walletLabel: string | null;
}

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
          {(header.tabs ?? []).length > 0 && (
            <nav className="crumb" aria-label="Sections">
              {(header.tabs ?? []).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`btn sec${tab.active ? ' on' : ''}`}
                  aria-current={tab.active ? 'page' : undefined}
                  onClick={tab.onSelect}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          )}
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

        <aside className="left" aria-label="Sessions and limits">
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

          <div className="minipanel">
            {left.onOpenBudget && (
              <div className="row">
                <span>Budget &amp; payments</span>
                <button type="button" className="btn sec" onClick={left.onOpenBudget}>
                  Open
                </button>
              </div>
            )}
            {left.limits ? (
              <>
                <div className="row">
                  <span>Daily limit</span>
                  <span className="v mono">{left.limits.dailyLabel}</span>
                </div>
                <div className="usebar">
                  <span style={{ width: `${left.limits.dailyPercent}%` }} />
                </div>
                <div className="row" style={{ marginTop: 9 }}>
                  <span>Intelligence</span>
                  <span className="v mono">{left.limits.intelligenceLabel}</span>
                </div>
                <div className="usebar">
                  <span style={{ width: `${left.limits.intelligencePercent}%` }} />
                </div>
              </>
            ) : (
              <div className="row">
                <span>Limits</span>
                <span className="v">{left.limitsUnavailableReason ?? CONSOLE_COPY_V1.limitsMissing}</span>
              </div>
            )}
          </div>

          <div className="minipanel">
            <div className="row">
              <span>Route adapters</span>
              <span className="v mono">{left.adapters.summary}</span>
            </div>
            {left.adapters.rows.map((row) => (
              <div key={row.name} className={`row${(row.usable ?? row.live) ? '' : ' off'}`}>
                <span>{row.name}</span>
                <span className={`v${row.live ? ' ok' : ''}`}>{row.label}</span>
              </div>
            ))}
          </div>
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
        </footer>
      </div>
    </>
  );
}
