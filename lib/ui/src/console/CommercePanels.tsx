import React from 'react';

void React;

// ---------------------------------------------------------------------------
// T64 — the Commerce surfaces.
//
// lib/ui is presentational only and types its wire objects STRUCTURALLY, so
// nothing here imports a contract package. Three rules the markup enforces:
//
//   * every denomination the comparison found stays on screen, including the
//     ones that cannot be bought, each with the reason;
//   * an estimated total is labelled as a minimum, never as the price;
//   * a paid order with no confirmed order id is rendered as reconciliation,
//     never as a completed purchase.
// ---------------------------------------------------------------------------

export interface CommerceScoreDimensionLikeV1 {
  dimension: string;
  status: 'scored' | 'not_scored';
  score: number | null;
  notScoredReason: string | null;
}

export interface CommerceComparisonLikeV1 {
  candidate: {
    candidateHash: string;
    product: { productId: string; name: string; packageValue: string; country: string; currency: string };
    fiatPrice: { amountDecimal: string; currency: string };
    payment: { amountAtomic: string; amountDecimal: string };
    fees: { totalBasis: 'exact_quote' | 'minimum' };
    availability: 'in_stock' | 'out_of_stock' | 'unknown';
    provider: { displayName: string };
  };
  score: { dimensions: CommerceScoreDimensionLikeV1[] };
  denominationDelta: { requestedDecimal: string; offeredDecimal: string; exact: boolean };
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
  freshnessState: 'fresh' | 'stale' | 'unknown';
  missingEvidence: string[];
}

export interface CommerceRouteCardLikeV1 {
  routeCardHash: string;
  status: string;
  optimizationMode: string;
  requestedValue: { amountDecimal: string; currency: string };
  recommendedCandidateHash: string | null;
  recommendationReason: string | null;
  degradedReason: string | null;
  comparisons: CommerceComparisonLikeV1[];
  expiresAt: string;
}

const AVAILABILITY_COPY_V1: Record<CommerceComparisonLikeV1['availability'], string> = {
  in_stock: 'in stock',
  out_of_stock: 'out of stock',
  unknown: 'stock not reported',
};

const EXCLUSION_COPY_V1: Record<string, string> = {
  spend_ceiling_exceeded: 'costs more than the amount you authorized',
  recipient_required: 'needs a phone number you have not given',
  recipient_not_allowed: 'does not take a recipient',
  price_unavailable: 'the storefront quoted no price',
  fx_rate_unavailable: 'priced in a currency Miorail has no rate source for',
  provider_invalid_response: 'the storefront answer could not be read',
};

export function commerceExclusionCopyV1(reason: string): string {
  return EXCLUSION_COPY_V1[reason] ?? reason.replaceAll('_', ' ');
}

export interface CommerceRouteCardPanelProps {
  card: CommerceRouteCardLikeV1;
  /** True when the market was inferred from the currency rather than stated. */
  countryInferred: boolean;
  /** Reason codes for denominations the comparison deliberately left out. */
  excluded: string[];
  checkout: { available: boolean; reason: string | null };
  onOrder?: (candidateHash: string) => void;
  ordering?: boolean;
}

export function CommerceRouteCardPanel(props: CommerceRouteCardPanelProps) {
  const { card } = props;
  return (
    <div className="panel">
      <div className="ph">
        <h3>Commerce route</h3>
        <span className="rt">
          <span className="pill n">
            {card.requestedValue.amountDecimal} {card.requestedValue.currency} requested
          </span>
        </span>
      </div>
      <div className="pb">
        {props.countryInferred && (
          <p className="note">
            Market inferred from the price you gave, not stated. Say the country to override it.
          </p>
        )}
        {card.recommendationReason ? (
          <p className="why">{card.recommendationReason}</p>
        ) : (
          <p className="why warn">{card.degradedReason ?? 'Nothing is recommended for this request.'}</p>
        )}

        <div className="cardrows">
          {card.comparisons.map((entry) => {
            const chosen = entry.candidate.candidateHash === card.recommendedCandidateHash;
            const sellable = entry.availability === 'in_stock';
            return (
              <article key={entry.candidate.candidateHash} className={`cardrow${sellable ? '' : ' off'}`}>
                <div className="cr-top">
                  <span className="cr-name">
                    {entry.candidate.product.name} · {entry.candidate.product.packageValue}{' '}
                    {entry.candidate.product.currency}
                  </span>
                  {chosen ? (
                    <span className="pill br">chosen</span>
                  ) : (
                    <span className={`pill ${sellable ? 'n' : 'a'}`}>{AVAILABILITY_COPY_V1[entry.availability]}</span>
                  )}
                </div>
                <div className="cr-nums">
                  <div>
                    <span className="cr-k">
                      {entry.candidate.fees.totalBasis === 'exact_quote' ? 'You pay' : 'At least'}
                    </span>
                    <span className="cr-v mono">{entry.candidate.payment.amountDecimal} USDC</span>
                  </div>
                  <div>
                    <span className="cr-k">Denomination</span>
                    <span className="cr-v mono">
                      {entry.denominationDelta.offeredDecimal} {entry.candidate.product.currency}
                      {entry.denominationDelta.exact ? '' : ' · closest'}
                    </span>
                  </div>
                </div>
                <p className="cr-why">
                  {entry.candidate.provider.displayName} · {entry.candidate.product.country} ·{' '}
                  {entry.freshnessState === 'fresh' ? 'price is current' : 'price reading is stale'}
                  {entry.candidate.fees.totalBasis === 'minimum'
                    ? ' · fees are confirmed at checkout, so this total is a minimum'
                    : ''}
                  {entry.missingEvidence.length > 0 ? ` · not scored: ${entry.missingEvidence.join(', ')}` : ''}
                </p>
                {sellable && props.onOrder && (
                  <button
                    type="button"
                    className="btn sec"
                    disabled={!props.checkout.available || props.ordering === true}
                    onClick={() => props.onOrder?.(entry.candidate.candidateHash)}
                  >
                    {props.ordering ? 'Opening checkout…' : 'Open checkout'}
                  </button>
                )}
              </article>
            );
          })}
        </div>

        {props.excluded.length > 0 && (
          <p className="note">
            Left out: {props.excluded.map((reason) => commerceExclusionCopyV1(reason)).join('; ')}.
          </p>
        )}
        {!props.checkout.available && props.checkout.reason && <p className="note warn">{props.checkout.reason}</p>}
      </div>
    </div>
  );
}

// --- Payment review --------------------------------------------------------

export interface CommerceOrderLikeV1 {
  invoiceId: string;
  status: string;
  paymentState: string;
  deliveryState: string;
  amount: { amountDecimal: string };
  payTo: string;
  expiresAt: string;
  items: { productId: string; packageValue: string; orderId: string | null; deliveryState: string }[];
}

export interface CommercePaymentRequirementsLikeV1 {
  asset: string;
  payTo: string;
  maxAmountAtomic: string;
  network: string;
  resource: string;
  expiresAt: string;
}

/** Exactly what the wallet will authorize. Nothing here is signed by opening
 * this panel — the user signs in their own wallet, or nothing happens. */
export function CommercePaymentReviewPanel(props: {
  order: CommerceOrderLikeV1;
  payment: CommercePaymentRequirementsLikeV1;
  children?: React.ReactNode;
}) {
  return (
    <div className="panel">
      <div className="ph">
        <h3>Payment review</h3>
        <span className="rt">
          <span className="pill n">nothing signed yet</span>
        </span>
      </div>
      <div className="pb">
        <div className="kv">
          <span className="k">You pay</span>
          <span className="v mono">{props.order.amount.amountDecimal} USDC</span>
        </div>
        <div className="kv">
          <span className="k">Recipient</span>
          <span className="v mono">{props.payment.payTo}</span>
        </div>
        <div className="kv">
          <span className="k">Network</span>
          <span className="v mono">{props.payment.network}</span>
        </div>
        <div className="kv">
          <span className="k">Checkout</span>
          <span className="v mono">{props.order.invoiceId}</span>
        </div>
        <div className="kv">
          <span className="k">Price locked until</span>
          <span className="v mono">{props.order.expiresAt}</span>
        </div>
        <p className="note">
          Miorail prepared this payment. Your wallet authorizes it — the server holds no key and cannot pay for you.
        </p>
        {props.children}
      </div>
    </div>
  );
}

// --- Three-leg proof -------------------------------------------------------

export interface CommerceProofLikeV1 {
  finalStatus: string;
  payment: { state: string; transactionHash: string | null; amountAtomic: string; settledAt: string | null };
  order: { state: string; invoiceId: string | null; orderIds: string[]; confirmedAt: string | null };
  delivery: { state: string; itemCount: number; deliveredCount: number; confirmedAt: string | null };
  proofHash: string;
}

const PROOF_COPY_V1: Record<string, string> = {
  pending: 'Waiting for the storefront to confirm this order.',
  delivered: 'Paid, order confirmed, and every item delivered.',
  partial_delivery: 'Paid and the order is confirmed, but not every item has been delivered yet.',
  order_unconfirmed:
    'The payment settled but the storefront has not confirmed an order. This is not a completed purchase — it is being reconciled.',
  payment_failed: 'The payment did not settle. No order was created and nothing was delivered.',
  failed: 'The storefront reported this order as failed.',
  reconciliation_required:
    'The storefront could not report the delivery state for this paid order. It is being reconciled.',
};

export function commerceProofCopyV1(finalStatus: string): string {
  return PROOF_COPY_V1[finalStatus] ?? `The order is in state ${finalStatus.replaceAll('_', ' ')}.`;
}

/**
 * The Commerce Route Proof: three legs, shown separately.
 *
 * A single "done" tick would be a lie here — a paid transaction is one third
 * of a proof, so each leg carries its own state and only `delivered` reads as
 * success.
 */
export function CommerceProofPanel(props: { proof: CommerceProofLikeV1 }) {
  const { proof } = props;
  const legs: { label: string; state: string; detail: string; good: boolean }[] = [
    {
      label: 'Payment',
      state: proof.payment.state,
      detail: proof.payment.transactionHash ?? 'no transaction yet',
      good: proof.payment.state === 'settled',
    },
    {
      label: 'Order',
      state: proof.order.state,
      detail:
        proof.order.orderIds.length > 0
          ? proof.order.orderIds.join(', ')
          : 'the storefront has confirmed no order id',
      good: proof.order.state === 'confirmed',
    },
    {
      label: 'Delivery',
      state: proof.delivery.state,
      detail: `${proof.delivery.deliveredCount} of ${proof.delivery.itemCount} delivered`,
      good: proof.delivery.state === 'all_delivered' && proof.delivery.deliveredCount === proof.delivery.itemCount,
    },
  ];
  const proven = proof.finalStatus === 'delivered';
  return (
    <div className="panel">
      <div className="ph">
        <h3>Commerce route proof</h3>
        <span className="rt">
          <span className={`pill ${proven ? 'br' : 'a'}`}>{proof.finalStatus.replaceAll('_', ' ')}</span>
        </span>
      </div>
      <div className="pb">
        <p className={`why${proven ? '' : ' warn'}`}>{commerceProofCopyV1(proof.finalStatus)}</p>
        <div className="cardrows">
          {legs.map((leg) => (
            <article key={leg.label} className={`cardrow${leg.good ? '' : ' off'}`}>
              <div className="cr-top">
                <span className="cr-name">{leg.label}</span>
                <span className={`pill ${leg.good ? 'n' : 'a'}`}>{leg.state.replaceAll('_', ' ')}</span>
              </div>
              <p className="cr-why mono">{leg.detail}</p>
            </article>
          ))}
        </div>
        <div className="kv">
          <span className="k">Proof hash</span>
          <span className="v mono">{proof.proofHash}</span>
        </div>
      </div>
    </div>
  );
}
