import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { marketRouter, marketRuntime } from './market.js';
import { readMarketSnapshotV1, resetMarketSnapshotCacheV1, parseCoinGeckoMarketRowV1 } from '../lib/marketSnapshot.js';

// A detonator on the global fetch: the provider seam is injected, so a test
// that forgets to stub it fails loudly instead of calling CoinGecko for real.
globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// T65.2A §5/§6 — the market rail's server side.
//
// What these hold in place: a price is READ or it is absent, the API key never
// appears in a response, and a cached answer keeps its own observedAt so an old
// number can never be shown as a current one.
// ---------------------------------------------------------------------------

const KEY = 'cg-demo-key-not-a-real-one';
const NOW = new Date('2026-07-26T21:00:00.000Z');
const original = { ...marketRuntime };
const originalEnv = { provider: process.env.PRICE_PROVIDER, key: process.env.COINGECKO_API_KEY };

function marketRow(overrides: Record<string, unknown> = {}) {
  return [
    {
      id: 'ethereum',
      symbol: 'eth',
      current_price: 3182.44,
      price_change_percentage_1h_in_currency: -0.4213,
      sparkline_in_7d: { price: [3100, 3150, 3182.44] },
      last_updated: '2026-07-26T20:59:31.000Z',
      ...overrides,
    },
  ];
}

let responses: Array<{ status: number; body: unknown } | Error>;
let requested: string[];

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/market', marketRouter);
  return instance;
}

beforeEach(() => {
  resetMarketSnapshotCacheV1();
  responses = [{ status: 200, body: marketRow() }];
  requested = [];
  process.env.PRICE_PROVIDER = 'coingecko';
  process.env.COINGECKO_API_KEY = KEY;
  marketRuntime.now = () => NOW;
  marketRuntime.read = readMarketSnapshotV1;
  marketRuntime.fetch = (async (url: unknown) => {
    requested.push(String(url));
    const next = responses.shift() ?? { status: 200, body: marketRow() };
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  Object.assign(marketRuntime, original);
  resetMarketSnapshotCacheV1();
  if (originalEnv.provider === undefined) delete process.env.PRICE_PROVIDER;
  else process.env.PRICE_PROVIDER = originalEnv.provider;
  if (originalEnv.key === undefined) delete process.env.COINGECKO_API_KEY;
  else process.env.COINGECKO_API_KEY = originalEnv.key;
});

describe('the market snapshot is a real read', () => {
  test('a live read returns the price, the 1h change, the age and the provider', async () => {
    const response = await request(app()).get('/api/market/snapshot');
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'snapshot');
    assert.equal(response.body.status, 'live');
    assert.equal(response.body.asset, 'ETH');
    assert.equal(response.body.price, '3182.44');
    assert.equal(response.body.changePercent1h, '-0.42');
    assert.deepEqual(response.body.points, [3100, 3150, 3182.44]);
    // The PROVIDER's timestamp, not the moment we asked.
    assert.equal(response.body.observedAt, '2026-07-26T20:59:31.000Z');
    assert.equal(response.body.provider, 'coingecko');
  });

  test('the API key is sent to CoinGecko and appears in NO response', async () => {
    const response = await request(app()).get('/api/market/snapshot');
    assert.ok(requested[0]?.includes('x_cg_demo_api_key='), 'the key must reach the provider');
    assert.ok(!JSON.stringify(response.body).includes(KEY), 'the key must never be echoed back');
    // …and the request asks for exactly what the rail shows.
    assert.ok(requested[0]?.includes('price_change_percentage=1h'));
    assert.ok(requested[0]?.includes('ids=ethereum'));
  });

  test('a second call inside the TTL does not spend another provider call', async () => {
    await request(app()).get('/api/market/snapshot');
    const second = await request(app()).get('/api/market/snapshot');
    assert.equal(requested.length, 1, 'the free-tier allowance is not spent per page render');
    assert.equal(second.body.status, 'cached');
    assert.equal(second.body.observedAt, '2026-07-26T20:59:31.000Z');
  });

  test('a provider outage with nothing cached shows no price at all', async () => {
    responses = [{ status: 503, body: {} }];
    const response = await request(app()).get('/api/market/snapshot');
    assert.equal(response.body.outcome, 'unavailable');
    assert.equal(response.body.reason, 'provider_unavailable');
    assert.match(response.body.detail, /shows no price rather than an old one/);
    assert.equal(response.body.price, undefined);
  });

  test('rate limiting is named, not disguised as an outage', async () => {
    responses = [{ status: 429, body: {} }];
    const response = await request(app()).get('/api/market/snapshot');
    assert.equal(response.body.reason, 'rate_limited');
  });

  test('a response Miorail cannot read is refused, not coerced', async () => {
    responses = [{ status: 200, body: [{ current_price: 'a lot' }] }];
    const response = await request(app()).get('/api/market/snapshot');
    assert.equal(response.body.reason, 'provider_invalid_response');
  });

  test('an outage AFTER a good read serves the old snapshot, marked and dated', async () => {
    marketRuntime.now = () => NOW;
    await request(app()).get('/api/market/snapshot');
    // Past the TTL, so the cache is not simply reused — the read is retried.
    marketRuntime.now = () => new Date(NOW.getTime() + 120_000);
    responses = [{ status: 500, body: {} }];
    const response = await request(app()).get('/api/market/snapshot');
    assert.equal(response.body.outcome, 'snapshot');
    assert.equal(response.body.status, 'cached', 'a stale reading must say so');
    // Its OWN observedAt, which is what makes the age visible on the surface.
    assert.equal(response.body.observedAt, '2026-07-26T20:59:31.000Z');
  });

  test('a deployment priced by another provider says so instead of reading CoinGecko', async () => {
    process.env.PRICE_PROVIDER = 'moralis';
    const response = await request(app()).get('/api/market/snapshot');
    assert.equal(response.body.reason, 'not_configured');
    assert.equal(requested.length, 0, 'a source this server was told not to use is not called');
  });

  test('a missing key still reads the public tier rather than failing', async () => {
    delete process.env.COINGECKO_API_KEY;
    const response = await request(app()).get('/api/market/snapshot');
    assert.equal(response.body.outcome, 'snapshot');
    assert.ok(!requested[0]?.includes('x_cg_demo_api_key='));
  });
});

describe('the provider row is validated field by field', () => {
  test('a missing 1h change is null, never zero', () => {
    const parsed = parseCoinGeckoMarketRowV1(marketRow({ price_change_percentage_1h_in_currency: null }), NOW);
    assert.equal(parsed?.changePercent1h, null);
  });

  test('a missing sparkline is an empty series, never a drawn guess', () => {
    const parsed = parseCoinGeckoMarketRowV1(marketRow({ sparkline_in_7d: undefined }), NOW);
    assert.deepEqual(parsed?.points, []);
  });

  test('a non-positive or non-finite price is refused', () => {
    for (const price of [0, -1, Number.NaN, '3182.44', null]) {
      assert.equal(parseCoinGeckoMarketRowV1(marketRow({ current_price: price }), NOW), null, `${String(price)} must be refused`);
    }
  });

  test('an absent provider timestamp falls back to our clock, which cannot understate age', () => {
    const parsed = parseCoinGeckoMarketRowV1(marketRow({ last_updated: undefined }), NOW);
    assert.equal(parsed?.observedAt, NOW.toISOString());
  });

  test('an empty or non-array payload is refused', () => {
    assert.equal(parseCoinGeckoMarketRowV1([], NOW), null);
    assert.equal(parseCoinGeckoMarketRowV1({ ethereum: { usd: 3182 } }, NOW), null);
  });
});
