import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  STOCK_CHART_DAYS_V1,
  StockChartResponseV1Schema,
  stockChartBaseOnlyV1,
  stockChartV1,
} from '../src/stockChart.js';
import { stockQuotesV1 } from '../src/stockQuotes.js';
import { etInstantV1 } from '../src/weekendMarket.js';

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const OTHER = '0xb200000000000000000000aaaaaaaaaaaaaaaaaaaa';

const et = (localDate: string, clock: string): Date => {
  const [hour, minute] = clock.split(':').map(Number);
  return etInstantV1(localDate, hour! * 60 + minute!);
};

/** Runs every `everyMinutes` from `from` to `to`, priced by `mid(index)`. */
function runs(from: Date, to: Date, everyMinutes: number, mid: (index: number) => number, token = TOKEN) {
  const out: { token: string; at: string; mid: number }[] = [];
  for (let at = from.getTime(), index = 0; at <= to.getTime(); at += everyMinutes * 60_000, index += 1) {
    out.push({ token, at: new Date(at).toISOString(), mid: mid(index) });
  }
  return out;
}

describe('a week on the stock card', () => {
  test('each point is the price the card would have shown at the end of that hour', () => {
    const now = et('2026-10-07', '12:00');
    const prices = runs(new Date(now.getTime() - 8 * 86_400_000), now, 20, (index) => 100 + index * 0.01);
    const chart = stockChartV1({ now, tokenAddress: TOKEN, prices });
    assert.equal(chart.schemaVersion, 'stock-chart/v1');
    StockChartResponseV1Schema.parse(chart);
    // One point per hour of the week, and no more.
    assert.ok(chart.points.length >= STOCK_CHART_DAYS_V1 * 24 - 1 && chart.points.length <= STOCK_CHART_DAYS_V1 * 24 + 1);
    // The last point is the card's own price, by the card's own rule.
    const card = stockQuotesV1({
      now,
      prices,
      stocks: [{ tokenAddress: TOKEN, underlyingKey: 'k', tokenSymbol: null, companyName: null, iconPath: null }],
    }).rows[0]!.priceUsd!;
    assert.equal(chart.points[chart.points.length - 1]!.mid, Math.round(card * 10_000) / 10_000);
    assert.equal(chart.points[chart.points.length - 1]!.at, now.toISOString());
  });

  test('one stray quote does not become a spike', () => {
    const now = et('2026-10-07', '12:00');
    const prices = runs(new Date(now.getTime() - 86_400_000), now, 20, (index) => (index === 30 ? 140 : 100));
    const chart = stockChartV1({ now, tokenAddress: TOKEN, prices });
    assert.ok(chart.points.every((point) => point.mid === 100));
  });

  test('an hour with no run of its own has no point, and another token never leaks in', () => {
    const now = et('2026-10-07', '12:00');
    const before = runs(new Date(now.getTime() - 48 * 3_600_000), new Date(now.getTime() - 30 * 3_600_000), 60, () => 100);
    const after = runs(new Date(now.getTime() - 10 * 3_600_000), now, 60, () => 101);
    const other = runs(new Date(now.getTime() - 30 * 3_600_000), new Date(now.getTime() - 10 * 3_600_000), 30, () => 900, OTHER);
    const chart = stockChartV1({ now, tokenAddress: TOKEN.toUpperCase().replace('0X', '0x'), prices: [...before, ...after, ...other] });
    assert.ok(chart.points.every((point) => point.mid === 100 || point.mid === 101));
    const gap = chart.points.filter(
      (point) => Date.parse(point.at) > now.getTime() - 29 * 3_600_000 && Date.parse(point.at) < now.getTime() - 11 * 3_600_000,
    );
    assert.deepEqual(gap, []);
    assert.equal(chart.tokenAddress, TOKEN);
  });

  test('nothing measured is no points, never a line at zero', () => {
    const chart = stockChartV1({ now: et('2026-10-07', '12:00'), tokenAddress: TOKEN, prices: [] });
    assert.deepEqual(chart.points, []);
  });
});

describe('when only Base traded', () => {
  test('the weekend is marked from Friday 20:00 ET to Sunday 20:00 ET', () => {
    const now = et('2026-10-07', '12:00');
    assert.deepEqual(stockChartBaseOnlyV1(new Date(now.getTime() - 7 * 86_400_000), now), [
      { from: et('2026-10-02', '20:00').toISOString(), to: et('2026-10-04', '20:00').toISOString() },
    ]);
  });

  test('a holiday Friday is marked from Thursday evening, from the reviewed calendar', () => {
    // Christmas 2026 is a Friday: the close is Thursday's, at 13:00 ET.
    const now = et('2026-12-29', '12:00');
    assert.deepEqual(stockChartBaseOnlyV1(new Date(now.getTime() - 7 * 86_400_000), now), [
      { from: et('2026-12-24', '20:00').toISOString(), to: et('2026-12-27', '20:00').toISOString() },
    ]);
  });

  test('a weekend still running is marked up to now', () => {
    const now = et('2026-10-03', '12:00');
    const bands = stockChartBaseOnlyV1(new Date(now.getTime() - 7 * 86_400_000), now);
    assert.deepEqual(bands[bands.length - 1], { from: et('2026-10-02', '20:00').toISOString(), to: now.toISOString() });
  });

  test('a weeknight is not marked: the overnight session trades', () => {
    const now = et('2026-10-01', '12:00');
    const from = et('2026-09-28', '12:00');
    assert.deepEqual(stockChartBaseOnlyV1(from, now), []);
  });
});
