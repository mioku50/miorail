import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { marketAgeLabelV1, marketRailFromSnapshotV1, type MarketSnapshotLikeV1 } from '../src/index.js';

// ---------------------------------------------------------------------------
// T65.2A §6/§7 — the price rail's copy.
//
// A number on this rail is one the server read. There is no placeholder price,
// no zero standing in for a missing change, and no reading shown without its
// age — a price with no age reads as "now" whether or not it is.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-26T21:00:00.000Z');

const live: MarketSnapshotLikeV1 = {
  outcome: 'snapshot',
  status: 'live',
  price: '3182.44',
  changePercent1h: '-0.42',
  points: [3100, 3150, 3182.44],
  observedAt: '2026-07-26T20:59:31.000Z',
  provider: 'coingecko',
};

describe('the price rail states what was read', () => {
  test('a live snapshot shows the price, the 1h change, the age and the provider', () => {
    const rail = marketRailFromSnapshotV1(live, NOW);
    assert.equal(rail.unavailableReason, null);
    assert.equal(rail.price?.title, 'ETH / USD');
    assert.equal(rail.price?.value, '$3,182.44');
    assert.match(rail.price?.change ?? '', /-0\.42% · 1h/);
    assert.match(rail.price?.change ?? '', /29s ago/);
    assert.match(rail.price?.change ?? '', /coingecko/);
    assert.equal(rail.price?.up, false);
    assert.deepEqual(rail.price?.points, [3100, 3150, 3182.44]);
  });

  test('a rise is marked up and signed', () => {
    const rail = marketRailFromSnapshotV1({ ...live, changePercent1h: '1.5' }, NOW);
    assert.equal(rail.price?.up, true);
    assert.match(rail.price?.change ?? '', /\+1\.50% · 1h/);
  });

  test('a missing 1h change is stated, never rendered as 0%', () => {
    const rail = marketRailFromSnapshotV1({ ...live, changePercent1h: null }, NOW);
    assert.match(rail.price?.change ?? '', /no 1h change reported/);
    assert.ok(!/0\.00%/.test(rail.price?.change ?? ''), 'absence must not become a number');
    assert.equal(rail.price?.up, false);
  });

  test('a cached snapshot carries its real age, so it cannot pass for current', () => {
    const rail = marketRailFromSnapshotV1({ ...live, status: 'cached' }, new Date('2026-07-26T21:20:00.000Z'));
    assert.match(rail.price?.change ?? '', /20m ago/);
  });

  test('an unavailable market shows the server’s reason and NO price', () => {
    const rail = marketRailFromSnapshotV1(
      { outcome: 'unavailable', reason: 'rate_limited', detail: 'CoinGecko is rate limiting this server.' },
      NOW,
    );
    assert.equal(rail.price, null);
    assert.equal(rail.unavailableReason, 'CoinGecko is rate limiting this server.');
  });

  test('before the first answer the rail says it is reading, not that nothing exists', () => {
    assert.deepEqual(marketRailFromSnapshotV1(undefined, NOW), {
      price: null,
      unavailableReason: 'Reading the market…',
    });
    assert.equal(marketRailFromSnapshotV1(null, NOW).price, null);
  });

  test('ages read in the units a person uses', () => {
    assert.equal(marketAgeLabelV1('2026-07-26T20:59:31.000Z', NOW), '29s ago');
    assert.equal(marketAgeLabelV1('2026-07-26T20:50:00.000Z', NOW), '10m ago');
    assert.equal(marketAgeLabelV1('2026-07-26T18:00:00.000Z', NOW), '3h ago');
    // A clock that ran backwards is never a negative age.
    assert.equal(marketAgeLabelV1('2026-07-26T21:00:30.000Z', NOW), '0s ago');
    assert.equal(marketAgeLabelV1('not a date', NOW), 'age unknown');
  });
});
