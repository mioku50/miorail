import React, { useId } from 'react';

import type { SkyStateV1 } from './skyState';
import { StillHeader, StillLink } from './StillFrame';
import { STOCKS, type StockId } from '@mioagent/still-engine/registry';

void React;

export type StillBorrowAssetV1 = 'cbBTC' | 'WETH' | 'ETH' | StockId;
/** Still's limit beside the protocol's own, in the page's words. */
export interface StillBorrowComparisonV1 {
  protocol: 'Aave V4' | 'Morpho';
  protocolLimitUsdc: string;
  stillLimitUsdc: string;
  sharePercent: string;
  /** How far all the collateral could fall before liquidation, with the debt at Still's full limit. */
  marginPercent: string;
  /** Why the stock counts lower now; null at the full share. */
  lowered: string | null;
}
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
    nativeReserve?: string;
    existingDebt?: string;
    walletBalance: string | null;
    pledged: string | null;
    maximumUsdc: string | null;
    blockNumber: number | null;
    /** The protocol's limit and Still's, as the server measured both. */
    comparison?: StillBorrowComparisonV1 | null;
  };
  error: string | null;
  /** An amount the server said this wallet can add, after refusing more. */
  suggestedAmount?: string | null;
  /** The connected wallet cannot send a loan at all (one batch only). The
   * limit can still be read; the loan cannot be sent from this wallet. */
  walletNote?: string | null;
  onSuggestedAmount?: (amount: string) => void;
  /** Fills the amount with what the wallet holds of the chosen collateral. */
  onMax?: () => void;
  maxReading?: boolean;
  /** Still Spend: the Bitrefill invoice this loan pays in the same batch. Its
   * price is the loan; native ETH cannot carry a payment. */
  spend?: StillBorrowSpendV1 | null;
}
export type StillBorrowSpendV1 =
  | { state: 'reading' }
  | { state: 'gone' }
  | { state: 'ready'; productName: string; packageValue: string; priceUsdc: string; expiresAt: string };

function heldUntilV1(iso: string): string {
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'soon';
}

/** Choose a precise pledge, read the server's limit, then choose a loan.
 * This page creates no wallet request and computes no borrowing allowance. */
export function StillBorrow({ model }: { model: StillBorrowModelV1 }) {
  const id = useId();
  const busy = model.reading || model.preparing;
  const capacity = model.needsRead ? null : model.capacity;
  const canRead = model.asset !== null && model.collateralAmount.trim().length > 0 && !busy;
  const paying = model.spend?.state === 'ready' ? model.spend : null;
  const canReview = capacity !== null && capacity.maximumUsdc !== null && model.asset !== null && model.borrowAmount.trim().length > 0 && !busy &&
    (model.spend == null || paying !== null);
  const tokenAmount = (amount: string | null) => amount === null ? 'Not read' : `${amount} ${model.asset ?? ''}`.trim();

  return (
    <div className="still-borrow">
      <StillHeader title="Get money" sky={model.sky} />
      <div className="still-section still-borrow-intro">
        <p className="still-sub">Choose collateral, read your limit, then choose how much USDC to borrow.</p>
        {/* Said where the decision is made, not in a footnote: the operator
            asked on 2026-10-31 that the product name the protocols. */}
        <section className="still-borrow-venues" aria-labelledby={`${id}-venues`}>
          <h2 id={`${id}-venues`} className="still-eyebrow">Where your loan lives</h2>
          <p className="still-note">
            Still is not a lender and never holds your collateral or your USDC. Your wallet borrows directly from a
            lending protocol, and the position is recorded there, under your wallet.
          </p>
          <dl className="still-borrow-venue-list">
            <div><dt>Tokenized stocks</dt><dd>Aave V4</dd></div>
            <div><dt>cbBTC, WETH or explicitly selected ETH</dt><dd>Morpho</dd></div>
          </dl>
        </section>
      </div>
      {!model.signedIn ? null : model.spend?.state === 'reading' ? <p className="still-section still-note" role="status">Reading your Bitrefill invoice…</p>
        : model.spend?.state === 'gone' ? (
          <p className="still-section still-warn" role="alert">
            Still no longer holds this Bitrefill invoice: it expired, or the server restarted. Nothing was paid. <StillLink href="/spend">Open a new one from Spend</StillLink>.
          </p>
        ) : paying ? (
          <div className="still-section still-notice" role="note">
            <span>
              <strong>Paying Bitrefill · {paying.productName} · {paying.packageValue}: {paying.priceUsdc} USDC.</strong>{' '}
              Bitrefill holds this price until {heldUntilV1(paying.expiresAt)}. The loan is exactly this amount, and the same transaction pays the invoice.
            </span>
          </div>
        ) : null}
      {!model.signedIn ? (
        <div className="still-section still-card still-borrow-signin">
          <h2>Your wallet, your choice.</h2>
          <p className="still-sub">Sign in to read your balances and borrowing limit.</p>
          <a className="still-btn" href={model.signInHref}>Sign in</a>
        </div>
      ) : (
        <>
          {model.walletNote ? <p className="still-section still-warn" role="status">{model.walletNote}</p> : null}
          {model.error ? <p className="still-section still-warn" role="alert">{model.error}</p> : null}
          {model.suggestedAmount && model.onSuggestedAmount && model.asset ? (
            <p className="still-section">
              <button type="button" className="still-btn sec" disabled={busy} onClick={() => model.onSuggestedAmount!(model.suggestedAmount!)}>
                Use {model.suggestedAmount} {model.asset}
              </button>
            </p>
          ) : null}
          <div className="still-borrow-grid">
            <section className="still-card still-borrow-step" aria-labelledby={`${id}-collateral-title`}>
              <div className="still-step"><span className="n" aria-hidden="true">1</span>Collateral</div>
              <h2 id={`${id}-collateral-title`}>Choose what to add.</h2>
              <form onSubmit={(event) => { event.preventDefault(); if (canRead) model.onReadLimit(); }}>
                <div className="still-borrow-assets" role="group" aria-label="Collateral token">
                  {([
                    ['cbBTC', 'Bitcoin on Base', '₿'],
                    ['WETH', 'Wrapped ETH', 'Ξ'],
                    ['ETH', 'Wrap native ETH', 'Ξ'],
                  ] as const).filter(([asset]) => !(model.spend && asset === 'ETH')).map(([asset, description, symbol]) => (
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
                <div className={model.onMax ? 'still-borrow-amount has-max' : 'still-borrow-amount'}>
                  <input id={`${id}-collateral`} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={model.collateralAmount} placeholder="0" disabled={busy || model.asset === null} aria-describedby={`${id}-collateral-unit ${id}-collateral-help`} onChange={(event) => model.onCollateralAmount(event.target.value)} />
                  {model.onMax ? (
                    <button type="button" className="still-borrow-max" disabled={busy || model.maxReading || model.asset === null}
                      title={model.asset === 'ETH' ? 'All the ETH in your wallet, less 0.0005 ETH kept for network fees' : 'All of it in your wallet'}
                      onClick={model.onMax}>{model.maxReading ? 'Reading…' : 'Max'}</button>
                  ) : null}
                  <span id={`${id}-collateral-unit`} className="mono">{model.asset ?? 'Token'}</span>
                </div>
                <p id={`${id}-collateral-help`} className="still-note">{model.asset === 'ETH' ? 'Enter the exact ETH to wrap and pledge. Wallet-held WETH is not spent. Keep ETH for wallet/network fees.' : 'Enter 0 to use only collateral already deposited. Choosing an amount does not move it.'}</p>
                <button type="submit" className="still-btn" disabled={!canRead}>{model.reading ? 'Reading limit…' : 'Read borrowing limit'}</button>
              </form>
            </section>

            <section className="still-card still-borrow-step" aria-labelledby={`${id}-loan-title`} aria-busy={busy}>
              <div className="still-step"><span className="n" aria-hidden="true">2</span>Borrowing</div>
              <h2 id={`${id}-loan-title`}>Choose your loan.</h2>
              {model.reading ? <p className="still-note" role="status">Reading your balance and borrowing limit…</p> : null}
              {capacity ? (
                <>
                  <div className="still-borrow-limit" aria-live="polite">
                    <div className="still-note">Still’s borrowing limit</div>
                    <div className="still-borrow-maximum mono">{capacity.maximumUsdc === null ? 'Not read' : <>{capacity.maximumUsdc}<span> USDC</span></>}</div>
                    <dl className="still-borrow-facts">
                      <div><dt>In your wallet</dt><dd className="mono">{tokenAmount(capacity.walletBalance)}</dd></div>
                      <div><dt>Already deposited</dt><dd className="mono">{capacity.pledged === null ? 'Not read' : model.asset === 'ETH' ? capacity.pledged + ' WETH' : tokenAmount(capacity.pledged)}</dd></div>
                      {capacity.existingDebt ? <div><dt>Current debt</dt><dd className="mono">{capacity.existingDebt} USDC</dd></div> : null}
                    </dl>
                    <p className="still-note still-borrow-block">{capacity.blockNumber === null ? 'Reading block not available.' : <>Read at Base block <span className="mono">{capacity.blockNumber.toLocaleString('en-US')}</span>.</>}</p>
                    {/* What Still's limit is worth, in numbers: the operator
                        asked on 2026-10-31 for "Aave would lend $X, Still
                        lends $Y, because…" where the amount is chosen. */}
                    {capacity.comparison ? (
                      <div className="still-borrow-compare">
                        <dl className="still-borrow-compare-list">
                          <div><dt>{capacity.comparison.protocol} would lend up to</dt><dd className="mono">{capacity.comparison.protocolLimitUsdc} USDC</dd></div>
                          <div><dt>Still lends up to</dt><dd className="mono">{capacity.comparison.stillLimitUsdc} USDC · {capacity.comparison.sharePercent} of it</dd></div>
                        </dl>
                        <p className="still-note">Borrowing {capacity.comparison.protocol}’s full amount, the smallest fall in price could start liquidation. Borrowing Still’s, your collateral could fall {capacity.comparison.marginPercent} first.</p>
                        {capacity.comparison.lowered ? <p className="still-note">{capacity.comparison.lowered}</p> : null}
                      </div>
                    ) : null}
                  </div>
                  {capacity.maximumUsdc === null ? <p className="still-note">The limit could not be read. Read it again before continuing.</p> : null}
                  {capacity.nativeReserve ? <p className="still-note">At least {capacity.nativeReserve} ETH is kept out of the collateral for wallet/network fees. Fees are not quoted here; your wallet calculates them before approval.</p> : null}
                  <form onSubmit={(event) => { event.preventDefault(); if (canReview) model.onReview(); }}>
                    <label className="still-borrow-label" htmlFor={`${id}-loan`}>{model.spend ? 'USDC to borrow · the invoice’s price' : 'USDC to borrow'}</label>
                    <div className="still-borrow-amount">
                      <input id={`${id}-loan`} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={model.borrowAmount} readOnly={model.spend != null} disabled={busy || capacity.maximumUsdc === null} aria-describedby={`${id}-loan-help`} onChange={(event) => model.onBorrowAmount(event.target.value)} />
                      <span className="mono" aria-hidden="true">USDC</span>
                    </div>
                    <p id={`${id}-loan-help`} className="still-note">{model.spend
                      ? 'The next page checks the loan and the payment together, as one transaction, before you approve anything in your wallet.'
                      : 'The next page checks this exact amount and shows the terms before you approve anything in your wallet.'}</p>
                    <button type="submit" className="still-btn" disabled={!canReview}>{model.preparing ? 'Preparing review…' : model.spend ? 'Review loan and payment' : 'Review loan'}</button>
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
