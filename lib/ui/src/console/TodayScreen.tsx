'use client';

import React from 'react';
import { MyStocksTodayCard, type MyStocksTodayModelV1 } from './MyStocksTodayCard';
import { MyStockCashOut } from './MyStockCashOut';
import type { TodayModelV1, TodayItemV1 } from './todayView';

void React;

export type TodayScreenModelV1 = TodayModelV1 & { stocksToday: MyStocksTodayModelV1 | null };

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
    {item.actions.length > 0 ? <div className="card-actions">
      {item.actions.map(action => <button key={action.label} type="button" className="btn sec" onClick={action.onClick}>
        {action.label}
      </button>)}
    </div> : null}
  </article>;
}

/** One holding above the question; all holdings and source records stay below.
 * A reference value cannot become cash proceeds. The quote request requires
 * pressing Check cash out, through the existing guarded control. */
function TodayStock({ model }: { model: TodayScreenModelV1 }) {
  const stocks = model.stocksToday;
  const holding = stocks?.data?.holdings[0];
  if (!stocks) return null;
  if (!holding) return stocks.loading || stocks.failed
    ? <p className="lnote" role="status">{stocks.failed
      ? 'Your stock overview could not be refreshed. This says nothing about your holdings.'
      : 'Reading your stocks…'}</p>
    : null;
  const value = holding.reference ? Number(holding.reference.valueUsd) : null;
  const actions = <>
    {model.stockActions.onOpenDividends ? <button type="button" className="btn sec"
      onClick={model.stockActions.onOpenDividends}>Dividends</button> : null}
    <button type="button" className="btn sec"
      onClick={() => model.stockActions.onOpenStock(holding.symbol)}>View market</button>
  </>;
  return <article className="today-stock" aria-label={`Your ${holding.tokenSymbol}`}>
    <div className="today-stock-head">
      <strong>Your {holding.tokenSymbol}</strong>
      <strong>{value !== null && Number.isFinite(value)
        ? value > 0 && value < 0.01 ? '≈ less than $0.01'
          : `≈ $${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : 'Reference value unavailable'}</strong>
    </div>
    <p className="lnote">{holding.tokens} held{holding.reference
      ? ` · Reference value · ${dateV1(holding.reference.publishedAt) ?? 'publication time unavailable'}` : ''}</p>
    {stocks.failed ? <p className="lnote" role="status">The overview could not be refreshed; this is the last dated reading.</p> : null}
    {stocks.onMeasureCashOut ? <MyStockCashOut key={`${stocks.walletKey}:${holding.tokenAddress}`}
      tokenAddress={holding.tokenAddress} tokenSymbol={holding.tokenSymbol}
      overviewTokens={holding.tokens} onMeasure={stocks.onMeasureCashOut} compact additionalActions={actions} />
      : <div className="card-actions">{actions}</div>}
    {(stocks.data?.holdings.length ?? 0) > 1 ? <p className="lnote">More holdings in Stocks and recent updates below.</p> : null}
  </article>;
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
  return (
    <section className="radar today" aria-label="Today">
      <header className="radar-hero">
        <div>
          <p className="eyebrow">Today on Base</p>
          <h2>{wallet ? 'Your Base Today' : 'Is it the real one, and can you sell it?'}</h2>
          {wallet ? <>
            {wallet.tiles.length > 0 ? <p className="today-summary" aria-label="Today in numbers">
              {wallet.tiles.filter(tile => /stock(s)? held|address(es)? to check/u.test(tile.label)).map(tile =>
                <span key={tile.label} data-tone={tile.attention ? 'attention' : undefined}>
                  <strong>{tile.value}</strong> {tile.label}
                </span>)}
              {updates !== null ? <span><strong>{updates}</strong> {updates === 1 ? 'update' : 'updates'} on this page</span> : null}
            </p> : null}
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
      {wallet ? <TodayStock model={model} /> : null}

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
