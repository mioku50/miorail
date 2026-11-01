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

/** Countries the page offers; Bitrefill serves more, and search narrows by brand. */
export const SPEND_COUNTRIES_V1 = [
  'AE', 'AR', 'AT', 'AU', 'BE', 'BR', 'CA', 'CH', 'CL', 'CO', 'CZ', 'DE', 'DK', 'ES', 'FI', 'FR', 'GB', 'GR', 'HK', 'HU', 'ID', 'IE',
  'IL', 'IN', 'IT', 'JP', 'KR', 'MX', 'MY', 'NG', 'NL', 'NO', 'NZ', 'PH', 'PL', 'PT', 'RO', 'SA', 'SE', 'SG', 'TH', 'TR', 'UA', 'US',
  'VN', 'ZA',
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
  /** "10GB, 30 Days", or "50 EUR" for a face value. */
  label: string;
  /** "13.25 USDC" */
  price: string;
  /** Against the reader's Still room: within it, more than it, or not said. */
  room: 'within' | 'over' | null;
  /** How much of a fully read room the price takes, 0 to 1; null when the room is partial or unknown. */
  share: number | null;
}

export interface SpendProductViewV1 {
  id: string;
  name: string;
  packages: SpendPackageRowV1[];
  /** Said when buying would need something more, such as the number to top up. */
  needs: string | null;
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
  const packages: SpendPackageRowV1[] = [];
  for (const row of product.packages) {
    if (!object(row) || !text(row.value, 80) || typeof row.priceUsdc !== 'string') continue;
    const cents = priceCentsV1(row.priceUsdc);
    if (cents === null) continue;
    const face = typeof row.faceCurrency === 'string' && /^[A-Z]{3}$/.test(row.faceCurrency) && /^\d+(?:\.\d+)?$/.test(row.value) ? ` ${row.faceCurrency}` : '';
    const fits = roomCents === null ? null : cents <= roomCents ? 'within' as const : room!.complete ? 'over' as const : null;
    // A share of a partial room would overstate it, so the bar is drawn only against a whole one.
    const share = roomCents === null || !room!.complete || roomCents === 0n ? null : cents >= roomCents ? 1 : Number(cents) / Number(roomCents);
    packages.push({ label: `${row.value}${face}`, price: `${row.priceUsdc} USDC`, room: fits, share });
  }
  const recipient = typeof product.recipientType === 'string' ? product.recipientType : '';
  const needs = /phone/i.test(recipient) ? 'Buying it needs the phone number to top up.'
    : /mixed|account|email|user/i.test(recipient) && !/esim/i.test(product.id) ? 'Buying it may need an account, an email or a number for the recipient.'
      : null;
  return { product: { id: product.id, name: product.name, packages, needs }, error: null };
}
