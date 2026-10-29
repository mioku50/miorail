import React, { useId } from 'react';

import type { SkyStateV1 } from './skyState';
import { StillHeader, StillLink } from './StillFrame';
import { STOCKS, type StockId } from '@mioagent/still-engine/registry';

void React;

export type StillBorrowAssetV1 = 'cbBTC' | 'WETH' | StockId;
export interface StillBorrowModelV1 {
  sky: SkyStateV1;
  signedIn: boolean;
  signInHref: string;
  asset: StillBorrowAssetV1 | null;
  onAsset: (asset: StillBorrowAssetV1) => void;
  collateralAmount: string;
  onCollateralAmount: (amount: string) => void;
  borrowAmount: string;
  onBorrowAmount: (amount: string) => void;
  reading: boolean;
  preparing: boolean;
  needsRead: boolean;
  onReadLimit: () => void;
  onReview: () => void;
  /** Display units already prepared by the server, never a client estimate. */
  capacity: null | {
    walletBalance: string | null;
    pledged: string | null;
    maximumUsdc: string | null;
    blockNumber: number | null;
  };
  error: string | null;
}

/** Choose a precise pledge, read the server's limit, then choose a loan.
 * This page creates no wallet request and computes no borrowing allowance. */
export function StillBorrow({ model }: { model: StillBorrowModelV1 }) {
  const id = useId();
  const busy = model.reading || model.preparing;
  const capacity = model.needsRead ? null : model.capacity;
  const canRead = model.asset !== null && model.collateralAmount.trim().length > 0 && !busy;
  const canReview = capacity !== null && capacity.maximumUsdc !== null && model.asset !== null && model.borrowAmount.trim().length > 0 && !busy;
  const tokenAmount = (amount: string | null) => amount === null ? 'Not read' : `${amount} ${model.asset ?? ''}`.trim();

  return (
    <div className="still-borrow">
      <StillHeader title="Get money" sky={model.sky} />
      <div className="still-section still-borrow-intro">
        <p className="still-sub">Choose collateral, read your limit, then choose how much USDC to borrow.</p>
        <p className="still-note">Tokenized stocks through Aave V4; cbBTC or WETH through Morpho. Native ETH is not added here.</p>
      </div>
      {!model.signedIn ? (
        <div className="still-section still-card still-borrow-signin">
          <h2>Your wallet, your choice.</h2>
          <p className="still-sub">Sign in to read your balances and borrowing limit.</p>
          <a className="still-btn" href={model.signInHref}>Sign in</a>
        </div>
      ) : (
        <>
          {model.error ? <p className="still-section still-warn" role="alert">{model.error}</p> : null}
          <div className="still-borrow-grid">
            <section className="still-card still-borrow-step" aria-labelledby={`${id}-collateral-title`}>
              <div className="still-eyebrow">1 · Collateral</div>
              <h2 id={`${id}-collateral-title`}>Choose what to add.</h2>
              <form onSubmit={(event) => { event.preventDefault(); if (canRead) model.onReadLimit(); }}>
                <div className="still-borrow-assets" role="group" aria-label="Collateral token">
                  {([
                    ['cbBTC', 'Bitcoin on Base', '₿'],
                    ['WETH', 'Wrapped ETH', 'Ξ'],
                  ] as const).map(([asset, description, symbol]) => (
                    <button key={asset} className="still-borrow-choice" type="button" aria-pressed={model.asset === asset} disabled={busy} onClick={() => model.onAsset(asset)}>
                      <span className="still-borrow-symbol" aria-hidden="true">{symbol}</span>
                      <span><strong>{asset}</strong><span className="still-note">{description}</span></span>
                    </button>
                  ))}
                </div>
                <label className="still-borrow-label" htmlFor={`${id}-stock`}>Stock collateral · Aave V4</label>
                <select id={`${id}-stock`} className="still-borrow-stock-select" disabled={busy}
                  value={STOCKS.some(stock => stock.id === model.asset) ? model.asset! : ''}
                  onChange={event => { const stock = STOCKS.find(row => row.id === event.target.value); if (stock) model.onAsset(stock.id); }}>
                  <option value="">Choose a stock</option>
                  {STOCKS.map(stock => <option value={stock.id} key={stock.id}>{stock.id} · {stock.name}</option>)}
                </select>
                <label className="still-borrow-label" htmlFor={`${id}-collateral`}>Amount to add</label>
                <div className="still-borrow-amount">
                  <input id={`${id}-collateral`} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={model.collateralAmount} placeholder="0" disabled={busy || model.asset === null} aria-describedby={`${id}-collateral-unit ${id}-collateral-help`} onChange={(event) => model.onCollateralAmount(event.target.value)} />
                  <span id={`${id}-collateral-unit`} className="mono">{model.asset ?? 'Token'}</span>
                </div>
                <p id={`${id}-collateral-help`} className="still-note">Enter 0 to use only collateral already deposited. Choosing an amount does not move it.</p>
                <button type="submit" className="still-btn" disabled={!canRead}>{model.reading ? 'Reading limit…' : 'Read borrowing limit'}</button>
              </form>
            </section>

            <section className="still-card still-borrow-step" aria-labelledby={`${id}-loan-title`} aria-busy={busy}>
              <div className="still-eyebrow">2 · Borrowing</div>
              <h2 id={`${id}-loan-title`}>Choose your loan.</h2>
              {model.reading ? <p className="still-note" role="status">Reading your balance and borrowing limit…</p> : null}
              {capacity ? (
                <>
                  <div className="still-borrow-limit" aria-live="polite">
                    <div className="still-note">Still’s borrowing limit</div>
                    <div className="still-borrow-maximum mono">{capacity.maximumUsdc === null ? 'Not read' : <>{capacity.maximumUsdc}<span> USDC</span></>}</div>
                    <dl className="still-borrow-facts">
                      <div><dt>In your wallet</dt><dd className="mono">{tokenAmount(capacity.walletBalance)}</dd></div>
                      <div><dt>Already deposited</dt><dd className="mono">{tokenAmount(capacity.pledged)}</dd></div>
                    </dl>
                    <p className="still-note still-borrow-block">{capacity.blockNumber === null ? 'Reading block not available.' : <>Read at Base block <span className="mono">{capacity.blockNumber.toLocaleString('en-US')}</span>.</>}</p>
                  </div>
                  {capacity.maximumUsdc === null ? <p className="still-note">The limit could not be read. Read it again before continuing.</p> : null}
                  <form onSubmit={(event) => { event.preventDefault(); if (canReview) model.onReview(); }}>
                    <label className="still-borrow-label" htmlFor={`${id}-loan`}>USDC to borrow</label>
                    <div className="still-borrow-amount">
                      <input id={`${id}-loan`} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={model.borrowAmount} disabled={busy || capacity.maximumUsdc === null} aria-describedby={`${id}-loan-help`} onChange={(event) => model.onBorrowAmount(event.target.value)} />
                      <span className="mono" aria-hidden="true">USDC</span>
                    </div>
                    <p id={`${id}-loan-help`} className="still-note">The next page checks this exact amount and shows the terms before you approve anything in your wallet.</p>
                    <button type="submit" className="still-btn" disabled={!canReview}>{model.preparing ? 'Preparing review…' : 'Review loan'}</button>
                  </form>
                </>
              ) : !model.reading ? (
                <p className="still-note" role="status">{model.capacity && model.needsRead ? 'Your collateral choice changed. Read the borrowing limit again.' : 'Choose your collateral and read the borrowing limit first.'}</p>
              ) : null}
            </section>
          </div>
        </>
      )}
      <div className="still-section still-borrow-foot">
        <p className="still-note">Still’s limit is not a recommendation to borrow. A loan creates debt and your collateral can be liquidated.</p>
        <StillLink href="/assets">Back to Assets</StillLink>
      </div>
    </div>
  );
}
