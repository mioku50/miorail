import { z } from 'zod';
import { partnerFetch } from '@mioagent/security/httpAllowlist';
import type { CommerceDeliveryStateV1 } from '@mioagent/route-domain';
import {
  BITREFILL_INVOICE_CREATE_PATH_V1,
  BITREFILL_INVOICE_STATUS_PATH_V1,
  BITREFILL_PAY_TO_V1,
  BITREFILL_PROVIDER_V1,
  COMMERCE_INVOICE_TTL_MS_V1,
  COMMERCE_USDC_ADDRESS_V1,
  buildCommerceUrlV1,
  resolveCommerceTimeoutMsV1,
} from './pinned-config.js';
import {
  classifyCommerceHttpStatusV1,
  classifyCommerceTransportErrorV1,
  decimalToAtomicV1,
} from './normalization.js';
import type {
  CommerceCreateOrderInputV1,
  CommerceCreateOrderResultV1,
  CommerceFailureReasonV1,
  CommerceOrderGatewayV1,
  CommerceOrderStatusResultV1,
  CommerceSourceOptionsV1,
} from './types.js';

// ---------------------------------------------------------------------------
// T64 — the Bitrefill ORDER gateway: the half of the family that changes
// something at the provider.
//
// Kept separate from the catalogue adapter on purpose. A deployment can enable
// comparison (read-only, repeatable, free of consequence) without enabling
// checkout, and the two halves have different configuration and different
// failure handling.
//
// What this gateway will NOT return into the domain, under any response shape:
// redemption codes, PINs, eSIM QR URLs, `next_step` hints, or session tokens.
// Only invoice ids, provider order ids, states, and counts cross the boundary.
// ---------------------------------------------------------------------------

const InvoiceCreateResponseSchema = z
  .object({
    invoice_id: z.string().min(1).max(200),
    price_usdc: z.union([z.string(), z.number()]).optional(),
    price_usd: z.union([z.string(), z.number()]).optional(),
    expires_in_minutes: z.number().int().min(1).max(1_440).optional(),
    orders: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200).optional(),
            product_id: z.string().min(1).max(200).optional(),
            package_value: z.string().min(1).max(80).optional(),
          })
          .passthrough(),
      )
      .max(20)
      .optional(),
  })
  .passthrough();

const InvoiceStatusOrderSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    order_id: z.string().min(1).max(200).optional(),
    status: z.string().min(1).max(60).optional(),
    delivery_status: z.string().min(1).max(60).optional(),
  })
  .passthrough();

const InvoiceStatusResponseSchema = z
  .object({
    invoice_id: z.string().min(1).max(200),
    status: z.string().min(1).max(60).optional(),
    invoice_status: z.string().min(1).max(60).optional(),
    delivery_status: z.string().min(1).max(60).optional(),
    orders_delivery_status: z.string().min(1).max(60).optional(),
    transaction: z.string().min(1).max(200).optional(),
    settled_at: z.string().min(1).max(60).optional(),
    orders: z.array(InvoiceStatusOrderSchema).max(20).optional(),
  })
  .passthrough();

function priceToAtomicV1(value: unknown): string | null {
  if (typeof value === 'string') return decimalToAtomicV1(value.trim());
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return decimalToAtomicV1(String(value));
  }
  return null;
}

/** Only a settled payment status counts as settled — an unknown or in-flight
 * value stays unsettled, so the proof cannot advance on a guess. */
export function isSettledInvoiceStatusV1(status: string | undefined): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return normalized === 'payment_confirmed' || normalized === 'paid' || normalized === 'complete';
}

/** Maps the provider's delivery vocabulary onto the closed contract enum.
 * Anything unrecognised becomes `unknown`, which forces reconciliation rather
 * than being optimistically read as progress. */
export function mapDeliveryStateV1(value: string | undefined): CommerceDeliveryStateV1 {
  if (!value) return 'unknown';
  switch (value.trim().toLowerCase()) {
    case 'all_delivered':
    case 'delivered':
      return 'all_delivered';
    case 'partially_delivered':
    case 'partial':
      return 'partially_delivered';
    case 'pending':
    case 'processing':
    case 'fulfilling':
      return 'pending';
    case 'failed':
    case 'error':
      return 'failed';
    case 'not_started':
      return 'not_started';
    default:
      return 'unknown';
  }
}

function transactionHashV1(value: string | undefined): `0x${string}` | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
}

export function createBitrefillOrderGatewayV1(
  options: CommerceSourceOptionsV1 = {},
): CommerceOrderGatewayV1 {
  const timeoutMs = resolveCommerceTimeoutMsV1(options.timeoutMs);

  async function call(
    path: string,
    init: { method: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown },
  ): Promise<{ ok: true; body: unknown } | { ok: false; reason: CommerceFailureReasonV1 }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (options.accessToken) headers['X-Access-Token'] = options.accessToken;
    let response: Response;
    try {
      response = await partnerFetch(
        buildCommerceUrlV1(path, init.query ?? {}),
        {
          method: init.method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        },
        { timeoutMs, fetchImpl: options.fetchImpl },
      );
    } catch (error) {
      return { ok: false, reason: classifyCommerceTransportErrorV1(error) };
    }
    const statusFailure = classifyCommerceHttpStatusV1(response.status);
    if (statusFailure !== null) return { ok: false, reason: statusFailure };
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, reason: 'provider_invalid_response' };
    }
  }

  return {
    id: `${BITREFILL_PROVIDER_V1.id}-orders`,

    async createOrder(input: CommerceCreateOrderInputV1): Promise<CommerceCreateOrderResultV1> {
      // The package value is sent VERBATIM — the provider rejects a
      // transformed one, and a rejected create is the safe outcome anyway.
      const item: Record<string, string> = {
        product_id: input.productId,
        package_value: input.packageValue,
      };
      if (input.recipientInput !== null) item.refill_input = input.recipientInput;

      const result = await call(BITREFILL_INVOICE_CREATE_PATH_V1, {
        method: 'POST',
        body: { items: [item] },
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      const parsed = InvoiceCreateResponseSchema.safeParse(result.body);
      if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
      const invoice = parsed.data;

      const totalAtomic = priceToAtomicV1(invoice.price_usdc) ?? priceToAtomicV1(invoice.price_usd);
      if (totalAtomic === null) return { ok: false, reason: 'price_unavailable' };
      if (BigInt(totalAtomic) > BigInt(input.maxSpendAtomic)) {
        return { ok: false, reason: 'spend_ceiling_exceeded' };
      }

      const ttlMs = (invoice.expires_in_minutes ?? COMMERCE_INVOICE_TTL_MS_V1 / 60_000) * 60_000;
      return {
        ok: true,
        order: {
          invoiceId: invoice.invoice_id,
          totalAtomic,
          // The settlement pair is PINNED, never read from the response.
          payTo: BITREFILL_PAY_TO_V1,
          asset: COMMERCE_USDC_ADDRESS_V1,
          expiresAt: new Date(input.now.getTime() + ttlMs).toISOString(),
          items: [
            {
              productId: input.productId,
              packageValue: input.packageValue,
              orderId: invoice.orders?.[0]?.id ?? null,
            },
          ],
        },
      };
    },

    async readOrderStatus(input: { invoiceId: string; now: Date }): Promise<CommerceOrderStatusResultV1> {
      const result = await call(BITREFILL_INVOICE_STATUS_PATH_V1, {
        method: 'GET',
        query: { invoice_id: input.invoiceId },
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      const parsed = InvoiceStatusResponseSchema.safeParse(result.body);
      if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
      const body = parsed.data;
      if (body.invoice_id !== input.invoiceId) return { ok: false, reason: 'provider_invalid_response' };

      const orders = body.orders ?? [];
      const orderIds = orders
        .map((order) => order.order_id ?? order.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const deliveryState = mapDeliveryStateV1(body.orders_delivery_status ?? body.delivery_status);
      const deliveredCount = orders.filter(
        (order) => mapDeliveryStateV1(order.delivery_status ?? order.status) === 'all_delivered',
      ).length;

      return {
        ok: true,
        status: {
          invoiceId: body.invoice_id,
          paymentSettled: isSettledInvoiceStatusV1(body.invoice_status ?? body.status),
          paymentTransactionHash: transactionHashV1(body.transaction),
          settledAt: body.settled_at ?? null,
          orderIds,
          deliveryState,
          itemCount: Math.max(orders.length, 1),
          deliveredCount:
            deliveryState === 'all_delivered' ? Math.max(deliveredCount, Math.max(orders.length, 1)) : deliveredCount,
          observedAt: input.now.toISOString(),
        },
      };
    },
  };
}
