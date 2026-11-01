import React, { useId } from 'react';
import { formatCents } from '@mioagent/still-engine/format';

import type { SkyStateV1 } from './skyState';
import { StillHeader, StillLink } from './StillFrame';
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
      <StillHeader title="Spend" sky={model.sky} />
      <div className="still-section still-borrow-intro">
        <p className="still-sub">What a loan against what you hold could pay for: mobile data, phone top-ups and gift cards from Bitrefill, priced in USDC.</p>
        <p className="still-note">Nothing can be bought here yet. Paying from Still, with the loan and the payment in one transaction, is the next step.</p>
      </div>
      <div className="still-borrow-grid">
        <section className="still-card still-borrow-step" aria-labelledby={`${id}-what`}>
          <div className="still-eyebrow">1 · What</div>
          <h2 id={`${id}-what`}>Choose what to look at.</h2>
          <div className="still-borrow-assets" role="group" aria-label="Kind of product">
            {SPEND_TYPES_V1.map((kind) => (
              <button key={kind.type} className="still-borrow-choice" type="button" aria-pressed={model.type === kind.type} onClick={() => model.onType(kind.type)}>
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
              <div className="still-borrow-amount">
                <input id={`${id}-brand`} type="text" autoComplete="off" spellCheck={false} maxLength={40} value={model.query} placeholder="Amazon, Steam, Uber…" onChange={(event) => model.onQuery(event.target.value)} />
                <span aria-hidden="true" />
              </div>
              <button type="submit" className="still-btn sec" disabled={model.searching}>Search</button>
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
          <div className="still-eyebrow">2 · Price</div>
          <h2 id={`${id}-price`}>{product ? product.name : 'Choose a product.'}</h2>
          {model.productLoading ? <p className="still-note" role="status">Reading its prices…</p>
            : model.productError ? <p className="still-warn" role="alert">{model.productError}</p>
              : product ? (
                <>
                  <dl className="still-borrow-facts">
                    {product.packages.map((row) => (
                      <div key={row.label}>
                        <dt>{row.label}</dt>
                        <dd>
                          <span className="mono">{row.price}</span>
                          {row.room ? <span className="still-spend-fit">{row.room === 'within' ? 'within your room' : 'more than your room'}</span> : null}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {product.packages.length === 0 ? <p className="still-note">Bitrefill quoted no price in USDC for it.</p> : null}
                  {product.needs ? <p className="still-note">{product.needs}</p> : null}
                  {model.room ? (
                    <p className="still-note still-spend-room">
                      Your Still room now: {model.room.complete ? '' : 'at least '}{formatCents(model.room.cents)}. A loan for the price would be read again, with Still’s terms, before anything is signed.
                    </p>
                  ) : model.signedIn ? <p className="still-note still-spend-room">Your Still room could not be read just now, so no price is compared with it.</p>
                    : <p className="still-note still-spend-room"><a href={model.signInHref}>Sign in</a> to see which of these your Still room covers.</p>}
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
