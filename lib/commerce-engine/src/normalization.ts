import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import { COMMERCE_USDC_DECIMALS_V1 } from './pinned-config.js';
import type { CommerceFailureReasonV1 } from './types.js';

// ---------------------------------------------------------------------------
// Deterministic, offline normalization. Money crosses this boundary as decimal
// STRINGS and leaves as unsigned base-unit integer strings — never as a
// JavaScript number, which cannot represent a cent reliably.
// ---------------------------------------------------------------------------

const DECIMAL_PATTERN_V1 = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * Decimal money → base units, exactly. Returns null (rather than rounding)
 * when the value carries more precision than the asset can express: silently
 * dropping a fraction of a cent on an irreversible purchase is not acceptable.
 */
export function decimalToAtomicV1(value: string, decimals = COMMERCE_USDC_DECIMALS_V1): string | null {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN_V1.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) return null;
  const padded = fraction.padEnd(decimals, '0');
  const atomic = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  return atomic.length === 0 ? '0' : atomic;
}

/** Base units → decimal string, for display only. */
export function atomicToDecimalV1(value: string, decimals = COMMERCE_USDC_DECIMALS_V1): string {
  const padded = value.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

/** Normalizes a provider address for pinned comparison. Returns null for
 * anything that is not a 20-byte hex address, so a malformed value fails
 * closed instead of comparing unequal by accident. */
export function normalizeAddressV1(value: unknown): `0x${string}` | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return trimmed.toLowerCase() as `0x${string}`;
}

export function normalizeCountryV1(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

export function normalizeCurrencyV1(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

/** The provider's `package_value` is used VERBATIM in the order it creates —
 * this only rejects values that could not round-trip, it never reformats. */
export function validatePackageValueV1(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  return trimmed === value ? value : null;
}

/**
 * The denomination as a decimal amount, when the provider's package value IS a
 * bare amount ("10", "25"). Descriptive values ("1GB, 7 Days") return null —
 * they are labels, not prices, and are never coerced into one.
 */
export function packageValueAsDecimalV1(packageValue: string): string | null {
  return DECIMAL_PATTERN_V1.test(packageValue) ? packageValue : null;
}

/** Request provenance. The URL is hashed WITHOUT its query string and with no
 * header material, so an access token or session id can never reach evidence. */
export function commerceRequestHashV1(input: {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}): HashV1 {
  return stableHashV1('commerce-request/v1', {
    method: input.method.toUpperCase(),
    path: input.path,
    query: Object.fromEntries(Object.entries(input.query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    body: input.body === undefined ? null : (input.body as never),
  });
}

export function commerceResponseHashV1(body: unknown): HashV1 {
  return stableHashV1('commerce-response/v1', body as never);
}

/** Maps a thrown transport error onto the closed taxonomy. Provider text never
 * escapes: only the code does. */
export function classifyCommerceTransportErrorV1(error: unknown): CommerceFailureReasonV1 {
  if (error && typeof error === 'object') {
    const name = 'name' in error ? String((error as { name: unknown }).name) : '';
    if (name === 'TimeoutError' || name === 'AbortError') return 'provider_timeout';
    if (name === 'PartnerHostNotAllowlistedError') return 'provider_host_not_allowlisted';
  }
  return 'provider_unreachable';
}

/** Maps an HTTP status onto the closed taxonomy. 402 is called out separately:
 * on this provider it means "this route is gated", which is a configuration
 * fact, not a transport failure. */
export function classifyCommerceHttpStatusV1(status: number): CommerceFailureReasonV1 | null {
  if (status >= 200 && status < 300) return null;
  if (status === 402) return 'provider_payment_required';
  if (status === 408 || status === 504) return 'provider_timeout';
  if (status === 429) return 'provider_rate_limited';
  return 'provider_http_error';
}

/** `now` never runs ahead of the clock: a provider timestamp in the future is
 * ignored rather than trusted, so evidence can never claim to be newer than
 * the moment it was read. */
export function resolveObservedAtV1(providerTimestamp: string | null, now: Date): string {
  if (providerTimestamp === null) return now.toISOString();
  const parsed = Date.parse(providerTimestamp);
  if (Number.isNaN(parsed) || parsed > now.getTime()) return now.toISOString();
  return new Date(parsed).toISOString();
}
