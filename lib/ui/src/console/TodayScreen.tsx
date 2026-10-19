'use client';

import React from 'react';
import { MyStocksTodayCard, type MyStocksTodayModelV1 } from './MyStocksTodayCard';
import { MyStockCashOut } from './MyStockCashOut';
import { TodayWallet } from './TodayWallet';
import { TodayAavePosition, type TodayAavePositionModelV1 } from './TodayAavePosition';
import { StockShareLinks } from './StockShareLinks';
import {
  todayHoldingsViewV1,
  type TodayHoldingQuoteV1,
  type TodayHoldingTileV1,
  type TodayHoldingsViewV1,
  type TodayModelV1,
  type TodayItemV1,
} from './todayView';

void React;

export type TodayScreenModelV1 = TodayModelV1 & {
  stocksToday: MyStocksTodayModelV1 | null;
  aavePosition?: TodayAavePositionModelV1 | null;
  /** The Stocks board's icons and Base prices, by token address. */
  stockQuotes?: ReadonlyMap<string, TodayHoldingQuoteV1> | null;
};

/** How many holdings lead above the question. Three rows and a finding still
 * leave the question on a phone's first screen; the rest stay in the full card. */
export const TODAY_LEAD_HOLDINGS_V1 = 3;

function dateV1(iso: string | null): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) + ' UTC';
}

function TodayItem({ item }: { item: TodayItemV1 }) {
  return <article className="cardrow" data-tone={item.attention ? 'attention' : undefined}>
    <span className="cr-name">{item.title}</span>
    <p className="lnote">{item.body}</p>
    {item.clocks ? <dl className="today-watch-clocks">
      {item.clocks.map(clock => <div key={clock.id} data-tone={clock.tone === 'warn' ? 'attention' : undefined}>
        <dt>{clock.label}</dt><dd><strong>{clock.state}</strong>
          {clock.detail ? <span>{clock.detail}</span> : null}
          {clock.note ? <span>{clock.note}</span> : null}
        </dd>
      </div>)}
    </dl> : null}
    {item.actions.length > 0 ? <div className="card-actions">
      {item.actions.map(action => <button key={action.label} type="button" className="btn sec" onClick={action.onClick}>
        {action.label}
      </button>)}
    </div> : null}
  </article>;
}

/** Coinbase's own icon, served from our origin; the ticker's letter where
 * there is none. Decorative: the ticker beside it is the name. */
function StockFace({ tile }: { tile: TodayHoldingTileV1 }) {
  return tile.iconPath
    ? <img className="mr-stock-icon" src={tile.iconPath} alt="" width={40} height={40} decoding="async" />
    : <span className="mr-stock-icon mr-choice-letter" aria-hidden="true">{tile.symbol.slice(0, 1)}</span>;
}

/** A holding, by its face: icon, ticker, company and reference value, one row
 * that opens to its record and its actions. A reference value cannot become
 * cash proceeds; the quote request requires pressing Check cash out, through
 * the existing guarded control. */
function TodayStockTile({ tile, model }: { tile: TodayHoldingTileV1; model: TodayScreenModelV1 }) {
  const stocks = model.stocksToday!;
  const actions = <>
    {model.stockActions.onOpenDividends ? <button type="button" className="btn sec"
      onClick={model.stockActions.onOpenDividends}>Dividends</button> : null}
    <button type="button" className="btn sec"
      onClick={() => model.stockActions.onOpenStock(tile.symbol)}>View market</button>
    <StockShareLinks symbol={tile.symbol} folded />
  </>;
  return <article className="today-stock" aria-label={`Your ${tile.tokenSymbol}`}>
    <details>
      <summary className="today-stock-id">
        <StockFace tile={tile} />
        <strong className="today-stock-name">{tile.tokenSymbol}</strong>
        <span className="today-stock-company">{tile.company}</span>
        <strong className="today-stock-value">{tile.valueLabel}</strong>
        <span className="today-stock-px mono">{tile.baseLine ?? ''}</span>
      </summary>
      <p className="lnote">{tile.tokens} held{tile.referenceAt
        ? ` · Reference value · ${dateV1(tile.referenceAt) ?? 'publication time unavailable'}` : ''}</p>
      {stocks.onMeasureCashOut ? <MyStockCashOut key={`${stocks.walletKey}:${tile.tokenAddress}`}
        tokenAddress={tile.tokenAddress} tokenSymbol={tile.tokenSymbol}
        overviewTokens={tile.tokens} onMeasure={stocks.onMeasureCashOut} compact additionalActions={actions} />
        : <div className="card-actions">{actions}</div>}
    </details>
  </article>;
}

/** The holdings above the question, the largest first; all of them, with
 * their records, stay in the full card below. */
function TodayStocks({ model, view }: { model: TodayScreenModelV1; view: TodayHoldingsViewV1 }) {
  const stocks = model.stocksToday;
  if (!stocks) return null;
  if (view.tiles.length === 0) return stocks.loading || stocks.failed
    ? <p className="lnote" role="status">{stocks.failed
      ? 'Your stock overview could not be refreshed. This says nothing about your holdings.'
      : 'Reading your stocks…'}</p>
    : null;
  const lead = view.tiles.slice(0, TODAY_LEAD_HOLDINGS_V1);
  const more = view.tiles.length - lead.length;
  return <section className="radar-section" aria-labelledby="today-stocks-title">
    <h3 id="today-stocks-title">Your stocks</h3>
    {stocks.failed ? <p className="lnote" role="status">The overview could not be refreshed; these are the last dated readings.</p> : null}
    <div className="today-stocks">
      {lead.map(tile => <TodayStockTile key={tile.tokenAddress} tile={tile} model={model} />)}
    </div>
    {more > 0 ? <p className="lnote">{more} more in Stocks and recent updates below.</p> : null}
  </section>;
}

export function TodayScreen({ model }: { model: TodayScreenModelV1 }) {
  const wallet = model.wallet;
  const lead = wallet?.items.find(item => item.attention);
  const remaining = wallet?.items.filter(item => item !== lead) ?? [];
  const groups = [
    { title: 'More addresses to check', items: remaining.filter(item => item.attention) },
    { title: 'Rewards', items: remaining.filter(item => item.key === 'rewards') },
    { title: remaining.find(item => item.key === 'unchecked')?.title ?? 'Outside reviewed coverage',
      items: remaining.filter(item => item.key === 'unchecked') },
    { title: 'Markets and watches', items: remaining.filter(item => !item.attention && !['rewards', 'unchecked'].includes(item.key)) },
  ].filter(group => group.items.length > 0);
  const data = wallet ? model.stocksToday?.data : null;
  const updates = data && !data.changesUnavailable && !data.changesTruncated
    ? data.inbox.heldCount + data.inbox.watchedCount : null;
  const updatedAt = dateV1(wallet?.overviewUpdatedAt ?? null);
  const holdings = todayHoldingsViewV1(wallet ? model.stocksToday?.data?.holdings ?? [] : [], model.stockQuotes);
  // The total already counts the stocks; the line under it says the rest.
  const counted = wallet?.tiles.filter(tile => (holdings.total ? /address(es)? to check/u
    : /stock(s)? held|address(es)? to check/u).test(tile.label)) ?? [];
  return (
    <section className="radar today" aria-label="Today">
      <header className="radar-hero">
        <div>
          <p className="eyebrow">Today on Base</p>
          <h2>{wallet ? 'Your Base Today' : 'Is it the real one, and can you sell it?'}</h2>
          {wallet && holdings.total ? <div className="amtrow today-total" aria-label="Your stocks in reference value">
            <span className="amount mono">{holdings.total.label}</span>
            <span className="unit">in {holdings.total.priced} {holdings.total.priced === 1 ? 'stock' : 'stocks'}
              {holdings.total.unpriced > 0 ? ` · ${holdings.total.unpriced} without a reference value` : ''}</span>
          </div> : null}
          {wallet ? <>
            {wallet.tiles.length > 0 && (counted.length > 0 || updates !== null)
              ? <p className="today-summary" aria-label="Today in numbers">
              {counted.map(tile =>
                <span key={tile.label} data-tone={tile.attention ? 'attention' : undefined}>
                  <strong>{tile.value}</strong> {tile.label}
                </span>)}
              {updates !== null ? <span><strong>{updates}</strong> {updates === 1 ? 'update' : 'updates'} on this page</span> : null}
            </p> : null}
            {holdings.total ? <p className="lnote">The issuer's reference value, not what a sale would return.</p> : null}
            <p className="lnote">{updatedAt ? `Wallet overview updated ${updatedAt}` : 'Wallet overview time unavailable'}
              {wallet.dataFreshness && wallet.dataFreshness !== 'live' ? ` · ${wallet.dataFreshness} data` : ''}
            </p>
          </> : <p>Paste a token address. Miorail checks its issuer listing and the quoted route out.</p>}
        </div>
      </header>

      {wallet?.unavailable ? <p className="note warn" role="status">{wallet.unavailable}</p> : null}
      {wallet?.loading ? <p className="empty" role="status">Reading your wallet…</p> : null}
      {lead ? <section className="radar-section" aria-labelledby="today-items-title">
        <h3 id="today-items-title">Worth your attention</h3>
        <TodayItem item={lead} />
      </section> : null}
      {wallet ? <TodayStocks model={model} view={holdings} /> : null}

      <form className="b20-ask-form today-ask" onSubmit={event => { event.preventDefault(); model.ask.onSubmit(); }}>
        <label htmlFor="today-ask-input" className="sr-only">Ask about a token, a stock, your rewards or a swap</label>
        <div>
          <input id="today-ask-input" value={model.ask.value} maxLength={500}
            placeholder="Ask something or paste a contract…" autoComplete="off"
            onChange={event => model.ask.onChange(event.currentTarget.value)} />
          <button type="submit" className="btn" disabled={model.ask.value.trim().length === 0}>Go</button>
        </div>
      </form>
      {model.ask.reply ? <p className="lnote" role="status">{model.ask.reply}</p> : null}
      {!wallet && model.onSignIn ? <div className="today-signin">
        <p className="lnote">Sign in for your holdings, rewards and updates.</p>
        <button type="button" className="btn sec" onClick={model.onSignIn}>Continue with your wallet</button>
      </div> : null}

      {wallet?.balances ? <TodayWallet model={wallet.balances} onInvestigate={wallet.onInvestigate}
        quotes={model.stockQuotes ?? null} /> : null}

      {wallet && model.aavePosition ? <TodayAavePosition model={model.aavePosition} /> : null}

      {wallet && model.stocksToday ? <details className="today-details">
        <summary>Stocks and recent updates{updates !== null ? ` · ${updates}` : ''}</summary>
        <MyStocksTodayCard model={model.stocksToday} />
      </details> : null}
      {groups.map(group => <details className="today-details" key={group.title}>
        <summary>{group.title}</summary>
        <div className="cardrows">{group.items.map(item => <TodayItem key={item.key} item={item} />)}</div>
      </details>)}
    </section>
  );
}
