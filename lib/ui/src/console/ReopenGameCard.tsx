'use client';

import React from 'react';

import type { ReopenDirectionV1 } from '@mioagent/rwa-market-reality/reopen-game';

import type { ReopenGameViewV1 } from './reopenGameView';

void React;

export interface ReopenGameModelV1 {
  view: ReopenGameViewV1;
  /** Absent where picks cannot be sent; the round still shows. */
  onPick?: (symbol: string, side: ReopenDirectionV1) => void;
  onSignIn?: () => void;
}

const SIDES_V1: readonly { side: ReopenDirectionV1; label: string }[] = [
  { side: 'up', label: '▲ Above' },
  { side: 'down', label: '▼ Below' },
];

/**
 * Call the reopen, on the Weekend tab. Every sentence comes from the view, so
 * the web and the Base App say the same thing; this only lays it out. One row
 * per stock, readable on a phone: the stock and its numbers on one line, the
 * call under them.
 */
export function ReopenGameCard({ model }: { model: ReopenGameModelV1 }) {
  const { view } = model;
  return (
    <section className="panel" aria-label="Call the reopen">
      <div className="ph">
        <h3>{view.title}</h3>
        <span className="pill cr-status" data-tone="neutral">
          {view.badge}
        </span>
      </div>
      <div className="pb">
        <p className="lnote">{view.lede}</p>
        {view.rows.length > 0 ? (
          <ul className="mr-reopen">
            {view.rows.map((row) => (
              <li key={row.symbol} className="mr-reopen-row">
                <div className="mr-reopen-stock">
                  <strong>{row.symbol}</strong>
                  {row.name !== row.symbol ? <span className="lnote">{row.name}</span> : null}
                </div>
                <div className="mr-reopen-nums mono">
                  <span>Fri {row.close}</span>
                  {row.baseNow ? <span className="lnote">Base {row.baseNow}</span> : null}
                  {row.baseCall ? <span className="lnote">Base {row.baseCall}</span> : null}
                </div>
                <div className="mr-reopen-call">
                  {view.state === 'open' && model.onPick ? (
                    <div className="mr-scope-switch" role="group" aria-label={`${row.symbol}: above or below Friday's close`}>
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
                    <td className="mono">{row.rank}</td>
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
