import React, { useId } from 'react';
import { formatCents } from '@mioagent/still-engine/format';

import type { SkyStateV1 } from './skyState';
import { StillHeader, StillLink } from './StillFrame';
import { StillIconV1 } from './icons';
import {
  SPEND_TYPES_V1,
  spendCountryNameV1,
  spendCountryOptionsV1,
  spendPhoneDraftV1,
  type SpendProductRowV1,
  type SpendOrderViewV1,
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
  /** Paying from Still: null when this server does not pay Bitrefill from a loan. */
  pay?: null | {
    /** The package value chosen to pay, or none yet. */
    chosen: string | null;
    onChoose: (value: string | null) => void;
    email: string;
    onEmail: (email: string) => void;
    /** The number a top-up goes to, as the person writes it. */
    phone: string;
    onPhone: (phone: string) => void;
    creating: boolean;
    error: string | null;
    onCreate: () => void;
  };
}

/** Still Spend: what a loan could pay for, with Bitrefill's USDC prices.
 * Where the server pays Bitrefill from a loan, a price opens an invoice and the
 * Get money page; nothing is paid on this page, and nothing is signed here. */
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
        {model.pay ? (
          <span>Pay with Still: a loan for the exact price pays Bitrefill in the same transaction, which you approve in your own wallet. Up to 100 USDC a purchase.</span>
        ) : (
          <span>Nothing can be bought here yet. Paying from Still, with the loan and the payment in one transaction, is the next step.</span>
        )}
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
            {spendCountryOptionsV1().map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
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
                        {row.room || (model.pay && row.payable) ? (
                          <span className="still-spend-price-foot">
                            {row.room ? <span className="still-spend-fit">{row.room === 'within' ? 'Within your room' : 'More than your room'}</span> : <span />}
                            {model.pay && row.payable ? (
                              <button type="button" className="still-spend-pay" aria-pressed={model.pay.chosen === row.value} onClick={() => model.pay!.onChoose(model.pay!.chosen === row.value ? null : row.value)}>
                                Pay with Still
                              </button>
                            ) : null}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {model.pay && model.pay.chosen !== null ? (() => {
                    const chosen = product.packages.find((row) => row.value === model.pay!.chosen);
                    if (!chosen) return null;
                    const number = product.phone ? spendPhoneDraftV1(model.pay!.phone, product.phone.callingCode) : null;
                    return (
                      <form className="still-spend-checkout" aria-labelledby={`${id}-pay`} onSubmit={(event) => { event.preventDefault(); model.pay!.onCreate(); }}>
                        <div className="still-step"><span className="n" aria-hidden="true">3</span>Pay</div>
                        <h3 id={`${id}-pay`}>{chosen.price} for {product.name} · {chosen.label}</h3>
                        <p className="still-note">
                          Still opens Bitrefill’s invoice for it, then you choose what to borrow against. A loan of exactly {chosen.price} pays the invoice in
                          the same transaction, and you approve it in your own wallet. Bitrefill holds the price for 15 minutes.
                        </p>
                        <label className="still-borrow-label" htmlFor={`${id}-email`}>Email for Bitrefill’s receipt</label>
                        <div className="still-borrow-amount">
                          <input id={`${id}-email`} type="email" autoComplete="email" spellCheck={false} maxLength={254} value={model.pay.email}
                            onChange={(event) => model.pay!.onEmail(event.target.value)} placeholder="you@example.com" />
                          <span aria-hidden="true" />
                        </div>
                        <p className="still-note">Bitrefill sends the receipt and the order there. Still passes it to Bitrefill and keeps no copy.</p>
                        {product.phone ? (
                          <>
                            <label className="still-borrow-label" htmlFor={`${id}-phone`}>Phone number to top up</label>
                            <div className="still-borrow-amount">
                              <input id={`${id}-phone`} type="tel" inputMode="tel" autoComplete="tel" spellCheck={false} maxLength={32} value={model.pay.phone}
                                onChange={(event) => model.pay!.onPhone(event.target.value)} placeholder={`+${product.phone.callingCode} …`} aria-describedby={`${id}-phone-help`} />
                              <span aria-hidden="true" />
                            </div>
                            <p id={`${id}-phone-help`} className="still-note">
                              {number ? <>Bitrefill tops up <strong className="mono">{number}</strong>. </> : <>Write it with the country code, +{product.phone.callingCode}. </>}
                              A top-up sent to a wrong number cannot be taken back. Still passes the number to Bitrefill and holds it only while the invoice is open.
                            </p>
                          </>
                        ) : null}
                        {model.type === 'giftcard' ? <p className="still-warn">Never buy a gift card because someone asked you to pay them with one. Nobody legitimate asks for that.</p> : null}
                        {model.pay.error ? <p className="still-warn" role="alert">{model.pay.error}</p> : null}
                        <div className="still-spend-checkout-actions">
                          <button type="submit" className="still-btn" disabled={model.pay.creating || model.pay.email.trim() === '' || (product.phone !== null && number === null)}>
                            {model.pay.creating ? 'Opening the invoice…' : 'Open invoice and choose collateral'}
                          </button>
                          <button type="button" className="still-btn sec" disabled={model.pay.creating} onClick={() => model.pay!.onChoose(null)}>Cancel</button>
                        </div>
                      </form>
                    );
                  })() : null}
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

/** After the loan that paid it is confirmed: where the Bitrefill order stands,
 * as Bitrefill says, and its own page. Still proves the payment, not the delivery. */
export function StillSpendPaid({ order, reading }: { order: SpendOrderViewV1 | null; reading: boolean }) {
  return (
    <div className="still-section still-extras" aria-label="Your Bitrefill order">
      <div className="still-extra">
        <span className="still-extra-icon"><StillIconV1 name="spend" /></span>
        <span className="still-extra-body">
          <span className="still-extra-title">{order?.delivered ? 'Bitrefill delivered your order' : 'Paid to Bitrefill in the same transaction'}</span>
          <span className="still-extra-note">
            {order ? <>{order.productName} · {order.packageLabel}{order.refillTo ? ` for ${order.refillTo}` : ''}. {order.status ? `Bitrefill: ${order.status}.` : 'Bitrefill’s status could not be read just now.'} </>
              : reading ? 'Reading the order from Bitrefill… ' : ''}
            Bitrefill emails the receipt and the order to the address you gave.
          </span>
          {order?.esimInstallLink ? <a className="still-share-link" href={order.esimInstallLink} target="_blank" rel="noreferrer">Install the eSIM</a> : null}
        </span>
        {order?.orderLink ? <a className="still-extra-action" href={order.orderLink} target="_blank" rel="noreferrer">Open order</a> : null}
      </div>
    </div>
  );
}
