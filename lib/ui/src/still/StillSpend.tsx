import React, { useEffect, useId, useRef } from 'react';
import { formatCents } from '@mioagent/still-engine/format';

import { composerLinksV1 } from '../console/composerLinks';
import { ShareLinkV1 } from '../console/shareHost';
import type { SkyStateV1 } from './skyState';
import { StillHeader, StillLink } from './StillFrame';
import { StillIconV1 } from './icons';
import {
  SPEND_TYPES_V1,
  spendCountryNameV1,
  spendCountryOptionsV1,
  spendPhoneDraftV1,
  spendPhonePrefixesTextV1,
  type SpendProductRowV1,
  type SpendOrderViewV1,
  type LoanShareViewV1,
  type SpendShareViewV1,
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
  /** Paying open on this server, for a reader who has not signed in yet. */
  payAfterSignIn?: boolean;
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
  // A chosen price brings its checkout into view, with the first empty field ready to type in.
  const checkoutRef = useRef<HTMLFormElement | null>(null);
  const chosenValue = model.pay?.chosen ?? null;
  useEffect(() => {
    const form = checkoutRef.current;
    if (chosenValue === null || !form) return;
    form.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    const empty = [...form.querySelectorAll<HTMLInputElement>('input')].find((input) => input.value.trim() === '');
    empty?.focus({ preventScroll: true });
  }, [chosenValue]);
  return (
    <div className="still-borrow still-spend">
      <StillHeader
        title="Spend"
        sky={model.sky}
        // Who sells is said where the page begins: Bitrefill, under its own terms.
        lede={<>What a loan against what you hold could pay for: mobile data, phone top-ups and gift cards from <strong className="still-provider">Bitrefill</strong>, priced in USDC.</>}
      />
      <p className="still-section still-notice">
        <StillIconV1 name="info" />
        {model.pay ? (
          <span>Pay with Still: a loan for the exact price pays <strong>Bitrefill</strong>, and your own wallet approves it, as one transaction where it can send one and in steps where it cannot. Up to 100 USDC a purchase.</span>
        ) : model.payAfterSignIn ? (
          <span>Sign in with your wallet to pay with Still: a loan for the exact price pays <strong>Bitrefill</strong>, and your own wallet approves it. Up to 100 USDC a purchase.</span>
        ) : (
          <span>Paying with Still is not open on this server. The prices below are <strong>Bitrefill</strong>’s own, in USDC.</span>
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
                  {(() => {
                    // The checkout opens right under the price it pays, not below the whole list.
                    const chosenAt = model.pay && model.pay.chosen !== null ? product.packages.findIndex((row) => row.value === model.pay!.chosen) : -1;
                    const priceRow = (row: SpendProductViewV1['packages'][number]) => (
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
                    );
                    const list = (rows: SpendProductViewV1['packages'], label: string) => rows.length > 0
                      ? <ul className="still-spend-prices" aria-label={label}>{rows.map(priceRow)}</ul> : null;
                    if (chosenAt < 0 || !model.pay) return list(product.packages, 'Prices in USDC');
                    const chosen = product.packages[chosenAt]!;
                    const number = product.phone ? spendPhoneDraftV1(model.pay.phone, product.phone) : null;
                    const shared = product.phone !== null && product.phone.prefixes.some((prefix) => prefix !== product.phone!.callingCode);
                    return (
                      <>
                        {list(product.packages.slice(0, chosenAt + 1), 'Prices in USDC')}
                        <form ref={checkoutRef} className="still-spend-checkout" aria-labelledby={`${id}-pay`} onSubmit={(event) => { event.preventDefault(); model.pay!.onCreate(); }}>
                          <div className="still-step"><span className="n" aria-hidden="true">3</span>Pay</div>
                          <h3 id={`${id}-pay`}>{chosen.price} for {product.name} · {chosen.label}</h3>
                          <p className="still-note">
                            Still opens Bitrefill’s invoice for it, then you choose what to borrow against. A loan of exactly {chosen.price} pays the invoice,
                            and you approve it in your own wallet. Bitrefill holds the price for 15 minutes.
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
                                {number ? <>Bitrefill tops up <strong className="mono">{number}</strong>. </>
                                  : shared ? <>Write it with the country code: numbers here start with {spendPhonePrefixesTextV1(product.phone)}. </>
                                    : <>Write it with the country code, +{product.phone.callingCode}. </>}
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
                        {list(product.packages.slice(chosenAt + 1), 'More prices in USDC')}
                      </>
                    );
                  })()}
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
 * as Bitrefill says, and its own page. Still proves the payment, not the delivery.
 * The server offers a card to share once it confirmed the loan onchain; the
 * link names the purchase and never the wallet. */
export function StillSpendPaid({ order, reading, share }: { order: SpendOrderViewV1 | null; reading: boolean; share?: { url: string; text: string } | null }) {
  const links = share ? composerLinksV1(share) : null;
  return (
    <div className="still-section still-extras" aria-label="Your Bitrefill order">
      <div className="still-extra">
        <span className="still-extra-icon"><StillIconV1 name="spend" /></span>
        <span className="still-extra-body">
          <span className="still-extra-title">{order?.delivered ? 'Bitrefill delivered your order' : 'Paid to Bitrefill with the loan'}</span>
          <span className="still-extra-note">
            {order ? <>{order.productName} · {order.packageLabel}{order.refillTo ? ` for ${order.refillTo}` : ''}. {order.status ? `Bitrefill: ${order.status}.` : 'Bitrefill’s status could not be read just now.'} </>
              : reading ? 'Reading the order from Bitrefill… ' : ''}
            Bitrefill emails the receipt and the order to the address you gave.
          </span>
          {order?.esimInstallLink ? <a className="still-share-link" href={order.esimInstallLink} target="_blank" rel="noreferrer">Install the eSIM</a> : null}
        </span>
        {order?.orderLink ? <a className="still-extra-action" href={order.orderLink} target="_blank" rel="noreferrer">Open order</a> : null}
      </div>
      {links ? (
        <div className="still-share">
          <span className="still-note">Share this purchase:</span>
          <ShareLinkV1 href={links.x} className="still-share-link">Post on X</ShareLinkV1>
          <ShareLinkV1 href={links.farcaster} className="still-share-link">Cast on Farcaster</ShareLinkV1>
        </div>
      ) : null}
    </div>
  );
}

/** After a plain loan is confirmed: its card, to share. The server signed it once
 * it confirmed the loan onchain; it says how much, against what and through which
 * protocol, and names no wallet and no transaction (the operator, 2026-11-03:
 * «нет карточки после успешного взятия займа для шаринга»). */
export function StillLoanShare({ share, cardUrl }: { share: { url: string; text: string }; cardUrl: string }) {
  const links = composerLinksV1(share);
  return (
    <div className="still-section still-extras" aria-label="Your loan’s card">
      <img className="still-spend-card" src={cardUrl} width={1200} height={630}
        alt="Your loan’s card: how much, against what and through which protocol. It names no wallet and no transaction." />
      <div className="still-share">
        <span className="still-note">Share this loan’s card:</span>
        <ShareLinkV1 href={links.x} className="still-share-link">Post on X</ShareLinkV1>
        <ShareLinkV1 href={links.farcaster} className="still-share-link">Cast on Farcaster</ShareLinkV1>
      </div>
    </div>
  );
}

/** A loan someone shared, as the server verified its link: the card and what it claims, and nothing about whose it is. */
export function StillLoanShared({ sky, view, cardUrl }: { sky: SkyStateV1; view: LoanShareViewV1; cardUrl: string | null }) {
  return (
    <div className="still-borrow still-spend">
      <StillHeader
        title="Spent without selling"
        sky={sky}
        lede={`${view.borrowedUsdc} USDC borrowed against ${view.collateralLabel} through ${view.venueName} on Base. Nothing was sold: it is the loan’s collateral.`}
      />
      {cardUrl ? (
        <div className="still-section">
          <img className="still-spend-card" src={cardUrl} width={1200} height={630}
            alt={`A loan of ${view.borrowedUsdc} USDC against ${view.collateralLabel} through ${view.venueName}, on Still: nothing sold.`} />
        </div>
      ) : null}
      <div className="still-section still-borrow-foot">
        <p className="still-note">
          Still checked this loan onchain before it signed the card. Still is not a lender: a wallet borrows from the lending protocol directly. A loan creates debt, and collateral can be liquidated. Not offered to US persons.
        </p>
        <StillLink href="/">See what a wallet could borrow without selling</StillLink>
      </div>
    </div>
  );
}

/** A purchase someone shared, as the server verified its link: the card, what
 * it says, and Still's door. It names no wallet: the server signed the claim
 * only after the loan that paid it was confirmed onchain. */
export function StillSpendShared({ sky, view, reading, cardUrl }: { sky: SkyStateV1; view: SpendShareViewV1 | null; reading: boolean; cardUrl: string | null }) {
  return (
    <div className="still-borrow still-spend">
      <StillHeader
        title={view ? 'Paid with a loan' : 'Spend'}
        sky={sky}
        lede={view
          ? `${view.productName}, ${view.packageLabel}, for ${view.priceUsdc} USDC. Borrowed against ${view.collateralLabel} through ${view.venueName} and paid to Bitrefill with that loan on Base, without selling.`
          : reading ? 'Reading this purchase…' : 'This purchase card could not be verified, so nothing about it is shown.'}
      />
      {view && cardUrl ? (
        <div className="still-section">
          <img className="still-spend-card" src={cardUrl} width={1200} height={630}
            alt={`Paid for ${view.productName} (${view.packageLabel}, ${view.priceUsdc} USDC) with a loan against ${view.collateralLabel} through ${view.venueName}, on Still.`} />
        </div>
      ) : null}
      <div className="still-section still-borrow-foot">
        <p className="still-note">
          {view ? 'Still checked this loan onchain before it signed the card. ' : ''}
          Still is not a lender: a wallet borrows from the lending protocol directly, and Bitrefill sells under its own terms. A loan creates debt, and collateral can be liquidated. Not offered to US persons.
        </p>
        <StillLink href="/spend">See what a loan could pay for</StillLink>
      </div>
    </div>
  );
}
