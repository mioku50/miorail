import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { dividendCalendarV1, type DividendTokenV1 } from '@mioagent/rwa-market-reality/dividends';

import { DividendCalendarCard } from '../src/console/DividendCalendarCard';
import { dividendCalendarViewV1 } from '../src/console/dividendCalendarView';

// The test runner compiles JSX with the classic transform: React.createElement.
void React;

const WAD = '1000000000000000000';

function token(symbol: string, key: string, over: Partial<DividendTokenV1> = {}): DividendTokenV1 {
  return {
    tokenAddress: `0xb2${symbol.toLowerCase().padEnd(38, '0').replace(/[^0-9a-f]/g, '0')}`,
    tokenSymbol: `${symbol}c`,
    underlyingKey: key,
    symbol,
    company: symbol,
    reading: { multiplierWad: WAD, readAt: '2026-09-27T03:18:00.000Z' },
    changes: [],
    scheduled: [],
    supplyAtRecord: {},
    priceNow: 100,
    ...over,
  };
}

/** Production on 2026-09-27, as the calendar reads it. */
const CALENDAR = dividendCalendarV1({
  now: new Date('2026-09-27T12:00:00.000Z'),
  tokens: [
    token('GOOGL', 'security:isin:US02079K3059', {
      reading: { multiplierWad: '1000377118676784179', readAt: '2026-09-27T03:18:00.000Z' },
      changes: [{ fromWad: WAD, toWad: '1000377118676784179', at: '2026-09-14T18:29:21.000Z', confirmed: true, priceAt: 347.1 }],
      supplyAtRecord: { '2026-09-07': '6113.6938' },
      priceNow: 350,
    }),
    token('META', 'security:isin:US30303M1027', { supplyAtRecord: { '2026-09-21': '2951.4838' }, priceNow: 749 }),
    token('AAPL', 'security:isin:US0378331005', { supplyAtRecord: { '2026-08-10': '0' }, priceNow: 340 }),
    token('NVDA', 'security:isin:US67066G1040', { supplyAtRecord: { '2026-09-10': '4200' }, priceNow: 225 }),
    token('TSLA', 'security:isin:US88160R1014'),
  ],
});

describe('Dividends on Base, on the Stocks board', () => {
  test('the next payment first, what the company declared kept apart from what reached the token', () => {
    const view = dividendCalendarViewV1(CALENDAR)!;
    assert.deepEqual(view.rows.map((row) => row.symbol), ['META', 'NVDA', 'AAPL', 'GOOGL']);
    const [meta, nvidia, apple, alphabet] = view.rows;
    assert.equal(meta!.next, '$0.525 · Sep 28');
    assert.equal(meta!.state, 'Declared');
    assert.equal(meta!.effect, '≈ +0.042% META per METAc, about $0.312 a token (estimate)');
    assert.deepEqual(meta!.source, { label: "META's release", href: 'https://www.prnewswire.com/news-releases/meta-announces-quarterly-cash-dividend-302875821.html' });
    assert.equal(nvidia!.next, '$0.25 · Oct 1');
    // Not declared yet: an estimate, and called one.
    assert.equal(apple!.next, '≈ $0.27 · around Nov 12');
    assert.equal(apple!.state, 'Estimate');
    assert.equal(apple!.source, null);
    assert.equal(apple!.last, 'Aug 13: $0.27 paid, not owed — AAPLc had no supply on the record date.');
    assert.equal(alphabet!.last, 'Sep 14: +0.038% GOOGL per GOOGLc, worth $0.131 — 59.5% of the $0.22 declared.');
    assert.equal(view.none, 'No dividend on record: TSLA.');
    assert.match(view.note, /59\.5% of a dividend has reached a token so far \(GOOGL, Sep 14\)/);
  });

  test('nothing at all when no stock has a dividend on record', () => {
    assert.equal(dividendCalendarViewV1(null), null);
    assert.equal(dividendCalendarViewV1({ ...CALENDAR, stocks: CALENDAR.stocks.filter((stock) => stock.symbol === 'TSLA') }), null);
  });

  test('the card shows three before "Show all", links the release, and colours nothing', () => {
    const view = dividendCalendarViewV1(CALENDAR)!;
    const html = renderToStaticMarkup(<DividendCalendarCard view={view} />);
    assert.match(html, /<section class="panel" aria-label="Dividends on Base">/);
    assert.equal(html.match(/<tr>/g)?.length, 4, 'a header and three rows');
    assert.match(html, /<button type="button" class="btn sec">Show all 4<\/button>/);
    assert.match(html, /<a href="https:\/\/www\.prnewswire\.com\/[^"]+" target="_blank" rel="noreferrer">META&#x27;s release<\/a>/);
    assert.doesNotMatch(html, /data-tone="(good|bad|warn)"/);
  });
});
