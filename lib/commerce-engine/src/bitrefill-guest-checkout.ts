import { SPEND_DELIVERY_EMAIL_V1 } from '@mioagent/route-domain';
import { ToonParseError, decodeToonV1 } from './toon.js';
import {
  createBitrefillGuestTransportV1,
  type BitrefillGuestOptionsV1,
  type SpendFailureV1,
} from './bitrefill-mcp-guest.js';

// ---------------------------------------------------------------------------
// Still Spend, stage 3: one Bitrefill invoice for one person, paid by that
// person's own wallet in the same transaction as the loan.
//
// A guest checkout (Bitrefill's MCP, client_credentials): `buy-products` with
// `usdc_base` and crypto details, and `get-invoice-by-id` to read where it
// stands. Bitrefill documents the answer only in prose ("a payment_info block
// (address and amount)", "expiration_minutes", "send the exact amount to the
// address before the invoice expires"), so the reading is strict and
// cross-checked: the amount must equal the USDC price Bitrefill quoted for
// the same package a moment before, or there is no invoice to pay. A changed
// shape is a failed read with its keys named, never a guess at an amount.
//
// The access token is the buyer's handle on the purchase ("anyone with
// invoice_id and invoice_access_token can read the invoice, including the
// codes"). It is returned to the caller and never logged here.
// ---------------------------------------------------------------------------

export const BITREFILL_CHECKOUT_TOOLS_V1 = ['buy-products', 'get-invoice-by-id'] as const;

/** Bitrefill's invoice states, as its eCommerce MCP page lists them. */
export const SPEND_INVOICE_STATUSES_V1 = [
  'unpaid', 'payment_detected', 'payment_confirmed', 'pending', 'complete', 'blocked', 'denied', 'payment_error',
] as const;
export type SpendInvoiceStatusNameV1 = (typeof SPEND_INVOICE_STATUSES_V1)[number];

/** The states an invoice does not leave by itself: delivered, or stopped by Bitrefill.
 * A page waiting on one of them has nothing more to wait for, so it stops asking. */
export const SPEND_INVOICE_SETTLED_STATUSES_V1: readonly SpendInvoiceStatusNameV1[] = ['complete', 'blocked', 'denied', 'payment_error'];
export const spendInvoiceSettledV1 = (status: SpendInvoiceStatusNameV1): boolean => SPEND_INVOICE_SETTLED_STATUSES_V1.includes(status);

/** USDC methods hold their price for fifteen minutes; Still never counts on more. */
export const SPEND_PRICE_LOCK_MS_V1 = 15 * 60_000;

export interface SpendInvoiceV1 {
  invoiceId: string;
  /** The buyer's handle on the purchase. Never logged, never put in a URL Still serves. */
  accessToken: string;
  /** Where the exact amount goes, lowercase. */
  payTo: `0x${string}`;
  /** USDC base units, equal to the price quoted for the package. */
  amountAtomic: bigint;
  /** No later than the price lock. */
  expiresAt: string;
  /** Bitrefill's own page for the invoice; it carries the access token. */
  paymentLink: string | null;
}

export interface SpendInvoiceStatusV1 {
  status: SpendInvoiceStatusNameV1;
  /** The order's page on bitrefill.com, when Bitrefill gave one. */
  accessLink: string | null;
  /** For an eSIM, once delivered. */
  esimInstallLink: string | null;
}

/** A refusal names the answer's keys (`shape`) and the one it could not read (`field`), never a value. */
export type SpendCheckoutResultV1<T> = { ok: true; value: T } | { ok: false; reason: SpendFailureV1; shape?: string; field?: string; detail?: string; local?: true };

export interface BitrefillGuestCheckoutV1 {
  /** Its requests carry Still's affiliate code (`?ref=`), so an invoice it opens may earn Still a commission. */
  readonly affiliated?: boolean;
  /** `refillInput` is the number a phone top-up goes to, from `spendPhoneV1`; nothing else needs one. */
  createInvoice(input: { productId: string; packageValue: string; email: string; refillInput?: string; quotedAtomic: bigint; now: Date }): Promise<SpendCheckoutResultV1<SpendInvoiceV1>>;
  /** Display polling uses ordinary slots. An omitted purpose is a fresh payment safety check, from the
   * priority part; `step`, the read before a loan's next step, from the part kept for it and for buying. */
  readInvoice(input: { invoiceId: string; accessToken: string }, options?: { purpose?: 'display' | 'payment' | 'step' }): Promise<SpendCheckoutResultV1<SpendInvoiceStatusV1>>;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const UUID_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_V1 = /^[A-Za-z0-9._~+/=-]{8,1024}$/;
const DECIMAL_V1 = /^(0|[1-9]\d{0,9})(?:\.(\d{1,6}))?$/;
const BASE_UNITS_V1 = /^[1-9]\d{0,15}$/;
/** Bitrefill's own email pattern, from the buy-products input schema. */
export const SPEND_EMAIL_V1 = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;
/** The names a payment_info amount might carry, in decimal USDC. Which one is
 * read never matters to what is paid: the value must equal the quoted price
 * either way. Bitrefill's first real usdc_base invoices (2026-11-01) carried
 * `altcoinPrice` beside `altBasePrice`, `contractAddress` and `paymentUri`. */
const AMOUNT_KEYS_V1 = ['amount', 'price', 'payment_amount', 'altcoin_price', 'altcoinPrice'] as const;
/** The same price in the coin's smallest unit. */
const BASE_UNIT_KEYS_V1 = ['altBasePrice'] as const;
/** USDC on Base: the one token a usdc_base invoice may ask for. */
const USDC_BASE_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/** Keys and value kinds only, for a log line: never a value. */
export function spendShapeV1(value: unknown, depth = 0): string {
  if (Array.isArray(value)) return depth > 2 ? 'array' : `[${value.length ? spendShapeV1(value[0], depth + 1) : ''}]`;
  if (!object(value)) return value === null ? 'null' : typeof value;
  if (depth > 2) return 'object';
  return `{${Object.keys(value).sort().slice(0, 30).map((key) => `${/^[A-Za-z0-9_]{1,40}$/.test(key) ? key : '?'}:${spendShapeV1(value[key], depth + 1)}`).join(',')}}`;
}

/** USDC base units from Bitrefill's amount: decimal USDC, or base units when it is
 * the quoted price in base units. Anything else is unread. */
function usdcAtomicV1(value: unknown, quotedAtomic: bigint): bigint | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(6).replace(/\.?0+$/, '') : typeof value === 'string' ? value.trim() : null;
  if (text === null) return null;
  if (BASE_UNITS_V1.test(text) && BigInt(text) === quotedAtomic && quotedAtomic >= 1_000_000n) return BigInt(text);
  const match = DECIMAL_V1.exec(text);
  return match ? BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0')) : null;
}

/** A whole number of base units, from a JSON number or a digit string. */
function baseUnitsV1(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null;
  return typeof value === 'string' && BASE_UNITS_V1.test(value.trim()) ? BigInt(value.trim()) : null;
}

/** "260000" or "2.6e5" as an exact whole number; anything with a fraction is null. */
function exactUintV1(text: string): bigint | null {
  if (/^[1-9]\d{0,30}$/.test(text)) return BigInt(text);
  const match = /^([1-9])(?:\.(\d{1,30}))?e\+?(\d{1,2})$/i.exec(text);
  if (!match) return null;
  const digits = `${match[1]}${match[2] ?? ''}`, exponent = Number(match[3]);
  return digits.length - 1 > exponent ? null : BigInt(digits) * 10n ** BigInt(exponent - (digits.length - 1));
}

/** An EIP-681 ERC-20 transfer, "ethereum:<token>@<chain>/transfer?address=<to>&uint256=<amount>",
 * or null when the text is not one. Exported for its tests. */
export function spendPaymentUriV1(value: unknown): { token: string; chainId: number | null; to: string; amount: bigint } | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  const match = /^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d{1,10}))?\/transfer\?([^#]*)$/.exec(value.trim());
  if (!match) return null;
  const params = new URLSearchParams(match[3]);
  const to = params.get('address'), amount = params.get('uint256');
  const units = amount === null ? null : exactUintV1(amount);
  if (!to || !ADDRESS_V1.test(to) || units === null) return null;
  return { token: match[1]!.toLowerCase(), chainId: match[2] ? Number(match[2]) : null, to: to.toLowerCase(), amount: units };
}

function httpsLinkV1(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'bitrefill.com' || url.hostname.endsWith('.bitrefill.com')) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Reads one buy-products answer. Exported for its tests. */
export function spendInvoiceFromAnswerV1(answer: unknown, quotedAtomic: bigint, now: Date): SpendCheckoutResultV1<SpendInvoiceV1> {
  const failed = (field: string, reason: SpendFailureV1 = 'bitrefill_invalid_response'): SpendCheckoutResultV1<SpendInvoiceV1> => ({ ok: false, reason, shape: spendShapeV1(answer), field });
  // The partner guide wraps the invoice in `response`; the eCommerce page lists it flat.
  const invoice = object(answer) ? object(answer.response) ? answer.response : answer : null;
  if (!invoice) return failed('response');
  const payment = invoice.payment_info;
  if (typeof invoice.invoice_id !== 'string' || !UUID_V1.test(invoice.invoice_id)) return failed('invoice_id');
  if (typeof invoice.invoice_access_token !== 'string' || !TOKEN_V1.test(invoice.invoice_access_token)) return failed('invoice_access_token');
  if (!object(payment) || typeof payment.address !== 'string' || !ADDRESS_V1.test(payment.address)) return failed('payment_info.address');
  const payTo = payment.address.toLowerCase();
  // USDC itself, or USDC on Base: a currency naming another network is refused, whatever else the invoice says.
  if (payment.currency !== undefined && (typeof payment.currency !== 'string' || !/^usdc(?:_base)?$/i.test(payment.currency))) return failed('payment_info.currency');
  // The token asked for is USDC on Base, or there is nothing Still can pay.
  if (payment.contractAddress !== undefined && (typeof payment.contractAddress !== 'string' || payment.contractAddress.toLowerCase() !== USDC_BASE_V1)) return failed('payment_info.contractAddress');
  const present = (key: string) => payment[key] !== undefined && payment[key] !== null;
  const decimals = AMOUNT_KEYS_V1.filter(present).map((key) => [key, usdcAtomicV1(payment[key], quotedAtomic)] as const);
  const units = BASE_UNIT_KEYS_V1.filter(present).map((key) => [key, baseUnitsV1(payment[key])] as const);
  const amounts = [...decimals, ...units];
  if (amounts.length === 0) return failed('payment_info.amount');
  const unread = amounts.find(([, amount]) => amount === null);
  if (unread) return failed(`payment_info.${unread[0]}`);
  if (amounts.some(([, amount]) => amount !== quotedAtomic)) return failed('payment_info.amount', 'bitrefill_invoice_price_changed');
  // A payment URI, where it can be read, must ask the same: USDC on Base, to the same address, the same amount.
  const uri = spendPaymentUriV1(payment.paymentUri);
  if (uri && (uri.token !== USDC_BASE_V1 || (uri.chainId !== null && uri.chainId !== 8453) || uri.to !== payTo)) return failed('payment_info.paymentUri');
  if (uri && uri.amount !== quotedAtomic) return failed('payment_info.paymentUri', 'bitrefill_invoice_price_changed');
  // The invoice must say Base itself: Base's USDC contract, or a payment URI on chain 8453. An address and
  // an amount alone fit any network's USDC, and a transfer on the wrong one is never credited.
  if (payment.contractAddress === undefined && !(uri && uri.chainId === 8453)) return failed('payment_info.network');
  const minutes = invoice.expiration_minutes;
  if (minutes !== undefined && (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0)) return failed('expiration_minutes');
  const lifetime = Math.min(SPEND_PRICE_LOCK_MS_V1, minutes === undefined ? SPEND_PRICE_LOCK_MS_V1 : minutes * 60_000);
  return {
    ok: true,
    value: {
      invoiceId: invoice.invoice_id.toLowerCase(),
      accessToken: invoice.invoice_access_token,
      payTo: payTo as `0x${string}`,
      amountAtomic: quotedAtomic,
      expiresAt: new Date(now.getTime() + lifetime).toISOString(),
      paymentLink: httpsLinkV1(invoice.payment_link),
    },
  };
}

/** Reads one get-invoice-by-id answer, JSON or TOON. Exported for its tests. */
export function spendInvoiceStatusFromAnswerV1(text: string): SpendCheckoutResultV1<SpendInvoiceStatusV1> {
  let answer: unknown;
  try {
    answer = text.trimStart().startsWith('{') ? JSON.parse(text) : decodeToonV1(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ToonParseError) return { ok: false, reason: 'bitrefill_invalid_response' };
    throw error;
  }
  const invoice = object(answer) ? object(answer.response) ? answer.response : answer : null;
  const status = invoice?.invoice_status;
  if (!invoice || typeof status !== 'string' || !(SPEND_INVOICE_STATUSES_V1 as readonly string[]).includes(status)) {
    return { ok: false, reason: 'bitrefill_invalid_response', shape: spendShapeV1(answer) };
  }
  const orders = Array.isArray(invoice.orders) ? invoice.orders.filter(object) : [];
  return {
    ok: true,
    value: {
      status: status as SpendInvoiceStatusNameV1,
      accessLink: httpsLinkV1(invoice.access_link),
      esimInstallLink: orders.map((order) => httpsLinkV1(order.esim_install_link)).find((link) => link !== null) ?? null,
    },
  };
}

export function createBitrefillGuestCheckoutV1(options: BitrefillGuestOptionsV1 = {}): BitrefillGuestCheckoutV1 {
  // The same ten slots, including OAuth: display polling cannot spend the four
  // kept for opening invoices and checking them immediately before payment.
  // Of the ten, reviews and display reads never take the last two: those are kept for opening an invoice
  // and for the read before a loan's next step (audit SPEND-2, 2026-11-14).
  const transport = createBitrefillGuestTransportV1(BITREFILL_CHECKOUT_TOOLS_V1, { perMinute: 10, normalPerMinute: 6, priorityPerMinute: 8, ...options });
  return {
    // The transport has refused a code that breaks Bitrefill's rule by now, so a code here is one it sends.
    affiliated: options.affiliateCode !== undefined,
    async createInvoice(input) {
      // An address the review could not show is never sent (audit SPEND-1).
      if (!SPEND_EMAIL_V1.test(input.email) || !SPEND_DELIVERY_EMAIL_V1.test(input.email) || input.email.length > 254 || input.quotedAtomic <= 0n) return { ok: false, reason: 'bitrefill_refused' };
      if (input.refillInput !== undefined && !/^\d{7,15}$/.test(input.refillInput)) return { ok: false, reason: 'bitrefill_refused' };
      const answer = await transport.callTool('buy-products', {
        cart_items: [{ product_id: input.productId, package_value: input.packageValue, ...(input.refillInput !== undefined ? { refill_input: input.refillInput } : {}) }],
        payment_method: 'usdc_base',
        return_payment_link: false,
        email: input.email,
      }, { reserved: true });
      if (!answer.ok) return answer;
      let json: unknown;
      // buy-products "returns plain JSON so payment details can be parsed exactly".
      try { json = JSON.parse(answer.value); } catch { return { ok: false, reason: 'bitrefill_invalid_response', shape: 'text' }; }
      return spendInvoiceFromAnswerV1(json, input.quotedAtomic, input.now);
    },
    async readInvoice(input, readOptions) {
      if (!UUID_V1.test(input.invoiceId) || !TOKEN_V1.test(input.accessToken)) return { ok: false, reason: 'bitrefill_refused' };
      const answer = await transport.callTool('get-invoice-by-id', { invoice_id: input.invoiceId, invoice_access_token: input.accessToken },
        readOptions?.purpose === 'step' ? { reserved: true } : { priority: readOptions?.purpose !== 'display' });
      if (!answer.ok) return answer;
      return spendInvoiceStatusFromAnswerV1(answer.value);
    },
  };
}
