import type {
  CommerceAvailabilityV1,
  CommerceDeliveryStateV1,
  CommerceFeeBreakdownV1,
  CommerceProductKindV1,
  CommerceProductRefV1,
} from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T64 — the injected commerce seams.
//
// The engine performs NO I/O of its own. Two interfaces separate reading the
// catalogue (safe, repeatable) from touching an order (irreversible), so a
// deployment can enable comparison without enabling purchase — and so unit
// tests can exercise the whole family without opening a socket.
// ---------------------------------------------------------------------------

/** The closed failure taxonomy. These codes travel verbatim into the Route
 * Card's provider failures and into operator logs, so they must stay stable
 * and must never carry provider text, a URL, or a credential. */
export type CommerceFailureReasonV1 =
  | 'unsupported_kind'
  | 'unsupported_country'
  | 'unsupported_currency'
  | 'provider_host_not_allowlisted'
  | 'provider_not_configured'
  | 'provider_timeout'
  | 'provider_unreachable'
  | 'provider_rate_limited'
  | 'provider_payment_required'
  | 'provider_http_error'
  | 'provider_invalid_response'
  /** The catalogue answered but held no product matching the query. */
  | 'product_not_found'
  /** A product matched but no denomination is usable for the requested value. */
  | 'denomination_unavailable'
  | 'product_out_of_stock'
  /** The provider quoted no settlement price and none can be derived. */
  | 'price_unavailable'
  /** A non-USD product with no provider USDC quote. Miorail has no FX evidence
   * source, so it refuses to invent a rate rather than guessing one. */
  | 'fx_rate_unavailable'
  | 'pinned_chain_mismatch'
  | 'pinned_asset_mismatch'
  | 'pinned_recipient_mismatch'
  | 'pinned_host_mismatch'
  | 'price_out_of_range'
  | 'spend_ceiling_exceeded'
  | 'recipient_required'
  | 'recipient_not_allowed'
  | 'order_expired'
  | 'order_not_confirmed'
  | 'delivery_unconfirmed';

/** One purchasable denomination of a product, already normalized. */
export interface CommercePackageObservationV1 {
  product: CommerceProductRefV1;
  fiatAmountDecimal: string;
  /** Total charge in settlement base units, fees included. */
  fees: CommerceFeeBreakdownV1;
  availability: CommerceAvailabilityV1;
}

/** A validated catalogue reading for one product, with its provenance. */
export interface CommerceCatalogObservationV1 {
  packages: CommercePackageObservationV1[];
  observedAt: string;
  expiresAt: string;
  /** Bare provider path — never a URL, never a query with credentials. */
  endpoint: string;
  requestHash: `0x${string}`;
  responseHash: `0x${string}`;
  providerId: string;
  providerDisplayName: string;
}

export type CommerceCatalogResultV1 =
  | { ok: true; observation: CommerceCatalogObservationV1 }
  | { ok: false; reason: CommerceFailureReasonV1 };

export interface CommerceCatalogSearchInputV1 {
  query: string;
  kind: CommerceProductKindV1;
  country: string;
  /** The value the user asked for, in the requested currency. */
  requestedValueDecimal: string;
  requestedCurrency: string;
  now: Date;
}

/** Read-only catalogue access. Safe to call for a comparison; never mutates. */
export interface CommerceCatalogSourceV1 {
  readonly id: string;
  search(input: CommerceCatalogSearchInputV1): Promise<CommerceCatalogResultV1>;
}

// --- Order gateway (the irreversible half) ---------------------------------

export interface CommerceCreateOrderInputV1 {
  productId: string;
  packageValue: string;
  /** Phone/account identifier for a top-up; null otherwise. */
  recipientInput: string | null;
  /** Ceiling the created invoice must not exceed, in settlement base units. */
  maxSpendAtomic: string;
  now: Date;
}

/** What the provider returns when a checkout is opened. Deliberately narrow:
 * the gateway does not surface `next_step` hints, session tokens, or any
 * redemption material into the domain. */
export interface CommerceCreatedOrderV1 {
  invoiceId: string;
  totalAtomic: string;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  expiresAt: string;
  items: { productId: string; packageValue: string; orderId: string | null }[];
}

export type CommerceCreateOrderResultV1 =
  | { ok: true; order: CommerceCreatedOrderV1 }
  | { ok: false; reason: CommerceFailureReasonV1 };

/** Provider-reported order state. Counts and states only — codes, PINs and
 * eSIM URLs are bearer credentials and never cross this boundary. */
export interface CommerceOrderStatusObservationV1 {
  invoiceId: string;
  paymentSettled: boolean;
  paymentTransactionHash: `0x${string}` | null;
  settledAt: string | null;
  orderIds: string[];
  deliveryState: CommerceDeliveryStateV1;
  itemCount: number;
  deliveredCount: number;
  observedAt: string;
}

export type CommerceOrderStatusResultV1 =
  | { ok: true; status: CommerceOrderStatusObservationV1 }
  | { ok: false; reason: CommerceFailureReasonV1 };

export interface CommerceOrderGatewayV1 {
  readonly id: string;
  createOrder(input: CommerceCreateOrderInputV1): Promise<CommerceCreateOrderResultV1>;
  readOrderStatus(input: { invoiceId: string; now: Date }): Promise<CommerceOrderStatusResultV1>;
}

export interface CommerceSourceOptionsV1 {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  freshnessTtlMs?: number;
  /** Session token for the provider's gated routes. Held in memory only: it is
   * never logged, never hashed, and never placed in evidence. */
  accessToken?: string;
}
