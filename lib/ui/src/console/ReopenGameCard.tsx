'use client';

import React, { useEffect, useState } from 'react';

import type { ReopenDirectionV1 } from '@mioagent/rwa-market-reality/reopen-game';

import { countdownV1, type ReopenGameViewV1 } from './reopenGameView';

void React;

export interface ReopenGameModelV1 {
  view: ReopenGameViewV1;
  /** Absent where picks cannot be sent; the round still shows. */
  onPick?: (symbol: string, side: ReopenDirectionV1) => void;
  onSignIn?: () => void;
  /** Opens a stock's card in place. Absent: the link is followed as a link. */
  onOpenStock?: (symbol: string) => void;
}

const SIDES_V1: readonly { side: ReopenDirectionV1; label: string }[] = [
  { side: 'up', label: '▲ Above' },
  { side: 'down', label: '▼ Below' },
];

const MARK_V1 = { '🟩': 'right', '🟥': 'wrong', '⬜': 'void' } as const;

/** The countdown, recounted every 15 seconds. It starts from the count the
 * view was built with, so the first paint is the same on every render. */
function ReopenClock({ clock }: { clock: NonNullable<ReopenGameViewV1['clock']> }) {
  const [left, setLeft] = useState<string | null>(clock.left);
  useEffect(() => {
    const tick = () => setLeft(countdownV1(clock.until, new Date()));
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [clock.until]);
  if (!left) return null;
  return (
    <div className="mr-reopen-clock" role="timer" aria-label={`${left} ${clock.label}`}>
      <span className="amount">{left}</span>
      <span className="mr-reopen-clock-label">
        {clock.label}
        <span className="lnote">{clock.at}</span>
      </span>
    </div>
  );
}

/**
 * Call the reopen, on the Weekend tab. Every sentence comes from the view, so
 * the web and the Base App say the same thing; this only lays it out. One row
 * per stock, readable on a phone: the stock and its numbers on one line, the
 * call under them.
 */
export function ReopenGameCard({ model }: { model: ReopenGameModelV1 }) {
  const { view } = model;
  const closeDay = view.closeDay ?? { long: 'Friday', short: 'Fri' };
  const cta = view.cta;
  return (
    <section className="panel mr-reopen-card" data-state={view.state} aria-label="Call the reopen">
      <div className="mr-reopen-hero">
        <div className="mr-reopen-top">
          <h3 className="mr-reopen-title">{view.title}</h3>
          <span className={`pill ${view.state === 'open' ? 'br' : 'n'}`}>
            {view.state === 'open' ? <span className="dot mr-reopen-live" aria-hidden="true" /> : null}
            {view.badge}
          </span>
        </div>
        <p className="lnote">{view.lede}</p>
        {view.clock ? <ReopenClock key={view.clock.until} clock={view.clock} /> : null}
        {view.verdict ? (
          <p className="mr-reopen-verdict">
            <span className={`pill ${view.verdict.tone === 'won' ? 'g' : view.verdict.tone === 'level' ? 'br' : 'n'}`}>
              {view.verdict.text}
            </span>
          </p>
        ) : null}
        {view.tiles.length > 0 ? (
          <div className="mr-reopen-tiles">
            {view.tiles.map((tile) => (
              <div key={tile.key} className="kpi">
                <span className="k">{tile.label}</span>
                <span className="v">{tile.value}</span>
                {tile.detail ? <span className="d">{tile.detail}</span> : null}
                {typeof tile.progress === 'number' ? (
                  <span className="usebar" aria-hidden="true">
                    <span style={{ width: `${Math.round(tile.progress * 100)}%` }} />
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {view.steps.length > 0 ? (
        <div className="stepper mr-reopen-steps" role="list" aria-label="The round">
          {view.steps.map((step) => (
            <div
              key={step.key}
              role="listitem"
              className={`st${step.state === 'next' ? '' : ` ${step.state}`}`}
              aria-current={step.state === 'now' ? 'step' : undefined}
            >
              <div className="n">{step.label}</div>
              <div className="b" />
              <div className="tm">{step.at}</div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="pb">
        {view.rows.length > 0 ? (
          <ul className="mr-reopen">
            {view.rows.map((row) => (
              <li
                key={row.symbol}
                className="mr-reopen-row"
                data-picked={view.state === 'open' && row.pick ? 'true' : undefined}
                data-mark={row.mark ? MARK_V1[row.mark] : undefined}
              >
                <div className="mr-reopen-stock">
                  {row.icon ? (
                    <img className="mr-choice-icon" src={row.icon} alt="" width={24} height={24} loading="lazy" decoding="async" />
                  ) : (
                    <span className="mr-choice-icon" aria-hidden="true" />
                  )}
                  <div className="mr-reopen-id">
                    <strong>{row.symbol}</strong>
                    {row.name !== row.symbol ? <span className="lnote">{row.name}</span> : null}
                  </div>
                </div>
                <div className="mr-reopen-nums mono">
                  <span>
                    {closeDay.short} {row.close}
                  </span>
                  {row.baseNow ? <span className="lnote">Base {row.baseNow}</span> : null}
                  {row.baseCall ? <span className="lnote">Base {row.baseCall}</span> : null}
                </div>
                <div className="mr-reopen-call">
                  {view.state === 'open' && model.onPick ? (
                    <div className="mr-scope-switch" role="group" aria-label={`${row.symbol}: above or below ${closeDay.long}'s close`}>
                      {SIDES_V1.map(({ side, label }) => (
                        <button
                          key={side}
                          type="button"
                          aria-pressed={row.pick === side}
                          className={row.pick === side ? 'on' : undefined}
                          onClick={() => model.onPick?.(row.symbol, side)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <>
                      <span>
                        {row.mark ? `${row.mark} ` : ''}
                        {row.pick ? `You ${row.pick === 'up' ? '▲ above' : '▼ below'}` : 'No pick'}
                      </span>
                      {row.crowd ? <span className="lnote">Players {row.crowd}</span> : null}
                      {row.result ? <span className="lnote">{row.result}</span> : null}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {view.standing ? <p className="lnote">{view.standing}</p> : null}
        {view.keepWithWallet && model.onSignIn ? (
          <button type="button" className="btn sec" onClick={model.onSignIn}>
            Sign in to keep your streak
          </button>
        ) : null}
        {view.error ? <p className="note warn">{view.error}</p> : null}
        {view.share ? (
          <div className="gift-share-row">
            <a className="btn sec" href={view.share.x} target="_blank" rel="noreferrer">
              Post on X
            </a>
            <a className="btn sec" href={view.share.farcaster} target="_blank" rel="noreferrer">
              Cast on Farcaster
            </a>
          </div>
        ) : null}
        {cta ? (
          <p className="mr-reopen-cta">
            <a
              className="btn sec"
              href={cta.href}
              onClick={(event) => {
                // A modified click is the reader asking for a new tab or window.
                if (!model.onOpenStock || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                model.onOpenStock(cta.symbol);
              }}
            >
              {cta.label}
            </a>
          </p>
        ) : null}
        {view.leaderboard ? (
          <div className="mr-reopen-board" aria-label={view.leaderboard.title}>
            <h4>{view.leaderboard.title}</h4>
            <p className="lnote">{view.leaderboard.note}</p>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th className="r">Right</th>
                  <th className="r">Rounds</th>
                </tr>
              </thead>
              <tbody>
                {view.leaderboard.rows.map((row) => (
                  <tr key={row.key} className={row.you ? 'you' : undefined}>
                    <td className="mono" title={row.rank}>
                      {row.medal ?? row.rank}
                    </td>
                    <td className="nm">{row.name}</td>
                    <td className="r mono">{row.score}</td>
                    <td className="r mono">{row.rounds}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.leaderboard.me ? <p className="lnote">{view.leaderboard.me}</p> : null}
          </div>
        ) : null}
        <details className="mr-reopen-rules">
          <summary>How a round is decided</summary>
          <p className="lnote">{view.rules}</p>
        </details>
      </div>
    </section>
  );
}
