import { z } from 'zod';
import {
  CommerceDeliveryRecordV1Schema,
  stableHashV1,
  type CommerceDeliveryRecordV1,
  type CommercePaymentProgressV1,
} from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T64.3 §8 — delivery, and the material that must never be stored.
//
// A gift-card code, a PIN, a redemption link and an eSIM URL are bearer
// credentials: whoever holds them holds the value. They are fetched on demand,
// returned once to the wallet that owns the order, and stored NOWHERE — not in
// the database, not in a log, not in an audit event, not in an error message,
// and not in the Route Proof.
//
// The proof records that redemption became available, when, and a hash of the
// REDACTED response. That is enough to prove delivery happened and useless to
// anyone who steals it.
// ---------------------------------------------------------------------------

/** Keys that may carry redemption material. Anything under one of these is
 * removed before hashing, before logging, and before persistence. */
export const COMMERCE_SECRET_KEYS_V1: readonly string[] = Object.freeze([
  'redemption_info',
  'redemptioninfo',
  'redemption',
  'code',
  'pin',
  'link',
  'url',
  'instructions',
  'barcode_value',
  'rsp_url',
  'access_token',
  'activation_code',
  'voucher',
]);

const REDACTED = '[redacted]';

/**
 * Replaces every secret-bearing value with a marker, recursively.
 *
 * Redacts by KEY rather than by pattern: a code that happens to look like an
 * ordinary string would slip past a pattern, and the whole point is that no
 * redemption material reaches a hash or a log.
 */
export function redactCommerceDeliveryV1(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactCommerceDeliveryV1(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = COMMERCE_SECRET_KEYS_V1.includes(key.toLowerCase())
        ? REDACTED
        : redactCommerceDeliveryV1(inner);
    }
    return out;
  }
  return value;
}

/** The hash the proof stores: over the REDACTED body, so it proves what was
 * observed without carrying anything worth stealing. */
export function commerceRedactedResponseHashV1(body: unknown): `0x${string}` {
  return stableHashV1('commerce-delivery-redacted/v1', redactCommerceDeliveryV1(body) as never);
}

/** One provider order, narrowed to what may cross into the domain. */
const ProviderOrderSchema = z
  .object({
    id: z.string().min(1).max(200),
    status: z.string().min(1).max(60).optional(),
    delivered: z.boolean().optional(),
    delivered_time: z.string().min(1).max(60).nullable().optional(),
    redemption_info: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

export type CommerceDeliverySecretV1 = {
  /** Returned once, to the owner, over a no-store response. Never persisted. */
  fields: Record<string, string>;
};

export type CommerceDeliveryReadV1 =
  | { ok: true; record: CommerceDeliveryRecordV1; secret: CommerceDeliverySecretV1 | null }
  | { ok: false; reason: 'not_delivered' | 'provider_invalid_response' };

/**
 * Reads a provider order into (a) a storable delivery record and (b) an
 * ephemeral secret that the caller must return immediately and never keep.
 *
 * The secret is only produced once the provider itself reports the order
 * delivered — an order that is merely paid for yields no redemption material.
 */
export function readCommerceDeliveryV1(input: {
  order: unknown;
  orderStatus: CommercePaymentProgressV1;
  now: Date;
}): CommerceDeliveryReadV1 {
  const parsed = ProviderOrderSchema.safeParse(input.order);
  if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
  const order = parsed.data;

  const delivered =
    input.orderStatus === 'delivered' &&
    (order.delivered === true || (order.status ?? '').trim().toLowerCase() === 'delivered');

  const redactedResponseHash = commerceRedactedResponseHashV1(order);
  if (!delivered) {
    const record = CommerceDeliveryRecordV1Schema.safeParse({
      redemptionAvailable: false,
      deliveryObservedAt: null,
      orderStatus: input.orderStatus,
      redactedResponseHash,
    });
    if (!record.success) return { ok: false, reason: 'provider_invalid_response' };
    return { ok: true, record: record.data, secret: null };
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(order.redemption_info ?? {})) {
    if (typeof value === 'string' && value.length > 0) fields[key] = value;
  }

  const record = CommerceDeliveryRecordV1Schema.safeParse({
    // Only claim redemption is available when the provider actually returned
    // something to redeem.
    redemptionAvailable: Object.keys(fields).length > 0,
    deliveryObservedAt:
      Object.keys(fields).length > 0
        ? (order.delivered_time ?? input.now.toISOString())
        : null,
    orderStatus: input.orderStatus,
    redactedResponseHash,
  });
  if (!record.success) return { ok: false, reason: 'provider_invalid_response' };
  return {
    ok: true,
    record: record.data,
    secret: Object.keys(fields).length > 0 ? { fields } : null,
  };
}

/** The response headers a delivery read MUST carry. */
export const COMMERCE_DELIVERY_HEADERS_V1: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  // Never let a code end up in a referrer or an intermediary's index.
  'referrer-policy': 'no-referrer',
});

/** Maps a provider ladder position onto the closed progress set. */
export function commercePaymentProgressV1(input: {
  onchainVerified: boolean;
  providerPaymentSeen: boolean;
  providerPaymentConfirmed: boolean;
  orderConfirmed: boolean;
  delivered: boolean;
  refunded: boolean;
  failed: boolean;
}): CommercePaymentProgressV1 {
  if (input.failed) return 'failed';
  if (input.refunded) return 'refunded';
  // Each rung requires the one below it. An onchain transfer is not a provider
  // confirmation, and a provider confirmation is not an order.
  if (input.delivered && input.orderConfirmed) return 'delivered';
  if (input.orderConfirmed) return 'delivery_pending';
  if (input.providerPaymentConfirmed) return 'order_processing';
  if (input.providerPaymentSeen) return 'payment_detected';
  if (input.onchainVerified) return 'payment_submitted';
  return 'payment_submitted';
}

/** Paid onchain, but the provider never acknowledged it. A reconciliation
 * event, never a purchase. */
export function commercePaymentUnconfirmedV1(input: {
  onchainVerified: boolean;
  providerPaymentSeen: boolean;
  elapsedMs: number;
  boundMs: number;
}): boolean {
  return input.onchainVerified && !input.providerPaymentSeen && input.elapsedMs >= input.boundMs;
}
