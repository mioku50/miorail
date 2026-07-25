import type { AssetRefV1, CommerceProductKindV1, ProviderRefV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T64 §2 — the pinned Commerce binding.
//
// Everything a commerce request may ever touch is enumerated here: one
// provider, one host, one chain, one settlement asset, one payment recipient,
// and a fixed set of provider paths. Nothing in this file is discoverable at
// runtime and nothing here comes from a client. A response that does not match
// these pins produces a TYPED FAILURE and no candidate — never a "corrected"
// one.
//
// Source of these values: the vendored Bitrefill capability document
// (.claude/skills/base-mcp/plugins/bitrefill.md), which is the `documented`
// lifecycle artefact this route family is promoted from.
// ---------------------------------------------------------------------------

export const BASE_MAINNET_CHAIN_ID_V1 = 8453 as const;

/** CAIP-2 identifier used by the provider's x402 envelopes. */
export const COMMERCE_PAYMENT_NETWORK_V1 = 'eip155:8453' as const;

export const BITREFILL_HOST_V1 = 'api.bitrefill.com';
export const BITREFILL_ORIGIN_V1 = `https://${BITREFILL_HOST_V1}`;

/** Canonical USDC on Base — the only settlement asset in Commerce V1. */
export const COMMERCE_USDC_ADDRESS_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
export const COMMERCE_USDC_DECIMALS_V1 = 6;

/** The provider's fixed payment recipient. Re-checked against every 402
 * envelope before the user is asked to sign anything. */
export const BITREFILL_PAY_TO_V1 = '0x480cd46e6fade651a0437deadda53d5c8e7d846a' as const;

export const COMMERCE_USDC_ASSET_V1: AssetRefV1 = Object.freeze({
  assetId: `eip155:${BASE_MAINNET_CHAIN_ID_V1}/erc20:${COMMERCE_USDC_ADDRESS_V1}`,
  chainId: BASE_MAINNET_CHAIN_ID_V1,
  kind: 'erc20',
  address: COMMERCE_USDC_ADDRESS_V1,
  symbol: 'USDC',
  decimals: COMMERCE_USDC_DECIMALS_V1,
});

export const BITREFILL_PROVIDER_V1: ProviderRefV1 = Object.freeze({
  id: 'bitrefill-x402-v1',
  displayName: 'Bitrefill',
  kind: 'protocol',
  operator: 'Bitrefill',
});

/** The complete set of provider paths this adapter may call. `invoice/pay` is
 * deliberately absent from the READ set — it is a settlement route, reached
 * only through the payment flow, never through catalogue reads. */
export const BITREFILL_SEARCH_PATHS_V1: Record<CommerceProductKindV1, string> = Object.freeze({
  gift_card: '/x402/gift-cards/search',
  esim: '/x402/esims/search',
  topup: '/x402/topups/search',
});

export const BITREFILL_DETAIL_PATH_V1 = '/x402/products/detail';
export const BITREFILL_INVOICE_CREATE_PATH_V1 = '/x402/invoice/create';
export const BITREFILL_INVOICE_PAY_PATH_V1 = '/x402/invoice/pay';
export const BITREFILL_INVOICE_STATUS_PATH_V1 = '/x402/invoice/status';

// --- Personal API (`/v2/*`, Bearer) ----------------------------------------
//
// The account-backed surface reached with a Developers-page API key. It is a
// DIFFERENT API from the x402 routes above — different paths, different auth
// header, different response envelope (`{ meta, data }`) — so it gets its own
// pinned path set rather than being folded into the x402 one.

export const BITREFILL_V2_PATH_PREFIX_V1 = '/v2/';
export const BITREFILL_X402_PATH_PREFIX_V1 = '/x402/';

export const BITREFILL_V2_PRODUCT_SEARCH_PATH_V1 = '/v2/products/search';
export const BITREFILL_V2_PRODUCT_BROWSE_PATH_V1 = '/v2/products';
export const BITREFILL_V2_INVOICES_PATH_V1 = '/v2/invoices';
export const BITREFILL_V2_ORDERS_PATH_V1 = '/v2/orders';
export const BITREFILL_V2_PING_PATH_V1 = '/v2/ping';

/** `/v2/products/{id}` and `/v2/invoices/{id}` carry an id in the path, so the
 * allowlist checks a PREFIX for those two and exact paths for everything else.
 * The id itself is always URL-encoded by the caller. */
export const BITREFILL_V2_PATH_PREFIXES_V1: readonly string[] = Object.freeze([
  '/v2/products/',
  '/v2/invoices/',
  '/v2/orders/',
]);

/** The settlement rail named on a Personal API invoice. Pinned: no other
 * payment method may ever be requested by this deployment. */
export const COMMERCE_PAYMENT_METHOD_V1 = 'usdc_base' as const;

export const BITREFILL_ALLOWED_PATHS_V1: readonly string[] = Object.freeze([
  ...Object.values(BITREFILL_SEARCH_PATHS_V1),
  BITREFILL_DETAIL_PATH_V1,
  BITREFILL_INVOICE_CREATE_PATH_V1,
  BITREFILL_INVOICE_PAY_PATH_V1,
  BITREFILL_INVOICE_STATUS_PATH_V1,
  BITREFILL_V2_PRODUCT_SEARCH_PATH_V1,
  BITREFILL_V2_PRODUCT_BROWSE_PATH_V1,
  BITREFILL_V2_INVOICES_PATH_V1,
  BITREFILL_V2_ORDERS_PATH_V1,
  BITREFILL_V2_PING_PATH_V1,
]);

/**
 * Countries this deployment will transact in. A narrow allowlist rather than
 * "whatever the storefront offers": an unlisted country is a typed failure, so
 * a mis-parsed intent can never buy a card for the wrong market.
 */
export const COMMERCE_SUPPORTED_COUNTRIES_V1: readonly string[] = Object.freeze([
  'US',
  'GB',
  'DE',
  'FR',
  'IT',
  'ES',
  'NL',
  'PL',
  'CA',
  'AU',
]);

/** Currencies a candidate may be quoted in. Settlement is always USDC. */
export const COMMERCE_SUPPORTED_CURRENCIES_V1: readonly string[] = Object.freeze([
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'PLN',
]);

/** Product kinds this family serves today. eSIM and top-up shapes are typed
 * but stay off until each has its own delivery evidence. */
export const COMMERCE_SUPPORTED_KINDS_V1: readonly CommerceProductKindV1[] = Object.freeze([
  'gift_card',
]);

/** Hard ceiling for a single commerce order, in USDC base units ($500). A
 * bigger request is refused before any provider call — an irreversible
 * purchase does not get an unbounded amount. */
export const COMMERCE_MAX_ORDER_ATOMIC_V1 = '500000000';

/** The provider price-locks a checkout for ~15 minutes. */
export const COMMERCE_INVOICE_TTL_MS_V1 = 15 * 60_000;

/** How long a catalogue reading counts as fresh (drives `expiresAt`). */
export const DEFAULT_COMMERCE_FRESHNESS_TTL_MS_V1 = 2 * 60_000;

export const DEFAULT_COMMERCE_TIMEOUT_MS_V1 = 8_000;

export function resolveCommerceFreshnessTtlMsV1(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_COMMERCE_FRESHNESS_TTL_MS_V1;
  return Math.max(1_000, Math.floor(value));
}

export function resolveCommerceTimeoutMsV1(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_COMMERCE_TIMEOUT_MS_V1;
  return Math.min(60_000, Math.max(250, Math.floor(value)));
}

/** True only for a path this adapter is allowed to reach on the pinned host.
 * Exact match, plus the three `/v2/` families whose last segment is an id. */
export function isPinnedCommercePathV1(path: string): boolean {
  if (BITREFILL_ALLOWED_PATHS_V1.includes(path)) return true;
  return BITREFILL_V2_PATH_PREFIXES_V1.some(
    (prefix) => path.startsWith(prefix) && path.length > prefix.length && !path.slice(prefix.length).includes('?'),
  );
}

/** Builds a provider URL from a PINNED path plus explicit query parameters.
 * The path is validated against the allowlist here, so no caller — and no
 * upstream `next_step` hint — can steer a request somewhere else. */
export function buildCommerceUrlV1(path: string, query: Record<string, string> = {}): string {
  if (!isPinnedCommercePathV1(path)) {
    throw new Error(`Commerce path is not pinned: ${path}`);
  }
  const url = new URL(path, BITREFILL_ORIGIN_V1);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}
