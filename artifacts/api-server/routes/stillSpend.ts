import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { SPEND_EMAIL_V1, type BitrefillGuestCheckoutV1 } from '@mioagent/commerce-engine';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';

import { sessionWalletV1 } from '../lib/sessionWallet.js';
import {
  STILL_SPEND_CAP_ATOMIC_V1,
  spendBuyableV1,
  spendOrderStoreV1,
  spendPriceAtomicV1,
  stillSpendCheckoutV1,
  stillSpendPayEnabledV1,
  type SpendOrderV1,
} from '../lib/stillSpendOrders.js';
import { publicStillRuntimeV1 } from './stillPublic.js';

// ---------------------------------------------------------------------------
// Still Spend, stage 3: one Bitrefill invoice for the signed-in wallet.
//
// Opening an invoice moves no money. It is paid by the loan's own batch, which
// is reviewed, simulated and signed on the lending page like any other loan.
// The email goes to Bitrefill for its receipt and is not kept here.
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

const OrderRequestV1 = z.object({
  productId: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/),
  packageValue: z.string().min(1).max(80),
  email: z.string().max(254).regex(SPEND_EMAIL_V1),
}).strict();
const UUID_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the owner's page may see of an order: all of it but the access token.
 * Bitrefill's payment link carries that token, and it is the owner's own. */
function orderWireV1(order: SpendOrderV1) {
  return {
    orderId: order.orderId, productId: order.productId, productName: order.productName, packageValue: order.packageValue,
    faceCurrency: order.faceCurrency, priceAtomic: order.priceAtomic, payTo: order.payTo, createdAt: order.createdAt,
    expiresAt: order.expiresAt, paymentLink: order.paymentLink,
  };
}

stillSpendRouter.post('/orders', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  const owner = { tenantId: `eip155:8453:${wallet}`, walletAddress: wallet };
  if (!stillSpendRuntimeV1.enabled()) {
    res.status(503).json({ error: 'spend_pay_off' });
    return;
  }
  const parsed = OrderRequestV1.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'spend_request_invalid' });
    return;
  }
  if (stillSpendRuntimeV1.orders.openedLastHour(owner) >= 6) {
    res.status(429).json({ error: 'spend_rate_limited' });
    return;
  }
  // A fresh quote, not the page's cached one: the invoice is checked against it.
  const product = await stillSpendRuntimeV1.catalog().product(parsed.data.productId);
  if (!product.ok) {
    res.status(product.reason === 'bitrefill_product_not_found' ? 404 : 503).json({ error: product.reason });
    return;
  }
  if (!product.value.inStock || !spendBuyableV1(product.value)) {
    res.status(409).json({ error: 'spend_product_not_buyable' });
    return;
  }
  const offered = product.value.packages.find((row) => row.value === parsed.data.packageValue);
  const quoted = offered ? spendPriceAtomicV1(offered.priceUsdc) : null;
  if (!offered || quoted === null || quoted <= 0n) {
    res.status(409).json({ error: 'spend_package_not_offered' });
    return;
  }
  if (quoted > STILL_SPEND_CAP_ATOMIC_V1) {
    res.status(409).json({ error: 'spend_over_cap' });
    return;
  }
  const now = stillSpendRuntimeV1.now();
  const invoice = await stillSpendRuntimeV1.checkout().createInvoice({
    productId: product.value.id, packageValue: offered.value, email: parsed.data.email, quotedAtomic: quoted, now,
  });
  if (!invoice.ok) {
    // The shape names keys and kinds only: never an address, an amount or a token.
    logger.warn('Still Spend invoice not opened', { reason: invoice.reason, ...(invoice.shape ? { shape: invoice.shape } : {}) });
    res.status(invoice.reason === 'bitrefill_invoice_price_changed' ? 409 : 503).json({ error: invoice.reason });
    return;
  }
  if (invoice.value.payTo === wallet) {
    res.status(409).json({ error: 'spend_payee_refused' });
    return;
  }
  const order: SpendOrderV1 = {
    orderId: invoice.value.invoiceId, ...owner, productId: product.value.id, productName: product.value.name,
    packageValue: offered.value, faceCurrency: offered.faceCurrency, priceAtomic: quoted.toString(), payTo: invoice.value.payTo,
    createdAt: now.toISOString(), expiresAt: invoice.value.expiresAt, accessToken: invoice.value.accessToken, paymentLink: invoice.value.paymentLink,
  };
  stillSpendRuntimeV1.orders.put(order);
  res.json({ order: orderWireV1(order) });
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
