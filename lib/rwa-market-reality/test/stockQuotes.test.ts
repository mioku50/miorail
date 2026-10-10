import assert from 'node:assert/strict';
import test from 'node:test';

import { stockQuotesV1, type StockQuoteStockV1 } from '../src/stockQuotes.js';

const NOW = new Date('2026-10-03T14:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const stock = (overrides: Partial<StockQuoteStockV1> = {}): StockQuoteStockV1 => ({
  tokenAddress: TOKEN,
  underlyingKey: 'security:isin:US67066G1040',
  tokenSymbol: 'NVDAc',
  companyName: 'NVIDIA Corporation',
  iconPath: `/api/public/stocks/icons/${TOKEN}.png`,
  ...overrides,
});

test('a price is the median of the last three runs, so one stray quote is not the headline', () => {
  const [row] = stockQuotesV1({
    now: NOW,
    stocks: [stock()],
    prices: [
      { token: TOKEN, at: hoursAgo(2.5), mid: 234 },
      { token: TOKEN, at: hoursAgo(1.5), mid: 236 },
      // A broken quote, 6% away from its neighbours.
      { token: TOKEN.toUpperCase().replace('0X', '0x'), at: hoursAgo(0.5), mid: 250 },
    ],
  }).rows;
  assert.equal(row!.priceUsd, 236);
  assert.equal(row!.priceAt, hoursAgo(0.5));
});

test('the 24-hour change is taken against runs near 24 hours ago, and is null without them', () => {
  const prices = [
    { token: TOKEN, at: hoursAgo(24.5), mid: 200 },
    { token: TOKEN, at: hoursAgo(23.8), mid: 202 },
    { token: TOKEN, at: hoursAgo(1), mid: 210 },
  ];
  const [row] = stockQuotesV1({ now: NOW, stocks: [stock()], prices }).rows;
  assert.equal(row!.priceUsd, 210);
  assert.ok(Math.abs(row!.change24h! - (210 / 201 - 1)) < 1e-12);
  assert.equal(row!.changeFromAt, hoursAgo(23.8));

  const [fresh] = stockQuotesV1({
    now: NOW,
    stocks: [stock()],
    prices: [{ token: TOKEN, at: hoursAgo(1), mid: 210 }],
  }).rows;
  assert.equal(fresh!.change24h, null);
  assert.equal(fresh!.changeFromAt, null);
});

test('no run inside three hours is no price, never zero and never an old one', () => {
  const [row] = stockQuotesV1({
    now: NOW,
    stocks: [stock()],
    prices: [
      { token: TOKEN, at: hoursAgo(5), mid: 210 },
      // From the future: a clock skew must not become the current price.
      { token: TOKEN, at: new Date(NOW.getTime() + 60_000).toISOString(), mid: 999 },
    ],
  }).rows;
  assert.equal(row!.priceUsd, null);
  assert.equal(row!.priceAt, null);
  assert.equal(row!.change24h, null);
  // The rest of the row still names the stock.
  assert.equal(row!.companyName, 'NVIDIA Corporation');
  assert.match(row!.iconPath!, /\.png$/);
});

test('every listed stock gets a row, priced or not, in the order given', () => {
  const other = '0xb2000000000000000000009426b660396ebcf343';
  const result = stockQuotesV1({
    now: NOW,
    stocks: [stock({ tokenAddress: other, underlyingKey: 'security:isin:US85238K1007' }), stock()],
    prices: [{ token: TOKEN, at: hoursAgo(1), mid: 210 }],
  });
  assert.equal(result.schemaVersion, 'stock-quotes/v1');
  assert.equal(result.asOf, NOW.toISOString());
  assert.deepEqual(
    result.rows.map((row) => [row.tokenAddress, row.priceUsd]),
    [
      [other, null],
      [TOKEN, 210],
    ],
  );
});

test('what the server sends is what the client accepts', async () => {
  const { StockQuotesResponseV1Schema } = await import('../src/stockQuotes.js');
  const response = stockQuotesV1({
    now: NOW,
    stocks: [stock(), stock({ tokenAddress: `0x${'2'.repeat(40)}`, iconPath: null, companyName: null, tokenSymbol: null })],
    prices: [
      { token: TOKEN, at: hoursAgo(24), mid: 200 },
      { token: TOKEN, at: hoursAgo(1), mid: 210 },
    ],
  });
  assert.deepEqual(StockQuotesResponseV1Schema.parse(response), response);
  // An icon path the server never builds is refused before it reaches an <img>.
  assert.equal(
    StockQuotesResponseV1Schema.safeParse({
      ...response,
      rows: [{ ...response.rows[0], iconPath: 'https://example.com/x.png' }],
    }).success,
    false,
  );
});

test('a price whose $1,000 round trip loses a fifth or more is a thin market, measured from the same runs', () => {
  // PFEc on 2026-10-10: $100 at $143.21 / $143.06, then $1,000 bought at
  // $180.33 and sold at $143.03, a 20.7% loss, while Pfizer traded at $28.
  const thin = stockQuotesV1({
    now: NOW,
    stocks: [stock()],
    prices: [
      { token: TOKEN, at: hoursAgo(2.5), mid: 143.1, buyAt1k: 180.33, sellAt1k: 143.03 },
      { token: TOKEN, at: hoursAgo(1.5), mid: 143.1, buyAt1k: 181, sellAt1k: 143 },
      { token: TOKEN, at: hoursAgo(0.5), mid: 143.1, buyAt1k: null, sellAt1k: null },
    ],
  }).rows[0]!;
  // Medians: round trip of 2068 and 2099; a $1,000 buy 26% above the $100 price.
  assert.deepEqual(thin.depth, { state: 'thin', roundTripLossBps: 2084, buyMoveBps: 2625, sellMoveBps: 6, measuredAt: hoursAgo(1.5) });
  // The price itself is still the measurement; what is shown is the screen's call.
  assert.equal(thin.priceUsd, 143.1);

  const deep = stockQuotesV1({
    now: NOW,
    stocks: [stock()],
    prices: [{ token: TOKEN, at: hoursAgo(0.5), mid: 336.5, buyAt1k: 336.46, sellAt1k: 336.54 }],
  }).rows[0]!;
  assert.equal(deep.depth?.state, 'normal');
  // A spread that keeps 83.5% is a wide market, not a thin one (LIc, NIOc).
  const wide = stockQuotesV1({
    now: NOW,
    stocks: [stock()],
    prices: [{ token: TOKEN, at: hoursAgo(0.5), mid: 11.55, buyAt1k: 12.58, sellAt1k: 10.5 }],
  }).rows[0]!;
  assert.deepEqual(wide.depth, { state: 'normal', roundTripLossBps: 1653, buyMoveBps: 892, sellMoveBps: 909, measuredAt: hoursAgo(0.5) });

  // PFEc an hour later: the round trip at 19.4%, just under the line, while
  // a $1,000 buy still paid 24% more than a $100 one. One side is enough.
  const oneSided = stockQuotesV1({
    now: NOW,
    stocks: [stock()],
    prices: [{ token: TOKEN, at: hoursAgo(0.5), mid: 143.13, buyAt1k: 177.6, sellAt1k: 143.13 }],
  }).rows[0]!;
  assert.deepEqual(oneSided.depth, { state: 'thin', roundTripLossBps: 1941, buyMoveBps: 2408, sellMoveBps: 0, measuredAt: hoursAgo(0.5) });

  const unmeasured = stockQuotesV1({
    now: NOW,
    stocks: [stock()],
    prices: [{ token: TOKEN, at: hoursAgo(0.5), mid: 18.33 }],
  }).rows[0]!;
  assert.deepEqual(unmeasured.depth, { state: 'unmeasured', roundTripLossBps: null, buyMoveBps: null, sellMoveBps: null, measuredAt: null });
});
