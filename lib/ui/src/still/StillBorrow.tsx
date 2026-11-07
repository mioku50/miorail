import React, { useId, useState } from 'react';

import type { SkyStateV1 } from './skyState';
import { StillHeader, StillLink } from './StillFrame';
import { StillIconV1 } from './icons';
import { STOCKS, type StockId } from '@mioagent/still-engine/registry';

void React;

export type StillBorrowAssetV1 = 'cbBTC' | 'WETH' | 'ETH' | 'PAXG' | StockId;
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
  | { state: 'ready'; productName: string; packageValue: string; priceUsdc: string; expiresAt: string; refillTo?: string | null };

/** What Get money says to a wallet that cannot send a batch, before anything is
 * asked: a stock loan goes in steps, a Spend payment as the last of them;
 * cbBTC, WETH, ETH and PAXG need one transaction. */
export function stillBorrowWalletNoteV1(input: { cannotBatch: boolean; walletName: string | null; asset: StillBorrowAssetV1 | null; paying: boolean }): string | null {
  if (!input.cannotBatch) return null;
  const name = input.walletName?.trim();
  const wallet = name && name.length <= 40 && !/^(injected|browser wallet)$/i.test(name) ? name : 'This wallet';
  const others = 'Base Account, Coinbase Wallet (Base App) or MetaMask';
  if (input.asset === 'cbBTC' || input.asset === 'WETH' || input.asset === 'ETH' || input.asset === 'PAXG') {
    return input.paying
      ? `${wallet} sends one transaction at a time, and paying Bitrefill from a loan against cbBTC, WETH, ETH or PAXG goes only as one transaction. Choose a stock, or use ${others}.`
      : `${wallet} sends one transaction at a time, and a loan against cbBTC, WETH, ETH or PAXG goes only as one transaction for now. Choose a stock, or use ${others}.`;
  }
  if (input.paying) {
    return `${wallet} sends one transaction at a time, so this loan goes in steps and the last one pays Bitrefill. Still reads the invoice again before that step; if Bitrefill no longer waits for it, nothing is paid and the loan stays yours to repay.`;
  }
  return `${wallet} sends one transaction at a time, so a loan against a stock goes in steps: your wallet asks for each one, and Still checks each next step again before it does.`;
}

/**
 * The pictures on the collateral cards (operator, 2026-11-07: "their real icons"):
 * - a stock wears the icon Coinbase publishes for its tokenized stock in its Tokenized Stocks
 *   API, served from our own origin as the Stocks pages serve it;
 * - ETH and WETH wear the ETH diamond from ethereum.org's brand assets, kept in
 *   public/tokens (see NOTICE);
 * - cbBTC and PAXG keep Still's own marks. Paxos's brand rules ask for a written agreement
 *   before its logos are used, and Coinbase publishes no cbBTC mark to integrators.
 * A picture that does not load gives way to the mark, so a card is never blank.
 */
export function stockIconPathV1(token: string): string {
  return `/api/public/stocks/icons/${token.toLowerCase()}.png`;
}
const ETH_ICON_V1 = '/tokens/eth.svg';

const CRYPTO_CHOICES_V1 = [
  ['cbBTC', 'Bitcoin on Base', '₿', null],
  ['WETH', 'Wrapped ETH', 'Ξ', ETH_ICON_V1],
  ['ETH', 'Wrap native ETH', 'Ξ', ETH_ICON_V1],
  // Gold's chemical symbol: Still's own mark, not Paxos's logo.
  ['PAXG', 'Gold, by Paxos', 'Au', null],
] as const;

/** One collateral card: its picture or mark, its token, and what it is. */
function BorrowChoiceV1(props: { asset: StillBorrowAssetV1; description: string; mark: string; icon?: string | null; stock: boolean; pressed: boolean; disabled: boolean; onChoose: (asset: StillBorrowAssetV1) => void }) {
  const [broken, setBroken] = useState(false);
  const picture = props.icon && !broken ? props.icon : null;
  const classes = ['still-borrow-symbol', props.stock ? 'is-stock' : '', picture ? 'has-icon' : ''].filter(Boolean).join(' ');
  return (
    <button className="still-borrow-choice" type="button" aria-pressed={props.pressed} disabled={props.disabled} onClick={() => props.onChoose(props.asset)}>
      <span className={classes} aria-hidden="true">
        {picture ? <img src={picture} alt="" width={32} height={32} loading="lazy" decoding="async" onError={() => setBroken(true)} /> : props.mark}
      </span>
      <span><strong>{props.asset}</strong><span className="still-note">{props.description}</span></span>
    </button>
  );
}

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
        {/* Small and in view where the loan is chosen: the operator asked on 2026-11-03 for a line that
            Still's system keeps a loan far from liquidation. It says how, and does not say a
            liquidation cannot happen: a fall of more than half still starts one. */}
        <p className="still-borrow-guard">
          <StillIconV1 name="shield" />
          <span>
            <strong>Built to stay far from liquidation.</strong> Still lends at most half of what Aave or Morpho would, and less around
            earnings or while Wall Street is closed. Even at Still’s full limit, your collateral could lose about half its value before
            liquidation could start. Every loan is checked again onchain before you sign, and Still can alert you on Telegram as prices move.
          </span>
        </p>
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
            <div><dt>cbBTC, WETH, PAXG (gold) or explicitly selected ETH</dt><dd>Morpho</dd></div>
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
              <strong>Paying Bitrefill · {paying.productName} · {paying.packageValue}{paying.refillTo ? ` for ${paying.refillTo}` : ''}: {paying.priceUsdc} USDC.</strong>{' '}
              Bitrefill holds this price until {heldUntilV1(paying.expiresAt)}. The loan is exactly this amount, and it pays the invoice.
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
                {/* Every collateral is the same kind of card, in two groups that each name the protocol
                    the loan lives on. The operator asked on 2026-11-05 for the stocks to be chosen the
                    way cbBTC and WETH are, with a mark each, instead of from a list. The mark is Still's
                    own: a stock's is the blue circle with its company's initial, as on Assets, never the
                    company's logo, which is not ours to copy. */}
                <p className="still-borrow-label" id={`${id}-crypto-label`}>Crypto and gold · Morpho</p>
                <div className="still-borrow-assets still-borrow-collateral" role="group" aria-labelledby={`${id}-crypto-label`}>
                  {CRYPTO_CHOICES_V1.filter(([asset]) => !(model.spend && asset === 'ETH')).map(([asset, description, symbol, icon]) => (
                    <BorrowChoiceV1 key={asset} asset={asset} description={description} mark={symbol} icon={icon} stock={false} pressed={model.asset === asset} disabled={busy} onChoose={model.onAsset} />
                  ))}
                </div>
                <p className="still-borrow-label" id={`${id}-stock-label`}>Stock collateral · Aave V4</p>
                <div className="still-borrow-assets still-borrow-collateral" role="group" aria-labelledby={`${id}-stock-label`}>
                  {STOCKS.map((stock) => (
                    <BorrowChoiceV1 key={stock.id} asset={stock.id} description={stock.name} mark={stock.name.charAt(0)} icon={stockIconPathV1(stock.token)} stock pressed={model.asset === stock.id} disabled={busy} onChoose={model.onAsset} />
                  ))}
                </div>
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
                      ? 'The next page checks the loan and the payment together before you approve anything in your wallet.'
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
