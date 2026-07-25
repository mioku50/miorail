import { z } from 'zod';
import { partnerFetch } from '@mioagent/security/httpAllowlist';
import type { CommerceDeliveryStateV1 } from '@mioagent/route-domain';
import {
  BITREFILL_PAY_TO_V1,
  BITREFILL_PROVIDER_V1,
  BITREFILL_V2_INVOICES_PATH_V1,
  COMMERCE_INVOICE_TTL_MS_V1,
  COMMERCE_PAYMENT_METHOD_V1,
  COMMERCE_USDC_ADDRESS_V1,
  buildCommerceUrlV1,
  resolveCommerceTimeoutMsV1,
} from './pinned-config.js';
import { commerceAuthHeadersV1, resolveCommerceCredentialV1, type CommerceCredentialV1 } from './auth.js';
import {
  classifyCommerceHttpStatusV1,
  classifyCommerceTransportErrorV1,
  decimalToAtomicV1,
} from './normalization.js';
import { isSettledInvoiceStatusV1, mapDeliveryStateV1 } from './bitrefill-gateway.js';
import type {
  CommerceCreateOrderInputV1,
  CommerceCreateOrderResultV1,
  CommerceFailureReasonV1,
  CommerceOrderGatewayV1,
  CommerceOrderStatusResultV1,
  CommerceSourceOptionsV1,
} from './types.js';

// ---------------------------------------------------------------------------
// T64.1 — the Bitrefill PERSONAL API order gateway (`/v2/invoices`, Bearer).
//
// `payment_method` is PINNED to `usdc_base`. It is never taken from a request,
// a config value, or a provider hint: this deployment settles commerce in USDC
// on Base or it does not settle at all. Every other rail Bitrefill accepts
// (lightning, solana, polygon, account balance…) is unreachable from here.
//
// As with the x402 gateway, no redemption material crosses this boundary —
// only invoice ids, order ids, states and counts.
// ---------------------------------------------------------------------------

const V2InvoicePaymentSchema = z
  .object({
    address: z.string().min(1).max(200).optional(),
    amount: z.union([z.string(), z.number()]).optional(),
    currency: z.string().min(1).max(20).optional(),
    method: z.string().min(1).max(40).optional(),
    status: z.string().min(1).max(40).optional(),
  })
  .passthrough();

const V2InvoiceOrderSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    status: z.string().min(1).max(60).optional(),
    delivered: z.boolean().optional(),
    product: z.union([z.string().min(1).max(200), z.record(z.unknown())]).optional(),
    value: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const V2InvoiceSchema = z
  .object({
    id: z.string().min(1).max(200),
    status: z.string().min(1).max(60).optional(),
    created_time: z.string().min(1).max(60).optional(),
    expires_time: z.string().min(1).max(60).optional(),
    payment: V2InvoicePaymentSchema.optional(),
    orders: z.array(V2InvoiceOrderSchema).max(20).optional(),
  })
  .passthrough();

const V2InvoiceEnvelopeSchema = z
  .object({
    meta: z.record(z.unknown()).optional(),
    data: V2InvoiceSchema,
  })
  .passthrough();

function amountToAtomicV1(value: unknown): string | null {
  if (typeof value === 'string') return decimalToAtomicV1(value.trim());
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return decimalToAtomicV1(String(value));
  }
  return null;
}

function transactionHashV1(value: unknown): `0x${string}` | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
}

/** An order line counts as delivered only on an explicit delivered signal.
 * Anything ambiguous stays undelivered, which keeps the proof from advancing
 * on a guess. */
export function v2OrderDeliveredV1(order: z.infer<typeof V2InvoiceOrderSchema>): boolean {
  if (order.delivered === true) return true;
  return mapDeliveryStateV1(order.status) === 'all_delivered';
}

export function v2InvoiceDeliveryStateV1(
  orders: readonly z.infer<typeof V2InvoiceOrderSchema>[],
  paymentSettled: boolean,
): CommerceDeliveryStateV1 {
  if (!paymentSettled) return 'not_started';
  if (orders.length === 0) return 'unknown';
  const delivered = orders.filter((order) => v2OrderDeliveredV1(order)).length;
  if (delivered === orders.length) return 'all_delivered';
  if (delivered > 0) return 'partially_delivered';
  if (orders.some((order) => mapDeliveryStateV1(order.status) === 'failed')) return 'failed';
  return 'pending';
}

export function createBitrefillPersonalOrderGatewayV1(
  options: CommerceSourceOptionsV1 & { apiKey?: string } = {},
): CommerceOrderGatewayV1 {
  const timeoutMs = resolveCommerceTimeoutMsV1(options.timeoutMs);
  const credential: CommerceCredentialV1 = resolveCommerceCredentialV1({ apiKey: options.apiKey });

  async function call(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; reason: CommerceFailureReasonV1; uncertain?: boolean }
  > {
    if (credential.kind !== 'personal_api') return { ok: false, reason: 'provider_not_configured' };
    let headers: Record<string, string>;
    try {
      headers = { accept: 'application/json', ...commerceAuthHeadersV1(credential, path) };
    } catch {
      return { ok: false, reason: 'provider_not_configured' };
    }
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await partnerFetch(
        buildCommerceUrlV1(path),
        {
          method: init.method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        },
        { timeoutMs, fetchImpl: options.fetchImpl },
      );
    } catch (error) {
      // T64.2: a POST that never returned may still have created an invoice.
      // It is reported as UNKNOWN, never as a failure, and never retried.
      const reason = classifyCommerceTransportErrorV1(error);
      if (init.method === 'POST') return { ok: false, reason, uncertain: true };
      return { ok: false, reason };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'provider_not_configured' };
    }
    const statusFailure = classifyCommerceHttpStatusV1(response.status);
    if (statusFailure !== null) {
      const uncertain = init.method === 'POST' && response.status >= 500;
      return { ok: false, reason: statusFailure, uncertain };
    }
    try {
      return { ok: true, body: await response.json() };
    } catch {
      // A POST whose body could not be read is also uncertain: the write may
      // have landed even though the answer did not.
      return {
        ok: false,
        reason: 'provider_invalid_response',
        uncertain: init.method === 'POST',
      };
    }
  }

  return {
    id: `${BITREFILL_PROVIDER_V1.id}-personal-orders`,

    async createOrder(input: CommerceCreateOrderInputV1): Promise<CommerceCreateOrderResultV1> {
      // A crypto-settled invoice needs a refund address. Without one the
      // storefront has nowhere to return a failed payment, so the order is
      // refused here rather than opened blind.
      if (!input.refundAddress) return { ok: false, reason: 'provider_not_configured' };

      const line: Record<string, unknown> = {
        product_id: input.productId,
        // The denomination is sent VERBATIM as the provider stated it.
        value: input.packageValue,
        quantity: 1,
      };
      if (input.recipientInput !== null) line.phone_number = input.recipientInput;

      const result = await call(BITREFILL_V2_INVOICES_PATH_V1, {
        method: 'POST',
        body: {
          products: [line],
          // Pinned. Not configurable, not client-supplied.
          payment_method: COMMERCE_PAYMENT_METHOD_V1,
          auto_pay: false,
          refund_address: input.refundAddress,
        },
      });
      if (!result.ok) {
        if (result.uncertain === true) {
          return {
            ok: false,
            reason: 'invoice_creation_unknown',
            detail: `The checkout call did not return a definite answer (${result.reason}).`,
          };
        }
        return { ok: false, reason: result.reason };
      }
      const parsed = V2InvoiceEnvelopeSchema.safeParse(result.body);
      if (!parsed.success) {
        return {
          ok: false,
          reason: 'invoice_creation_unknown',
          detail: 'The checkout answer could not be read, so an invoice may exist.',
        };
      }
      const invoice = parsed.data.data;

      const totalAtomic = amountToAtomicV1(invoice.payment?.amount);
      if (totalAtomic === null) return { ok: false, reason: 'price_unavailable' };
      if (BigInt(totalAtomic) > BigInt(input.maxSpendAtomic)) {
        return { ok: false, reason: 'spend_ceiling_exceeded' };
      }

      const expires = invoice.expires_time ? Date.parse(invoice.expires_time) : Number.NaN;
      const expiresAt = Number.isNaN(expires)
        ? new Date(input.now.getTime() + COMMERCE_INVOICE_TTL_MS_V1)
        : new Date(expires);

      return {
        ok: true,
        order: {
          invoiceId: invoice.id,
          totalAtomic,
          // The settlement pair stays PINNED. The invoice's own payment
          // address is deliberately NOT trusted as the recipient: it is
          // re-validated against the pinned payTo by buildCommerceOrderV1,
          // which is what refuses a redirected payment.
          payTo: BITREFILL_PAY_TO_V1,
          asset: COMMERCE_USDC_ADDRESS_V1,
          expiresAt: expiresAt.toISOString(),
          items: [
            {
              productId: input.productId,
              packageValue: input.packageValue,
              orderId: invoice.orders?.[0]?.id ?? null,
            },
          ],
          providerFeeAtomic: null,
          // Reported verbatim. The invoice validator maps these onto the
          // closed status set — the gateway reports, it does not interpret.
          paymentStatus: invoice.payment?.status ?? invoice.status,
          orderStatus: invoice.orders?.[0]?.status ?? invoice.status,
        },
      };
    },

    async readOrderStatus(input: { invoiceId: string; now: Date }): Promise<CommerceOrderStatusResultV1> {
      const result = await call(`${BITREFILL_V2_INVOICES_PATH_V1}/${encodeURIComponent(input.invoiceId)}`, {
        method: 'GET',
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      const parsed = V2InvoiceEnvelopeSchema.safeParse(result.body);
      if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
      const invoice = parsed.data.data;
      if (invoice.id !== input.invoiceId) return { ok: false, reason: 'provider_invalid_response' };

      const orders = invoice.orders ?? [];
      const orderIds = orders
        .map((order) => order.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const paymentSettled =
        isSettledInvoiceStatusV1(invoice.status) || isSettledInvoiceStatusV1(invoice.payment?.status);
      const deliveryState = v2InvoiceDeliveryStateV1(orders, paymentSettled);

      return {
        ok: true,
        status: {
          invoiceId: invoice.id,
          paymentSettled,
          paymentTransactionHash: transactionHashV1(
            (invoice as Record<string, unknown>).transaction ?? (invoice.payment as Record<string, unknown> | undefined)?.transaction,
          ),
          settledAt: null,
          orderIds,
          deliveryState,
          itemCount: Math.max(orders.length, 1),
          deliveredCount: paymentSettled ? orders.filter((order) => v2OrderDeliveredV1(order)).length : 0,
          observedAt: input.now.toISOString(),
        },
      };
    },
  };
}
