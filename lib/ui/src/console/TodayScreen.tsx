'use client';

import React from 'react';
import { MyStocksTodayCard, type MyStocksTodayModelV1 } from './MyStocksTodayCard';
import type { TodayModelV1 } from './todayView';

void React;

// ---------------------------------------------------------------------------
// Today — what Miorail already knows about a reader's wallet, then one line
// for a question. The projection lives in todayView.ts; this file only draws.
// ---------------------------------------------------------------------------

/** The projection, plus the holder's card the Stocks page already draws. */
export type TodayScreenModelV1 = TodayModelV1 & { stocksToday: MyStocksTodayModelV1 | null };

export function TodayScreen({ model }: { model: TodayScreenModelV1 }) {
  const wallet = model.wallet;
  return (
    <section className="radar today" aria-label="Today">
      <header className="radar-hero">
        <div>
          <p className="eyebrow">Today on Base</p>
          <h2>{wallet ? 'Your wallet, checked' : 'Is it the real one, and can you sell it?'}</h2>
          <p>
            {wallet
              ? 'What Miorail already knows about the tokens you hold, before you ask anything.'
              : 'Paste a token address. Miorail says whether its issuer lists it, and what getting back out costs.'}
          </p>
        </div>
        {wallet && wallet.tiles.length > 0 ? (
          <div className="radar-counts" aria-label="Today in numbers">
            {wallet.tiles.map((tile) => (
              <span key={tile.label} data-tone={tile.attention ? 'attention' : undefined}>
                <strong>{tile.value}</strong>
                {tile.label}
              </span>
            ))}
          </div>
        ) : null}
      </header>


      {wallet ? (
        <section className="radar-section" aria-labelledby="today-items-title">
          <div className="radar-section-head">
            <h3 id="today-items-title">Worth a look</h3>
          </div>
          {wallet.unavailable ? <p className="note warn">{wallet.unavailable}</p> : null}
          {wallet.loading ? <p className="empty">Reading your wallet…</p> : null}
          <div className="cardrows">
            {wallet.items.map((item) => (
              <article className="cardrow" key={item.key} data-tone={item.attention ? 'attention' : undefined}>
                <div className="cr-top">
                  <span className="cr-name">{item.title}</span>
                </div>
                <p className="lnote">{item.body}</p>
                {item.actions.length > 0 ? (
                  <div className="card-actions">
                    {item.actions.map((action) => (
                      <button key={action.label} type="button" className="btn sec" onClick={action.onClick}>
                        {action.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : model.onSignIn ? (
        <section className="radar-section">
          <div className="radar-empty">
            <strong>Sign in to see your wallet here.</strong>
            <p className="lnote">
              Lookalikes among your tokens, rewards you can claim and changes in the markets you watch,
              read for you before you ask.
            </p>
            <button type="button" className="btn" onClick={model.onSignIn}>
              Continue with your wallet
            </button>
          </div>
        </section>
      ) : null}

      {model.stocksToday ? <MyStocksTodayCard model={model.stocksToday} /> : null}

      <form
        className="b20-ask-form today-ask"
        onSubmit={(event) => {
          event.preventDefault();
          model.ask.onSubmit();
        }}
      >
        <label htmlFor="today-ask-input" className="sr-only">
          Ask about a token, a stock, your rewards or a swap
        </label>
        <div>
          <input
            id="today-ask-input"
            value={model.ask.value}
            maxLength={500}
            placeholder={model.ask.placeholder}
            autoComplete="off"
            onChange={(event) => model.ask.onChange(event.currentTarget.value)}
          />
          <button type="submit" className="btn" disabled={model.ask.value.trim().length === 0}>
            Go
          </button>
        </div>
      </form>
      {model.ask.reply ? <p className="lnote">{model.ask.reply}</p> : null}
      {model.ask.suggestions.length > 0 ? (
        <div className="mcp-filters" aria-label="Try">
          {model.ask.suggestions.map((suggestion) => (
            <button key={suggestion.label} type="button" className="btn sec" onClick={suggestion.onClick}>
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}

    </section>
  );
}
