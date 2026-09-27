import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DIVIDEND_DECLARATIONS_V1,
  DividendCalendarResponseV1Schema,
  dividendCalendarV1,
  newYorkDateV1,
  recordCloseV1,
  type DividendTokenV1,
} from '../src/dividends.js';

const WAD = '1000000000000000000';
const GOOGL_AFTER = '1000377118676784179';

function token(symbol: string, over: Partial<DividendTokenV1> = {}): DividendTokenV1 {
  const keys: Record<string, string> = {
    AAPL: 'security:isin:US0378331005',
    GOOGL: 'security:isin:US02079K3059',
    META: 'security:isin:US30303M1027',
    MSFT: 'security:isin:US5949181045',
    NVDA: 'security:isin:US67066G1040',
    TSLA: 'security:isin:US88160R1014',
  };
  return {
    tokenAddress: `0xb2${symbol.toLowerCase().padEnd(38, '0').replace(/[^0-9a-f]/g, '0')}`,
    tokenSymbol: `${symbol}c`,
    underlyingKey: keys[symbol]!,
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

/** GOOGLc as production holds it on 2026-09-27. */
const GOOGL = token('GOOGL', {
  reading: { multiplierWad: GOOGL_AFTER, readAt: '2026-09-27T03:18:00.000Z' },
  changes: [{ fromWad: WAD, toWad: GOOGL_AFTER, at: '2026-09-14T18:29:21.000Z', confirmed: true, priceAt: 347.1 }],
  supplyAtRecord: { '2026-09-07': '6113.6938' },
  priceNow: 350,
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const AP = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

/** Every spelling a company press release uses for a date. */
function spellingsV1(date: string): string[] {
  const [year, month, day] = date.split('-').map(Number);
  return [`${MONTHS[month! - 1]} ${day}, ${year}`, `${AP[month! - 1]} ${day}, ${year}`];
}

describe('the declarations are the companies’ own words', () => {
  test('every amount and date appears in the sentence it was read from', () => {
    for (const declaration of DIVIDEND_DECLARATIONS_V1) {
      const label = `${declaration.symbol} ${declaration.payDate}`;
      assert.ok(declaration.source.quote.includes(`$${declaration.amountPerShare} per share`), `${label}: amount`);
      assert.ok(spellingsV1(declaration.payDate).some((s) => declaration.source.quote.includes(s)), `${label}: payment date`);
      assert.ok(spellingsV1(declaration.recordDate).some((s) => declaration.source.quote.includes(s)), `${label}: record date`);
      if (declaration.exDate) {
        assert.ok(spellingsV1(declaration.exDate).some((s) => declaration.source.quote.includes(s)), `${label}: ex-date`);
      }
    }
  });

  test('from an official host, in order, and each one once', () => {
    const hosts = new Set(['www.sec.gov', 'news.microsoft.com', 'www.prnewswire.com']);
    const seen = new Set<string>();
    for (const declaration of DIVIDEND_DECLARATIONS_V1) {
      const label = `${declaration.symbol} ${declaration.payDate}`;
      assert.ok(hosts.has(new URL(declaration.source.url).host), `${label}: host`);
      assert.match(declaration.underlyingKey, /^security:isin:US[0-9A-Z]{9}[0-9]$/);
      assert.ok(declaration.declaredOn <= declaration.recordDate, `${label}: declared before the record date`);
      assert.ok(declaration.recordDate < declaration.payDate, `${label}: record date before payment`);
      if (declaration.exDate) assert.ok(declaration.exDate <= declaration.recordDate, `${label}: ex-date`);
      assert.ok(!seen.has(label), `${label}: listed twice`);
      seen.add(label);
    }
  });

  test('the record date closes at 16:00 in New York, summer or winter', () => {
    assert.equal(recordCloseV1('2026-09-07').toISOString(), '2026-09-07T20:00:00.000Z');
    assert.equal(recordCloseV1('2026-11-19').toISOString(), '2026-11-19T21:00:00.000Z');
    assert.equal(newYorkDateV1(new Date('2026-09-28T02:00:00.000Z')), '2026-09-27');
  });
});

describe('the calendar', () => {
  const NOW = new Date('2026-09-27T12:00:00.000Z');

  test('Alphabet: paid 2026-09-14, and 59.5% of it reached a token the same day', () => {
    const calendar = dividendCalendarV1({ now: NOW, tokens: [GOOGL] });
    assert.doesNotThrow(() => DividendCalendarResponseV1Schema.parse(calendar));
    const stock = calendar.stocks[0]!;
    const paid = stock.history[0]!;
    assert.equal(paid.state, 'effective');
    assert.equal(paid.payDate, '2026-09-14');
    assert.equal(paid.supplyAtRecord, '6113.6938');
    assert.deepEqual(paid.token, {
      kind: 'measured',
      multiplierFrom: WAD,
      multiplierTo: GOOGL_AFTER,
      increasePercent: '0.0377',
      perTokenUsd: '0.1309',
      passThroughPercent: '59.5',
      at: '2026-09-14T18:29:21.000Z',
      priceUsd: '347.10',
    });
    assert.deepEqual(calendar.passThrough, { percent: '59.5', measuredOn: [{ symbol: 'GOOGL', payDate: '2026-09-14', percent: '59.5' }] });
    // Not declared yet: the same again a quarter on, and said to be a guess.
    assert.equal(stock.next?.state, 'estimated');
    assert.equal(stock.next?.payDate, '2026-12-14');
    assert.equal(stock.next?.payDateApproximate, true);
    assert.equal(stock.next?.source, null);
    assert.match(stock.next?.basis ?? '', /Not declared yet\. Alphabet last paid \$0\.22 per share on 2026-09-14/);
    assert.equal(stock.next?.token.kind, 'estimate');
  });

  test('Apple and Microsoft: no supply at the record date, so nothing was owed', () => {
    const calendar = dividendCalendarV1({
      now: NOW,
      tokens: [
        token('AAPL', { supplyAtRecord: { '2026-08-10': '0' } }),
        token('MSFT', { supplyAtRecord: { '2026-08-20': '0' } }),
      ],
    });
    const apple = calendar.stocks.find((stock) => stock.symbol === 'AAPL')!;
    const microsoft = calendar.stocks.find((stock) => stock.symbol === 'MSFT')!;
    assert.equal(apple.history[0]?.state, 'not_entitled');
    assert.equal(apple.history[0]?.token.kind, 'none');
    assert.equal(microsoft.history[0]?.state, 'not_entitled');
    // Microsoft's next one is declared: $0.98 on 2026-12-10, from its own release.
    assert.equal(microsoft.next?.state, 'announced');
    assert.equal(microsoft.next?.amountPerShare, '0.98');
    assert.equal(microsoft.next?.payDate, '2026-12-10');
    assert.match(microsoft.next?.source?.url ?? '', /news\.microsoft\.com\/source\/2026\/09\/15/);
    // Nothing measured yet, so nothing is estimated.
    assert.equal(microsoft.next?.token.kind, 'none');
  });

  test('Meta, the day before it pays: announced, and estimated from what reached GOOGLc', () => {
    const calendar = dividendCalendarV1({
      now: NOW,
      tokens: [GOOGL, token('META', { supplyAtRecord: { '2026-09-21': '2951.4838' }, priceNow: 749 })],
    });
    const meta = calendar.stocks.find((stock) => stock.symbol === 'META')!;
    assert.equal(meta.next?.state, 'announced');
    assert.equal(meta.next?.payDate, '2026-09-28');
    assert.deepEqual(meta.next?.token, {
      kind: 'estimate',
      multiplierFrom: WAD,
      multiplierTo: null,
      increasePercent: '0.0417',
      perTokenUsd: '0.3124',
      passThroughPercent: '59.5',
      at: null,
      priceUsd: '749.00',
    });
    // Soonest payment first.
    assert.deepEqual(calendar.stocks.map((stock) => stock.symbol), ['META', 'GOOGL']);
  });

  test('after the payment: effective once the token moved, and our gap named until we have looked', () => {
    const after = new Date('2026-09-29T12:00:00.000Z');
    const moved = dividendCalendarV1({
      now: after,
      tokens: [
        token('META', {
          reading: { multiplierWad: '1000400000000000000', readAt: '2026-09-29T09:00:00.000Z' },
          changes: [{ fromWad: WAD, toWad: '1000400000000000000', at: '2026-09-28T18:00:00.000Z', confirmed: true, priceAt: 750 }],
          supplyAtRecord: { '2026-09-21': '2951.4838' },
        }),
      ],
    });
    assert.equal(moved.stocks[0]?.history[0]?.state, 'effective');

    const stale = { multiplierWad: WAD, readAt: '2026-09-28T15:00:00.000Z' };
    const fresh = { multiplierWad: WAD, readAt: '2026-09-29T09:00:00.000Z' };
    const state = (over: Partial<DividendTokenV1>) =>
      dividendCalendarV1({ now: after, tokens: [token('META', over)] }).stocks[0]?.history[0];
    assert.deepEqual(
      [state({ reading: stale, supplyAtRecord: { '2026-09-21': '1' } })?.state, state({ reading: stale, supplyAtRecord: { '2026-09-21': '1' } })?.reason],
      ['awaiting_confirmation', 'not_read_since_payment'],
    );
    assert.equal(state({ reading: fresh })?.reason, 'supply_at_record_unread');
    assert.equal(state({ reading: fresh, supplyAtRecord: { '2026-09-21': '1' } })?.state, 'not_reflected');
  });

  test('a change the issuer published ahead is scheduled, then awaits a reading', () => {
    const plan = { multiplierWad: '1000700000000000000', effectiveAt: '2026-10-01T14:00:00.000Z' };
    const nvda = token('NVDA', { scheduled: [plan], supplyAtRecord: { '2026-09-10': '1000' }, priceNow: 225 });
    const before = dividendCalendarV1({ now: new Date('2026-09-30T12:00:00.000Z'), tokens: [nvda] }).stocks[0]!;
    assert.equal(before.next?.state, 'scheduled');
    assert.equal(before.next?.token.kind, 'scheduled');
    assert.equal(before.next?.token.multiplierTo, plan.multiplierWad);
    assert.equal(before.next?.token.increasePercent, '0.0700');
    const matured = dividendCalendarV1({ now: new Date('2026-10-01T15:00:00.000Z'), tokens: [nvda] }).stocks[0]!;
    assert.equal(matured.next?.state, 'awaiting_confirmation');
    assert.equal(matured.next?.reason, 'scheduled_not_confirmed');
  });

  test('a split is not a dividend, and a company with none on record has no next', () => {
    const split = token('GOOGL', {
      changes: [{ fromWad: WAD, toWad: '2000000000000000000', at: '2026-09-14T18:29:21.000Z', confirmed: true, priceAt: 347.1 }],
      supplyAtRecord: { '2026-09-07': '6113.6938' },
    });
    const calendar = dividendCalendarV1({ now: NOW, tokens: [token('TSLA'), split] });
    assert.equal(calendar.stocks[0]?.symbol, 'GOOGL');
    assert.equal(calendar.stocks[0]?.history[0]?.state, 'not_reflected');
    assert.equal(calendar.passThrough.percent, null);
    assert.deepEqual([calendar.stocks[1]?.symbol, calendar.stocks[1]?.next, calendar.stocks[1]?.history], ['TSLA', null, []]);
  });
});
