import { z } from 'zod';
import {
  CommerceOrderV1Schema,
  CommercePaymentRequirementsV1Schema,
  hashCommerceOrderV1,
  hashCommercePaymentRequirementsV1,
  stableHashV1,
  ZERO_HASH_V1,
  type CommerceCandidateV1,
  type CommerceOrderStatusV1,
  type CommerceOrderV1,
  type CommercePaymentRequirementsV1,
  type CommerceRouteIntentV1,
} from '@mioagent/route-domain';
import {
  BITREFILL_PAY_TO_V1,
  COMMERCE_INVOICE_TTL_MS_V1,
  COMMERCE_PAYMENT_NETWORK_V1,
  COMMERCE_USDC_ADDRESS_V1,
  COMMERCE_USDC_ASSET_V1,
} from './pinned-config.js';
import { atomicToDecimalV1, normalizeAddressV1 } from './normalization.js';
import { validateCommercePaymentTermsV1 } from './validation.js';
import type {
  CommerceCreatedOrderV1,
  CommerceFailureReasonV1,
  CommerceOrderStatusObservationV1,
} from './types.js';

// ---------------------------------------------------------------------------
// T64 — the order lifecycle.
//
// An order is the object that makes Commerce different from Swap and Earn:
// the money moving is only the FIRST of three things that have to happen. The
// state machine below is deliberately one-directional and refuses to walk
// backwards, so a late or duplicated provider poll can never downgrade a
// delivered order or resurrect a failed one.
// ---------------------------------------------------------------------------

// Forward jumps ARE allowed — a gift card can be paid for and delivered
// between two polls, and refusing that reading would strand a real order. What
// the table forbids is going backwards, and leaving a terminal state at all.
const ORDER_TRANSITIONS_V1: Record<CommerceOrderStatusV1, readonly CommerceOrderStatusV1[]> = {
  created: ['created', 'payment_pending', 'payment_confirmed', 'fulfilling', 'delivered', 'failed', 'expired'],
  payment_pending: ['payment_pending', 'payment_confirmed', 'fulfilling', 'delivered', 'failed', 'expired'],
  payment_confirmed: ['payment_confirmed', 'fulfilling', 'delivered', 'failed'],
  fulfilling: ['fulfilling', 'delivered', 'failed'],
  delivered: ['delivered'],
  failed: ['failed'],
  expired: ['expired'],
};

export function canTransitionCommerceOrderV1(
  from: CommerceOrderStatusV1,
  to: CommerceOrderStatusV1,
): boolean {
  return ORDER_TRANSITIONS_V1[from].includes(to);
}

export interface BuildCommerceOrderInputV1 {
  intent: CommerceRouteIntentV1;
  candidate: CommerceCandidateV1;
  created: CommerceCreatedOrderV1;
  now: Date;
}

export type CommerceOrderResultV1 =
  | { ok: true; order: CommerceOrderV1 }
  | { ok: false; reason: CommerceFailureReasonV1 };

/**
 * A freshly opened checkout, as a validated order.
 *
 * The created invoice is re-checked against the PINNED settlement pair and the
 * ceiling the user already agreed to — the provider's own numbers are the
 * input, never the authority. Nothing is signed at this point, and the order
 * starts with payment `awaiting_signature` and delivery `not_started`.
 */
export function buildCommerceOrderV1(input: BuildCommerceOrderInputV1): CommerceOrderResultV1 {
  const { intent, candidate, created, now } = input;

  const terms = validateCommercePaymentTermsV1({
    network: `eip155:${intent.chainId}`,
    asset: created.asset,
    payTo: created.payTo,
    amountAtomic: created.totalAtomic,
    maxSpendAtomic: intent.maxSpendAtomic,
    // The created checkout is settled on the provider's own pay route.
    resource: 'https://api.bitrefill.com/x402/invoice/pay',
  });
  if (!terms.ok) return { ok: false, reason: terms.reason };

  const expiresAt = new Date(
    Math.min(Date.parse(created.expiresAt), now.getTime() + COMMERCE_INVOICE_TTL_MS_V1),
  );
  if (!(expiresAt.getTime() > now.getTime())) return { ok: false, reason: 'order_expired' };

  const nowIso = now.toISOString();
  const orderBase = {
    schemaVersion: 'commerce-order/v1' as const,
    id: `commerce-order:${stableHashV1('commerce-order-id', {
      intentHash: intent.intentHash,
      invoiceId: created.invoiceId,
    }).slice(2, 26)}`,
    tenantId: intent.tenantId,
    walletAddress: intent.walletAddress,
    chainId: intent.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'created' as const,
    intentHash: intent.intentHash,
    candidateHash: candidate.candidateHash,
    orderHash: ZERO_HASH_V1,
    provider: 'bitrefill' as const,
    invoiceId: created.invoiceId,
    items: created.items.map((item) => ({
      productId: item.productId,
      packageValue: item.packageValue,
      orderId: item.orderId,
      deliveryState: 'not_started' as const,
    })),
    amount: {
      asset: COMMERCE_USDC_ASSET_V1,
      amountAtomic: created.totalAtomic,
      amountDecimal: atomicToDecimalV1(created.totalAtomic),
    },
    payTo: normalizeAddressV1(created.payTo) ?? candidate.paymentTarget.payTo,
    paymentState: 'awaiting_signature' as const,
    deliveryState: 'not_started' as const,
    paymentTransactionHash: null,
    expiresAt: expiresAt.toISOString(),
  };

  const parsed = CommerceOrderV1Schema.safeParse({
    ...orderBase,
    orderHash: hashCommerceOrderV1(orderBase as unknown as CommerceOrderV1),
  });
  if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
  return { ok: true, order: parsed.data };
}

/** Derives the order status from the three observed facts. Payment alone never
 * reaches `delivered`: that needs a provider order id on every line AND a
 * complete delivery report. */
export function deriveCommerceOrderStatusV1(input: {
  paymentSettled: boolean;
  everyItemHasOrderId: boolean;
  deliveryState: CommerceOrderV1['deliveryState'];
  expired: boolean;
}): CommerceOrderStatusV1 {
  if (input.deliveryState === 'failed') return 'failed';
  if (!input.paymentSettled) return input.expired ? 'expired' : 'payment_pending';
  if (input.deliveryState === 'all_delivered' && input.everyItemHasOrderId) return 'delivered';
  if (input.deliveryState === 'pending' || input.deliveryState === 'partially_delivered') return 'fulfilling';
  return 'payment_confirmed';
}

export interface ApplyCommerceOrderStatusInputV1 {
  order: CommerceOrderV1;
  observation: CommerceOrderStatusObservationV1;
  now: Date;
}

/**
 * Folds a provider status reading into the order.
 *
 * Guards, in order: the reading must be for THIS invoice; the item count must
 * not change under us; and the resulting status must be a legal forward
 * transition. Any of those failing leaves the stored order untouched and
 * returns a typed failure — a surprising poll is a reconciliation signal, not
 * an instruction to rewrite history.
 */
export function applyCommerceOrderStatusV1(
  input: ApplyCommerceOrderStatusInputV1,
): CommerceOrderResultV1 {
  const { order, observation, now } = input;
  if (observation.invoiceId !== order.invoiceId) return { ok: false, reason: 'order_not_confirmed' };
  if (observation.itemCount !== order.items.length) return { ok: false, reason: 'provider_invalid_response' };
  if (observation.deliveredCount > observation.itemCount) {
    return { ok: false, reason: 'provider_invalid_response' };
  }
  if (observation.paymentSettled && observation.paymentTransactionHash === null) {
    return { ok: false, reason: 'provider_invalid_response' };
  }

  const expired = Date.parse(order.expiresAt) < now.getTime();
  // Order ids arrive positionally, in the order the lines were submitted.
  const items = order.items.map((item, index) => {
    const orderId = observation.orderIds[index] ?? item.orderId;
    const delivered = index < observation.deliveredCount && orderId !== null;
    return {
      ...item,
      orderId,
      deliveryState: (delivered
        ? 'all_delivered'
        : observation.paymentSettled
          ? observation.deliveryState === 'failed'
            ? 'failed'
            : 'pending'
          : 'not_started') as CommerceOrderV1['deliveryState'],
    };
  });
  const everyItemHasOrderId = items.every((item) => item.orderId !== null);
  const deliveryState = observation.paymentSettled ? observation.deliveryState : 'not_started';
  const status = deriveCommerceOrderStatusV1({
    paymentSettled: observation.paymentSettled,
    everyItemHasOrderId,
    deliveryState,
    expired,
  });
  if (!canTransitionCommerceOrderV1(order.status, status)) {
    return { ok: false, reason: 'order_not_confirmed' };
  }

  const nextBase = {
    ...order,
    updatedAt: now.toISOString(),
    status,
    items,
    paymentState: (observation.paymentSettled
      ? 'settled'
      : expired
        ? 'expired'
        : order.paymentState) as CommerceOrderV1['paymentState'],
    deliveryState,
    paymentTransactionHash: observation.paymentTransactionHash ?? order.paymentTransactionHash,
    orderHash: ZERO_HASH_V1,
  };
  const parsed = CommerceOrderV1Schema.safeParse({
    ...nextBase,
    orderHash: hashCommerceOrderV1(nextBase as unknown as CommerceOrderV1),
  });
  if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
  return { ok: true, order: parsed.data };
}

// --- Payment review --------------------------------------------------------

/**
 * One `accepts[]` entry from the provider's 402.
 *
 * The amount field is named `amount` in x402 v2 and `maxAmountRequired` in v1,
 * and the resource lives on the envelope in v2 but on the entry in v1. Both
 * shapes are accepted and BOTH are validated the same way — verified against
 * the live envelope Bitrefill returns, which is v2.
 */
export const CommerceX402AcceptsV1Schema = z
  .object({
    scheme: z.string().min(1).max(40),
    network: z.string().min(1).max(60),
    asset: z.string().min(1).max(120),
    payTo: z.string().min(1).max(120),
    amount: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    maxAmountRequired: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    resource: z.string().min(1).max(500).optional(),
    maxTimeoutSeconds: z.number().int().min(1).max(86_400).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.amount === undefined && value.maxAmountRequired === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'A payment requirement must name an amount',
      });
    }
  });

export type CommerceX402AcceptsV1 = z.infer<typeof CommerceX402AcceptsV1Schema>;

/** The full 402 body. `accepts` routinely offers SEVERAL chains — the live
 * Bitrefill envelope lists Base, Arbitrum, Polygon and Solana — so the entry
 * is selected here, never taken by position. */
export const CommerceX402EnvelopeV1Schema = z
  .object({
    accepts: z.array(CommerceX402AcceptsV1Schema).min(1).max(20),
    resource: z
      .union([z.string().min(1).max(500), z.object({ url: z.string().min(1).max(500) }).passthrough()])
      .optional(),
  })
  .passthrough();

function acceptsAmountV1(accepts: CommerceX402AcceptsV1): string {
  return accepts.amount ?? accepts.maxAmountRequired ?? '0';
}

function envelopeResourceV1(envelope: z.infer<typeof CommerceX402EnvelopeV1Schema>): string | null {
  if (typeof envelope.resource === 'string') return envelope.resource;
  if (envelope.resource && typeof envelope.resource === 'object') return envelope.resource.url;
  return null;
}

/**
 * Picks the ONE Base + canonical-USDC + pinned-recipient entry out of a
 * multi-chain 402. Every other offer — another chain, another asset, another
 * recipient — is ignored rather than ranked, so a mis-selection cannot happen
 * by ordering. No match at all is a typed failure and no payment.
 */
export function selectCommerceBaseAcceptsV1(
  envelope: unknown,
): { ok: true; accepts: CommerceX402AcceptsV1; resource: string | null } | { ok: false; reason: CommerceFailureReasonV1 } {
  const parsed = CommerceX402EnvelopeV1Schema.safeParse(envelope);
  if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
  const resource = envelopeResourceV1(parsed.data);
  const match = parsed.data.accepts.find(
    (entry) =>
      entry.scheme === 'exact' &&
      entry.network === COMMERCE_PAYMENT_NETWORK_V1 &&
      normalizeAddressV1(entry.asset) === COMMERCE_USDC_ADDRESS_V1 &&
      normalizeAddressV1(entry.payTo) === BITREFILL_PAY_TO_V1,
  );
  if (!match) return { ok: false, reason: 'pinned_asset_mismatch' };
  return { ok: true, accepts: match, resource: match.resource ?? resource };
}

export type CommercePaymentRequirementsResultV1 =
  | { ok: true; requirements: CommercePaymentRequirementsV1 }
  | { ok: false; reason: CommerceFailureReasonV1 };

/**
 * The payment review object: exactly what the wallet will authorize.
 *
 * Every field is copied from the provider's own 402 envelope and then checked
 * against the pinned config — asset, recipient, network, host — and against
 * the order's own total. If anything disagrees, no requirements are produced
 * and therefore no signing prompt is ever shown. This is Commerce's equivalent
 * of the Safety Kernel refusing to hand back an approved batch.
 */
export function buildCommercePaymentRequirementsV1(input: {
  /** Either the whole 402 body (`{ accepts: [...] }`) or a single entry. */
  accepts: unknown;
  order: CommerceOrderV1;
  intent: CommerceRouteIntentV1;
  now: Date;
  /** Fallback resource when the envelope names none (v1-shaped entries). */
  resourceUrl?: string;
}): CommercePaymentRequirementsResultV1 {
  let accepts: CommerceX402AcceptsV1;
  let resource: string | null;
  const envelope = CommerceX402EnvelopeV1Schema.safeParse(input.accepts);
  if (envelope.success) {
    const selected = selectCommerceBaseAcceptsV1(input.accepts);
    if (!selected.ok) return { ok: false, reason: selected.reason };
    accepts = selected.accepts;
    resource = selected.resource;
  } else {
    const single = CommerceX402AcceptsV1Schema.safeParse(input.accepts);
    if (!single.success) return { ok: false, reason: 'provider_invalid_response' };
    accepts = single.data;
    resource = accepts.resource ?? null;
  }
  if (accepts.scheme !== 'exact') return { ok: false, reason: 'provider_invalid_response' };
  const resourceUrl = resource ?? input.resourceUrl ?? null;
  if (resourceUrl === null) return { ok: false, reason: 'pinned_host_mismatch' };
  const amountAtomic = acceptsAmountV1(accepts);

  const terms = validateCommercePaymentTermsV1({
    network: accepts.network,
    asset: accepts.asset,
    payTo: accepts.payTo,
    amountAtomic,
    maxSpendAtomic: input.intent.maxSpendAtomic,
    resource: resourceUrl,
  });
  if (!terms.ok) return { ok: false, reason: terms.reason };

  // The ceiling the user signs cannot exceed what the reviewed order says.
  if (BigInt(amountAtomic) > BigInt(input.order.amount.amountAtomic)) {
    return { ok: false, reason: 'spend_ceiling_exceeded' };
  }

  const expiresAt = new Date(
    Math.min(
      Date.parse(input.order.expiresAt),
      input.now.getTime() + (accepts.maxTimeoutSeconds ?? 600) * 1_000,
    ),
  );
  if (!(expiresAt.getTime() > input.now.getTime())) return { ok: false, reason: 'order_expired' };

  const base = {
    schemaVersion: 'commerce-payment-requirements/v1' as const,
    requirementsHash: ZERO_HASH_V1,
    scheme: 'exact' as const,
    network: 'eip155:8453' as const,
    asset: normalizeAddressV1(accepts.asset) as `0x${string}`,
    payTo: normalizeAddressV1(accepts.payTo) as `0x${string}`,
    maxAmountAtomic: amountAtomic,
    resource: resourceUrl,
    invoiceId: input.order.invoiceId,
    candidateHash: input.order.candidateHash,
    createdAt: input.now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  const parsed = CommercePaymentRequirementsV1Schema.safeParse({
    ...base,
    requirementsHash: hashCommercePaymentRequirementsV1(base as unknown as CommercePaymentRequirementsV1),
  });
  if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
  return { ok: true, requirements: parsed.data };
}
