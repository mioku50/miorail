'use client';

import React, { useState } from 'react';

import type { WeekendMarketViewV1 } from './weekendMarketView';

void React;

/** The biggest moves first, and this many before "Show all": ten rows would
 * push the board itself a phone's height down. */
const WEEKEND_ROWS_FOLDED_V1 = 5;

/**
 * The weekend card: shown only while Wall Street is closed and until the next
 * session closes after the reopen. Every sentence comes from the view, so the
 * web board and the Base App board say the same thing.
 */
export function WeekendMarketCard({ view }: { view: WeekendMarketViewV1 }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? view.rows : view.rows.slice(0, WEEKEND_ROWS_FOLDED_V1);
  const hidden = view.rows.length - rows.length;
  return (
    <section className="panel" aria-label={view.title}>
      <div className="ph">
        <h3>{view.title}</h3>
        <span className={`pill ${view.state === 'in_progress' ? 'br' : 'n'}`}>{view.badge}</span>
      </div>
      <div className="pb">
        <p className="lnote">{view.lede}</p>
        <table>
          <thead>
            <tr>
              <th>Stock</th>
              <th className="r">{view.columns.close}</th>
              <th className="r">{view.columns.base}</th>
              {view.columns.reopen ? <th className="r">{view.columns.reopen}</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="nm">
                  <div className="mr-wk-stock">
                    {row.icon ? (
                      <img className="mr-choice-icon" src={row.icon} alt="" width={24} height={24} loading="lazy" decoding="async" />
                    ) : (
                      <span className="mr-choice-icon" aria-hidden="true" />
                    )}
                    <div className="mr-wk-id">
                      {row.symbol}
                      {row.name !== row.symbol ? <div className="lnote">{row.name}</div> : null}
                      {row.mark ? <div className="lnote">{row.mark}</div> : null}
                    </div>
                  </div>
                </td>
                <td className={`r mono${row.off ? ' off' : ''}`}>{row.close}</td>
                <td className={`r mono${row.off ? ' off' : ''}`}>
                  {row.base}
                  <div className="lnote">{row.move}</div>
                  {row.bar ? (
                    <span className="mr-wk-bar" data-side={row.bar.side} aria-hidden="true">
                      <span style={{ width: `${Math.round(row.bar.share * 50)}%` }} />
                    </span>
                  ) : null}
                </td>
                {view.columns.reopen ? (
                  <td className="r mono">
                    {row.reopen}
                    <div className="lnote">{row.gap}</div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {hidden > 0 ? (
          <button type="button" className="btn sec" onClick={() => setExpanded(true)}>
            Show all {view.rows.length}
          </button>
        ) : null}
        <p className="lnote">{view.note}</p>
        <div className="gift-share-row">
          <a className="btn sec" href={view.share.x} target="_blank" rel="noreferrer">
            Post on X
          </a>
          <a className="btn sec" href={view.share.farcaster} target="_blank" rel="noreferrer">
            Cast on Farcaster
          </a>
        </div>
      </div>
    </section>
  );
}
