import { z } from 'zod';
import { partnerFetch } from '@mioagent/security/httpAllowlist';
import type { CommerceAvailabilityV1, CommerceFeeBreakdownV1, CommerceProductRefV1 } from '@mioagent/route-domain';
import {
  BITREFILL_DETAIL_PATH_V1,
  BITREFILL_PROVIDER_V1,
  BITREFILL_SEARCH_PATHS_V1,
  buildCommerceUrlV1,
  resolveCommerceFreshnessTtlMsV1,
  resolveCommerceTimeoutMsV1,
} from './pinned-config.js';
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
import type {
  CommerceCatalogResultV1,
  CommerceCatalogSearchInputV1,
  CommerceCatalogSourceV1,
  CommerceFailureReasonV1,
  CommercePackageObservationV1,
  CommerceSourceOptionsV1,
} from './types.js';

// ---------------------------------------------------------------------------
// T64 — the Bitrefill catalogue adapter (read-only half of the family).
//
// Two pinned calls, in this order and no other:
//   1. the kind's search path, with the query and the requested country;
//   2. the detail path, for the ONE slug that search selection resolved to.
//
// Nothing here follows the provider's `next_step` hints: an upstream field
// must never be able to redirect a request. Every URL is rebuilt from a pinned
// path by `buildCommerceUrlV1`, which refuses anything outside the allowlist.
//
// The access token, when configured, is attached as a header and appears in NO
// hash, NO log, and NO evidence record.
// ---------------------------------------------------------------------------

/** A price may arrive as a string or a JSON number. Exponent notation and
 * non-finite values are refused rather than coerced. */
const PriceLikeSchema = z.union([z.string(), z.number()]);

function priceLikeToDecimalV1(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(trimmed) ? trimmed : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    const text = String(value);
    return /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text) ? text : null;
  }
  return null;
}

const BitrefillProductSchema = z
  .object({
    slug: z.string().min(1).max(200),
    name: z.string().min(1).max(200).optional(),
    country: z.string().optional(),
    country_code: z.string().optional(),
    currency: z.string().optional(),
    in_stock: z.boolean().optional(),
    recipient_required: z.boolean().optional(),
    recipient_type: z.string().min(1).max(40).optional(),
  })
  .passthrough();

const BitrefillSearchResponseSchema = z
  .object({
    products: z.array(BitrefillProductSchema).max(200),
  })
  .passthrough();

const BitrefillPackageSchema = z
  .object({
    package_value: z.string().min(1).max(80),
    value: PriceLikeSchema.optional(),
    price: PriceLikeSchema.optional(),
    usd_price: PriceLikeSchema.optional(),
    usdc_price: PriceLikeSchema.optional(),
    in_stock: z.boolean().optional(),
  })
  .passthrough();

const BitrefillDetailResponseSchema = z
  .object({
    slug: z.string().min(1).max(200),
    name: z.string().min(1).max(200).optional(),
    country: z.string().optional(),
    country_code: z.string().optional(),
    currency: z.string().min(1).max(10),
    in_stock: z.boolean().optional(),
    recipient_required: z.boolean().optional(),
    recipient_type: z.string().min(1).max(40).optional(),
    packages: z.array(BitrefillPackageSchema).min(1).max(200),
  })
  .passthrough();

type BitrefillProduct = z.infer<typeof BitrefillProductSchema>;
type BitrefillPackage = z.infer<typeof BitrefillPackageSchema>;

function productCountryV1(product: { country?: string; country_code?: string }): string | null {
  return normalizeCountryV1(product.country_code ?? product.country);
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

/**
 * Deterministic product selection — the provider's ordering is an input, never
 * the decision. An exact slug match wins; otherwise the FIRST product whose
 * name or slug contains the query, restricted to the requested country. If
 * nothing matches, there is no product and no candidate.
 */
export function selectBitrefillProductV1(
  products: readonly BitrefillProduct[],
  input: { query: string; country: string },
): BitrefillProduct | null {
  const query = normalizeText(input.query);
  if (query.length === 0) return null;
  const inCountry = products.filter((product) => {
    const country = productCountryV1(product);
    // A product that does not state its country cannot be matched to one.
    return country !== null && country === input.country;
  });
  const exact = inCountry.find((product) => normalizeText(product.slug) === query);
  if (exact) return exact;
  return (
    inCountry.find((product) => {
      const haystack = `${normalizeText(product.slug)} ${normalizeText(product.name ?? '')}`;
      return haystack.includes(query);
    }) ?? null
  );
}

export function resolveRecipientRequiredV1(product: {
  recipient_required?: boolean;
  recipient_type?: string;
}): boolean {
  if (typeof product.recipient_required === 'boolean') return product.recipient_required;
  if (typeof product.recipient_type === 'string') {
    return product.recipient_type.trim().toLowerCase() !== 'none';
  }
  return false;
}

function availabilityV1(pkg: BitrefillPackage, productInStock: boolean | undefined): CommerceAvailabilityV1 {
  const value = pkg.in_stock ?? productInStock;
  if (value === true) return 'in_stock';
  if (value === false) return 'out_of_stock';
  return 'unknown';
}

/**
 * The settlement price for one package.
 *
 * `exact_quote` requires the provider to have named a USDC figure. A USD price
 * is treated as a MINIMUM — the exact USDC charge is only fixed by the
 * checkout the user reviews — and a non-USD product with no USDC quote is
 * refused outright, because Miorail has no FX evidence source and will not
 * invent a rate.
 */
export function resolvePackagePriceV1(
  pkg: BitrefillPackage,
  currency: string,
): { fees: CommerceFeeBreakdownV1; fiatAmountDecimal: string } | { failure: CommerceFailureReasonV1 } {
  const usdc = priceLikeToDecimalV1(pkg.usdc_price);
  const usd = priceLikeToDecimalV1(pkg.usd_price);
  const quoted = priceLikeToDecimalV1(pkg.price ?? pkg.value);
  const denomination = quoted ?? packageValueAsDecimalV1(pkg.package_value);

  if (usdc !== null) {
    const atomic = decimalToAtomicV1(usdc);
    if (atomic === null) return { failure: 'price_unavailable' };
    return {
      fiatAmountDecimal: denomination ?? usdc,
      fees: {
        productPriceAtomic: atomic,
        providerFeeAtomic: null,
        networkFeeAtomic: null,
        totalAtomic: atomic,
        totalBasis: 'exact_quote',
      },
    };
  }

  const usdBasis = usd ?? (currency === 'USD' ? denomination : null);
  if (usdBasis === null) {
    return { failure: currency === 'USD' ? 'price_unavailable' : 'fx_rate_unavailable' };
  }
  const atomic = decimalToAtomicV1(usdBasis);
  if (atomic === null) return { failure: 'price_unavailable' };
  return {
    fiatAmountDecimal: denomination ?? usdBasis,
    fees: {
      productPriceAtomic: atomic,
      providerFeeAtomic: null,
      networkFeeAtomic: null,
      totalAtomic: atomic,
      totalBasis: 'minimum',
    },
  };
}

export function createBitrefillCatalogSourceV1(
  options: CommerceSourceOptionsV1 = {},
): CommerceCatalogSourceV1 {
  const timeoutMs = resolveCommerceTimeoutMsV1(options.timeoutMs);
  const freshnessTtlMs = resolveCommerceFreshnessTtlMsV1(options.freshnessTtlMs);

  async function readJson(
    path: string,
    query: Record<string, string>,
  ): Promise<{ ok: true; body: unknown } | { ok: false; reason: CommerceFailureReasonV1 }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    // Held in memory, sent as a header, and never hashed or logged.
    if (options.accessToken) headers['X-Access-Token'] = options.accessToken;
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
    const statusFailure = classifyCommerceHttpStatusV1(response.status);
    if (statusFailure !== null) return { ok: false, reason: statusFailure };
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, reason: 'provider_invalid_response' };
    }
  }

  return {
    id: BITREFILL_PROVIDER_V1.id,

    async search(input: CommerceCatalogSearchInputV1): Promise<CommerceCatalogResultV1> {
      const searchPath = BITREFILL_SEARCH_PATHS_V1[input.kind];
      if (!searchPath) return { ok: false, reason: 'unsupported_kind' };
      const country = normalizeCountryV1(input.country);
      if (country === null) return { ok: false, reason: 'unsupported_country' };

      const searchQuery = { q: input.query, country };
      const searchResult = await readJson(searchPath, searchQuery);
      if (!searchResult.ok) return { ok: false, reason: searchResult.reason };
      const searchParsed = BitrefillSearchResponseSchema.safeParse(searchResult.body);
      if (!searchParsed.success) return { ok: false, reason: 'provider_invalid_response' };

      const product = selectBitrefillProductV1(searchParsed.data.products, { query: input.query, country });
      if (!product) return { ok: false, reason: 'product_not_found' };

      const detailQuery = { slug: product.slug };
      const detailResult = await readJson(BITREFILL_DETAIL_PATH_V1, detailQuery);
      if (!detailResult.ok) return { ok: false, reason: detailResult.reason };
      const detailParsed = BitrefillDetailResponseSchema.safeParse(detailResult.body);
      if (!detailParsed.success) return { ok: false, reason: 'provider_invalid_response' };
      const detail = detailParsed.data;

      // The detail response must describe the SAME product the search selected
      // and the SAME country that was asked for. Anything else is a mismatch,
      // not something to reconcile.
      if (detail.slug !== product.slug) return { ok: false, reason: 'provider_invalid_response' };
      const detailCountry = productCountryV1(detail);
      if (detailCountry === null || detailCountry !== country) return { ok: false, reason: 'unsupported_country' };
      const currency = normalizeCurrencyV1(detail.currency);
      if (currency === null) return { ok: false, reason: 'unsupported_currency' };

      // The live catalogue reports `recipient_type: "none"` rather than a
      // boolean. Only an explicit "none" clears the requirement — an
      // unrecognised value is treated as needing a recipient, which fails
      // closed by refusing to order rather than sending a code nowhere.
      const recipientRequired = resolveRecipientRequiredV1(detail);
      const packages: CommercePackageObservationV1[] = [];
      for (const pkg of detail.packages) {
        const packageValue = validatePackageValueV1(pkg.package_value);
        if (packageValue === null) continue;
        const priced = resolvePackagePriceV1(pkg, currency);
        if ('failure' in priced) continue;
        const productRef: CommerceProductRefV1 = {
          provider: 'bitrefill',
          productId: detail.slug,
          name: detail.name ?? product.name ?? detail.slug,
          kind: input.kind,
          country,
          currency,
          packageValue,
          recipientRequired,
        };
        packages.push({
          product: productRef,
          fiatAmountDecimal: priced.fiatAmountDecimal,
          fees: priced.fees,
          availability: availabilityV1(pkg, detail.in_stock),
        });
      }
      if (packages.length === 0) return { ok: false, reason: 'denomination_unavailable' };

      const observedAt = input.now.toISOString();
      return {
        ok: true,
        observation: {
          packages,
          observedAt,
          expiresAt: new Date(input.now.getTime() + freshnessTtlMs).toISOString(),
          endpoint: BITREFILL_DETAIL_PATH_V1,
          requestHash: commerceRequestHashV1({
            method: 'GET',
            path: BITREFILL_DETAIL_PATH_V1,
            query: { ...detailQuery, searchPath, searchQuery: JSON.stringify(searchQuery) },
          }),
          responseHash: commerceResponseHashV1(detailResult.body),
          providerId: BITREFILL_PROVIDER_V1.id,
          providerDisplayName: BITREFILL_PROVIDER_V1.displayName,
        },
      };
    },
  };
}
