import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarketRealityScreen, type MarketRealityScreenModelV1 } from '../src/console/MarketRealityScreen';
import {
  STOCKS_SECTION_PATHS_V1,
  stocksSectionOfSegmentV1,
  stocksSectionTabsV1,
  type StocksSectionV1,
} from '../src/console/stocksSections';
import { weekendQuietViewV1 } from '../src/console/weekendMarketView';

// The test runner compiles JSX with the classic transform: React.createElement.
void React;

const WEEKEND = {
  state: 'in_progress' as const,
  title: 'The weekend on Base',
  badge: 'Wall Street closed',
  lede: 'Wall Street is closed until Sun 20:00 ET.',
  columns: { close: 'Friday close', base: 'On Base now', reopen: null },
  rows: [],
  note: '',
  share: { x: '', farcaster: '' },
};

function screen(over: Partial<MarketRealityScreenModelV1> & { section?: StocksSectionV1 | null } = {}): string {
  const { section = 'market', ...rest } = over;
  const visited: StocksSectionV1[] = [];
  const model: MarketRealityScreenModelV1 = {
    choices: [],
    choicesLoading: false,
    choicesError: null,
    counters: [],
    selectedKey: null,
    direction: 'sell',
    requestedCashAtomic: '1000000000',
    surface: 'market',
    historyPeriod: 'now',
    view: null,
    viewLoading: false,
    viewError: null,
    history: null,
    historyLoading: false,
    historyError: null,
    measuring: false,
    measurementNote: null,
    measurementError: null,
    watchedTokenAddresses: [],
    watchingTokenAddress: null,
    removingWatchTokenAddress: null,
    watchError: null,
    sections:
      section === null
        ? null
        : {
            current: section,
            onSection: (next) => visited.push(next),
            tabs: stocksSectionTabsV1({ unread: 2, weekendLive: true, href: (key) => STOCKS_SECTION_PATHS_V1[key] }),
          },
    actions: {
      onUnderlying: () => undefined,
      onDirection: () => undefined,
      onSize: () => undefined,
      onSurface: () => undefined,
      onHistoryPeriod: () => undefined,
    },
    ...rest,
  };
  return renderToStaticMarkup(<MarketRealityScreen model={model} />);
}

describe('Stocks in four tabs', () => {
  test('the bar is four links, the current one marked, with words for news', () => {
    const html = screen();
    assert.match(html, /<nav class="tabbar mr-sections" aria-label="Stocks">/);
    assert.match(html, /<a href="\/stocks" class="item on" aria-current="page">Market<\/a>/);
    assert.match(html, /<a href="\/stocks\/mine" class="item">My stocks<span class="n"> · 2 new<\/span><\/a>/);
    assert.match(html, /<a href="\/stocks\/dividends" class="item">Dividends<\/a>/);
    assert.match(html, /<a href="\/stocks\/weekend" class="item">Weekend<span class="n"> · live<\/span><\/a>/);
  });

  test('without addresses the tabs are buttons, as in the Base App', () => {
    const tabs = stocksSectionTabsV1({ unread: null, weekendLive: false });
    assert.deepEqual(
      tabs.map((tab) => [tab.label, tab.note, tab.href]),
      [
        ['Market', null, null],
        ['My stocks', null, null],
        ['Dividends', null, null],
        ['Weekend', null, null],
      ],
    );
    assert.equal(stocksSectionTabsV1({ unread: 3, unreadMore: true, weekendLive: false })[1]!.note, '3+ new');
  });

  test('the market tab shows the board and nothing from the other tabs', () => {
    const html = screen({ weekend: WEEKEND });
    assert.match(html, /Pick a security above\./);
    assert.match(html, /How we know this/);
    assert.doesNotMatch(html, /Wall Street is closed until/);
  });

  test('the weekend tab shows the weekend and not the board', () => {
    const html = screen({ section: 'weekend', weekend: WEEKEND });
    assert.match(html, /Wall Street is closed until Sun 20:00 ET\./);
    assert.doesNotMatch(html, /Pick a security above|How we know this/);
  });

  test('between weekends the weekend tab says when the next one starts', () => {
    const quiet = weekendQuietViewV1(new Date('2026-10-07T15:00:00.000Z'));
    assert.equal(
      quiet.lede,
      "Wall Street is open now. It closes for the weekend Fri 20:00 ET (in 2 d 9 h). From then until the reopen, these tokens keep trading on Base, and this tab shows where they trade against Friday's close, then where they reopened.",
    );
    const html = screen({ section: 'weekend', weekend: null, weekendQuiet: quiet });
    assert.match(html, /It closes for the weekend Fri 20:00 ET/);
  });

  test('my stocks, signed out, says what it holds and offers the way in', () => {
    const html = screen({
      section: 'mine',
      visitor: { title: 'Reading without a wallet', body: '', action: 'Sign in', onSignIn: () => undefined },
    });
    assert.match(html, /<h3>Your stocks<\/h3>/);
    assert.match(html, /<button type="button" class="btn">Sign in<\/button>/);
    // The visitor note belongs to the board, not to a second copy here.
    assert.doesNotMatch(html, /Reading without a wallet/);
  });

  test('the dividends tab says it is reading rather than showing an empty page', () => {
    assert.match(screen({ section: 'dividends', dividends: null }), /Reading the dividend calendar…/);
  });

  test('with no tabs every part is on one page, as before', () => {
    const html = screen({ section: null, weekend: WEEKEND });
    assert.doesNotMatch(html, /mr-sections/);
    assert.match(html, /Wall Street is closed until/);
    assert.match(html, /Pick a security above\./);
  });
});

describe('a path names a tab or a ticker', () => {
  test('three words are tabs; the market is the bare path; anything else is a ticker', () => {
    assert.equal(stocksSectionOfSegmentV1('dividends'), 'dividends');
    assert.equal(stocksSectionOfSegmentV1('Weekend'), 'weekend');
    assert.equal(stocksSectionOfSegmentV1('mine'), 'mine');
    assert.equal(stocksSectionOfSegmentV1('market'), null);
    assert.equal(stocksSectionOfSegmentV1('nvda'), null);
    assert.equal(stocksSectionOfSegmentV1(null), null);
  });
});
