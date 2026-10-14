'use client';

import React from 'react';
import type { AaveV4PositionV1 } from '@mioagent/rwa-issuer/aaveV4';
import { AAVE_V4_BASE_PAGE_V1 } from '@mioagent/rwa-issuer/aaveV4';

void React;

export interface TodayAavePositionModelV1 {
  data: AaveV4PositionV1 | null;
  loading: boolean;
  failed: boolean;
  onRead: () => void;
}

function money(value: string | null): string {
  if (value === null || !Number.isFinite(Number(value))) return 'Not read';
  const n = Number(value);
  if (n !== 0 && Math.abs(n) < 0.01) return `${n < 0 ? '−' : ''}less than $0.01`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function TodayAavePosition({ model }: { model: TodayAavePositionModelV1 }) {
  const data = model.data;
  const health = data?.healthFactor === null || data?.healthFactor === undefined ? null : Number(data.healthFactor);
  const atRisk = health !== null && health < 1;
  return <details className="today-details">
    <summary>Your Aave v4 stock position</summary>
    <div className="cardrow">
      <p className="lnote">Coinbase stocks on Base · Aave v4 Equities market. Read your deposited collateral, debt and position health.</p>
      <div className="card-actions">
        <button type="button" className="btn sec" disabled={model.loading} onClick={model.onRead}>
          {model.loading ? 'Reading Aave…' : data ? 'Read again' : 'Read my Aave position'}
        </button>
        <a className="btn sec" href={AAVE_V4_BASE_PAGE_V1} target="_blank" rel="noopener noreferrer">Open market on Aave</a>
      </div>
      {model.failed ? <p className="note warn" role="status">Your Aave position could not be refreshed. This does not mean you have no position.
        {data ? ' The dated reading below is the previous result.' : ''}</p> : null}
      {!data && !model.failed ? <p className="lnote">Nothing has been read here yet. Opening this section does not read your position.</p> : null}
      {data ? <>
        <p className="lnote">Aave API read {new Date(data.observedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC · Base MAG7 market only.</p>
        {data.state === 'empty' ? <p>No position was returned for your wallet in this Aave v4 market. Other Aave markets were not checked.</p> : <>
          <dl className="today-aave-facts">
            <div className="qrow"><dt>Collateral value</dt><dd>{money(data.collateralUsd)}</dd></div>
            <div className="qrow"><dt>Debt</dt><dd>{money(data.debtUsd)}</dd></div>
            <div className="qrow"><dt>Net accrued interest</dt><dd>{money(data.netAccruedInterestUsd)}</dd></div>
            <div className="qrow"><dt>Net borrow APY</dt><dd>{data.netBorrowApyBps === null ? 'Not read' : `${data.netBorrowApyBps / 100}%`}</dd></div>
            <div className="qrow"><dt>Health factor</dt><dd>{health === null ? 'No debt health factor returned' : health.toLocaleString('en-US', { maximumFractionDigits: 4 })}</dd></div>
            <div className="qrow"><dt>Remaining borrowing power</dt><dd>{money(data.remainingBorrowingPowerUsd)}</dd></div>
          </dl>
          <p className={atRisk ? 'note warn' : 'lnote'}>Liquidation threshold: health factor 1. A factor below 1 permits liquidation. Prices, interest and protocol settings can change it.</p>
          <p className="lnote">Values use Aave's oracle prices. Net accrued interest combines earned and charged interest. Net APY can include rewards and changes over time. Borrowing power is an API estimate, subject to liquidity, limits and a fresh simulation.</p>
        </>}
      </> : null}
    </div>
  </details>;
}
