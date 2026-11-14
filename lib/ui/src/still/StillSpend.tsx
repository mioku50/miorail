import React, { useEffect, useId, useRef } from 'react';
import { formatCents } from '@mioagent/still-engine/format';

import { composerLinksV1 } from '../console/composerLinks';
import { ShareLinkV1 } from '../console/shareHost';
import type { SkyStateV1 } from './skyState';
import { StillHeader, StillLink } from './StillFrame';
import { StillIconV1 } from './icons';
import {
  SHARE_CARD_PRIVACY_NOTE_V1,
  SPEND_DELIVERY_UNSHOWN_V1,
  SPEND_GIFT_CATEGORY_CHIPS_V1,
  SPEND_TYPES_V1,
  STILL_SPEND_COMMISSION_NOTE_V1,
  shareAmountWordsV1,
  spendConfirmByNoteV1,
  spendLatePaymentNoteV1,
  spendCountryNameV1,
  spendCountryOptionsV1,
  spendPhoneDraftV1,
  spendPhonePrefixesTextV1,
  type SpendProductRowV1,
  type SpendOrderViewV1,
  type LoanShareViewV1,
  type SpendShareViewV1,
  type SpendProductViewV1,
  type SpendGiftCategoryV1,
  type SpendTypeV1,
} from './spendView';
import type { StillSpendWalletModelV1 } from './useSpendWalletPayment';

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
  /** Gift cards by one of Bitrefill's categories instead of a brand; null for none. */
  category?: SpendGiftCategoryV1 | null;
  /** Pressing the chosen category again lets it go. Without this, no category is offered. */
  onCategory?: (category: SpendGiftCategoryV1 | null) => void;
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
  /** What the reader already owes on their loans, in cents; null when nothing is owed or a debt was not read. */
  owedCents?: string | null;
  /** The USDC already in the reader's wallet, "2.12 USDC"; null signed out or unread. */
  walletUsdc?: string | null;
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
    /** Which way the invoice being opened is paid. */
    creatingWith?: 'loan' | 'wallet' | null;
    error: string | null;
    /** Opens the invoice, then pays it with a loan (Get money) or from the wallet's own USDC. */
    onCreate: (method: 'loan' | 'wallet') => void;
  };
}

/** Still Spend: what a loan, or the USDC already in the wallet, could pay for,
 * with Bitrefill's USDC prices. Where the server pays Bitrefill, a price opens
 * an invoice, then the Get money page or the wallet payment's own page; nothing
 * is paid on this page, and nothing is signed here. */
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
        lede={<>What a loan against what you hold, or the USDC already in your wallet, could pay for: mobile data, phone top-ups and gift cards from <strong className="still-provider">Bitrefill</strong>, priced in USDC.</>}
      />
      <p className="still-section still-notice">
        <StillIconV1 name="info" />
        {model.pay ? (
          <span>Pay with Still: a loan for the exact price pays <strong>Bitrefill</strong>, or the USDC already in your wallet does, with no loan. Your own wallet approves either. Up to 100 USDC a purchase.</span>
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
              {model.onCategory ? (
                <div className="still-spend-categories" role="group" aria-label="Gift cards by category">
                  {SPEND_GIFT_CATEGORY_CHIPS_V1.map((entry) => (
                    <button key={entry.category} type="button" className="still-chip" aria-pressed={model.category === entry.category}
                      onClick={() => model.onCategory!(model.category === entry.category ? null : entry.category)}>{entry.label}</button>
                  ))}
                </div>
              ) : null}
            </form>
          ) : null}
          <div className="still-spend-results" aria-live="polite">
            {model.searching ? <p className="still-note" role="status">Reading Bitrefill’s catalogue…</p>
              : model.searchError ? <p className="still-warn" role="alert">{model.searchError}</p>
                // Bitrefill has no top-up for a number in some countries (Russia, 2026-11-14): said so, with
                // mobile data for the same country one press away, rather than "nothing in stock".
                : model.products && model.products.length === 0 && model.type === 'refill' ? (
                  <div className="still-spend-empty">
                    <p className="still-note">Bitrefill lists no top-up for a number in {spendCountryNameV1(model.country)}.</p>
                    <button type="button" className="still-chip" onClick={() => model.onType('esim')}>Mobile data for {spendCountryNameV1(model.country)}</button>
                  </div>
                )
                : model.products && model.products.length === 0 ? (
                  <p className="still-note">Nothing in stock here for {spendCountryNameV1(model.country)}{model.type === 'giftcard' && model.category
                    ? ` in ${SPEND_GIFT_CATEGORY_CHIPS_V1.find((entry) => entry.category === model.category)?.label ?? model.category}`
                    : model.query ? ` and “${model.query}”` : ''}.</p>
                )
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
          {/* The room is what Still can lend on top of the debt, and the wallet's USDC pays too: the
              operator asked on 2026-11-03 why Spend offered $0.20 right after a loan paid them 2 USDC. */}
          {model.room ? (
            <div className="still-spend-room">
              <span className="still-spend-room-label">Your Still room now</span>
              <span className="still-spend-room-amount">{model.room.complete ? '' : 'at least '}{formatCents(model.room.cents)}</span>
              <span className="still-spend-room-note">
                {model.owedCents ? <>What Still can lend you now, on top of the <strong>{formatCents(model.owedCents)}</strong> you already owe. </> : null}
                A loan for a price is read again, with Still’s terms, before anything is signed.
              </span>
              {model.walletUsdc ? (
                <span className="still-spend-room-wallet">
                  <span className="still-spend-room-label">In your wallet</span>
                  <span className="still-spend-room-usdc mono">{model.walletUsdc}</span>
                  {model.pay ? <span className="still-spend-room-note">It pays a price up to this directly, with no loan.</span> : null}
                </span>
              ) : null}
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
                        {row.room || row.wallet || (model.pay && row.payable) ? (
                          <span className="still-spend-price-foot">
                            <span className="still-spend-fits">
                              {row.room ? <span className="still-spend-fit">{row.room === 'within' ? 'Within your room' : 'More than your room'}</span> : null}
                              {row.wallet ? <span className="still-spend-fit is-wallet">Your USDC covers it</span> : null}
                            </span>
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
                    const fromWallet = chosen.wallet === true;
                    const unfilled = model.pay.creating || model.pay.email.trim() === '' || (product.phone !== null && number === null);
                    const opening = (method: 'loan' | 'wallet') => model.pay!.creating && (model.pay!.creatingWith ?? 'loan') === method;
                    return (
                      <>
                        {list(product.packages.slice(0, chosenAt + 1), 'Prices in USDC')}
                        <form ref={checkoutRef} className="still-spend-checkout" aria-labelledby={`${id}-pay`} onSubmit={(event) => { event.preventDefault(); model.pay!.onCreate(fromWallet ? 'wallet' : 'loan'); }}>
                          <div className="still-step"><span className="n" aria-hidden="true">3</span>Pay</div>
                          <h3 id={`${id}-pay`}>{chosen.price} for {product.name} · {chosen.label}</h3>
                          {fromWallet ? (
                            <p className="still-note">
                              Still opens Bitrefill’s invoice for it, and the USDC already in your wallet pays it: one transfer of exactly {chosen.price}, no loan,
                              which you approve in your own wallet. Or borrow it instead. Bitrefill holds the price for 15 minutes.
                            </p>
                          ) : (
                            <p className="still-note">
                              Still opens Bitrefill’s invoice for it, then you choose what to borrow against. A loan of exactly {chosen.price} pays the invoice,
                              and you approve it in your own wallet. Bitrefill holds the price for 15 minutes.
                              {chosen.wallet === false && model.walletUsdc ? <> Your wallet holds {model.walletUsdc}, less than this price.</> : null}
                            </p>
                          )}
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
                            {fromWallet ? (
                              <>
                                <button type="submit" className="still-btn" disabled={unfilled}>
                                  {opening('wallet') ? 'Opening the invoice…' : `Pay ${chosen.price} from your wallet`}
                                </button>
                                <button type="button" className="still-btn sec" disabled={unfilled} onClick={() => model.pay!.onCreate('loan')}>
                                  {opening('loan') ? 'Opening the invoice…' : 'Borrow it instead'}
                                </button>
                              </>
                            ) : (
                              <button type="submit" className="still-btn" disabled={unfilled}>
                                {opening('loan') ? 'Opening the invoice…' : 'Open invoice and choose collateral'}
                              </button>
                            )}
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
        <p className="still-note">Bitrefill sells these under its own terms. Still shows them with the USDC price Bitrefill quoted, which can change by checkout. A loan creates debt, and your collateral can be liquidated; paying from your wallet’s USDC takes no loan. Not offered to US persons.</p>
        <StillLink href="/borrow">Get money</StillLink>
      </div>
    </div>
  );
}

/** After the loan that paid it is confirmed: where the Bitrefill order stands,
 * as Bitrefill says, and its own page. Still proves the payment, not the delivery.
 * The server offers a card to share once it confirmed the loan onchain; the
 * link names the purchase and never the wallet. */
export function StillSpendPaid({ order, reading, share, paidWith = 'loan' }: { order: SpendOrderViewV1 | null; reading: boolean; share?: { url: string; text: string } | null;
  /** What paid it: the loan, or the USDC already in the wallet. */
  paidWith?: 'loan' | 'wallet' }) {
  const links = share ? composerLinksV1(share) : null;
  return (
    <div className="still-section still-extras" aria-label="Your Bitrefill order">
      <div className="still-extra">
        <span className="still-extra-icon"><StillIconV1 name="spend" /></span>
        <span className="still-extra-body">
          <span className="still-extra-title">{order?.delivered ? 'Bitrefill delivered your order' : paidWith === 'wallet' ? 'Paid to Bitrefill from your wallet' : 'Paid to Bitrefill with the loan'}</span>
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
        <>
          <div className="still-share">
            <span className="still-note">Share this purchase:</span>
            <ShareLinkV1 href={links.x} className="still-share-link">Post on X</ShareLinkV1>
            <ShareLinkV1 href={links.farcaster} className="still-share-link">Cast on Farcaster</ShareLinkV1>
          </div>
          <p className="still-note">{SHARE_CARD_PRIVACY_NOTE_V1}</p>
        </>
      ) : null}
    </div>
  );
}

/** What a payment from the wallet's own USDC is doing now, in words. */
/** The time now, read again every fifteen seconds while `ticking`: for a deadline counted in minutes. */
function useNowV1(ticking: boolean): Date {
  const [now, setNow] = React.useState(() => new Date());
  useEffect(() => {
    if (!ticking) return undefined;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function walletStatusTextV1(state: string, hash: string | null): string {
  const tx = hash ? ` Transaction ${hash.slice(0, 10)}…${hash.slice(-6)}.` : '';
  switch (state) {
    case 'awaiting_wallet': return 'Waiting for your wallet to send the payment…';
    case 'submitted': return `Sent. Still is reading the payment from Base.${tx}`;
    case 'unknown': return `Your wallet did not say whether it sent the payment, so Still reads Base for it. Check your wallet’s activity before paying again.${tx}`;
    case 'confirmed': return `Paid: Base shows your transfer to Bitrefill’s invoice.${tx}`;
    case 'failed': return `The transfer failed onchain: no USDC left your wallet for it, and Bitrefill was not paid.${tx}`;
    default: return '';
  }
}

/** A Bitrefill invoice paid from the USDC already in the wallet: one exact
 * transfer, no loan. The server prepared and simulated it and reads its result
 * from Base; the wallet signs it, and nothing is sent from this page itself. */
export function StillSpendWalletPay({ sky, model, order, orderReading }: {
  sky: SkyStateV1; model: StillSpendWalletModelV1; order: SpendOrderViewV1 | null; orderReading: boolean;
}) {
  const id = useId();
  const view = model.view;
  const paying = view && view.state !== 'refused' ? view : null;
  // While the wallet has the payment, and after it was sent: the invoice's own time decides what is said (audit SPEND-6).
  const sent = paying !== null && ['submitted', 'unknown', 'confirmed'].includes(paying.state);
  const now = useNowV1(Boolean(order) && (model.busy || sent));
  const confirmBy = order && model.busy && paying?.state === 'ready' ? spendConfirmByNoteV1({ expiresAt: order.expiresAt, orderId: order.orderId, now }) : null;
  const late = order && paying && sent
    ? spendLatePaymentNoteV1({ expiresAt: order.expiresAt, orderId: order.orderId, now, paymentState: paying.state, status: order.status, delivered: order.delivered }) : null;
  return (
    <div className="still-borrow still-spend">
      <StillHeader title="Pay from your wallet" sky={sky}
        lede={<>One transfer of the USDC already in your wallet pays <strong className="still-provider">Bitrefill</strong>’s invoice. No loan is taken.</>} />
      {model.loading ? <p className="still-section still-note" role="status">Reading the invoice and your wallet’s USDC…</p> : null}
      {model.error && !model.loading ? <p className="still-section still-warn" role="alert">{model.error}</p> : null}
      {view?.state === 'refused' ? (
        <div className="still-section">
          <p className="still-warn" role="alert">{view.detail} <StillLink href="/spend">Back to Spend</StillLink></p>
          {model.walletError ? <p className="still-warn" role="status">{model.walletError}</p> : null}
          {model.onRetry ? <button type="button" className="still-btn sec" disabled={model.checking} onClick={() => model.onRetry?.()}>{model.checking ? 'Reading…' : 'Check again'}</button> : null}
        </div>
      ) : null}
      {paying ? (
        <section className="still-section still-card still-spend-wallet" aria-labelledby={`${id}-title`}>
          <div className="still-step"><span className="n" aria-hidden="true">✓</span>Checked</div>
          <h2 id={`${id}-title`}>{paying.price} for {paying.productName} · {paying.packageLabel}</h2>
          <dl className="still-borrow-facts">
            <div><dt>Pays</dt><dd>Bitrefill’s invoice address <span className="mono">{paying.payTo}</span></dd></div>
            {paying.deliverTo ? <div><dt>Bitrefill sends it to</dt><dd style={{ overflowWrap: 'anywhere' }}>{paying.deliverTo.email}{paying.deliverTo.phone
              ? <>, and tops up <span className="mono">{paying.deliverTo.phone}</span></> : null}</dd></div> : null}
            {paying.before ? <div><dt>In your wallet</dt><dd className="mono">{paying.before}</dd></div> : null}
            {paying.after ? <div><dt>After paying</dt><dd className="mono">{paying.after}</dd></div> : null}
          </dl>
          {paying.deliverTo ? <p className="still-note">Check that {paying.deliverTo.phone ? 'the email and the number are' : 'the email is'} yours: the invoice was opened
            with {paying.deliverTo.phone ? 'them' : 'it'}, and Still cannot change {paying.deliverTo.phone ? 'them' : 'it'}.</p> : null}
          {order?.commission ? <p className="still-note">{STILL_SPEND_COMMISSION_NOTE_V1}</p> : null}
          {paying.block !== null ? (
            <p className="still-note still-borrow-block">Read at Base block <span className="mono">{paying.block.toLocaleString('en-US')}</span>; the transfer was run on that same state, and only the invoice’s price left the wallet.</p>
          ) : null}
          {paying.warnings.map((line) => <p key={line} className="still-note">{line}</p>)}
          {model.walletError ? <p className="still-warn" role="alert">{model.walletError}</p> : null}
          {model.lock ? <p className="still-note" role="status">{model.lock}</p> : null}
          {paying.state === 'ready' && !paying.deliverTo ? <p className="still-warn" role="alert">{SPEND_DELIVERY_UNSHOWN_V1}</p> : null}
          {paying.state === 'ready' && paying.deliverTo ? (
            <div className="still-spend-checkout-actions">
              <button type="button" className="still-btn" disabled={!model.onPay || model.busy} onClick={() => model.onPay?.()}>
                {model.busy ? 'Waiting for your wallet…' : `Pay ${paying.price}`}
              </button>
              <StillLink href="/spend">Cancel</StillLink>
            </div>
          ) : (
            <p className={paying.state === 'failed' ? 'still-warn' : 'still-note'} role="status">{walletStatusTextV1(paying.state, paying.transactionHash)}</p>
          )}
          {confirmBy ? <p className="still-note" role="status">{confirmBy}</p> : null}
          {late ? <p className="still-warn" role="alert">{late}</p> : null}
          {model.onCheck ? <button type="button" className="still-btn sec" disabled={model.checking} onClick={() => model.onCheck?.()}>{model.checking ? 'Reading…' : 'Read the result again'}</button> : null}
          {model.onFindTransaction ? (
            <details className="still-lending-details">
              <summary>Your wallet sent it, and the result is not here?</summary>
              <p className="still-note">Paste the transaction hash from your wallet’s activity. Still checks that transaction against this exact payment; it sends nothing.</p>
              <label className="still-borrow-label">Transaction hash
                <input className="still-borrow-stock-select mono" type="text" autoComplete="off" spellCheck={false} value={model.transactionHint}
                  onChange={(event) => model.onTransactionHint?.(event.target.value)} disabled={model.checking} />
              </label>
              <button type="button" className="still-btn sec" onClick={() => model.onFindTransaction?.()} disabled={model.checking}>Find this transaction</button>
            </details>
          ) : null}
        </section>
      ) : null}
      {paying?.state === 'confirmed' ? <StillSpendPaid order={order} reading={orderReading} paidWith="wallet" /> : null}
      <div className="still-section still-borrow-foot">
        <p className="still-note">Bitrefill sells under its own terms. A payment sent cannot be taken back by Still; if Bitrefill cannot deliver, its support handles the refund. Not offered to US persons.</p>
        <StillLink href="/spend">Back to Spend</StillLink>
      </div>
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
        alt="Your loan’s card: about how much, against what and through which protocol. It names no wallet and no transaction." />
      <div className="still-share">
        <span className="still-note">Share this loan’s card:</span>
        <ShareLinkV1 href={links.x} className="still-share-link">Post on X</ShareLinkV1>
        <ShareLinkV1 href={links.farcaster} className="still-share-link">Cast on Farcaster</ShareLinkV1>
      </div>
      <p className="still-note">{SHARE_CARD_PRIVACY_NOTE_V1}</p>
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
        lede={`${shareAmountWordsV1(view.borrowedUsdc).replace(/^a/, 'A')} borrowed against ${view.collateralLabel} through ${view.venueName} on Base. Nothing was sold: it is the loan’s collateral.`}
      />
      {cardUrl ? (
        <div className="still-section">
          <img className="still-spend-card" src={cardUrl} width={1200} height={630}
            alt={`A loan of ${shareAmountWordsV1(view.borrowedUsdc)} against ${view.collateralLabel} through ${view.venueName}, on Still: nothing sold.`} />
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
          ? `${view.productName}, ${view.packageLabel}, for ${shareAmountWordsV1(view.priceUsdc)}. Borrowed against ${view.collateralLabel} through ${view.venueName} and paid to Bitrefill with that loan on Base, without selling.`
          : reading ? 'Reading this purchase…' : 'This purchase card could not be verified, so nothing about it is shown.'}
      />
      {view && cardUrl ? (
        <div className="still-section">
          <img className="still-spend-card" src={cardUrl} width={1200} height={630}
            alt={`Paid for ${view.productName} (${view.packageLabel}, ${shareAmountWordsV1(view.priceUsdc)}) with a loan against ${view.collateralLabel} through ${view.venueName}, on Still.`} />
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
