import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { SPEND_EMAIL_V1, spendPhoneV1, type BitrefillGuestCheckoutV1 } from '@mioagent/commerce-engine';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';

import { sessionWalletV1 } from '../lib/sessionWallet.js';
import {
  STILL_SPEND_CAP_ATOMIC_V1,
  spendBuyableV1,
  spendNeedsPhoneV1,
  spendOrderStoreV1,
  spendPriceAtomicV1,
  stillSpendCheckoutV1,
  stillSpendPayEnabledV1,
  type SpendOrderOwnerV1,
  type SpendOrderV1,
} from '../lib/stillSpendOrders.js';
import { publicStillRuntimeV1 } from './stillPublic.js';

// ---------------------------------------------------------------------------
// Still Spend, stage 3: one Bitrefill invoice for the signed-in wallet.
//
// Opening an invoice moves no money. It is paid by the loan's own batch, which
// is reviewed, simulated and signed on the lending page like any other loan.
// The email goes to Bitrefill for its receipt and is not kept here. A top-up's
// number goes to Bitrefill too, and is held with the open order only, for its
// owner to see.
// ---------------------------------------------------------------------------

export const stillSpendRuntimeV1 = {
  catalog: () => publicStillRuntimeV1.spend(),
  checkout: (): BitrefillGuestCheckoutV1 => stillSpendCheckoutV1(),
  orders: spendOrderStoreV1,
  enabled: () => stillSpendPayEnabledV1(),
  now: () => new Date(),
  // A person opens an invoice and reads it a few times; a script reads it in a loop.
  statusLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 20 }),
};

export const stillSpendRouter = Router();
stillSpendRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

export const SpendOrderRequestV1Schema = z.object({
  productId: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/),
  packageValue: z.string().min(1).max(80),
  email: z.string().max(254).regex(SPEND_EMAIL_V1),
  /** The number a phone top-up goes to, as the person wrote it. */
  phone: z.string().min(1).max(32).optional(),
}).strict();
const UUID_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the owner's page may see of an order: all of it but the access token.
 * Bitrefill's payment link carries that token, and it is the owner's own. */
function orderWireV1(order: SpendOrderV1) {
  return {
    orderId: order.orderId, productId: order.productId, productName: order.productName, packageValue: order.packageValue,
    faceCurrency: order.faceCurrency, priceAtomic: order.priceAtomic, payTo: order.payTo, refillTo: order.refillTo === null ? null : `+${order.refillTo}`, createdAt: order.createdAt,
    expiresAt: order.expiresAt, paymentLink: order.paymentLink,
  };
}

export type SpendOrderOpenedV1 = { ok: true; order: SpendOrderV1 } | { ok: false; status: number; error: string; detail?: string };

/** One invoice for this owner, as the page and the connected MCP open it:
 * the hourly limit, a fresh quote, the product's own rules, the cap, then
 * Bitrefill's invoice, checked against that quote. Paying is on already. */
export async function openSpendOrderV1(owner: SpendOrderOwnerV1, request: z.infer<typeof SpendOrderRequestV1Schema>): Promise<SpendOrderOpenedV1> {
  // Every refusal is on record by its reason, Still's own as well as
  // Bitrefill's: an assistant's account of it is not evidence of whose it was.
  // The shape names keys and kinds only: never an address, an amount or a token.
  const refuse = (status: number, error: string, seen: { shape?: unknown; field?: unknown; detail?: string } = {}) => {
    logger.warn('Still Spend invoice not opened', { reason: error, ...(seen.shape ? { shape: seen.shape } : {}), ...(seen.field ? { field: seen.field } : {}),
      ...(seen.detail ? { detail: seen.detail } : {}) });
    return { ok: false as const, status, error, ...(seen.detail ? { detail: seen.detail } : {}) };
  };
  if (stillSpendRuntimeV1.orders.openedLastHour(owner) >= 6) return refuse(429, 'spend_rate_limited');
  // A fresh quote, not the page's cached one: the invoice is checked against it.
  const product = await stillSpendRuntimeV1.catalog().product(request.productId);
  if (!product.ok) return refuse(product.reason === 'bitrefill_product_not_found' ? 404 : 503, product.reason);
  if (!product.value.inStock || !spendBuyableV1(product.value)) return refuse(409, 'spend_product_not_buyable');
  // A number goes to Bitrefill only for a top-up, and only as a number of the operator's own country.
  const needsPhone = spendNeedsPhoneV1(product.value);
  if (!needsPhone && request.phone !== undefined) return refuse(400, 'spend_request_invalid');
  const refillTo = needsPhone && request.phone !== undefined ? spendPhoneV1(request.phone, product.value.country) : null;
  if (needsPhone && refillTo === null) return refuse(400, request.phone === undefined ? 'spend_phone_needed' : 'spend_phone_invalid');
  const offered = product.value.packages.find((row) => row.value === request.packageValue);
  const quoted = offered ? spendPriceAtomicV1(offered.priceUsdc) : null;
  if (!offered || quoted === null || quoted <= 0n) return refuse(409, 'spend_package_not_offered');
  if (quoted > STILL_SPEND_CAP_ATOMIC_V1) return refuse(409, 'spend_over_cap');
  const now = stillSpendRuntimeV1.now();
  const invoice = await stillSpendRuntimeV1.checkout().createInvoice({
    productId: product.value.id, packageValue: offered.value, email: request.email, ...(refillTo !== null ? { refillInput: refillTo } : {}), quotedAtomic: quoted, now,
  });
  if (!invoice.ok) {
    return refuse(invoice.reason === 'bitrefill_invoice_price_changed' ? 409 : 503, invoice.reason,
      { shape: invoice.shape, field: invoice.field, ...(invoice.detail ? { detail: invoice.detail } : {}) });
  }
  if (invoice.value.payTo === owner.walletAddress) return refuse(409, 'spend_payee_refused');
  const order: SpendOrderV1 = {
    orderId: invoice.value.invoiceId, ...owner, productId: product.value.id, productName: product.value.name,
    packageValue: offered.value, faceCurrency: offered.faceCurrency, priceAtomic: quoted.toString(), payTo: invoice.value.payTo, refillTo,
    createdAt: now.toISOString(), expiresAt: invoice.value.expiresAt, accessToken: invoice.value.accessToken, paymentLink: invoice.value.paymentLink,
  };
  stillSpendRuntimeV1.orders.put(order);
  return { ok: true, order };
}

stillSpendRouter.post('/orders', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  if (!stillSpendRuntimeV1.enabled()) {
    res.status(503).json({ error: 'spend_pay_off' });
    return;
  }
  const parsed = SpendOrderRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'spend_request_invalid' });
    return;
  }
  const opened = await openSpendOrderV1({ tenantId: `eip155:8453:${wallet}`, walletAddress: wallet }, parsed.data);
  if (!opened.ok) {
    res.status(opened.status).json({ error: opened.error, ...(opened.detail ? { detail: opened.detail } : {}) });
    return;
  }
  res.json({ order: orderWireV1(opened.order) });
});

stillSpendRouter.get('/orders/:id', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  const owner = { tenantId: `eip155:8453:${wallet}`, walletAddress: wallet };
  const id = String(req.params.id ?? '').toLowerCase();
  if (!UUID_V1.test(id)) {
    res.status(400).json({ error: 'spend_request_invalid' });
    return;
  }
  const order = stillSpendRuntimeV1.orders.get(owner, id);
  if (!order) {
    res.status(404).json({ error: 'spend_order_not_found' });
    return;
  }
  const allowed = await stillSpendRuntimeV1.statusLimiter.consume(wallet);
  const status = allowed.success
    ? await stillSpendRuntimeV1.checkout().readInvoice({ invoiceId: order.orderId, accessToken: order.accessToken })
    : { ok: false as const, reason: 'bitrefill_rate_limited' as const };
  if (!status.ok && 'shape' in status && status.shape) logger.warn('Still Spend invoice status unread', { reason: status.reason, shape: status.shape });
  res.json({ order: orderWireV1(order), status: status.ok ? status.value : null, statusError: status.ok ? null : status.reason });
});
