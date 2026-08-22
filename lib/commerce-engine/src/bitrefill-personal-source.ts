import { z } from 'zod';
import { partnerFetch } from '@mioagent/security/httpAllowlist';
import type { CommerceAvailabilityV1, CommerceFeeBreakdownV1, CommerceProductRefV1 } from '@mioagent/route-domain';
import {
  BITREFILL_PROVIDER_V1,
  BITREFILL_V2_PRODUCT_BROWSE_PATH_V1,
  BITREFILL_V2_PRODUCT_SEARCH_PATH_V1,
  buildCommerceUrlV1,
  resolveCommerceFreshnessTtlMsV1,
  resolveCommerceTimeoutMsV1,
} from './pinned-config.js';
import { commerceAuthHeadersV1, resolveCommerceCredentialV1, type CommerceCredentialV1 } from './auth.js';
import {
  classifyCommerceHttpStatusV1,
  classifyCommerceTransportErrorV1,
  commerceRequestHashV1,
  commerceResponseHashV1,
  decimalToAtomicV1,
  normalizeCountryV1,
  normalizeCurrencyV1,
  packageValueAsDecimalV1,
  validatePackageValueV1,
} from './normalization.js';
import { resolveRecipientRequiredV1 } from './bitrefill-source.js';
import type {
  CommerceCatalogBrowseResultV1,
  CommerceCatalogResultV1,
  CommerceCatalogSearchInputV1,
  CommerceCatalogSourceV1,
  CommerceFailureReasonV1,
  CommercePackageObservationV1,
  CommerceSourceOptionsV1,
} from './types.js';

// ---------------------------------------------------------------------------
// T64.1 — the Bitrefill PERSONAL API catalogue adapter (`/v2/*`, Bearer).
//
// A second, independent surface alongside the x402 adapter. It exists because
// a Personal API key authenticates `/v2/*` and NOTHING else: attaching it to
// an `/x402/*` request would ship an account credential to a gate that cannot
// use it. `commerceAuthHeadersV1` refuses that pairing outright, so the two
// surfaces cannot be crossed even by mistake.
//
// Contract source: Bitrefill's own MCP server (github.com/bitrefill/
// bitrefill-mcp-server), which pins the envelope `{ meta, data }`, the product
// fields, and the `{ id, value, price }` package shape used below.
//
// One call less than the x402 path: `/v2/products/search` already returns each
// product WITH its packages, so no follow-up detail read is needed.
// ---------------------------------------------------------------------------

const V2PackageSchema = z
  .object({
    id: z.string().min(1).max(300),
    value: z.string().min(1).max(80),
    price: z.number(),
    amount: z.number().optional(),
  })
  .passthrough();

const V2ProductSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    country_code: z.string().min(1).max(10),
    currency: z.string().min(1).max(10),
    in_stock: z.boolean().optional(),
    recipient_type: z.string().min(1).max(40).optional(),
    packages: z.array(V2PackageSchema).max(200).optional(),
  })
  .passthrough();

const V2ListEnvelopeSchema = z
  .object({
    meta: z.record(z.unknown()).optional(),
    data: z.array(V2ProductSchema).max(200),
  })
  .passthrough();

type V2Product = z.infer<typeof V2ProductSchema>;
type V2Package = z.infer<typeof V2PackageSchema>;

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

/**
 * Deterministic product selection.
 *
 * `/v2/products/search` takes no country filter — only the browse endpoint
 * does — so the country restriction is applied HERE, over the returned list.
 * A product that does not state a country cannot be matched to one, and an
 * exact id match always wins over a name match.
 */
export function selectV2ProductV1(
  products: readonly V2Product[],
  input: { query: string; country: string },
): V2Product | null {
  const query = normalizeText(input.query);
  if (query.length === 0) return null;
  const inCountry = products.filter((product) => normalizeCountryV1(product.country_code) === input.country);
  const exact = inCountry.find((product) => normalizeText(product.id) === query);
  if (exact) return exact;
  return (
    inCountry.find((product) => `${normalizeText(product.id)} ${normalizeText(product.name)}`.includes(query)) ?? null
  );
}

/** A JSON number price → an exact decimal string, or null when it could not
 * round-trip (non-finite, negative, or exponent-formatted). */
export function v2PriceToDecimalV1(price: number): string | null {
  if (!Number.isFinite(price) || price < 0) return null;
  const text = String(price);
  return /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text) ? text : null;
}

/**
 * The settlement price for one `/v2` package.
 *
 * `package.price` is DELIBERATELY IGNORED. The live catalogue returns
 * `{ id, value, price, amount }` and publishes no currency for `price`
 * anywhere in the response: a $200 Steam card carries `value: "200"`,
 * `amount: 200`, `currency: "USD"` — and `price: 347689`. Whatever unit that
 * is, it is not the product currency and not USDC, and an unlabelled number is
 * not evidence. Using it produced a 347,687 USDC "minimum" for a $200 card.
 *
 * What IS verifiable is the denomination: `amount` (number) or `value`
 * (numeric string), stated in the product's own `currency`. So the settlement
 * total is the face value, as a MINIMUM — the exact USDC charge is fixed by
 * the invoice the user reviews before signing, and re-checked against the
 * authorized ceiling there.
 *
 * A non-USD product is refused rather than converted: there is no FX evidence
 * source, and inventing a rate on an irreversible purchase is not an option.
 */
export function resolveV2PackagePriceV1(
  pkg: V2Package,
  currency: string,
): { fees: CommerceFeeBreakdownV1; fiatAmountDecimal: string } | { failure: CommerceFailureReasonV1 } {
  if (currency !== 'USD') return { failure: 'fx_rate_unavailable' };
  const denomination =
    typeof pkg.amount === 'number' ? v2PriceToDecimalV1(pkg.amount) : packageValueAsDecimalV1(pkg.value);
  // A descriptive package value ("1GB, 7 Days") is a label, not a price.
  if (denomination === null) return { failure: 'price_unavailable' };
  const atomic = decimalToAtomicV1(denomination);
  if (atomic === null) return { failure: 'price_unavailable' };
  return {
    fiatAmountDecimal: denomination,
    fees: {
      productPriceAtomic: atomic,
      providerFeeAtomic: null,
      networkFeeAtomic: null,
      totalAtomic: atomic,
      totalBasis: 'minimum',
    },
  };
}

function availabilityV1(product: V2Product): CommerceAvailabilityV1 {
  if (product.in_stock === true) return 'in_stock';
  if (product.in_stock === false) return 'out_of_stock';
  return 'unknown';
}

export function createBitrefillPersonalCatalogSourceV1(
  options: CommerceSourceOptionsV1 & { apiKey?: string } = {},
): CommerceCatalogSourceV1 {
  const timeoutMs = resolveCommerceTimeoutMsV1(options.timeoutMs);
  const freshnessTtlMs = resolveCommerceFreshnessTtlMsV1(options.freshnessTtlMs);
  const credential: CommerceCredentialV1 = resolveCommerceCredentialV1({ apiKey: options.apiKey });

  /** Shared request path: the credential check, the fetch, and the envelope
   * parse are identical for search and browse; only the path and query move. */
  async function readListV1(
    path: string,
    query: Record<string, string>,
  ): Promise<{ ok: true; products: V2Product[] } | { ok: false; reason: CommerceFailureReasonV1 }> {
    if (credential.kind !== 'personal_api') return { ok: false, reason: 'provider_not_configured' };
    let headers: Record<string, string>;
    try {
      headers = { accept: 'application/json', ...commerceAuthHeadersV1(credential, path) };
    } catch {
      return { ok: false, reason: 'provider_not_configured' };
    }
    let response: Response;
    try {
      response = await partnerFetch(
        buildCommerceUrlV1(path, query),
        { method: 'GET', headers },
        { timeoutMs, fetchImpl: options.fetchImpl },
      );
    } catch (error) {
      return { ok: false, reason: classifyCommerceTransportErrorV1(error) };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'provider_not_configured' };
    const statusFailure = classifyCommerceHttpStatusV1(response.status);
    if (statusFailure !== null) return { ok: false, reason: statusFailure };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'provider_invalid_response' };
    }
    const parsed = V2ListEnvelopeSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
    return { ok: true, products: parsed.data.data };
  }

  return {
    id: `${BITREFILL_PROVIDER_V1.id}-personal`,

    /**
     * What this storefront carries for a country, with no product named.
     *
     * Deliberately narrower than `search`: it returns the products and their
     * denominations, and it prices nothing. A price is only meaningful for a
     * chosen denomination, and quoting one here would put a number on screen
     * that no checkout is bound to.
     */
    async browse(input): Promise<CommerceCatalogBrowseResultV1> {
      if (input.kind !== 'gift_card') return { ok: false, reason: 'unsupported_kind' };
      const country = normalizeCountryV1(input.country);
      if (country === null) return { ok: false, reason: 'unsupported_country' };
      const limit = Math.max(1, Math.min(50, Math.trunc(input.limit)));
      const listed = await readListV1(BITREFILL_V2_PRODUCT_BROWSE_PATH_V1, {
        country,
        limit: String(limit),
      });
      if (!listed.ok) return listed;
      const products = listed.products
        .filter((product) => normalizeCountryV1(product.country_code) === country)
        .slice(0, limit)
        .map((product) => ({
          productId: product.id,
          name: product.name,
          country,
          currency: normalizeCurrencyV1(product.currency) ?? product.currency,
          availability: availabilityV1(product),
          packageValues: (product.packages ?? [])
            .map((pkg) => validatePackageValueV1(pkg.value))
            .filter((value): value is string => value !== null)
            .slice(0, 12),
        }));
      if (products.length === 0) return { ok: false, reason: 'product_not_found' };
      return {
        ok: true,
        products,
        observedAt: input.now.toISOString(),
        providerDisplayName: BITREFILL_PROVIDER_V1.displayName,
      };
    },

    async search(input: CommerceCatalogSearchInputV1): Promise<CommerceCatalogResultV1> {
      if (input.kind !== 'gift_card') return { ok: false, reason: 'unsupported_kind' };
      const country = normalizeCountryV1(input.country);
      if (country === null) return { ok: false, reason: 'unsupported_country' };
      if (credential.kind !== 'personal_api') return { ok: false, reason: 'provider_not_configured' };

      const query = { q: input.query, limit: '25' };
      let headers: Record<string, string>;
      try {
        // Throws rather than degrading if the credential does not belong to
        // this surface — the whole point of T64.1.
        headers = { accept: 'application/json', ...commerceAuthHeadersV1(credential, BITREFILL_V2_PRODUCT_SEARCH_PATH_V1) };
      } catch {
        return { ok: false, reason: 'provider_not_configured' };
      }

      let response: Response;
      try {
        response = await partnerFetch(
          buildCommerceUrlV1(BITREFILL_V2_PRODUCT_SEARCH_PATH_V1, query),
          { method: 'GET', headers },
          { timeoutMs, fetchImpl: options.fetchImpl },
        );
      } catch (error) {
        return { ok: false, reason: classifyCommerceTransportErrorV1(error) };
      }
      // 401/403 on this surface means the key is missing or wrong — a
      // configuration fact, reported as such rather than as an HTTP error.
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: 'provider_not_configured' };
      }
      const statusFailure = classifyCommerceHttpStatusV1(response.status);
      if (statusFailure !== null) return { ok: false, reason: statusFailure };

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, reason: 'provider_invalid_response' };
      }
      const parsed = V2ListEnvelopeSchema.safeParse(body);
      if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };

      const product = selectV2ProductV1(parsed.data.data, { query: input.query, country });
      if (!product) return { ok: false, reason: 'product_not_found' };
      const currency = normalizeCurrencyV1(product.currency);
      if (currency === null) return { ok: false, reason: 'unsupported_currency' };
      if (!product.packages || product.packages.length === 0) {
        return { ok: false, reason: 'denomination_unavailable' };
      }

      const recipientRequired = resolveRecipientRequiredV1(product);
      const availability = availabilityV1(product);
      const packages: CommercePackageObservationV1[] = [];
      for (const pkg of product.packages) {
        const packageValue = validatePackageValueV1(pkg.value);
        if (packageValue === null) continue;
        const priced = resolveV2PackagePriceV1(pkg, currency);
        if ('failure' in priced) continue;
        const productRef: CommerceProductRefV1 = {
          provider: 'bitrefill',
          productId: product.id,
          name: product.name,
          kind: 'gift_card',
          country,
          currency,
          packageValue,
          // `steam-usa<&>5` — what a fixed denomination must be ordered by.
          packageId: pkg.id,
          recipientRequired,
        };
        packages.push({
          product: productRef,
          fiatAmountDecimal: priced.fiatAmountDecimal,
          fees: priced.fees,
          availability,
        });
      }
      if (packages.length === 0) return { ok: false, reason: 'denomination_unavailable' };

      return {
        ok: true,
        observation: {
          packages,
          observedAt: input.now.toISOString(),
          expiresAt: new Date(input.now.getTime() + freshnessTtlMs).toISOString(),
          endpoint: BITREFILL_V2_PRODUCT_SEARCH_PATH_V1,
          // The API key is a header. It is not part of the request identity and
          // therefore cannot leak into evidence through the hash.
          requestHash: commerceRequestHashV1({
            method: 'GET',
            path: BITREFILL_V2_PRODUCT_SEARCH_PATH_V1,
            query: { ...query, country, productId: product.id },
          }),
          responseHash: commerceResponseHashV1(body),
          providerId: BITREFILL_PROVIDER_V1.id,
          providerDisplayName: BITREFILL_PROVIDER_V1.displayName,
        },
      };
    },
  };
}
