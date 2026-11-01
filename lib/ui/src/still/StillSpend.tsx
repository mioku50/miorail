import React, { useId } from 'react';
import { formatCents } from '@mioagent/still-engine/format';

import type { SkyStateV1 } from './skyState';
import { StillHeader, StillLink } from './StillFrame';
import { StillIconV1 } from './icons';
import {
  SPEND_COUNTRIES_V1,
  SPEND_TYPES_V1,
  spendCountryNameV1,
  type SpendProductRowV1,
  type SpendProductViewV1,
  type SpendTypeV1,
} from './spendView';

void React;

export interface StillSpendModelV1 {
  sky: SkyStateV1;
  signedIn: boolean;
  signInHref: string;
  type: SpendTypeV1;
  onType: (type: SpendTypeV1) => void;
  country: string;
  onCountry: (country: string) => void;
  /** A brand, for gift cards. */
  query: string;
  onQuery: (query: string) => void;
  onSearch: () => void;
  searching: boolean;
  products: SpendProductRowV1[] | null;
  searchError: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
  product: SpendProductViewV1 | null;
  productLoading: boolean;
  productError: string | null;
  /** The reader's Still room from the Mirror; null signed out or unread. */
  room: { cents: string; complete: boolean } | null;
}

/** Stage 1 of Still Spend: what a loan could pay for, with Bitrefill's USDC
 * prices. It shows and compares; it cannot buy, and says so. */
export function StillSpend({ model }: { model: StillSpendModelV1 }) {
  const id = useId();
  const product = model.product;
  return (
    <div className="still-borrow still-spend">
      <StillHeader
        title="Spend"
        sky={model.sky}
        lede="What a loan against what you hold could pay for: mobile data, phone top-ups and gift cards from Bitrefill, priced in USDC."
      />
      <p className="still-section still-notice">
        <StillIconV1 name="info" />
        <span>Nothing can be bought here yet. Paying from Still, with the loan and the payment in one transaction, is the next step.</span>
      </p>
      <div className="still-borrow-grid">
        <section className="still-card still-borrow-step" aria-labelledby={`${id}-what`}>
          <div className="still-step"><span className="n" aria-hidden="true">1</span>What</div>
          <h2 id={`${id}-what`}>Choose what to look at.</h2>
          <div className="still-spend-kinds" role="group" aria-label="Kind of product">
            {SPEND_TYPES_V1.map((kind) => (
              <button key={kind.type} className="still-spend-kind" type="button" aria-pressed={model.type === kind.type} onClick={() => model.onType(kind.type)}>
                <span className="still-spend-kind-icon"><StillIconV1 name={kind.type} /></span>
                <span><strong>{kind.label}</strong><span className="still-note">{kind.blurb}</span></span>
              </button>
            ))}
          </div>
          <label className="still-borrow-label" htmlFor={`${id}-country`}>Country</label>
          <select id={`${id}-country`} className="still-borrow-stock-select" value={model.country} onChange={(event) => model.onCountry(event.target.value)}>
            {SPEND_COUNTRIES_V1.map((code) => <option key={code} value={code}>{spendCountryNameV1(code)}</option>)}
          </select>
          {model.type === 'giftcard' ? (
            <form onSubmit={(event) => { event.preventDefault(); model.onSearch(); }}>
              <label className="still-borrow-label" htmlFor={`${id}-brand`}>Brand</label>
              <div className="still-spend-search-row">
                <div className="still-borrow-amount">
                  <input id={`${id}-brand`} type="text" autoComplete="off" spellCheck={false} maxLength={40} value={model.query} placeholder="Amazon, Steam, Uber…" onChange={(event) => model.onQuery(event.target.value)} />
                  <span aria-hidden="true" />
                </div>
                <button type="submit" className="still-btn" disabled={model.searching}>Search</button>
              </div>
            </form>
          ) : null}
          <div className="still-spend-results" aria-live="polite">
            {model.searching ? <p className="still-note" role="status">Reading Bitrefill’s catalogue…</p>
              : model.searchError ? <p className="still-warn" role="alert">{model.searchError}</p>
                : model.products && model.products.length === 0 ? <p className="still-note">Nothing in stock here for {spendCountryNameV1(model.country)}{model.query ? ` and “${model.query}”` : ''}.</p>
                  : model.products ? (
                    <div className="still-borrow-assets" role="group" aria-label="Products">
                      {model.products.map((row) => (
                        <button key={row.id} className="still-borrow-choice" type="button" aria-pressed={model.selected === row.id} onClick={() => model.onSelect(row.id)}>
                          <span><strong>{row.name}</strong>{row.coverage ? <span className="still-note">{row.coverage}</span> : null}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
          </div>
        </section>
        <section className="still-card still-borrow-step" aria-labelledby={`${id}-price`} aria-busy={model.productLoading}>
          <div className="still-step"><span className="n" aria-hidden="true">2</span>Price</div>
          <h2 id={`${id}-price`}>{product ? product.name : 'Choose a product.'}</h2>
          {model.room ? (
            <div className="still-spend-room">
              <span className="still-spend-room-label">Your Still room now</span>
              <span className="still-spend-room-amount">{model.room.complete ? '' : 'at least '}{formatCents(model.room.cents)}</span>
              <span className="still-spend-room-note">A loan for a price is read again, with Still’s terms, before anything is signed.</span>
            </div>
          ) : model.signedIn ? <p className="still-note still-spend-room-missing">Your Still room could not be read just now, so no price is compared with it.</p>
            : <p className="still-note still-spend-room-missing"><a href={model.signInHref}>Sign in</a> to see which of these your Still room covers.</p>}
          {model.productLoading ? <p className="still-note" role="status">Reading its prices…</p>
            : model.productError ? <p className="still-warn" role="alert">{model.productError}</p>
              : product ? (
                <>
                  <ul className="still-spend-prices" aria-label="Prices in USDC">
                    {product.packages.map((row) => (
                      <li key={row.label} className="still-spend-price" data-fit={row.room ?? 'unsaid'}>
                        <span className="still-spend-price-top">
                          <span className="still-spend-price-label">{row.label}</span>
                          <span className="mono still-spend-price-amount">{row.price}</span>
                        </span>
                        {row.share !== null ? (
                          <span className="still-spend-meter" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.round(row.share * 100))}%` }} /></span>
                        ) : null}
                        {row.room ? <span className="still-spend-fit">{row.room === 'within' ? 'Within your room' : 'More than your room'}</span> : null}
                      </li>
                    ))}
                  </ul>
                  {product.packages.length === 0 ? <p className="still-note">Bitrefill quoted no price in USDC for it.</p> : null}
                  {product.needs ? <p className="still-note">{product.needs}</p> : null}
                </>
              ) : <p className="still-note">Prices appear here in USDC, as Bitrefill quotes them.</p>}
        </section>
      </div>
      <div className="still-section still-borrow-foot">
        <p className="still-note">Bitrefill sells these under its own terms. Still shows them with the USDC price Bitrefill quoted, which can change by checkout. A loan creates debt, and your collateral can be liquidated. Not offered to US persons.</p>
        <StillLink href="/borrow">Get money</StillLink>
      </div>
    </div>
  );
}
