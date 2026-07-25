import { z } from 'zod';
import {
  CommerceInvoiceV1Schema,
  hashCommerceInvoiceV1,
  ZERO_HASH_V1,
  type CommerceCandidateV1,
  type CommerceInvoiceV1,
  type CommerceProviderStatusV1,
  type CommerceRouteIntentV1,
} from '@mioagent/route-domain';
import {
  BITREFILL_PAY_TO_V1,
  COMMERCE_MAX_ORDER_ATOMIC_V1,
  COMMERCE_PAYMENT_NETWORK_V1,
  COMMERCE_USDC_ADDRESS_V1,
} from './pinned-config.js';
import { normalizeAddressV1 } from './normalization.js';
import type { CommerceFailureReasonV1 } from './types.js';

// ---------------------------------------------------------------------------
// T64.2 §3 — exact invoice validation.
//
// This is the only place a PRECISE settlement amount enters the system. The
// Route Card carries an ESTIMATED MINIMUM derived from the catalogue; that
// estimate is never overwritten here, and this exact figure is never
// synthesised from it. Both survive, labelled differently, so the user always
// sees which number came from where.
//
// Every check below is fail-closed. A single mismatch produces no invoice and
// therefore no payment review at all.
// ---------------------------------------------------------------------------

/** What the provider may state about an invoice. Only these fields are read;
 * anything else in the response is ignored rather than trusted. */
export const CommerceProviderInvoiceV1Schema = z
  .object({
    invoiceId: z.string().min(1).max(200),
    network: z.string().min(1).max(60),
    asset: z.string().min(1).max(120),
    payTo: z.string().min(1).max(120),
    amountAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/),
    providerFeeAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable().optional(),
    expiresAt: z.string().min(1).max(60),
    paymentStatus: z.string().min(1).max(60),
    orderStatus: z.string().min(1).max(60),
    productId: z.string().min(1).max(200),
    packageValue: z.string().min(1).max(80),
  })
  .strict();
export type CommerceProviderInvoiceV1 = z.infer<typeof CommerceProviderInvoiceV1Schema>;

/** Maps a provider status word onto the closed set. Unrecognised → `unknown`,
 * which forces reconciliation instead of reading as progress. */
export function mapProviderStatusV1(value: string | undefined): CommerceProviderStatusV1 {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'invoice_created':
    case 'created':
    case 'unpaid':
      return 'invoice_created';
    case 'payment_pending':
    case 'pending':
    case 'awaiting_payment':
      return 'payment_pending';
    case 'payment_confirmed':
    case 'payment_settled':
    case 'paid':
      return 'payment_settled';
    case 'order_confirmed':
    case 'confirmed':
      return 'order_confirmed';
    case 'delivery_pending':
    case 'fulfilling':
    case 'processing':
      return 'delivery_pending';
    case 'delivered':
    case 'complete':
    case 'all_delivered':
      return 'delivered';
    case 'expired':
      return 'expired';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/** An invoice that has not been paid is `awaiting_signature`, never `settled`.
 * Only an explicit settlement word advances it. */
export function mapInvoicePaymentStateV1(value: string | undefined): CommerceInvoiceV1['paymentStatus'] {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'paid':
    case 'payment_confirmed':
    case 'payment_settled':
    case 'complete':
      return 'settled';
    case 'expired':
      return 'expired';
    case 'failed':
    case 'cancelled':
    case 'canceled':
      return 'failed';
    default:
      return 'awaiting_signature';
  }
}

export type CommerceInvoiceValidationV1 =
  | { ok: true; invoice: CommerceInvoiceV1 }
  | { ok: false; reason: CommerceFailureReasonV1 };

export interface ValidateCommerceInvoiceInputV1 {
  provider: unknown;
  intent: CommerceRouteIntentV1;
  candidate: CommerceCandidateV1;
  /** The wallet that authenticated this request; refunds may go nowhere else. */
  authenticatedWallet: string;
  now: Date;
}

/**
 * Turns a provider invoice response into a validated CommerceInvoiceV1, or
 * refuses it.
 *
 * The checks, in order, are exactly the T64.2 §3 list:
 * canonical Base USDC · Base network · a positive exact amount · not expired ·
 * within the user's authorized ceiling · bound to the selected product and
 * package · refund wallet equals the authenticated wallet. The payment
 * recipient is taken ONLY from the validated invoice, and is itself pinned.
 */
export function validateCommerceInvoiceV1(
  input: ValidateCommerceInvoiceInputV1,
): CommerceInvoiceValidationV1 {
  const parsed = CommerceProviderInvoiceV1Schema.safeParse(input.provider);
  if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
  const provider = parsed.data;

  if (provider.network !== COMMERCE_PAYMENT_NETWORK_V1) {
    return { ok: false, reason: 'pinned_chain_mismatch' };
  }
  const asset = normalizeAddressV1(provider.asset);
  if (asset !== COMMERCE_USDC_ADDRESS_V1) return { ok: false, reason: 'pinned_asset_mismatch' };
  const payTo = normalizeAddressV1(provider.payTo);
  if (payTo !== BITREFILL_PAY_TO_V1) return { ok: false, reason: 'pinned_recipient_mismatch' };

  const amount = BigInt(provider.amountAtomic);
  if (amount <= BigInt(0)) return { ok: false, reason: 'price_out_of_range' };
  if (amount > BigInt(COMMERCE_MAX_ORDER_ATOMIC_V1)) return { ok: false, reason: 'spend_ceiling_exceeded' };
  if (amount > BigInt(input.intent.maxSpendAtomic)) return { ok: false, reason: 'spend_ceiling_exceeded' };

  // The invoice must be for the product and denomination that was selected —
  // an invoice for something else is not this order.
  if (provider.productId !== input.candidate.product.productId) {
    return { ok: false, reason: 'provider_invalid_response' };
  }
  if (provider.packageValue !== input.candidate.product.packageValue) {
    return { ok: false, reason: 'provider_invalid_response' };
  }

  const refundAddress = normalizeAddressV1(input.authenticatedWallet);
  if (refundAddress === null) return { ok: false, reason: 'provider_invalid_response' };
  if (refundAddress !== normalizeAddressV1(input.intent.walletAddress)) {
    return { ok: false, reason: 'pinned_recipient_mismatch' };
  }

  const expiresAtMs = Date.parse(provider.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= input.now.getTime()) {
    return { ok: false, reason: 'order_expired' };
  }

  const base = {
    schemaVersion: 'commerce-invoice/v1' as const,
    invoiceHash: ZERO_HASH_V1,
    invoiceId: provider.invoiceId,
    provider: 'bitrefill' as const,
    network: COMMERCE_PAYMENT_NETWORK_V1,
    asset,
    payTo,
    amountAtomic: provider.amountAtomic,
    providerFeeAtomic: provider.providerFeeAtomic ?? null,
    refundAddress,
    paymentStatus: mapInvoicePaymentStateV1(provider.paymentStatus),
    orderStatus: mapProviderStatusV1(provider.orderStatus),
    observedAt: input.now.toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  const validated = CommerceInvoiceV1Schema.safeParse({
    ...base,
    invoiceHash: hashCommerceInvoiceV1(base as unknown as CommerceInvoiceV1),
  });
  if (!validated.success) return { ok: false, reason: 'provider_invalid_response' };
  return { ok: true, invoice: validated.data };
}

/**
 * The two numbers, side by side and never merged.
 *
 * `estimatedMinimumAtomic` is what the catalogue said before any invoice
 * existed; `exactAmountAtomic` is what the invoice requires. A surface must
 * show the second as the price and the first as what it was — an estimate.
 */
export interface CommerceAmountReviewV1 {
  estimatedMinimumAtomic: string;
  estimatedBasis: 'exact_quote' | 'minimum';
  exactAmountAtomic: string;
  /** True when the exact charge exceeds what was estimated. */
  exceedsEstimate: boolean;
  differenceAtomic: string;
}

export function commerceAmountReviewV1(input: {
  candidate: CommerceCandidateV1;
  invoice: CommerceInvoiceV1;
}): CommerceAmountReviewV1 {
  const estimate = BigInt(input.candidate.fees.totalAtomic);
  const exact = BigInt(input.invoice.amountAtomic);
  const difference = exact > estimate ? exact - estimate : estimate - exact;
  return {
    estimatedMinimumAtomic: input.candidate.fees.totalAtomic,
    estimatedBasis: input.candidate.fees.totalBasis,
    exactAmountAtomic: input.invoice.amountAtomic,
    exceedsEstimate: exact > estimate,
    differenceAtomic: difference.toString(),
  };
}
