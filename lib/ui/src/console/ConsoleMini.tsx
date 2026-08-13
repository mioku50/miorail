import React, { useEffect, useState, type ReactNode } from 'react';
import { CONSOLE_COPY_V1, type CandidateRowViewV1, type ScoreDimensionViewV1 } from './consoleState';
import { ScoreRows } from './ConsoleCharts';
import type { ConsoleNavItemV1, ConsoleSectionV1 } from './navigation';

void React;

// ---------------------------------------------------------------------------
// Miniapp console — the centre column plus the status bar, nothing else.
//
// What compresses: the left rail becomes a drawer (the active goal is promoted
// into the header as one line), the right rail's panels move to the bottom of
// the centre column in the order freshness → evidence → budget, the 8-step rail
// becomes a compact "Step 5 of 8 · Score" strip, the radar is dropped (it is
// unreadable at 390px — the five score BARS stay), and tables become card rows
// with no horizontal scroll.
//
// What does NOT compress, at any width:
//   * unavailable routes stay visible with their reason;
//   * an unscored dimension keeps its hatched track and "not scored";
//   * the Review screen with its simulation still gates signing.
// ---------------------------------------------------------------------------

export interface ConsoleMiniShellProps {
  /** The active goal, promoted into the header as a single line. */
  goalLine: string;
  stepLine: string;
  networkLabel: string;
  connected: boolean;
  blockNumber: string | null;
  theme: 'dark' | 'light';
  onThemeChange: (theme: 'dark' | 'light') => void;
  /** Contents of the drawer: sessions and proofs. */
  drawer: ReactNode;
  children: ReactNode;
  /** Right-rail panels, folded to the bottom of the centre column. */
  panels: ReactNode;
  /**
   * T70 §4/§8 — Base App's bottom bar, built from the SAME section table the
   * web header reads. A section with no handler is not in this list at all: a
   * fourth tab that navigates nowhere reads as a broken app rather than an
   * unfinished one.
   */
  nav?: readonly ConsoleNavItemV1[];
  onNavigate?: (section: ConsoleSectionV1) => void;
}

export function ConsoleMiniShell(props: ConsoleMiniShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const nav = props.nav ?? [];

  useEffect(() => {
    document.documentElement.classList.add('mio-console-host');
    document.body.classList.add('mio-console-host');
    return () => {
      document.documentElement.classList.remove('mio-console-host');
      document.body.classList.remove('mio-console-host');
    };
  }, []);

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
      <div className={`mio-console mini${nav.length > 0 ? ' hasnav' : ''}${drawerOpen ? ' drawer-open' : ''}`}>
        <header>
          <button
            type="button"
            className="drawerbtn"
            aria-label={drawerOpen ? 'Close session drawer' : 'Open session drawer'}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            ☰
          </button>
          <div className="minihead">
            <div className="goalline">{props.goalLine}</div>
            <div className="stepline">{props.stepLine}</div>
          </div>
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
          {props.drawer}
        </aside>

        <main>
          {props.children}
          <div className="minipanels">{props.panels}</div>
        </main>

        {nav.length > 0 && (
          <nav className="tabbar" aria-label="Sections">
            {nav.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.active ? 'on' : undefined}
                aria-current={item.active ? 'page' : undefined}
                onClick={() => props.onNavigate?.(item.id)}
              >
                {item.compactLabel}
              </button>
            ))}
          </nav>
        )}

        <footer>
          <span className="g">
            <span className={`dot${props.connected ? '' : ' off'}`} />
            {CONSOLE_COPY_V1.readOnly}
          </span>
          <span className="g">{props.networkLabel}</span>
          <span className="g">
            Block <span className="v mono">{props.blockNumber ?? '—'}</span>
          </span>
          <span className="sp" />
        </footer>
      </div>
    </>
  );
}

/** Candidate table → card rows. No horizontal scroll, and an unavailable route
 * keeps its card and its reason rather than being dropped. */
export function CandidateCards({
  rows,
  onSelect,
  actionLabel = 'Use this',
}: {
  rows: readonly CandidateRowViewV1[];
  onSelect?: (id: string) => void;
  actionLabel?: string;
}) {
  if (rows.length === 0) return <p className="empty">No routes have answered yet.</p>;
  return (
    <div className="cardrows">
      {rows.map((row) => (
        <article key={row.id} className={`cardrow${row.selectable || row.state === 'chosen' ? '' : ' off'}`}>
          <div className="cr-top">
            <span className="cr-name">{row.name}</span>
            {row.state === 'chosen' ? (
              <span className="pill br">chosen</span>
            ) : (
              <span className={`pill ${row.selectable ? 'n' : 'a'}`}>{row.stateLabel}</span>
            )}
          </div>
          <div className="cr-nums">
            <div>
              <span className="cr-k">Output</span>
              <span className="cr-v mono">{row.outputLabel}</span>
            </div>
            <div>
              <span className="cr-k">Net</span>
              <span className="cr-v mono">{row.netLabel}</span>
            </div>
          </div>
          <span className={`cmpbar${row.scoreDim ? ' dim' : ''}`}>
            <span style={{ width: `${row.scorePercent}%` }} />
          </span>
          <p className="cr-why">{row.why}</p>
          {row.selectable && onSelect && (
            <button type="button" className="btn sec" onClick={() => onSelect(row.id)}>
              {actionLabel}
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

/** Plan-vs-actual table → card rows. */
export function PlanVsActualCards({
  rows,
}: {
  rows: readonly { label: string; expected: string; actual: string; difference: string; tone: 'good' | 'warn' | 'none' }[];
}) {
  if (rows.length === 0) return <p className="empty">No reconciled figures yet.</p>;
  return (
    <div className="cardrows">
      {rows.map((row) => (
        <article key={row.label} className="cardrow">
          <div className="cr-top">
            <span className="cr-name">{row.label}</span>
            <span className={`cr-v mono${row.tone === 'good' ? ' good' : row.tone === 'warn' ? ' warn' : ''}`}>{row.difference}</span>
          </div>
          <div className="cr-nums">
            <div>
              <span className="cr-k">Expected</span>
              <span className="cr-v mono">{row.expected}</span>
            </div>
            <div>
              <span className="cr-k">Actual</span>
              <span className="cr-v mono">{row.actual}</span>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

/** Score without the radar — the five bars carry the same information, and the
 * unscored dimension keeps its hatched track and its words. */
export function MiniScorePanel({ rows, note }: { rows: readonly ScoreDimensionViewV1[]; note: string }) {
  return (
    <div className="panel">
      <div className="ph">
        <h3>Path score</h3>
        <span className="rt">
          <span className="pill n">{note}</span>
        </span>
      </div>
      <div className="pb">
        <ScoreRows rows={rows} />
      </div>
    </div>
  );
}
