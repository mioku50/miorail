import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { WeekendMarketResponseV1, WeekendMarketStockV1 } from '@mioagent/rwa-market-reality/weekend-market';

import { renderCardPngV1 } from './cardImage.js';
import { weekendCardSvgV1, weekendCardV1 } from './weekendCard.js';

const WINDOW = {
  closeAt: '2026-09-25T20:00:00.000Z',
  darkStartAt: '2026-09-26T00:00:00.000Z',
  expectedReopenAt: '2026-09-28T00:00:00.000Z',
  nextSessionCloseAt: '2026-09-28T20:00:00.000Z',
};

function stock(symbol: string, close: string | null, base: [string, number] | null, reopen?: [string, number, boolean | null] | null): WeekendMarketStockV1 {
  return {
    tokenAddress: `0x${'0'.repeat(38)}${symbol.length.toString(16).padStart(2, '0')}`,
    symbol,
    name: `${symbol} Inc.`,
    close,
    base: base ? { value: base[0], moveBps: base[1], samples: 6, from: WINDOW.darkStartAt, to: '2026-09-26T07:40:00.000Z' } : null,
    reopen: reopen ? { value: reopen[0], at: '2026-09-28T00:01:00.000Z', gapBps: reopen[1], sameDirection: reopen[2] } : null,
    unavailable: base ? null : 'too_few_measurements',
  };
}

// Numbers from the board on 2026-09-26, as the operator's screenshot shows it.
const IN_PROGRESS: WeekendMarketResponseV1 = {
  schemaVersion: 'weekend-market/v1',
  state: 'in_progress',
  generatedAt: '2026-09-26T07:40:00.000Z',
  window: WINDOW,
  stocks: [
    stock('META', '752.77', ['745.26', -100]),
    stock('NVDA', '225.41', ['224.63', -35]),
    stock('SNDK', '1777.22', ['1771.13', -34]),
    stock('TSLA', '372.37', ['371.60', -21]),
    stock('AAPL', '341.51', ['340.87', -19]),
    stock('AMZN', '231.10', ['230.95', -6]),
    stock('SPCX', '101.00', null),
  ],
  called: null,
};

describe('the picture under a shared weekend post', () => {
  test('in progress: the biggest moves against Friday, and when they were measured', () => {
    const card = weekendCardV1(IN_PROGRESS)!;
    assert.equal(card.state, 'in_progress');
    assert.equal(card.asOf, 'Sat 03:40 ET');
    assert.equal(card.badge, 'Wall Street closed');
    assert.equal(card.lede, 'Wall Street is closed until Sun 20:00 ET. These tokens keep trading on Base.');
    assert.deepEqual(
      card.rows.map((row) => [row.symbol, row.close, row.base, row.last]),
      [
        ['META', '$752.77', '$745.26', '−1.00%'],
        ['NVDA', '$225.41', '$224.63', '−0.35%'],
        ['SNDK', '$1,777.22', '$1,771.13', '−0.34%'],
        ['TSLA', '$372.37', '$371.60', '−0.21%'],
        ['AAPL', '$341.51', '$340.87', '−0.19%'],
      ],
    );
    // Five drawn of six measured, and the picture says so. The unmeasured
    // stock is neither drawn nor counted as measured.
    assert.match(card.footer, /^5 of 6 stocks · median of \$100 quotes, last 6 h · miorail\.xyz\/stocks$/);
    // The page description is the post's own sentence, with its clock.
    assert.match(card.description, /As of Sat 03:40 ET: META −1\.00%, NVDA −0\.35%, SNDK −0\.34% against Friday's close/);
    assert.match(card.alt, /as of Sat 03:40 ET/);
  });

  test('reopened: the gap at the reopen, and which side Base had been on', () => {
    const card = weekendCardV1({
      ...IN_PROGRESS,
      state: 'reopened',
      generatedAt: '2026-09-28T00:10:00.000Z',
      stocks: [
        stock('META', '752.77', ['745.26', -100], ['747.10', -75, true]),
        stock('SNDK', '1777.22', ['1771.13', -34], ['1790.02', 72, false]),
        stock('AAPL', '341.51', null, ['341.70', 6, null]),
        stock('TSLA', '372.37', ['371.60', -21], null),
      ],
      called: { sameDirection: 1, meaningful: 2 },
    })!;
    assert.equal(card.badge, 'Reopened');
    assert.equal(card.asOf, 'Sun 20:10 ET');
    assert.equal(card.lede, "Base had been on the reopen's side of Friday's close for 1 of 2.");
    assert.deepEqual(
      card.rows.map((row) => [row.symbol, row.base, row.last, row.side]),
      [
        ['META', '−1.00%', '−0.75%', 'same side'],
        ['SNDK', '−0.34%', '+0.72%', 'other side'],
        ['AAPL', '—', '+0.06%', 'no clear gap'],
      ],
    );
    assert.match(card.footer, /a gap under 0\.20% has no side/);
    assert.match(card.description, /for 1 of 2 with a clear gap\. One weekend, not a track record\./);
  });

  test('nothing to draw is no picture: outside a quiet period, or before any reading', () => {
    assert.equal(weekendCardV1({ ...IN_PROGRESS, state: 'none', window: null, stocks: [] }), null);
    assert.equal(weekendCardV1({ ...IN_PROGRESS, stocks: [stock('SPCX', '101.00', null)] }), null);
    assert.equal(weekendCardV1({ ...IN_PROGRESS, state: 'reopened', stocks: [stock('META', '752.77', ['745.26', -100])] }), null);
  });

  test('whatever the corpus names a stock is drawn as text, never as markup', () => {
    const card = weekendCardV1({ ...IN_PROGRESS, stocks: [stock('<a&b>"', '10.00', ['10.10', 100])] })!;
    const svg = weekendCardSvgV1(card);
    assert.match(svg, /&lt;a&amp;b&gt;&quot;/);
    assert.doesNotMatch(svg, /<a&b>/);
  });

  test('the drawing carries its clock, and every number it shows', () => {
    const svg = weekendCardSvgV1(weekendCardV1(IN_PROGRESS)!);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630"/);
    assert.match(svg, />as of Sat 03:40 ET</);
    for (const number of ['$752.77', '$745.26', '−1.00%', '$1,771.13', '−0.19%']) {
      assert.ok(svg.includes(`>${number}<`), number);
    }
    assert.doesNotMatch(svg, /AMZN/, 'the sixth stock is counted, not drawn');
  });

  test('it becomes a 1200 by 630 PNG with the board’s own fonts', async () => {
    const png = await renderCardPngV1(weekendCardSvgV1(weekendCardV1(IN_PROGRESS)!));
    const bytes = Buffer.from(png);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 630);
    // Text drawn with no font at all leaves a near-empty picture.
    assert.ok(bytes.length > 60_000, `only ${bytes.length} bytes`);
  });
});
