import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { SPEND_EMAIL_V1, spendPhoneV1, type BitrefillGuestCheckoutV1 } from '@mioagent/commerce-engine';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';

import { createViemBaseReceiptReader } from '../lib/baseReceiptReader.js';
import { loanExecutionRuntimeV1 } from '../lib/loanExecutionStore.js';
import { sessionWalletV1 } from '../lib/sessionWallet.js';
import { readBaseWalletBatchHashesV1 } from '../lib/stockExecutionStatus.js';
import { prepareSpendWalletPaymentV1, refreshSpendWalletPaymentV1, spendWalletWireV1, withSpendInvoiceLockV1 } from '../lib/stillSpendWallet.js';
import { spendWalletStoreRuntimeV1 } from '../lib/stillSpendWalletStore.js';
import {
  STILL_SPEND_CAP_ATOMIC_V1,
  spendBuyableV1,
  spendDraftPaymentV1,
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
// is reviewed, simulated and signed on the lending page like any other loan,
// or from the USDC already in the wallet: one exact transfer, reviewed and
// simulated here and signed in the person's own wallet (2026-11-03).
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
  // Paying from the wallet's own USDC: its review and record, the loans that may already pay
  // the same invoice, and the chain that says what was paid.
  walletPayments: spendWalletStoreRuntimeV1.store,
  loans: loanExecutionRuntimeV1.store,
  prepareWallet: prepareSpendWalletPaymentV1,
  reader: createViemBaseReceiptReader,
  readBatchHashes: readBaseWalletBatchHashesV1,
  // A review reads the wallet and runs a simulation, and a result reads the chain:
  // a person asks a few times a minute, a script without end.
  walletLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 12 }),
  walletStatusLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 30 }),
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

export type SpendOrderOpenedV1 = { ok: true; order: SpendOrderV1 } | { ok: false; status: number; error: string; detail?: string; priceAtomic?: string };

/** One invoice for this owner, as the page and the connected MCP open it:
 * the hourly limit, a fresh quote, the product's own rules, the cap, then
 * Bitrefill's invoice, checked against that quote. Paying is on already.
 * `payableAtomic`: paid from the wallet's own USDC, a price above what it
 * holds opens no invoice. */
export async function openSpendOrderV1(owner: SpendOrderOwnerV1, request: z.infer<typeof SpendOrderRequestV1Schema>,
  options: { payableAtomic?: bigint } = {}): Promise<SpendOrderOpenedV1> {
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
  if (!product.ok) return refuse(product.reason === 'bitrefill_product_not_found' ? 404 : 503, product.reason, product.detail ? { detail: product.detail } : {});
  if (product.value.prepayment) return refuse(409, 'spend_product_prepayment');
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
  if (options.payableAtomic !== undefined && quoted > options.payableAtomic) return { ...refuse(409, 'spend_wallet_usdc_short'), priceAtomic: quoted.toString() };
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

// ---------------------------------------------------------------------------
// Paying an invoice from the wallet's own USDC. The page asks for the review,
// arms it, has the wallet send its one call, says what the wallet answered,
// then reads the result. Nothing here signs or sends.
// ---------------------------------------------------------------------------

const HASH_V1 = /^0x[0-9a-f]{64}$/i;
const WalletArmV1Schema = z.object({ callsHash: z.string().regex(HASH_V1), signingTermsHash: z.string().regex(HASH_V1) }).strict();
// A batch id (wallet_sendCalls) or a transaction hash (one transaction), never both; nothing with a refusal or an unknown.
const WalletSubmissionV1Schema = z.object({
  attemptId: z.string().uuid(), outcome: z.enum(['submitted', 'unknown', 'rejected']),
  batchId: z.string().min(1).max(2000).optional(), transactionHash: z.string().regex(HASH_V1).optional(),
}).strict().refine((v) => v.outcome === 'submitted' ? (v.batchId === undefined) !== (v.transactionHash === undefined) : v.batchId === undefined && v.transactionHash === undefined);
const WalletTransactionHintV1Schema = z.object({ transactionHash: z.string().regex(HASH_V1) }).strict();

function walletOrderV1(req: Request, res: Response): { wallet: string; owner: SpendOrderOwnerV1; orderId: string } | null {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return null;
  const orderId = String(req.params.id ?? '').toLowerCase();
  if (!UUID_V1.test(orderId)) {
    res.status(400).json({ error: 'spend_request_invalid' });
    return null;
  }
  return { wallet, owner: { tenantId: `eip155:8453:${wallet}`, walletAddress: wallet }, orderId };
}

/** A loan that paid this invoice, or tried to: one invoice is paid once. */
async function loanHoldsInvoiceV1(owner: SpendOrderOwnerV1, orderId: string): Promise<boolean> {
  const loans = await stillSpendRuntimeV1.loans();
  return (await loans.listByPaymentOrder({ owner, orderId })).some((row) => row.state !== 'ready');
}

/** The review: the invoice must still be this wallet's, waiting at Bitrefill and not paid by a loan, and the wallet must hold its price. */
stillSpendRouter.post('/orders/:id/wallet', async (req: Request, res: Response) => {
  const asked = walletOrderV1(req, res);
  if (!asked) return;
  const { wallet, owner, orderId } = asked;
  if (!stillSpendRuntimeV1.enabled()) {
    res.status(503).json({ error: 'spend_pay_off' });
    return;
  }
  const allowed = await stillSpendRuntimeV1.walletLimiter.consume(wallet);
  if (!allowed.success) {
    res.status(429).json({ error: 'spend_rate_limited' });
    return;
  }
  const store = await stillSpendRuntimeV1.walletPayments();
  // Sent, or tried: from then on a payment is read, never prepared again.
  const prior = await store.get({ owner, orderId });
  if (prior && prior.state !== 'ready') {
    res.json(spendWalletWireV1(prior));
    return;
  }
  const refuse = (refusal: string, detail: string) => { res.json({ orderId, state: 'refused', refusal, detail }); };
  const order = stillSpendRuntimeV1.orders.get(owner, orderId);
  if (!order) {
    refuse('spend_order_unread', 'Still no longer holds this Bitrefill invoice: it expired, or the server restarted. Open a new one from Spend. Nothing was sent.');
    return;
  }
  const payment = spendDraftPaymentV1(order, stillSpendRuntimeV1.now());
  if (!payment) {
    refuse('spend_invoice_expiring', 'Bitrefill holds this price for less than three more minutes. Open a new invoice from Spend.');
    return;
  }
  if (await loanHoldsInvoiceV1(owner, orderId)) {
    refuse('spend_invoice_has_attempt', 'A loan from Still already paid this invoice, or tried to. Check it on the loan’s page before paying again.');
    return;
  }
  const status = await stillSpendRuntimeV1.checkout().readInvoice({ invoiceId: order.orderId, accessToken: order.accessToken });
  if (!status.ok) {
    refuse('spend_invoice_unread', 'Bitrefill’s invoice could not be read just now, so nothing can be paid. Try again in a minute.');
    return;
  }
  if (status.value.status !== 'unpaid') {
    refuse('spend_invoice_not_unpaid', `Bitrefill reports this invoice as ${status.value.status.replace(/_/g, ' ')}, not waiting for payment. Nothing can be paid to it.`);
    return;
  }
  const run = await stillSpendRuntimeV1.prepareWallet({ walletAddress: wallet, payment, now: stillSpendRuntimeV1.now() });
  if (run.state === 'refused') {
    res.json({ orderId, ...run });
    return;
  }
  res.json(spendWalletWireV1(await store.putReady({ owner, run, now: stillSpendRuntimeV1.now() })));
});

stillSpendRouter.post('/orders/:id/wallet/arm', async (req: Request, res: Response) => {
  const asked = walletOrderV1(req, res);
  if (!asked) return;
  const { owner, orderId } = asked;
  const body = WalletArmV1Schema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'spend_request_invalid' });
    return;
  }
  if (!stillSpendRuntimeV1.enabled()) {
    res.status(503).json({ error: 'spend_pay_off' });
    return;
  }
  if (!stillSpendRuntimeV1.orders.get(owner, orderId)) {
    res.status(409).json({ error: 'spend_order_unread' });
    return;
  }
  const store = await stillSpendRuntimeV1.walletPayments();
  // Read beside the loans of the same invoice, one arm at a time: a loan armed first wins, and so does this.
  const result = await withSpendInvoiceLockV1(orderId, async () => (await loanHoldsInvoiceV1(owner, orderId))
    ? { ok: false as const, refusal: 'spend_invoice_has_attempt' }
    : store.arm({ owner, orderId, ...body.data, now: stillSpendRuntimeV1.now() }));
  if (!result.ok) {
    res.status(409).json({ error: result.refusal === 'payment_not_ready' ? 'spend_wallet_not_ready' : result.refusal });
    return;
  }
  res.json({ attemptId: result.attemptId });
});

stillSpendRouter.post('/orders/:id/wallet/submission', async (req: Request, res: Response) => {
  const asked = walletOrderV1(req, res);
  if (!asked) return;
  const { owner, orderId } = asked;
  const body = WalletSubmissionV1Schema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'spend_request_invalid' });
    return;
  }
  const store = await stillSpendRuntimeV1.walletPayments();
  const record = await store.recordSubmission({ owner, orderId, attemptId: body.data.attemptId, outcome: body.data.outcome,
    batchId: body.data.batchId ?? null, transactionHash: (body.data.transactionHash?.toLowerCase() ?? null) as `0x${string}` | null, now: stillSpendRuntimeV1.now() });
  if (!record) {
    res.status(409).json({ error: 'spend_wallet_attempt_changed' });
    return;
  }
  res.json(spendWalletWireV1(record));
});

/** A transaction hash from the wallet's own activity, for a payment whose result Still cannot find:
 * a batch id only that wallet knows, or an answer that never reached Still (re-audit R5, 2026-11-04).
 * Only a lookup hint: the result is still read from the chain against the approved call, and a hint
 * that matches nothing is replaced by the next one. Two different wallet answers stay as they are. */
stillSpendRouter.post('/orders/:id/wallet/transaction', async (req: Request, res: Response) => {
  const asked = walletOrderV1(req, res);
  if (!asked) return;
  const { wallet, owner, orderId } = asked;
  const body = WalletTransactionHintV1Schema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'spend_request_invalid' });
    return;
  }
  if (!(await stillSpendRuntimeV1.walletLimiter.consume(wallet)).success) {
    res.status(429).json({ error: 'spend_rate_limited' });
    return;
  }
  const store = await stillSpendRuntimeV1.walletPayments();
  const record = await store.get({ owner, orderId });
  if (!record || !['awaiting_wallet', 'submitted', 'unknown'].includes(record.state) || record.errorCode === 'conflicting_wallet_answers') {
    res.status(409).json({ error: 'spend_wallet_attempt_changed' });
    return;
  }
  const saved = await store.recordVerification({ owner, orderId, expectedVersion: record.version, state: 'unknown',
    transactionHash: body.data.transactionHash.toLowerCase() as `0x${string}`, proof: null, errorCode: 'spend_wallet_transaction_hint_unverified',
    now: stillSpendRuntimeV1.now() });
  if (!saved) {
    res.status(409).json({ error: 'spend_wallet_attempt_changed' });
    return;
  }
  res.json(spendWalletWireV1(saved));
});

/** The result, read from the chain. Over the limit, what was last recorded. */
stillSpendRouter.get('/orders/:id/wallet', async (req: Request, res: Response) => {
  const asked = walletOrderV1(req, res);
  if (!asked) return;
  const { wallet, owner, orderId } = asked;
  const store = await stillSpendRuntimeV1.walletPayments();
  const allowed = await stillSpendRuntimeV1.walletStatusLimiter.consume(wallet);
  const record = allowed.success
    ? await refreshSpendWalletPaymentV1({ owner, orderId }, { store, reader: stillSpendRuntimeV1.reader(), readBatchHashes: stillSpendRuntimeV1.readBatchHashes, now: stillSpendRuntimeV1.now })
    : await store.get({ owner, orderId });
  if (!record) {
    res.status(404).json({ error: 'spend_wallet_payment_not_found' });
    return;
  }
  res.json(spendWalletWireV1(record));
});
