import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { WeekendMarketResponseV1 } from '@mioagent/rwa-market-reality/weekend-market';
import { signedPercentV1, weekendMarketViewV1 } from '../src/console/weekendMarketView';

const WINDOW = {
  closeAt: '2026-09-18T20:00:00.000Z',
  darkStartAt: '2026-09-19T00:00:00.000Z',
  expectedReopenAt: '2026-09-21T00:00:00.000Z',
  nextSessionCloseAt: '2026-09-21T20:00:00.000Z',
};

function stock(symbol: string, overrides: Partial<WeekendMarketResponseV1['stocks'][number]> = {}) {
  return {
    tokenAddress: `0xb2${symbol.toLowerCase().padEnd(38, '0').slice(0, 38)}`.replace(/[^0-9a-fx]/g, '0'),
    symbol,
    name: `${symbol} Inc.`,
    close: '222.37',
    base: { value: '221.30', moveBps: -48, samples: 6, from: '2026-09-20T17:00:00.000Z', to: '2026-09-20T23:00:00.000Z' },
    reopen: null,
    unavailable: null,
    ...overrides,
  } as WeekendMarketResponseV1['stocks'][number];
}

// Numbers from the Sep 18 weekend on production, read 2026-09-25.
const IN_PROGRESS: WeekendMarketResponseV1 = {
  schemaVersion: 'weekend-market/v1',
  state: 'in_progress',
  generatedAt: '2026-09-20T23:00:00.000Z',
  window: WINDOW,
  stocks: [
    stock('SNDK', { close: '1734.99', base: { value: '1773.75', moveBps: 223, samples: 6, from: WINDOW.darkStartAt, to: WINDOW.expectedReopenAt } }),
    stock('MSTR', { close: '153.56', base: { value: '156.10', moveBps: 166, samples: 6, from: WINDOW.darkStartAt, to: WINDOW.expectedReopenAt } }),
    stock('AMZN', { close: '254.66', base: { value: '253.31', moveBps: -53, samples: 6, from: WINDOW.darkStartAt, to: WINDOW.expectedReopenAt } }),
    stock('MSFT', { base: null, unavailable: 'too_few_measurements' }),
  ],
  called: null,
};

describe('the weekend card', () => {
  test('in progress: where the tokens trade against Friday, and when Wall Street reopens', () => {
    const view = weekendMarketViewV1(IN_PROGRESS, { now: new Date('2026-09-20T23:00:00.000Z'), origin: 'https://miorail.xyz' });
    assert.ok(view);
    assert.equal(view.state, 'in_progress');
    assert.match(view.lede, /closed until Sun 20:00 ET \(in 1 h\)/);
    assert.deepEqual(
      view.rows.map((row) => [row.symbol, row.close, row.base, row.move]),
      [
        ['SNDK', '$1,734.99', '$1,773.75', '+2.23%'],
        ['MSTR', '$153.56', '$156.10', '+1.66%'],
        ['AMZN', '$254.66', '$253.31', '−0.53%'],
        // A stock with too few runs keeps its row and says why.
        ['MSFT', '$222.37', '—', 'too few measurements'],
      ],
    );
    assert.equal(view.rows[3]?.off, true);
    assert.equal(view.columns.reopen, null);
    // The share text names the three biggest moves and links the board.
    const x = new URL(view.share.x);
    assert.match(x.searchParams.get('text') ?? '', /SNDK \+2\.23%, MSTR \+1\.66%, AMZN −0\.53%/);
    assert.equal(x.searchParams.get('url'), 'https://miorail.xyz/stocks');
  });

  test('reopened: where it reopened, and which side Base had been on', () => {
    const view = weekendMarketViewV1(
      {
        ...IN_PROGRESS,
        state: 'reopened',
        stocks: [
          stock('SNDK', { reopen: { value: '1803.13', at: '2026-09-21T00:11:00.000Z', gapBps: 393, sameDirection: true }, base: { value: '1773.75', moveBps: 223, samples: 6, from: WINDOW.darkStartAt, to: WINDOW.expectedReopenAt } }),
          stock('META', { reopen: { value: '671.70', at: '2026-09-21T00:18:00.000Z', gapBps: -24, sameDirection: false } }),
          stock('AAPL', { reopen: { value: '335.49', at: '2026-09-21T00:01:00.000Z', gapBps: 1, sameDirection: null } }),
        ],
        called: { sameDirection: 1, meaningful: 2 },
      },
      { now: new Date('2026-09-21T13:30:00.000Z'), origin: 'https://miorail.xyz' },
    );
    assert.ok(view);
    assert.equal(view.state, 'reopened');
    // The earliest print names the reopen.
    assert.match(view.lede, /printed again Sun 20:01 ET\. Before it did, Base was on the same side of Friday's close as the reopen for 1 of 2 stocks with a clear gap\./);
    assert.deepEqual(
      view.rows.map((row) => [row.symbol, row.reopen, row.gap, row.mark]),
      [
        ['SNDK', '$1,803.13', '+3.93%', 'Base was on the same side'],
        ['META', '$671.70', '−0.24%', 'Base was on the other side'],
        ['AAPL', '$335.49', '+0.01%', 'no clear gap'],
      ],
    );
  });

  test('nothing to show is nothing on the board', () => {
    const now = { now: new Date(), origin: 'https://miorail.xyz' };
    assert.equal(weekendMarketViewV1(null, now), null);
    assert.equal(weekendMarketViewV1({ ...IN_PROGRESS, state: 'none', window: null, stocks: [] }, now), null);
    // A quiet period with no measured stock is not a card of dashes.
    assert.equal(
      weekendMarketViewV1({ ...IN_PROGRESS, stocks: [stock('MSFT', { base: null, unavailable: 'too_few_measurements' })] }, now),
      null,
    );
  });

  test('the card never calls a weekend price a forecast', () => {
    const view = weekendMarketViewV1(IN_PROGRESS, { now: new Date('2026-09-20T23:00:00.000Z'), origin: 'https://miorail.xyz' })!;
    const words = [view.title, view.lede, view.note, decodeURIComponent(view.share.x)].join(' ');
    assert.match(view.note, /not a forecast/);
    assert.doesNotMatch(words, /\bpredict|will open|expected to open|signal/i);
  });

  test('a signed percent reads the way a price move is written', () => {
    assert.equal(signedPercentV1(223), '+2.23%');
    assert.equal(signedPercentV1(-5), '−0.05%');
    assert.equal(signedPercentV1(0), '0.00%');
  });
});
