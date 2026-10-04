import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { StockChartResponseV1 } from '@mioagent/rwa-market-reality/stock-chart';

import { STOCK_CHART_MIN_POINTS_V1, stockChartViewV1 } from '../src/console/stockChartView';

const FROM = Date.parse('2026-09-30T16:00:00.000Z');
const NOW = Date.parse('2026-10-07T16:00:00.000Z');
const HOUR = 3_600_000;

function chartOf(
  mids: readonly (number | null)[],
  baseOnly: StockChartResponseV1['baseOnly'] = [],
): StockChartResponseV1 {
  const points = mids.flatMap((mid, index) =>
    mid === null ? [] : [{ at: new Date(NOW - (mids.length - 1 - index) * HOUR).toISOString(), mid }],
  );
  return {
    schemaVersion: 'stock-chart/v1',
    tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c',
    asOf: new Date(NOW).toISOString(),
    from: new Date(FROM).toISOString(),
    points,
    baseOnly,
  };
}

describe('the week on the stock card', () => {
  test('too few points draw nothing, rather than a shape that says nothing', () => {
    assert.equal(stockChartViewV1(null, 'NVIDIA'), null);
    assert.equal(stockChartViewV1(chartOf(Array(STOCK_CHART_MIN_POINTS_V1 - 1).fill(100)), 'NVIDIA'), null);
    assert.ok(stockChartViewV1(chartOf(Array(STOCK_CHART_MIN_POINTS_V1).fill(100)), 'NVIDIA'));
  });

  test('a missed pass is a gap, not a line through a price nobody measured', () => {
    const mids = [...Array(20).fill(100), ...Array(6).fill(null), ...Array(20).fill(101)];
    const view = stockChartViewV1(chartOf(mids), 'NVIDIA')!;
    assert.equal((view.path.match(/M/g) ?? []).length, 2);
    // Every coordinate stays inside the box.
    for (const [, x, y] of view.path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
      assert.ok(Number(x) >= 0 && Number(x) <= 100 && Number(y) >= 0 && Number(y) <= 40, `${x},${y}`);
    }
  });

  test('a flat week is a flat line in the middle', () => {
    const view = stockChartViewV1(chartOf(Array(30).fill(100)), 'NVIDIA')!;
    const ys = [...view.path.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((match) => Number(match[1]));
    assert.ok(ys.every((y) => y === 20));
    assert.equal(view.low, '$100.00');
    assert.equal(view.high, '$100.00');
  });

  test('the low and the high are the line’s own, and the label says the week in words', () => {
    const view = stockChartViewV1(chartOf([...Array(20).fill(100), 96.5, ...Array(10).fill(104.25)]), 'NVIDIA')!;
    assert.equal(view.low, '$96.50');
    assert.equal(view.high, '$104.25');
    assert.equal(
      view.label,
      'NVIDIA on Base over 7 days, hourly: from $100.00 to $104.25, low $96.50, high $104.25.',
    );
  });

  test('the weekend band sits where the weekend was, and only then does the caption explain shading', () => {
    const band = { from: '2026-10-03T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' };
    const view = stockChartViewV1(chartOf(Array(30).fill(100), [band]), 'NVIDIA')!;
    assert.equal(view.baseOnly.length, 1);
    const expectedX = ((Date.parse(band.from) - FROM) / (NOW - FROM)) * 100;
    assert.ok(Math.abs(view.baseOnly[0]!.x - expectedX) < 0.01);
    assert.ok(Math.abs(view.baseOnly[0]!.width - (2 / 7) * 100) < 0.02);
    assert.match(view.caption, /Shaded: Wall Street was closed/);
    assert.doesNotMatch(stockChartViewV1(chartOf(Array(30).fill(100)), 'NVIDIA')!.caption, /Shaded/);
  });
});
