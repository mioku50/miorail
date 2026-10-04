import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WeekendMarketCard } from '../src/console/WeekendMarketCard';
import type { WeekendMarketViewV1 } from '../src/console/weekendMarketView';

void React;

function view(count: number): WeekendMarketViewV1 {
  return {
    state: 'in_progress',
    title: 'The weekend on Base',
    badge: 'Wall Street closed',
    lede: 'Wall Street is closed until Sun 20:00 ET.',
    columns: { close: 'Friday close', base: 'On Base now', reopen: null },
    rows: Array.from({ length: count }, (_, index) => ({
      key: `row-${index}`,
      symbol: `S${index}`,
      name: `Stock ${index}`,
      close: '$100.00',
      base: '$101.00',
      move: '+1.00%',
      reopen: null,
      gap: null,
      mark: null,
      off: false,
      icon: index === 0 ? '/api/public/stocks/icons/0xb2.png' : null,
      bar: { side: index % 2 ? 'down' : 'up', share: 1 / (index + 1) },
    })),
    note: 'Where a market trades over the weekend is not a forecast of where it reopens.',
    share: { x: 'https://x.com/intent/tweet?text=t', farcaster: 'https://farcaster.xyz/~/compose?text=t' },
  };
}

test('the weekend card folds to the five biggest moves, and offers the rest', () => {
  const html = renderToStaticMarkup(<WeekendMarketCard view={view(10)} />);
  assert.equal((html.match(/<tr>/g) ?? []).length, 1 + 5);
  assert.match(html, /Show all 10/);
  assert.match(html, /Post on X/);
  assert.match(html, /not a forecast/);
});

test('a row wears its icon and its move as a bar on the side it moved', () => {
  const html = renderToStaticMarkup(<WeekendMarketCard view={view(2)} />);
  assert.match(html, /<img class="mr-choice-icon" src="\/api\/public\/stocks\/icons\/0xb2\.png"/);
  assert.match(html, /<span class="mr-choice-icon" aria-hidden="true"><\/span>/, 'no icon keeps the space');
  assert.match(html, /<span class="mr-wk-bar" data-side="up" aria-hidden="true"><span style="width:50%"><\/span><\/span>/);
  assert.match(html, /<span class="mr-wk-bar" data-side="down" aria-hidden="true"><span style="width:25%"><\/span><\/span>/);
  assert.match(html, /<span class="pill br">Wall Street closed<\/span>/);
});

test('five or fewer rows need no fold', () => {
  const html = renderToStaticMarkup(<WeekendMarketCard view={view(4)} />);
  assert.equal((html.match(/<tr>/g) ?? []).length, 1 + 4);
  assert.doesNotMatch(html, /Show all/);
});
