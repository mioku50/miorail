// Still Spend, stage 1: what a loan could pay for, in the page's words.
//
// The catalogue is Bitrefill's, read by Still's server as a guest; every price
// is the one Bitrefill quoted in USDC. Whether a price fits is said against the
// reader's own Still room, from the Mirror report, and only when that is known:
// a partial room says "within" or nothing, never "over".

export type SpendTypeV1 = 'esim' | 'refill' | 'giftcard';

export const SPEND_TYPES_V1: ReadonlyArray<{ type: SpendTypeV1; label: string; blurb: string }> = [
  { type: 'esim', label: 'Mobile data', blurb: 'An eSIM data plan for a trip' },
  { type: 'refill', label: 'Phone top-up', blurb: 'Credit for a mobile number' },
  { type: 'giftcard', label: 'Gift cards', blurb: 'Shops, travel, food and games' },
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

export function spendProductViewV1(payload: unknown, room: { cents: string; complete: boolean } | null): { product: SpendProductViewV1 | null; error: string | null } {
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
    packages.push({ value: row.value, label: `${row.value}${face}`, price: `${row.priceUsdc} USDC`, room: fits, share, payable });
  }
  const needs = topUp ? phone ? null : 'Buying it needs the phone number to top up.'
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
}

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
  };
}

/** What a refused invoice means to the reader, by the server's own code. */
export function spendOrderErrorV1(message: string): string {
  const code = message.split(':')[0]!.trim();
  switch (code) {
    case 'spend_pay_off': return 'Paying from Still is not switched on yet.';
    case 'spend_over_cap': return 'One purchase paid from Still can cost at most 100 USDC.';
    case 'spend_product_not_buyable': return 'This product needs details Still does not send, such as an account or a username.';
    case 'spend_phone_needed': return 'Write the phone number to top up.';
    case 'spend_phone_invalid': return 'Check the phone number: write it with the country code of the operator’s country, as the field shows.';
    case 'spend_package_not_offered': return 'Bitrefill no longer offers this package at this price. Read the product again.';
    case 'bitrefill_invoice_price_changed': return 'Bitrefill’s invoice asked a different price than it quoted a moment before. Nothing was opened to pay; read the product again.';
    case 'spend_rate_limited': return 'You opened several invoices this hour. Try again later.';
    case 'spend_request_invalid': return 'Check the email address: Bitrefill sends the receipt there.';
    default: return 'Bitrefill’s invoice could not be opened just now. Nothing was paid. Try again in a minute.';
  }
}
