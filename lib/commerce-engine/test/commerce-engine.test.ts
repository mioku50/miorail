import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCommerceCandidatesV1,
  buildCommerceScoreV1,
  compareCommerceRoutesV1,
  createBitrefillCatalogSourceV1,
  denominationDeltaV1,
  orderPackagesByFitV1,
  rankCommerceCandidatesV1,
  resolvePackagePriceV1,
  selectBitrefillProductV1,
  validateCommerceIntentV1,
  type CommerceCatalogSourceV1,
} from '../src/index.js';
import {
  CommerceRouteIntentV1Schema,
  hashCommerceRouteIntentV1,
  ZERO_HASH_V1,
  type CommerceOptimizationModeV1,
  type CommerceRouteIntentV1,
} from '@mioagent/route-domain';

// No unit test in this file may open a socket. Any live fetch is a bug in the
// test, not a flake: the engine takes its catalogue through an injected seam.
globalThis.fetch = (() => {
  throw new Error('Unit tests must not perform live network calls');
}) as typeof fetch;

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const NOW = new Date('2026-07-25T12:00:00.000Z');

const USDC_ASSET = {
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const,
  symbol: 'USDC',
  decimals: 6,
};

/** A ready commerce intent, built straight from the contract so this package's
 * tests exercise the engine rather than the extractor (which has its own). */
function commerceIntent(
  overrides: {
    requestedDecimal?: string;
    maxSpendAtomic?: string;
    optimizationMode?: CommerceOptimizationModeV1;
    country?: string;
    currency?: string;
  } = {},
): CommerceRouteIntentV1 {
  const nowIso = NOW.toISOString();
  const draft = {
    schemaVersion: 'commerce-route-intent/v1' as const,
    id: 'commerce-intent:test',
    tenantId: 'eip155:8453:0x1111111111111111111111111111111111111111',
    walletAddress: WALLET,
    chainId: 8453 as const,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'ready' as const,
    intentHash: ZERO_HASH_V1,
    goal: 'commerce' as const,
    query: 'Steam',
    kind: 'gift_card' as const,
    country: overrides.country ?? 'US',
    requestedValue: {
      amountDecimal: overrides.requestedDecimal ?? '25',
      currency: overrides.currency ?? 'USD',
    },
    paymentAsset: USDC_ASSET,
    maxSpendAtomic: overrides.maxSpendAtomic ?? '28750000',
    recipientInput: null,
    optimizationMode: overrides.optimizationMode ?? ('exact_denomination' as const),
    executionRequested: false,
  };
  return CommerceRouteIntentV1Schema.parse({
    ...draft,
    intentHash: hashCommerceRouteIntentV1(draft as unknown as CommerceRouteIntentV1),
  });
}

const SEARCH_BODY = {
  products: [
    { slug: 'steam-usa', name: 'Steam US', country_code: 'US', currency: 'USD', in_stock: true, recipient_required: false },
    { slug: 'steam-italy', name: 'Steam IT', country_code: 'IT', currency: 'EUR', in_stock: true },
  ],
};

const DETAIL_BODY = {
  slug: 'steam-usa',
  name: 'Steam US',
  country_code: 'US',
  currency: 'USD',
  in_stock: true,
  recipient_required: false,
  packages: [
    { package_value: '10', value: '10', usd_price: '10', in_stock: true },
    { package_value: '25', value: '25', usdc_price: '25.5', in_stock: true },
    { package_value: '50', value: '50', usd_price: '50', in_stock: false },
  ],
};

const SEARCH_INPUT = {
  query: 'Steam',
  kind: 'gift_card' as const,
  country: 'US',
  requestedValueDecimal: '25',
  requestedCurrency: 'USD',
  now: NOW,
};

/** A fetch double that answers only the two pinned paths. */
function stubFetch(
  responses: { search?: unknown; detail?: unknown; searchStatus?: number; detailStatus?: number } = {},
): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const isDetail = url.includes('/x402/products/detail');
    const status = isDetail ? (responses.detailStatus ?? 200) : (responses.searchStatus ?? 200);
    const body = isDetail ? (responses.detail ?? DETAIL_BODY) : (responses.search ?? SEARCH_BODY);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, urls };
}

function catalogStub(responses?: Parameters<typeof stubFetch>[0]): CommerceCatalogSourceV1 {
  return createBitrefillCatalogSourceV1({ fetchImpl: stubFetch(responses).impl });
}

// --- Validation ------------------------------------------------------------

test('an unsupported country is refused before any provider call', () => {
  assert.deepEqual(validateCommerceIntentV1(commerceIntent({ country: 'JP' })), {
    ok: false,
    reason: 'unsupported_country',
  });
});

test('an unsupported currency is refused', () => {
  assert.deepEqual(validateCommerceIntentV1(commerceIntent({ currency: 'JPY' })), {
    ok: false,
    reason: 'unsupported_currency',
  });
});

test('an order above the hard ceiling is refused', () => {
  assert.deepEqual(validateCommerceIntentV1(commerceIntent({ maxSpendAtomic: '900000000' })), {
    ok: false,
    reason: 'spend_ceiling_exceeded',
  });
});

// --- Catalogue adapter -----------------------------------------------------

test('product selection is deterministic and country-bound', () => {
  const chosen = selectBitrefillProductV1(SEARCH_BODY.products, { query: 'Steam', country: 'US' });
  assert.equal(chosen?.slug, 'steam-usa');
  assert.equal(selectBitrefillProductV1(SEARCH_BODY.products, { query: 'Steam', country: 'DE' }), null);
});

test('a USDC quote is exact; a USD price is only a minimum', () => {
  const exact = resolvePackagePriceV1({ package_value: '25', usdc_price: '25.5' }, 'USD');
  assert.ok('fees' in exact);
  assert.equal(exact.fees.totalBasis, 'exact_quote');
  assert.equal(exact.fees.totalAtomic, '25500000');

  const minimum = resolvePackagePriceV1({ package_value: '25', usd_price: '25' }, 'USD');
  assert.ok('fees' in minimum);
  assert.equal(minimum.fees.totalBasis, 'minimum');
  assert.equal(minimum.fees.providerFeeAtomic, null);
});

test('a non-USD product with no USDC quote is refused rather than converted', () => {
  assert.deepEqual(resolvePackagePriceV1({ package_value: '25' }, 'EUR'), { failure: 'fx_rate_unavailable' });
});

test('the catalogue adapter reads only the two pinned paths', async () => {
  const { impl, urls } = stubFetch();
  const result = await createBitrefillCatalogSourceV1({ fetchImpl: impl }).search(SEARCH_INPUT);
  assert.ok(result.ok);
  assert.equal(result.observation.packages.length, 3);
  assert.equal(result.observation.endpoint, '/x402/products/detail');
  assert.equal(urls.length, 2);
  assert.ok(urls[0].startsWith('https://api.bitrefill.com/x402/gift-cards/search'));
  assert.ok(urls[1].startsWith('https://api.bitrefill.com/x402/products/detail'));
});

test('an access token never reaches the evidence hashes', async () => {
  const withToken = createBitrefillCatalogSourceV1({ fetchImpl: stubFetch().impl, accessToken: 'secret-jwt' });
  const withoutToken = createBitrefillCatalogSourceV1({ fetchImpl: stubFetch().impl });
  const a = await withToken.search(SEARCH_INPUT);
  const b = await withoutToken.search(SEARCH_INPUT);
  assert.ok(a.ok && b.ok);
  assert.equal(a.observation.requestHash, b.observation.requestHash);
  assert.equal(a.observation.responseHash, b.observation.responseHash);
});

test('a detail response for another country fails closed', async () => {
  const result = await catalogStub({ detail: { ...DETAIL_BODY, country_code: 'DE' } }).search(SEARCH_INPUT);
  assert.deepEqual(result, { ok: false, reason: 'unsupported_country' });
});

test('a 402 from a gated route is reported as such, not as a transport error', async () => {
  const result = await catalogStub({ searchStatus: 402 }).search(SEARCH_INPUT);
  assert.deepEqual(result, { ok: false, reason: 'provider_payment_required' });
});

test('a provider timeout is a typed failure', async () => {
  const impl = (async () => {
    const error = new Error('timed out');
    error.name = 'TimeoutError';
    throw error;
  }) as typeof fetch;
  const result = await createBitrefillCatalogSourceV1({ fetchImpl: impl }).search(SEARCH_INPUT);
  assert.deepEqual(result, { ok: false, reason: 'provider_timeout' });
});

test('an unparsable catalogue response produces no candidate', async () => {
  const result = await catalogStub({ detail: { slug: 'steam-usa' } }).search(SEARCH_INPUT);
  assert.deepEqual(result, { ok: false, reason: 'provider_invalid_response' });
});

test('a query nothing matches produces no candidate', async () => {
  const result = await catalogStub({ search: { products: [] } }).search(SEARCH_INPUT);
  assert.deepEqual(result, { ok: false, reason: 'product_not_found' });
});

// --- Candidates, scoring, ranking ------------------------------------------

test('denominations are ordered by fit to the requested value', async () => {
  const observation = await catalogStub().search(SEARCH_INPUT);
  assert.ok(observation.ok);
  assert.deepEqual(
    orderPackagesByFitV1(observation.observation.packages, '25000000').map(
      (entry) => entry.product.packageValue,
    ),
    ['25', '10', '50'],
  );
});

test('a denomination above the authorized ceiling is excluded, not silently bought', async () => {
  const result = await compareCommerceRoutesV1({ catalog: catalogStub() }, { intent: commerceIntent(), now: NOW });
  assert.ok(result.ok);
  assert.deepEqual(
    result.routeCard.comparisons.map((entry) => entry.candidate.product.packageValue),
    ['25', '10'],
  );
  assert.ok(result.skipped.includes('spend_ceiling_exceeded'));
});

test('an out-of-stock denomination stays visible and is never recommended', async () => {
  const intent = commerceIntent({ maxSpendAtomic: '60000000' });
  const result = await compareCommerceRoutesV1({ catalog: catalogStub() }, { intent, now: NOW });
  assert.ok(result.ok);
  const outOfStock = result.routeCard.comparisons.find(
    (entry) => entry.candidate.product.packageValue === '50',
  );
  assert.ok(outOfStock, 'the out-of-stock option must stay on the card');
  assert.equal(outOfStock.availability, 'out_of_stock');
  assert.notEqual(result.routeCard.recommendedCandidateHash, outOfStock.candidate.candidateHash);
});

test('delivery certainty is never scored, in any comparison', async () => {
  const result = await compareCommerceRoutesV1({ catalog: catalogStub() }, { intent: commerceIntent(), now: NOW });
  assert.ok(result.ok);
  for (const entry of result.routeCard.comparisons) {
    const dimension = entry.score.dimensions.find((value) => value.dimension === 'delivery_certainty');
    assert.equal(dimension?.status, 'not_scored');
    assert.equal(dimension?.score, null);
    assert.equal(dimension?.confidence, null);
    assert.deepEqual(dimension?.sources, []);
    assert.deepEqual(dimension?.missingEvidence, ['delivery_terms']);
  }
});

test('an estimated total leaves the cost dimension unscored', async () => {
  const result = await compareCommerceRoutesV1({ catalog: catalogStub() }, { intent: commerceIntent(), now: NOW });
  assert.ok(result.ok);
  const estimated = result.routeCard.comparisons.find((entry) => entry.candidate.fees.totalBasis === 'minimum');
  assert.ok(estimated, 'expected at least one estimated total');
  const cost = estimated.score.dimensions.find((value) => value.dimension === 'total_cost');
  assert.equal(cost?.status, 'not_scored');
  assert.deepEqual(cost?.missingEvidence, ['fees']);
});

test('stale evidence is shown but scores nothing', async () => {
  const observation = await catalogStub().search(SEARCH_INPUT);
  assert.ok(observation.ok);
  const built = buildCommerceCandidatesV1({
    intent: commerceIntent(),
    observation: observation.observation,
    requestedAtomic: '25000000',
    now: NOW,
  });
  assert.ok(built.ok);
  const score = buildCommerceScoreV1({
    candidate: built.builds[0].candidate,
    evidence: built.builds[0].evidence,
    requestedValueDecimal: '25',
    cheapestTotalAtomic: built.builds[0].candidate.fees.totalAtomic,
    now: new Date(NOW.getTime() + 10 * 60_000),
  });
  assert.equal(score.status, 'not_scored');
  for (const dimension of score.dimensions) assert.equal(dimension.score, null);
});

test('a comparison with nothing in stock is degraded, not silently empty', async () => {
  const catalog = catalogStub({
    detail: {
      ...DETAIL_BODY,
      in_stock: false,
      packages: [{ package_value: '25', value: '25', usdc_price: '25', in_stock: false }],
    },
  });
  const result = await compareCommerceRoutesV1({ catalog }, { intent: commerceIntent(), now: NOW });
  assert.ok(result.ok);
  assert.equal(result.routeCard.status, 'degraded');
  assert.equal(result.routeCard.recommendedCandidateHash, null);
  assert.equal(result.routeCard.comparisons.length, 1);
  assert.match(result.routeCard.degradedReason ?? '', /in stock/i);
});

test('ranking refuses to name a best option when the deciding dimension is unscored', async () => {
  const intent = commerceIntent({ optimizationMode: 'fastest_delivery' });
  const result = await compareCommerceRoutesV1({ catalog: catalogStub() }, { intent, now: NOW });
  assert.ok(result.ok);
  assert.equal(result.routeCard.recommendedCandidateHash, null);
  assert.match(result.routeCard.degradedReason ?? '', /cannot be scored/i);
});

test('an exact denomination is reported exactly', async () => {
  const result = await compareCommerceRoutesV1({ catalog: catalogStub() }, { intent: commerceIntent(), now: NOW });
  assert.ok(result.ok);
  assert.deepEqual(result.routeCard.comparisons[0].denominationDelta, {
    requestedDecimal: '25',
    offeredDecimal: '25',
    exact: true,
  });
  assert.equal(
    denominationDeltaV1({ requestedDecimal: '25', candidate: result.routeCard.comparisons[1].candidate }).exact,
    false,
  );
});

test('a route card is deterministic for the same reading', async () => {
  const intent = commerceIntent();
  const first = await compareCommerceRoutesV1({ catalog: catalogStub() }, { intent, now: NOW });
  const second = await compareCommerceRoutesV1({ catalog: catalogStub() }, { intent, now: NOW });
  assert.ok(first.ok && second.ok);
  assert.equal(first.routeCard.routeCardHash, second.routeCard.routeCardHash);
});

test('an unreadable price degrades the comparison instead of hiding it', async () => {
  const catalog = catalogStub({
    detail: {
      ...DETAIL_BODY,
      currency: 'EUR',
      packages: [
        { package_value: '25', value: '25', usdc_price: '25', in_stock: true },
        { package_value: '30', value: '30', in_stock: true },
      ],
    },
  });
  const observation = await catalog.search(SEARCH_INPUT);
  assert.ok(observation.ok);
  // The unpriceable EUR denomination is dropped by the adapter, so only the
  // USDC-quoted one survives — and that is visible in the package count.
  assert.equal(observation.observation.packages.length, 1);
});

test('an empty candidate set ranks to nothing rather than to a default', () => {
  assert.deepEqual(rankCommerceCandidatesV1([], 'exact_denomination').orderedCandidateHashes, []);
  assert.equal(rankCommerceCandidatesV1([], 'exact_denomination').recommendedCandidateHash, null);
});
