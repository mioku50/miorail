import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BITREFILL_MCP_TOKEN_URL_V1,
  BITREFILL_MCP_URL_V1,
  STILL_BITREFILL_CLIENT_ID_V1,
  ToonParseError,
  createBitrefillGuestCatalogV1,
  decodeToonV1,
} from '../src/index.js';

// Shapes as Bitrefill's MCP answered on 2026-11-01. Reviews carry public
// authors' names, so the fixture's two rows are made up; the packages and
// prices are as read.
const SEARCH_V1 = `categories[1]{count,highlighted,value}:
  192,esim,esim
products[2]:
  - _id: bitrefill-esim-germany
    categories[1]: esim
    countries[1]: DE
    currency: USD
    in_stock: true
    keywords[4]: data,internet,mobile data,Deutschland
    name: Bitrefill eSIM Germany
    slug: bitrefill-esim-germany
    type: esims
    product_url: "https://www.bitrefill.com/bitrefill-esim-germany/"
  - _id: bitrefill-esim-europe
    categories[1]: esim
    countries[3]: AT,DE,FR
    currency: USD
    in_stock: true
    name: Bitrefill eSIM Europe
    slug: bitrefill-esim-europe
    type: esims
found: 192
page: 1
per_page: 2`;

const DETAIL_V1 = `id: bitrefill-esim-germany
name: Bitrefill eSIM Germany
country_code: DE
currency: USD
categories[1]: esim
recipient_type: mixed
in_stock: true
ratings:
  rating_value: 4.7
  rating_count: 31
  score_distribution[5]: 1,0,1,4,25
reviews[2]{content,score,score_max,author_name,created_time,date}:
  "Fast, and it \\"just worked\\",\\nthank you.",5,5,A reader,"2026-10-21T19:39:14.679Z",2026-10-21
  It is okay,3,5,Another reader,"2024-07-28T07:51:50.000Z",2024-07-28
packages[4]{package_value,package_currency,payment_price,payment_currency}:
  "1GB, 7 Days",USD,"2.53",USDC
  "10GB, 30 Days",USD,"13.25",USDC
  "Unlimited, 5 Days",USD,"20.00",USDC
  "5GB, 30 Days",USD,"8.38",EUR
url: "https://www.bitrefill.com/bitrefill-esim-germany/"
subtitles: Get instant mobile data in Germany.
descriptions: "\\n  <p>Stay in touch</p>\\n"`;

function rpc(text: string, isError = false): Response {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } });
  return new Response(`event: message\ndata: ${body}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function bitrefill(answers: Array<(url: string, init: RequestInit) => Response>) {
  const calls: Array<{ url: string; body: string; auth: string | null; accept: string | null }> = [];
  let next = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, body: String(init.body ?? ''), auth: headers.get('authorization'), accept: headers.get('accept') });
    const answer = answers[next++];
    if (!answer) throw new Error(`unexpected call ${url}`);
    return answer(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const token = (value = 'guest-token-0123456789') => () => new Response(JSON.stringify({ access_token: value, token_type: 'bearer', expires_in: 21600, scope: 'mcp' }), { status: 200 });

describe('TOON as Bitrefill speaks it', () => {
  it('reads lists, tables, inline arrays, nested objects and escaped strings', () => {
    const search = decodeToonV1(SEARCH_V1) as { products: Array<Record<string, unknown>>; categories: unknown[]; found: number };
    assert.equal(search.found, 192);
    assert.deepEqual(search.categories, [{ count: 192, highlighted: 'esim', value: 'esim' }]);
    assert.deepEqual(search.products[1], { _id: 'bitrefill-esim-europe', categories: ['esim'], countries: ['AT', 'DE', 'FR'], currency: 'USD', in_stock: true, name: 'Bitrefill eSIM Europe', slug: 'bitrefill-esim-europe', type: 'esims' });
    const detail = decodeToonV1(DETAIL_V1) as {
      ratings: { rating_value: number; score_distribution: number[] };
      reviews: Array<{ content: string; date: string }>;
      packages: Array<Record<string, unknown>>;
      subtitles: string;
    };
    assert.equal(detail.ratings.rating_value, 4.7);
    assert.deepEqual(detail.ratings.score_distribution, [1, 0, 1, 4, 25]);
    assert.equal(detail.reviews[0].content, 'Fast, and it "just worked",\nthank you.');
    assert.equal(detail.reviews[1].date, '2024-07-28');
    assert.deepEqual(detail.packages[0], { package_value: '1GB, 7 Days', package_currency: 'USD', payment_price: '2.53', payment_currency: 'USDC' });
    assert.equal(detail.subtitles, 'Get instant mobile data in Germany.');
  });

  it('a count that does not match, odd indentation, a duplicate key or a bad escape is a failed read', () => {
    assert.throws(() => decodeToonV1('items[2]: a'), ToonParseError);
    assert.throws(() => decodeToonV1('rows[2]{a,b}:\n  1,2'), /table expects 2 rows, found 1/);
    assert.throws(() => decodeToonV1('rows[1]{a,b}:\n  1,2,3'), /row has 3 cells for 2 fields/);
    assert.throws(() => decodeToonV1('a:\n   b: 1'), /two spaces/);
    assert.throws(() => decodeToonV1('a: 1\na: 2'), /duplicate key a/);
    assert.throws(() => decodeToonV1('a: "\\q"'), /unknown escape/);
    assert.throws(() => decodeToonV1('just text'), /expected `key: value`/);
  });
});

describe('Still reads Bitrefill’s catalogue as a guest', () => {
  it('gets a guest token with Still’s client document, then calls only the read tool', async () => {
    const { fetchImpl, calls } = bitrefill([token(), () => rpc(SEARCH_V1)]);
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl });
    const found = await catalog.search({ type: 'esim', country: 'DE' });
    assert.deepEqual(found, { ok: true, value: [
      { id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', countries: ['DE'], inStock: true },
      { id: 'bitrefill-esim-europe', name: 'Bitrefill eSIM Europe', countries: ['AT', 'DE', 'FR'], inStock: true },
    ] });
    assert.equal(calls[0]!.url, BITREFILL_MCP_TOKEN_URL_V1);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0]!.body)), {
      grant_type: 'client_credentials', client_id: STILL_BITREFILL_CLIENT_ID_V1, scope: 'mcp', resource: BITREFILL_MCP_URL_V1,
    });
    assert.equal(calls[1]!.url, BITREFILL_MCP_URL_V1);
    assert.equal(calls[1]!.auth, 'Bearer guest-token-0123456789');
    assert.equal(calls[1]!.accept, 'application/json, text/event-stream');
    const body = JSON.parse(calls[1]!.body);
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'search-products');
    assert.deepEqual([body.params.arguments.country, body.params.arguments.product_type, body.params.arguments.query], ['DE', 'esim', '*']);
  });

  it('a client registered at Bitrefill sends its id and secret to the token endpoint only, as client_secret_post', async () => {
    const { fetchImpl, calls } = bitrefill([token(), () => rpc(SEARCH_V1)]);
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl, clientId: '00000000-0000-4000-8000-000000000001', clientSecret: 'fixture-secret-never-production' });
    assert.equal((await catalog.search({ type: 'esim', country: 'DE' })).ok, true);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0]!.body)), {
      grant_type: 'client_credentials', client_id: '00000000-0000-4000-8000-000000000001', client_secret: 'fixture-secret-never-production', scope: 'mcp', resource: BITREFILL_MCP_URL_V1,
    });
    assert.ok(!calls[1]!.body.includes('fixture-secret') && calls[1]!.auth === 'Bearer guest-token-0123456789', 'the MCP call carries the token, never the secret');
  });

  it('keeps only packages priced in USDC, and never the reviews or the HTML', async () => {
    const { fetchImpl } = bitrefill([token(), () => rpc(DETAIL_V1)]);
    const product = await createBitrefillGuestCatalogV1({ fetchImpl }).product('bitrefill-esim-germany');
    assert.deepEqual(product, { ok: true, value: {
      id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', country: 'DE', inStock: true, recipientType: 'mixed',
      packages: [
        { value: '1GB, 7 Days', faceCurrency: 'USD', priceUsdc: '2.53' },
        { value: '10GB, 30 Days', faceCurrency: 'USD', priceUsdc: '13.25' },
        { value: 'Unlimited, 5 Days', faceCurrency: 'USD', priceUsdc: '20.00' },
      ],
      url: 'https://www.bitrefill.com/bitrefill-esim-germany/',
    } });
  });

  it('reuses its token, asks again once after a 401, and names each failure as ours or theirs', async () => {
    let at = 0;
    const { fetchImpl, calls } = bitrefill([
      token('first-token-0123456789'), () => rpc(SEARCH_V1),
      () => new Response('', { status: 401 }), token('second-token-0123456789'), () => rpc(SEARCH_V1),
      () => new Response('{"status":"rate_limit_reached"}', { status: 429 }),
      () => rpc('product_not_found: no such product', true),
      () => rpc('id: other-product\nname: Other'),
      () => rpc('this is not toon at all'),
      () => { throw new TypeError('network down'); },
    ]);
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl, now: () => at });
    assert.equal((await catalog.search({ type: 'esim', country: 'DE' })).ok, true);
    assert.equal((await catalog.search({ type: 'esim', country: 'DE' })).ok, true);
    assert.deepEqual(calls.map((call) => call.url === BITREFILL_MCP_TOKEN_URL_V1 ? 'token' : 'mcp'), ['token', 'mcp', 'mcp', 'token', 'mcp']);
    assert.equal(calls[4]!.auth, 'Bearer second-token-0123456789');
    assert.deepEqual(await catalog.search({ type: 'esim', country: 'DE' }), { ok: false, reason: 'bitrefill_rate_limited' });
    assert.deepEqual(await catalog.product('missing-thing'), { ok: false, reason: 'bitrefill_product_not_found' });
    assert.deepEqual(await catalog.product('bitrefill-esim-germany'), { ok: false, reason: 'bitrefill_invalid_response' }, 'another product is not this one');
    assert.deepEqual(await catalog.search({ type: 'refill', country: 'DE' }), { ok: false, reason: 'bitrefill_invalid_response' });
    assert.deepEqual(await catalog.search({ type: 'giftcard', country: 'DE' }), { ok: false, reason: 'bitrefill_unreachable' });
    // Input that cannot be a country or a slug never reaches Bitrefill.
    const before = calls.length;
    assert.deepEqual(await catalog.search({ type: 'esim', country: 'de' }), { ok: false, reason: 'bitrefill_refused' });
    assert.deepEqual(await catalog.product('../buy-products'), { ok: false, reason: 'bitrefill_product_not_found' });
    assert.equal(calls.length, before);
    at += 1;
  });

  it('keeps Bitrefill’s own words when it will not let Still in, or refuses a call outright', async () => {
    // As Bitrefill answered on 2026-11-02, when every read and invoice failed with the words dropped.
    const shut = bitrefill([() => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'client_id metadata document URL is not trusted by this authorization server' }),
      { status: 400, headers: { 'content-type': 'application/json' } })]);
    assert.deepEqual(await createBitrefillGuestCatalogV1({ fetchImpl: shut.fetchImpl, now: () => 1_000 }).product('mobile-legends-international'),
      { ok: false, reason: 'bitrefill_guest_refused', detail: 'invalid_client: client_id metadata document URL is not trusted by this authorization server' });
    const down = bitrefill([() => new Response('<html><body>Bad gateway</body></html>', { status: 502 })]);
    assert.deepEqual(await createBitrefillGuestCatalogV1({ fetchImpl: down.fetchImpl, now: () => 1_000 }).product('mobile-legends-international'),
      { ok: false, reason: 'bitrefill_unreachable', detail: 'Bad gateway' });

    const refusing = bitrefill([
      token(), () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid arguments: package_value' } }), { status: 400 }),
      () => new Response('', { status: 401 }), token('second-token-0123456789'), () => new Response('<html><body>Unauthorized</body></html>', { status: 401 }),
    ]);
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl: refusing.fetchImpl, now: () => 1_000 });
    assert.deepEqual(await catalog.product('mobile-legends-international'), { ok: false, reason: 'bitrefill_refused', detail: 'Invalid arguments: package_value' });
    // A fresh token refused as well is Bitrefill not letting Still in at all.
    assert.deepEqual(await catalog.product('mobile-legends-international'), { ok: false, reason: 'bitrefill_guest_refused', detail: 'Unauthorized' });
  });

  it('stays under Bitrefill’s limit by itself', async () => {
    const answers = [token(), ...Array.from({ length: 5 }, () => () => rpc(SEARCH_V1))];
    const { fetchImpl } = bitrefill(answers);
    const catalog = createBitrefillGuestCatalogV1({ fetchImpl, perMinute: 3, now: () => 1_000 });
    assert.equal((await catalog.search({ type: 'esim', country: 'DE' })).ok, true);
    assert.equal((await catalog.search({ type: 'esim', country: 'DE' })).ok, true);
    assert.deepEqual(await catalog.search({ type: 'esim', country: 'DE' }), { ok: false, reason: 'bitrefill_rate_limited' });
  });
});
