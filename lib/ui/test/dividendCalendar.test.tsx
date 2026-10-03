import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { dividendWalletConversionsV1, dividendWalletKeyV1, dividendWalletV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import { DIVIDEND_DECLARATIONS_V1, dividendCalendarV1, type DividendTokenV1 } from '@mioagent/rwa-market-reality/dividends';

import { DividendCalendarCard } from '../src/console/DividendCalendarCard';
import { dividendCalendarViewV1, myDividendsViewV1 } from '../src/console/dividendCalendarView';

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
    // Miorail does not read Tesla's releases: its gap, said as one, never "no dividend".
    assert.equal(view.none, null);
    assert.equal(
      view.unread,
      'Miorail reads the dividend releases of AAPL, GOOGL, META and NVDA. For the other stock on this board it shows a dividend only when Coinbase posts a notice in the token before paying it.',
    );
    assert.match(view.note, /median measured share.*59\.5%, from GOOGL Sep 14: 59\.5%/);
    assert.match(view.note, /historical reference price/);
    assert.doesNotMatch(view.note, /latest reference price/);
  });

  test('the estimate basis names all conversions rather than attributing a median to one stock', () => {
    const view = dividendCalendarViewV1({ ...CALENDAR, passThrough: {
      percent: '51.2', measuredOn: [
        { symbol: 'GOOGL', payDate: '2026-09-14', percent: '59.5' },
        { symbol: 'META', payDate: '2026-09-28', percent: '43.0' },
      ],
    } })!;
    assert.match(view.note, /51\.2%, from GOOGL Sep 14: 59\.5%; META Sep 28: 43\.0%/);
    assert.match(view.note, /not a fixed withholding rate or fee/);
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

/** A wallet with 4 GOOGLc (2.5 of them before Alphabet's dividend converted),
 * 1 METAc and 3 TSLAc. */
function walletOf(held: Record<string, number>, before: Record<string, number>) {
  const address = (symbol: string) => CALENDAR.stocks.find((stock) => stock.symbol === symbol)!.tokenAddress;
  const units = (amount: number) => BigInt(Math.round(amount * 1e8));
  return dividendWalletV1({
    calendar: CALENDAR,
    now: new Date('2026-09-27T12:00:00.000Z'),
    blockNumber: 51_000_000,
    decimals: new Map(CALENDAR.stocks.map((stock) => [stock.tokenAddress, 8])),
    balances: new Map(CALENDAR.stocks.map((stock) => [stock.tokenAddress, units(held[stock.symbol] ?? 0)])),
    balancesBefore: new Map(
      dividendWalletConversionsV1(CALENDAR).map((row) => {
        const symbol = CALENDAR.stocks.find((stock) => stock.tokenAddress === row.tokenAddress)!.symbol;
        return [dividendWalletKeyV1(address(symbol), row.at), units(before[symbol] ?? 0)] as const;
      }),
    ),
  });
}


test('"No dividend on record" only where Miorail reads the releases; the rest are "not read"', () => {
  // Sixty stocks on the board and five companies read: the board once said
  // "No dividend on record" for Pfizer, which pays one every quarter.
  const calendar = dividendCalendarV1({
    now: new Date('2026-09-27T12:00:00.000Z'),
    declarations: DIVIDEND_DECLARATIONS_V1.filter((row) => row.symbol !== 'MSFT'),
    tokens: [
      token('GOOGL', 'security:isin:US02079K3059', { supplyAtRecord: { '2026-09-07': '6113.6938' } }),
      token('MSFT', 'security:isin:US5949181045'),
      token('PFE', 'security:isin:US7170811035'),
    ],
  });
  const view = dividendCalendarViewV1(calendar)!;
  assert.equal(view.none, 'No dividend on record: MSFT.');
  assert.equal(
    view.unread,
    'Miorail reads the dividend releases of GOOGL and MSFT. For the other stock on this board it shows a dividend only when Coinbase posts a notice in the token before paying it.',
  );
  assert.match(renderToStaticMarkup(<DividendCalendarCard view={view} />), /<p class="lnote">Miorail reads the dividend releases of GOOGL and MSFT\./);
});

describe('Your dividends, for a signed-in wallet', () => {
  const MINE = walletOf({ GOOGL: 4, META: 1, TSLA: 3 }, { GOOGL: 2.5 });

  test('what is ahead on what it holds, and what already reached it', () => {
    const view = myDividendsViewV1({ data: MINE, failed: false })!;
    assert.deepEqual(
      view.rows.map((row) => [row.title, row.lines]),
      [
        ['METAc · 1 held', ['Sep 28: about $0.312 on your 1 METAc (estimate) — META declared $0.525 a share.']],
        [
          'GOOGLc · 4 held',
          [
            'Around Dec 14: about $0.524 on your 4 GOOGLc — an estimate, GOOGL has not declared it yet.',
            'Sep 14: $0.327 reinvested — 0.00094 more GOOGL shares on the 2.5 GOOGLc you held.',
          ],
        ],
        ['TSLAc · 3 held', ["Not read: Miorail does not read TSLA's dividend releases yet."]],
      ],
    );
    assert.equal(view.total, 'Reinvested into your tokens so far: $0.327.');
    // A sliver of a token: a bound, not "about" one.
    const sliver = myDividendsViewV1({ data: walletOf({ META: 0.0009 }, {}), failed: false })!;
    assert.equal(sliver.rows[0]?.lines[0], 'Sep 28: less than $0.001 on your 0.0009 METAc (estimate) — META declared $0.525 a share.');
    // ...which stays in the record and does not lead the holding (2026-10-03).
    assert.equal(sliver.rows[0]?.lead, null);
    assert.equal(sliver.total, null);
    // A sum worth a cent or more leads; a holding Miorail does not read leads
    // with nothing rather than with "Not read".
    assert.deepEqual(
      view.rows.map((row) => row.lead),
      [
        'Sep 28: about $0.312 on your 1 METAc (estimate) — META declared $0.525 a share.',
        'Around Dec 14: about $0.524 on your 4 GOOGLc — an estimate, GOOGL has not declared it yet.',
        null,
      ],
    );
    assert.equal(view.empty, null);
    assert.equal(view.note, 'A dividend reaches whoever holds the token when its multiplier moves, not on the record date.');
  });

  test('nothing before the first answer; a failed read and an empty wallet each say so', () => {
    assert.equal(myDividendsViewV1(null), null);
    assert.equal(myDividendsViewV1({ data: null, failed: false }), null);
    assert.equal(myDividendsViewV1({ data: null, failed: true })?.empty, 'Your dividends could not be read just now.');
    assert.equal(myDividendsViewV1({ data: walletOf({}, {}), failed: false })?.empty, 'This wallet holds none of these stocks.');
    // Signed out: the board has no section for it at all.
    assert.equal(dividendCalendarViewV1(CALENDAR)!.mine, null);
  });

  test('the card puts it above the board', () => {
    const view = dividendCalendarViewV1(CALENDAR, { data: MINE, failed: false })!;
    const html = renderToStaticMarkup(<DividendCalendarCard view={view} />);
    assert.match(html, /<div class="mr-utility-group" aria-label="Your dividends"><h4>Your dividends<\/h4>/);
    assert.match(html, /<strong>GOOGLc · 4 held<\/strong>/);
    assert.ok(html.indexOf('Your dividends') < html.indexOf('<table class="dividend-table">'));
    // On a phone an empty "Last" is not drawn; the marker is what hides it.
    assert.match(html, /<td class="lnote dividend-last" data-empty="">—<\/td>/);
  });
});

describe('a dividend notice in the token', () => {
  const AEO = token('AEO', 'security:isin:US02553E1064', {
    notices: [
      {
        at: '2026-10-03T00:38:13.000Z',
        announcementId: '4bc6:pre',
        description: 'Cash Dividend',
        transactionHash: `0x${'1'.padStart(64, '0')}`,
        carriedChange: false,
      },
    ],
  });
  const now = new Date('2026-10-04T12:00:00.000Z');
  const calendar = dividendCalendarV1({ now, tokens: [AEO], declarations: [] });

  test('a company Miorail does not read gets a row from the notice, with no amount', () => {
    const view = dividendCalendarViewV1(calendar)!;
    assert.ok(view);
    const row = view.rows[0]!;
    assert.equal(row.symbol, 'AEO');
    assert.equal(row.next, 'Amount and date not published');
    assert.equal(row.state, 'Notice in the token');
    assert.equal(row.notice, 'Coinbase posted “Cash Dividend” in the AEOc contract on Oct 3.');
    assert.equal(view.unread, null);
    const html = renderToStaticMarkup(<DividendCalendarCard view={view} all />);
    assert.match(html, /Coinbase posted “Cash Dividend” in the AEOc contract on Oct 3\./);
    assert.doesNotMatch(html, /\$\d/);
  });

  test('a holder reads the notice first, and it says who receives it', () => {
    const wallet = dividendWalletV1({
      calendar,
      now,
      blockNumber: 52100000,
      decimals: new Map([[AEO.tokenAddress, 8]]),
      balances: new Map([[AEO.tokenAddress, 300000000n]]),
      balancesBefore: new Map(),
    });
    const mine = myDividendsViewV1({ data: wallet, failed: false })!;
    assert.equal(
      mine.rows[0]!.lead,
      'Coinbase posted “Cash Dividend” in the AEOc contract on Oct 3. It reaches whoever holds AEOc when it converts; the amount is not published yet.',
    );
  });
});
