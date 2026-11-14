import { spendDeliveryWireV1, type SpendDeliveryWireV1 } from '../console/lendingReviewView';

// Still Spend, stage 1: what a loan could pay for, in the page's words.
//
// The catalogue is Bitrefill's, read by Still's server as a guest; every price
// is the one Bitrefill quoted in USDC. Whether a price fits is said against the
// reader's own Still room, from the Mirror report, and only when that is known:
// a partial room says "within" or nothing, never "over". Beside it, whether the
// USDC already in the wallet covers the price, which pays it with no loan.

export type SpendTypeV1 = 'esim' | 'refill' | 'giftcard';

export const SPEND_TYPES_V1: ReadonlyArray<{ type: SpendTypeV1; label: string; blurb: string }> = [
  { type: 'esim', label: 'Mobile data', blurb: 'An eSIM data plan for a trip' },
  { type: 'refill', label: 'Phone top-up', blurb: 'Credit for a mobile number' },
  { type: 'giftcard', label: 'Gift cards', blurb: 'Games, streaming, AI, shops and travel' },
];

/** Gift cards by Bitrefill's own categories; the server sends the value as it is and refuses any other.
 * The operator asked on 2026-11-14 about games and subscriptions: Bitrefill sells them as gift cards, but
 * only a brand typed in found one. Payment cards are not offered: Bitrefill sells prepaid Visa and
 * Mastercard only after steps Still's guest client is not offered. */
export type SpendGiftCategoryV1 = 'games' | 'entertainment' | 'ai' | 'online-marketplaces' | 'food' | 'travel';

export const SPEND_GIFT_CATEGORY_CHIPS_V1: ReadonlyArray<{ category: SpendGiftCategoryV1; label: string }> = [
  { category: 'games', label: 'Games' },
  { category: 'entertainment', label: 'Entertainment' },
  { category: 'ai', label: 'AI' },
  { category: 'online-marketplaces', label: 'Marketplaces' },
  { category: 'food', label: 'Food & groceries' },
  { category: 'travel', label: 'Travel' },
];

/** Where the product is used: every inhabited country, and Bitrefill says what
 * it has for each, nothing included. Cuba, Iran, North Korea and Syria are left
 * out, as embargoed. */
export const SPEND_COUNTRIES_V1 = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH',
  'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL',
  'CM', 'CN', 'CO', 'CR', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
  'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GT', 'GU',
  'GW', 'GY', 'HK', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IQ', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH',
  'KI', 'KM', 'KN', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME',
  'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE',
  'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT',
  'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO',
  'SR', 'SS', 'ST', 'SV', 'SX', 'SZ', 'TC', 'TD', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA',
  'UG', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;

/** The reader's own country when the browser says it and the page offers it, else Germany. */
export function spendCountryDefaultV1(language: string | undefined): string {
  const region = /[-_]([A-Za-z]{2})\b/.exec(language ?? '')?.[1]?.toUpperCase();
  return region && (SPEND_COUNTRIES_V1 as readonly string[]).includes(region) ? region : 'DE';
}

export function spendCountryNameV1(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

let countryOptionsV1: ReadonlyArray<{ code: string; name: string }> | null = null;
/** The page's countries by their English names, A to Z: a list this long is read by name, not by code. */
export function spendCountryOptionsV1(): ReadonlyArray<{ code: string; name: string }> {
  return countryOptionsV1 ??= SPEND_COUNTRIES_V1.map((code) => ({ code, name: spendCountryNameV1(code) })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** What a top-up's number must start with, as the server said for its country. */
export interface SpendPhoneRuleV1 { callingCode: string; prefixes: readonly string[] }

/** The number as Still sends it, "+919876543210", when it starts with one of
 * the country's prefixes; else null. The server checks it again against the
 * operator's own country before Bitrefill sees it. */
export function spendPhoneDraftV1(raw: string, rule: SpendPhoneRuleV1): string | null {
  let digits = raw.trim().replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  return /^\d{7,15}$/.test(digits) && rule.prefixes.some((prefix) => digits.startsWith(prefix)) && digits.length - rule.callingCode.length >= 4 ? `+${digits}` : null;
}

/** "+7 6 or +7 7", "+1 809, +1 829 or +1 849": how a country's own numbers begin. */
export function spendPhonePrefixesTextV1(rule: SpendPhoneRuleV1): string {
  const labels = rule.prefixes.map((prefix) => `+${rule.callingCode}${prefix.length > rule.callingCode.length ? ` ${prefix.slice(rule.callingCode.length)}` : ''}`);
  return labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const SLUG = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const PRICE = /^(0|[1-9]\d{0,9})(?:\.(\d{1,6}))?$/;

export interface SpendProductRowV1 {
  id: string;
  name: string;
  /** "34 countries" for a regional eSIM; null for one country. */
  coverage: string | null;
}

/** Whether this server pays Bitrefill from a loan now (STILL_SPEND_PAY_V1). Unread is not on. */
export function spendPayOpenV1(payload: unknown): boolean {
  return object(payload) && object(payload.checkout) && payload.checkout.enabled === true;
}

/** The server's search answer, or null and why it cannot be shown. */
export function spendSearchViewV1(payload: unknown): { products: SpendProductRowV1[] | null; error: string | null } {
  const failed = { products: null, error: 'Bitrefill’s catalogue could not be read just now. Try again in a minute.' };
  if (!object(payload) || payload.outcome !== 'products' || !Array.isArray(payload.products)) return failed;
  const products: SpendProductRowV1[] = [];
  for (const row of payload.products) {
    if (!object(row) || !text(row.id, 100) || !SLUG.test(row.id) || !text(row.name, 120) || row.inStock === false) continue;
    const countries = Array.isArray(row.countries) ? row.countries.filter((code) => typeof code === 'string').length : 0;
    products.push({ id: row.id, name: row.name, coverage: countries > 1 ? `${countries} countries` : null });
  }
  return { products, error: null };
}

export interface SpendPackageRowV1 {
  /** Bitrefill's own package_value, what an invoice is opened for. */
  value: string;
  /** "10GB, 30 Days", or "50 EUR" for a face value. */
  label: string;
  /** "13.25 USDC" */
  price: string;
  /** Against the reader's Still room: within it, more than it, or not said. */
  room: 'within' | 'over' | null;
  /** How much of a fully read room the price takes, 0 to 1; null when the room is partial or unknown. */
  share: number | null;
  /** It can be paid from Still now: the server pays this product, and the price is under its cap. */
  payable: boolean;
  /** The USDC already in the wallet covers it, so it can be paid with no loan; null when that USDC was not read. */
  wallet: boolean | null;
}

export interface SpendProductViewV1 {
  id: string;
  name: string;
  packages: SpendPackageRowV1[];
  /** Said when buying would need something Still does not ask for, such as an account. */
  needs: string | null;
  /** A top-up paid from Still asks for the number, starting with one of these prefixes; null for anything else. */
  phone: SpendPhoneRuleV1 | null;
  /** The most one purchase may cost when paid from Still, "100 USDC"; null when it cannot be paid here. */
  cap: string | null;
}

/** USDC cents a price takes, rounded up: a price is never said to fit when it might not. */
function priceCentsV1(price: string): bigint | null {
  const match = PRICE.exec(price);
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(6, '0');
  const micros = BigInt(match[1]!) * 1_000_000n + BigInt(fraction);
  return (micros + 9_999n) / 10_000n;
}

export function spendProductViewV1(payload: unknown, room: { cents: string; complete: boolean } | null, walletAtomic: string | null = null): { product: SpendProductViewV1 | null; error: string | null } {
  const failed = { product: null, error: 'This product could not be read from Bitrefill just now.' };
  if (!object(payload) || payload.outcome !== 'product' || !object(payload.product)) return failed;
  const product = payload.product;
  if (!text(product.id, 100) || !SLUG.test(product.id) || !text(product.name, 120) || !Array.isArray(product.packages)) return failed;
  const roomCents = room && /^\d{1,15}$/.test(room.cents) ? BigInt(room.cents) : null;
  const checkout = object(payload.checkout) ? payload.checkout : null;
  const capAtomic = checkout?.available === true && typeof checkout.capAtomic === 'string' && /^[1-9]\d{0,15}$/.test(checkout.capAtomic) ? BigInt(checkout.capAtomic) : null;
  const recipient = typeof product.recipientType === 'string' ? product.recipientType : '';
  const topUp = /phone/i.test(recipient);
  const offered = topUp && capAtomic !== null && checkout && object(checkout.phone) ? checkout.phone : null;
  const code = offered && typeof offered.callingCode === 'string' && /^[1-9]\d{0,3}$/.test(offered.callingCode) ? offered.callingCode : null;
  // A country that shares its calling code names its own prefixes; without them, the code is the prefix.
  const listed = code && Array.isArray(offered!.prefixes) && offered!.prefixes.length > 0 && offered!.prefixes.length <= 8 &&
    offered!.prefixes.every((prefix) => typeof prefix === 'string' && /^[1-9]\d{0,5}$/.test(prefix) && prefix.startsWith(code)) ? offered!.prefixes as string[] : null;
  const prefixes = code === null ? null : offered!.prefixes === undefined ? [code] : listed;
  const phone = code && prefixes ? { callingCode: code, prefixes } : null;
  const packages: SpendPackageRowV1[] = [];
  for (const row of product.packages) {
    if (!object(row) || !text(row.value, 80) || typeof row.priceUsdc !== 'string') continue;
    const cents = priceCentsV1(row.priceUsdc);
    if (cents === null) continue;
    const face = typeof row.faceCurrency === 'string' && /^[A-Z]{3}$/.test(row.faceCurrency) && /^\d+(?:\.\d+)?$/.test(row.value) ? ` ${row.faceCurrency}` : '';
    const fits = roomCents === null ? null : cents <= roomCents ? 'within' as const : room!.complete ? 'over' as const : null;
    // A share of a partial room would overstate it, so the bar is drawn only against a whole one.
    const share = roomCents === null || !room!.complete || roomCents === 0n ? null : cents >= roomCents ? 1 : Number(cents) / Number(roomCents);
    // A top-up is paid only with the number it goes to.
    const payable = capAtomic !== null && cents * 10_000n <= capAtomic && (!topUp || phone !== null);
    packages.push({ value: row.value, label: `${row.value}${face}`, price: `${row.priceUsdc} USDC`, room: fits, share, payable, wallet: spendWalletCoversV1(walletAtomic, row.priceUsdc) });
  }
  const needs = product.prepayment === true ? 'Bitrefill sells this only after steps such as the player’s game ID, which it does not offer to Still, so it cannot be paid from Still.'
    : topUp ? phone ? null : 'Buying it needs the phone number to top up.'
    : /mixed|account|email|user/i.test(recipient) && !/esim/i.test(product.id) ? 'Buying it may need an account, an email or a number for the recipient.'
      : null;
  const cap = capAtomic === null ? null : `${(capAtomic / 1_000_000n).toString()} USDC`;
  return { product: { id: product.id, name: product.name, packages, needs, phone, cap }, error: null };
}

/** An invoice the reader opened, as their page shows it. */
export interface SpendOrderViewV1 {
  orderId: string;
  productName: string;
  packageValue: string;
  /** "10GB, 30 Days", or "10 INR" for a face value. */
  packageLabel: string;
  /** "13.25", decimal USDC */
  priceUsdc: string;
  priceAtomic: string;
  expiresAt: string;
  /** Bitrefill's page for the order; it carries the buyer's access, so only its owner sees it. */
  orderLink: string | null;
  /** Bitrefill's state, in words; null when it was not read. */
  status: string | null;
  delivered: boolean;
  esimInstallLink: string | null;
  /** The number a top-up goes to, "+919876543210"; null for anything else. */
  refillTo: string | null;
  /** The server opened it with Still's affiliate code at Bitrefill; its review says so (STILL_SPEND_COMMISSION_NOTE_V1). */
  commission: boolean;
}

/** One line on a purchase's review, shown only for an invoice the server opened with Still's affiliate code.
 * Bitrefill's partner guide: an affiliate code changes who receives a commission, a coupon changes the
 * price; a commission counts only for a delivered order, and some products earn none. */
export const STILL_SPEND_COMMISSION_NOTE_V1 = 'Still is a Bitrefill affiliate: Bitrefill may pay Still a commission on this purchase. It does not change your price.';

/** Said instead of a sign button when the page cannot show where Bitrefill sends a purchase (audit SPEND-1). */
export const SPEND_DELIVERY_UNSHOWN_V1 = 'Still cannot show where Bitrefill would send this purchase, so it is not offered for signing. Nothing was sent; open a new invoice from Spend.';

const STATUS_WORDS_V1: Record<string, string> = {
  unpaid: 'Waiting for payment', payment_detected: 'Payment seen, waiting for confirmation', payment_confirmed: 'Payment confirmed',
  pending: 'Bitrefill is preparing it', complete: 'Delivered', blocked: 'Blocked by Bitrefill', denied: 'Payment denied by Bitrefill',
  payment_error: 'Bitrefill reports a payment error',
};
const link = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'bitrefill.com' || url.hostname.endsWith('.bitrefill.com')) ? url.toString() : null;
  } catch {
    return null;
  }
};

export function spendOrderViewV1(payload: unknown): SpendOrderViewV1 | null {
  if (!object(payload) || !object(payload.order)) return null;
  const order = payload.order, status = object(payload.status) ? payload.status : null;
  if (typeof order.orderId !== 'string' || !/^[0-9a-f-]{36}$/.test(order.orderId) || !text(order.productName, 120) || !text(order.packageValue, 80) ||
      typeof order.priceAtomic !== 'string' || !/^[1-9]\d{0,15}$/.test(order.priceAtomic) || typeof order.expiresAt !== 'string' || !Number.isFinite(Date.parse(order.expiresAt))) return null;
  const atomic = BigInt(order.priceAtomic), micro = (atomic % 1_000_000n).toString().padStart(6, '0'), trimmed = micro.replace(/0+$/, '');
  const state = typeof status?.status === 'string' && STATUS_WORDS_V1[status.status] ? status.status : null;
  const face = typeof order.faceCurrency === 'string' && /^[A-Z]{3}$/.test(order.faceCurrency) && /^\d+(?:\.\d+)?$/.test(order.packageValue) ? ` ${order.faceCurrency}` : '';
  return {
    orderId: order.orderId, productName: order.productName, packageValue: order.packageValue, packageLabel: `${order.packageValue}${face}`,
    priceUsdc: `${(atomic / 1_000_000n).toString()}.${trimmed.length <= 2 ? micro.slice(0, 2) : trimmed}`, priceAtomic: order.priceAtomic, expiresAt: order.expiresAt,
    orderLink: link(status?.accessLink) ?? link(order.paymentLink),
    status: state ? STATUS_WORDS_V1[state]! : null, delivered: state === 'complete', esimInstallLink: link(status?.esimInstallLink),
    refillTo: typeof order.refillTo === 'string' && /^\+\d{7,15}$/.test(order.refillTo) ? order.refillTo : null,
    commission: order.commission === true,
  };
}

/** What a refused invoice means to the reader, by the server's own code. */
export function spendOrderErrorV1(message: string): string {
  const code = message.split(':')[0]!.trim();
  switch (code) {
    case 'spend_pay_off': return 'Paying from Still is not switched on yet.';
    case 'spend_over_cap': return 'One purchase paid from Still can cost at most 100 USDC.';
    case 'spend_product_prepayment': return 'Bitrefill sells this only after steps such as the player’s game ID, which it does not offer to Still, so Still cannot pay for it. Nothing was opened.';
    case 'spend_product_not_buyable': return 'This product needs details Still does not send, such as an account or a username.';
    case 'spend_phone_needed': return 'Write the phone number to top up.';
    case 'spend_phone_invalid': return 'Check the phone number: write it with the country code of the operator’s country, as the field shows.';
    case 'spend_package_not_offered': return 'Bitrefill no longer offers this package at this price. Read the product again.';
    case 'bitrefill_invoice_price_changed': return 'Bitrefill’s invoice asked a different price than it quoted a moment before. Nothing was opened to pay; read the product again.';
    case 'bitrefill_guest_refused': return 'Bitrefill is not letting Still in right now, so Spend cannot open an invoice for any product. Nothing was paid.';
    case 'spend_rate_limited': return 'Still opens at most six invoices an hour for one wallet, and you have opened six. Try again later; nothing was opened.';
    case 'spend_attempts_limited': return 'Still asks Bitrefill for at most three invoices a minute and twelve an hour for one wallet, counting the ones that could not be opened, and this wallet has asked for that many. Try again in a few minutes; nothing was opened.';
    case 'spend_request_invalid': return 'Check the email address: Bitrefill sends the receipt there.';
    case 'region_restricted':
    case 'region_unchecked': {
      // Still is not offered in the United States or to US persons: the server's own sentence (2026-11-10).
      const detail = message.includes(': ') ? message.slice(message.indexOf(': ') + 2).trim() : '';
      return detail || 'Still does not open a purchase from where you are connecting. Nothing was opened.';
    }
    case 'bitrefill_refused': {
      // Bitrefill's own words, as the server cleaned them.
      const detail = message.includes(':') ? message.slice(message.indexOf(':') + 1).trim() : '';
      return detail ? `Bitrefill refused this invoice and said: “${detail}” Nothing was paid.` : 'Bitrefill refused this invoice. Nothing was paid.';
    }
    default: return 'Bitrefill’s invoice could not be opened just now. Nothing was paid. Try again in a minute.';
  }
}

/** A purchase's (ss1) or a loan's (sl1) card link as the server issued it, /spend/p/<token>, or null. */
export function spendSharePathV1(value: unknown): string | null {
  return typeof value === 'string' && /^\/spend\/p\/s[sl]1\.[A-Za-z0-9_-]{1,1100}\.[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export interface SpendShareViewV1 {
  productName: string;
  packageLabel: string;
  priceUsdc: string;
  collateralLabel: string;
  collateralName: string;
  venueName: 'Aave' | 'Morpho';
}

// ---------------------------------------------------------------------------
// While the wallet has the payment (audit SPEND-6, 2026-11-10).
//
// A review is checked against the invoice's time once, when it is armed. The
// transfer itself carries no deadline: a request left open in a wallet and
// confirmed ten minutes later pays an invoice Bitrefill has let expire, and
// with a loan the debt is taken all the same. So while the wallet has it, the
// page says by when to confirm, and counts the minutes; once the time has
// passed it says to decline; and a payment sent that Bitrefill still does not
// show after its invoice expired is sent to Bitrefill's support, with the
// invoice's id.
// ---------------------------------------------------------------------------
const clockV1 = (at: Date): string => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

/** What to say while the wallet is asked; null when the invoice's time is not readable. */
export function spendConfirmByNoteV1(input: { expiresAt: string; orderId: string; now: Date; withLoan?: boolean }): string | null {
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(expires)) return null;
  const until = clockV1(new Date(expires)), left = Math.floor((expires - input.now.getTime()) / 60_000);
  const late = `Bitrefill may not deliver, and getting the money back goes through Bitrefill’s support, with invoice ${input.orderId}`;
  if (expires <= input.now.getTime()) {
    return `Bitrefill’s invoice expired at ${until}. Decline this request in your wallet: confirmed now, ${input.withLoan ? 'the loan is taken and its payment arrives' : 'the payment arrives'} after the invoice expired. ${late}.`;
  }
  return `Confirm in your wallet before ${until}, ${left < 1 ? 'in less than a minute' : `within ${left} ${left === 1 ? 'minute' : 'minutes'}`}: that is when Bitrefill’s invoice expires. `
    + `Confirmed later, ${input.withLoan ? 'the loan is still taken and its payment still goes' : 'the payment still goes'} out; then ${late}.`;
}

/** A payment that was sent, for an invoice that expired and that Bitrefill still shows as unpaid, or does
 * not show at all; null for anything else. `status` is the order's words, as the page shows them. */
export function spendLatePaymentNoteV1(input: { expiresAt: string; orderId: string; now: Date; paymentState: string; status: string | null; delivered: boolean }): string | null {
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(expires) || input.now.getTime() <= expires || input.delivered) return null;
  if (!['submitted', 'unknown', 'confirmed'].includes(input.paymentState)) return null;
  if (input.status !== null && input.status !== STATUS_WORDS_V1.unpaid) return null;
  return `Bitrefill’s invoice expired at ${clockV1(new Date(expires))}, and Bitrefill ${input.status === null ? 'has not said it was paid' : 'still shows it waiting for payment'}. `
    + `If your transfer went out, it may have arrived too late. Write to Bitrefill’s support and give them invoice ${input.orderId}: Still cannot take a payment back.`;
}

/** A shared card's amount as a sentence says it: "about 13 USDC". The server rounds it to the dollar (audit
 * SPEND-4: an exact amount names the payment onchain), and the words say that it is rounded. */
export function shareAmountWordsV1(usdc: string): string {
  const [whole = '0', fraction = ''] = usdc.split('.');
  const dollars = Number(whole) + (Number(`0.${fraction || '0'}`) >= 0.5 ? 1 : 0);
  return `about ${Math.max(1, dollars)} USDC`;
}

/** What a person is told before they post a card: its amount is rounded, and Base is public all the same. */
export const SHARE_CARD_PRIVACY_NOTE_V1 = 'The card names no wallet and no transaction, and rounds the amount to the dollar. Base is public all the same: someone who looks for a loan of about this size against this collateral may find it.';

/** A shared purchase as the server verified its link; null when it did not. */
export function spendShareViewV1(payload: unknown): SpendShareViewV1 | null {
  if (!object(payload) || payload.outcome !== 'share' || !object(payload.share)) return null;
  const s = payload.share;
  if (!text(s.productName, 120) || !text(s.packageLabel, 84) || typeof s.priceUsdc !== 'string' || !/^\d{1,7}\.\d{2,6}$/.test(s.priceUsdc) ||
      !text(s.collateralLabel, 12) || !text(s.collateralName, 40) || (s.venueName !== 'Aave' && s.venueName !== 'Morpho')) return null;
  return { productName: s.productName, packageLabel: s.packageLabel, priceUsdc: s.priceUsdc, collateralLabel: s.collateralLabel,
    collateralName: s.collateralName, venueName: s.venueName };
}

/** A shared loan as the server verified its link: how much, against what, through which protocol. */
export interface LoanShareViewV1 {
  borrowedUsdc: string;
  collateralLabel: string;
  collateralName: string;
  venueName: 'Aave' | 'Morpho';
}

/** A shared loan as the server verified its link; null for a purchase, or when it did not verify. */
export function loanShareViewV1(payload: unknown): LoanShareViewV1 | null {
  if (!object(payload) || payload.outcome !== 'share' || !object(payload.share) || payload.share.kind !== 'loan') return null;
  const s = payload.share;
  if (typeof s.borrowedUsdc !== 'string' || !/^\d{1,7}\.\d{2,6}$/.test(s.borrowedUsdc) || !text(s.collateralLabel, 12) || !text(s.collateralName, 40) ||
      (s.venueName !== 'Aave' && s.venueName !== 'Morpho')) return null;
  return { borrowedUsdc: s.borrowedUsdc, collateralLabel: s.collateralLabel, collateralName: s.collateralName, venueName: s.venueName };
}

/** What a post says beside a loan's card. */
export function loanShareTextV1(input: { collateralSymbol: string }): string {
  const collateral = /^[A-Z]{1,6}c$/.test(input.collateralSymbol) ? input.collateralSymbol.slice(0, -1) : input.collateralSymbol;
  return `Spent without selling: a USDC loan against my ${collateral}, which I keep. On Base, through Still.`;
}

/** What a post says beside its card; the card says the rest. A stock token
 * (NVDAc) is named by its ticker, as the card names it. */
export function spendShareTextV1(input: { productName: string; collateralSymbol: string }): string {
  const collateral = /^[A-Z]{1,6}c$/.test(input.collateralSymbol) ? input.collateralSymbol.slice(0, -1) : input.collateralSymbol;
  return `Paid for ${input.productName} with a USDC loan against my ${collateral}, without selling it. On Base, through Still.`;
}

/** USDC base units in words, "2.12 USDC": two decimals at least, every non-zero one after them. */
export function spendUsdcTextV1(atomic: string): string | null {
  if (!/^(0|[1-9]\d{0,20})$/.test(atomic)) return null;
  const units = BigInt(atomic), micro = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${(units / 1_000_000n).toString()}.${micro.padEnd(2, '0')} USDC`;
}

/** Whether the wallet's own USDC covers a price exactly; null when either was not read. */
export function spendWalletCoversV1(walletAtomic: string | null, price: string): boolean | null {
  const match = PRICE.exec(price);
  if (walletAtomic === null || !/^(0|[1-9]\d{0,20})$/.test(walletAtomic) || !match) return null;
  return BigInt(walletAtomic) >= BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

/** What Spend's room card says beside the room: what is owed already, and
 * the USDC already in the wallet. The operator asked on 2026-11-03 why Spend
 * offered $0.20 right after a loan paid them 2 USDC: the room is what Still
 * can lend on top of the debt, and the wallet's USDC was not said at all. */
export function spendOwedCentsV1(report: { venues: ReadonlyArray<{ debtCents: string | null }> } | null | undefined): string | null {
  if (!report || report.venues.length === 0 || report.venues.some((venue) => venue.debtCents === null || !/^\d{1,15}$/.test(venue.debtCents))) return null;
  const owed = report.venues.reduce((sum, venue) => sum + BigInt(venue.debtCents!), 0n);
  return owed > 0n ? owed.toString() : null;
}

export type SpendWalletStateV1 = 'ready' | 'awaiting_wallet' | 'submitted' | 'unknown' | 'confirmed' | 'failed' | 'refused';
/** A Spend payment from the wallet's own USDC, as the server answered for it. */
export interface SpendWalletViewV1 {
  orderId: string;
  state: SpendWalletStateV1;
  refusal: string | null;
  /** The server's own sentence for a refusal. */
  detail: string | null;
  /** "2.00 USDC" */
  price: string | null;
  productName: string | null;
  packageLabel: string | null;
  /** The invoice address, shortened: "0x3333…3333". */
  payTo: string | null;
  /** The wallet's USDC before and after this payment, at `block`. */
  before: string | null;
  after: string | null;
  block: number | null;
  warnings: string[];
  expiresAt: string | null;
  transactionHash: string | null;
  /** The armed attempt, and the batch id the wallet answered with: a page gives a lost answer again only for its own attempt. */
  attemptId: string | null;
  batchId: string | null;
  /** Why a result is not known yet, in the server's code: a pasted hash that is not this payment says so. */
  errorCode: string | null;
  /** Only while it can be armed: what the wallet is asked to send, exactly as the server prepared it. */
  ready: null | { calls: Array<{ to: string; value: string; data: string }>; callsHash: string; signingTermsHash: string };
  /** Where Bitrefill sends what is bought, as the open invoice holds it; null once Still no longer holds the order. */
  deliverTo: SpendDeliveryWireV1 | null;
}

const STATES_V1: readonly SpendWalletStateV1[] = ['ready', 'awaiting_wallet', 'submitted', 'unknown', 'confirmed', 'failed', 'refused'];
const HASH_V1 = /^0x[0-9a-f]{64}$/;

export function spendWalletViewV1(payload: unknown): SpendWalletViewV1 | null {
  if (!object(payload) || typeof payload.orderId !== 'string' || !/^[0-9a-f-]{36}$/.test(payload.orderId) ||
      typeof payload.state !== 'string' || !(STATES_V1 as readonly string[]).includes(payload.state)) return null;
  const state = payload.state as SpendWalletStateV1;
  if (state === 'refused') {
    return { orderId: payload.orderId, state, refusal: typeof payload.refusal === 'string' ? payload.refusal : null,
      detail: text(payload.detail, 400) ? payload.detail : 'Still could not prepare this payment. Nothing was sent.',
      price: null, productName: null, packageLabel: null, payTo: null, before: null, after: null, block: null, warnings: [], expiresAt: null, transactionHash: null,
      attemptId: null, batchId: null, errorCode: null, ready: null, deliverTo: null };
  }
  const facts = object(payload.facts) ? payload.facts : null, payment = facts && object(facts.payment) ? facts.payment : null;
  if (!facts || !payment || payment.orderId !== payload.orderId || typeof payment.payTo !== 'string' || !/^0x[0-9a-f]{40}$/.test(payment.payTo) ||
      typeof payment.assets !== 'string' || !text(payment.productName, 120) || !text(payment.packageValue, 80)) return null;
  const price = spendUsdcTextV1(payment.assets), before = typeof facts.usdcBeforeAtomic === 'string' ? spendUsdcTextV1(facts.usdcBeforeAtomic) : null;
  const after = typeof facts.usdcAfterAtomic === 'string' ? spendUsdcTextV1(facts.usdcAfterAtomic) : null;
  if (!price) return null;
  const face = typeof payment.faceCurrency === 'string' && /^[A-Z]{3}$/.test(payment.faceCurrency) && /^\d+(?:\.\d+)?$/.test(payment.packageValue) ? ` ${payment.faceCurrency}` : '';
  const calls = Array.isArray(payload.calls) && payload.calls.length === 1 && payload.calls.every((call) => object(call) && typeof call.to === 'string' && /^0x[0-9a-f]{40}$/.test(call.to) &&
    typeof call.value === 'string' && /^\d{1,78}$/.test(call.value) && typeof call.data === 'string' && /^0x[0-9a-f]*$/.test(call.data))
    ? (payload.calls as Array<{ to: string; value: string; data: string }>).map((call) => ({ to: call.to, value: call.value, data: call.data })) : null;
  const ready = state === 'ready' && calls && typeof payload.callsHash === 'string' && HASH_V1.test(payload.callsHash) &&
    typeof payload.signingTermsHash === 'string' && HASH_V1.test(payload.signingTermsHash)
    ? { calls, callsHash: payload.callsHash, signingTermsHash: payload.signingTermsHash } : null;
  if (state === 'ready' && !ready) return null;
  return {
    orderId: payload.orderId, state, refusal: null, detail: null, price, productName: payment.productName, packageLabel: `${payment.packageValue}${face}`,
    payTo: `${payment.payTo.slice(0, 6)}…${payment.payTo.slice(-4)}`, before, after,
    block: typeof facts.blockNumber === 'number' && Number.isSafeInteger(facts.blockNumber) ? facts.blockNumber : null,
    warnings: Array.isArray(facts.warnings) ? facts.warnings.filter((line): line is string => text(line, 600)).slice(0, 4) : [],
    expiresAt: typeof payload.expiresAt === 'string' && Number.isFinite(Date.parse(payload.expiresAt)) ? payload.expiresAt : null,
    transactionHash: typeof payload.transactionHash === 'string' && HASH_V1.test(payload.transactionHash) ? payload.transactionHash : null,
    attemptId: typeof payload.attemptId === 'string' && /^[0-9a-f-]{36}$/.test(payload.attemptId) ? payload.attemptId : null,
    batchId: typeof payload.batchId === 'string' && payload.batchId.length > 0 && payload.batchId.length <= 2000 ? payload.batchId : null,
    errorCode: typeof payload.errorCode === 'string' && /^[a-z0-9_]{1,80}$/.test(payload.errorCode) ? payload.errorCode : null,
    ready,
    deliverTo: spendDeliveryWireV1(payload.deliverTo),
  };
}
