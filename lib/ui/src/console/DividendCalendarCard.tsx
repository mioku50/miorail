'use client';

import React, { useState } from 'react';

import type { DividendCalendarViewV1 } from './dividendCalendarView';

void React;

/** The soonest payments, and this many before "Show all": the card sits above
 * the board and must not push it a phone's height down. */
const DIVIDEND_ROWS_FOLDED_V1 = 3;

/** Dividends on Base: what each company declared, and what reached the token.
 * Every sentence comes from the view, so both boards say the same thing. */
export function DividendCalendarCard({ view }: { view: DividendCalendarViewV1 }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? view.rows : view.rows.slice(0, DIVIDEND_ROWS_FOLDED_V1);
  const hidden = view.rows.length - rows.length;
  return (
    <section className="panel" aria-label={view.title}>
      <div className="ph">
        <h3>{view.title}</h3>
      </div>
      <div className="pb">
        <p className="lnote">{view.lede}</p>
        <table>
          <thead>
            <tr>
              <th>Stock</th>
              <th>Next</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="nm">
                  {row.symbol}
                  <div className="lnote">{row.tokenSymbol}</div>
                </td>
                <td>
                  <span className="mono">{row.next}</span>{' '}
                  <span className="pill cr-status" data-tone="neutral">
                    {row.state}
                  </span>
                  {row.effect ? <div className="lnote">{row.effect}</div> : null}
                  {row.source ? (
                    <div className="lnote">
                      <a href={row.source.href} target="_blank" rel="noreferrer">
                        {row.source.label}
                      </a>
                    </div>
                  ) : null}
                </td>
                <td className="lnote">{row.last ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {hidden > 0 ? (
          <button type="button" className="btn sec" onClick={() => setExpanded(true)}>
            Show all {view.rows.length}
          </button>
        ) : null}
        {view.none ? <p className="lnote">{view.none}</p> : null}
        <p className="lnote">{view.note}</p>
      </div>
    </section>
  );
}
