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
    columns: { base: 'On Base now', reopen: null },
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

test('five or fewer rows need no fold', () => {
  const html = renderToStaticMarkup(<WeekendMarketCard view={view(4)} />);
  assert.equal((html.match(/<tr>/g) ?? []).length, 1 + 4);
  assert.doesNotMatch(html, /Show all/);
});
