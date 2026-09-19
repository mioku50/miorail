import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  lendingMarketsViewV1,
  lendingMarketsHeadlineV1,
} from '../src/console/lendingMarketsView';

// ---------------------------------------------------------------------------
// The four NVDAc markets as Morpho published them on 2026-09-19. Three empty
// and uncurated, one curated at 62.5% holding $15,425 against $835 of
// borrowable liquidity. Every one of them satisfies "a market exists".
// ---------------------------------------------------------------------------
const NVDA_MARKETS = [
  { marketId: '0xfef5641f70e19a87e369304daa9ba823754f3db1e6481d757fcae0442cffe479', curated: false, role: 'collateral', collateralAssetSymbol: 'NVDAc', loanAssetSymbol: 'USDC', lltvBps: 7700, collateralUsd: 0, supplyUsd: 0, borrowUsd: 0, liquidityUsd: 0 },
  { marketId: '0xb4b42dd66cef2561000000000000000000000000000000000000000000000000', curated: true, role: 'collateral', collateralAssetSymbol: 'NVDAc', loanAssetSymbol: 'USDC', lltvBps: 6250, collateralUsd: 15_425, supplyUsd: 8_440, borrowUsd: 7_605, liquidityUsd: 835 },
  { marketId: '0x91360eea2686000000000000000000000000000000000000000000000000ffff', curated: false, role: 'collateral', collateralAssetSymbol: 'NVDAc', loanAssetSymbol: 'USDC', lltvBps: 7700, collateralUsd: 11, supplyUsd: 98, borrowUsd: 1, liquidityUsd: 97 },
  { marketId: '0x5c800e8607e9000000000000000000000000000000000000000000000000aaaa', curated: false, role: 'collateral', collateralAssetSymbol: 'NVDAc', loanAssetSymbol: 'USDC', lltvBps: 7700, collateralUsd: 0, supplyUsd: 0, borrowUsd: 0, liquidityUsd: 0 },
];

describe('one lending market at a time', () => {
  test('the curated market is first, whatever order the venue returned', () => {
    // The venue listed the empty uncurated one first. A reader opening this
    // section wants the one they could use, and the old single `marketRef`
    // took index zero — which is how `curated: true` ended up beside the id of
    // an empty market.
    const view = lendingMarketsViewV1({ venueName: 'Morpho', markets: NVDA_MARKETS })!;
    assert.equal(view.rows[0]!.curated, true);
    assert.equal(view.rows[0]!.lltv, '62.5%');
    assert.match(view.rows[0]!.marketId, /^0xb4b42dd66cef2561/);
  });

  test('62.5 is not 62 — the terms are published at the precision the venue used', () => {
    const view = lendingMarketsViewV1({ venueName: 'Morpho', markets: NVDA_MARKETS })!;
    assert.equal(view.rows[0]!.lltv, '62.5%');
    // And a whole number does not grow a decimal it never had.
    const whole = lendingMarketsViewV1({
      venueName: 'Morpho',
      markets: [{ ...NVDA_MARKETS[1]!, lltvBps: 7700 }],
    })!;
    assert.equal(whole.rows[0]!.lltv, '77%');
  });

  test('existing, funded and usable are three different sentences', () => {
    const view = lendingMarketsViewV1({ venueName: 'Morpho', markets: NVDA_MARKETS })!;
    const curated = view.rows.find((row) => row.curated === true)!;
    const stranger = view.rows.find((row) => row.curated === false)!;
    // (1) exists, but nobody's venue put it there.
    assert.match(stranger.note, /Deployed by anyone/);
    // (2) exists, curated, and has money in it.
    assert.match(curated.note, /\$835 available to borrow right now/);
    // (3) is refused by name, in the caveats, for every row at once.
    assert.equal(view.caveats.length, 2);
    assert.match(view.caveats[0]!, /Whether YOU could borrow/);
    assert.match(view.caveats[0]!, /does not answer that/);
  });

  test('a curated market with nothing in it says so instead of looking available', () => {
    const view = lendingMarketsViewV1({
      venueName: 'Morpho',
      markets: [{ ...NVDA_MARKETS[1]!, liquidityUsd: 0 }],
    })!;
    assert.match(view.rows[0]!.note, /nothing is available to borrow right now/);
    assert.equal(view.rows[0]!.tone, 'off');
  });

  test('a figure the venue did not publish is not a zero', () => {
    const view = lendingMarketsViewV1({
      venueName: 'Morpho',
      markets: [{ ...NVDA_MARKETS[1]!, liquidityUsd: null, collateralUsd: null }],
    })!;
    assert.equal(view.rows[0]!.available, null);
    assert.equal(view.rows[0]!.collateral, null);
    assert.match(view.rows[0]!.note, /did not say how much is available/);
    // And under a dollar is money, not nothing.
    const dust = lendingMarketsViewV1({
      venueName: 'Morpho',
      markets: [{ ...NVDA_MARKETS[1]!, liquidityUsd: 0.4 }],
    })!;
    assert.equal(dust.rows[0]!.available, '<$1');
  });

  test('no markets is no section, not an empty table', () => {
    assert.equal(lendingMarketsViewV1({ venueName: 'Morpho', markets: [] }), null);
    assert.equal(lendingMarketsViewV1({ venueName: 'Morpho', markets: null }), null);
    assert.equal(lendingMarketsHeadlineV1(null), null);
  });

  test('the headline never says "listed" when nothing is usable', () => {
    const real = lendingMarketsHeadlineV1(
      lendingMarketsViewV1({ venueName: 'Morpho', markets: NVDA_MARKETS }),
    )!;
    assert.match(real, /1 market on the venue’s list, \$835 available to borrow\./);

    const dry = lendingMarketsHeadlineV1(
      lendingMarketsViewV1({
        venueName: 'Morpho',
        markets: [{ ...NVDA_MARKETS[1]!, liquidityUsd: 0 }],
      }),
    )!;
    assert.match(dry, /nothing available to borrow right now/);

    const strangersOnly = lendingMarketsHeadlineV1(
      lendingMarketsViewV1({ venueName: 'Morpho', markets: [NVDA_MARKETS[0]!, NVDA_MARKETS[2]!] }),
    )!;
    assert.match(strangersOnly, /2 markets exist here, none on the venue’s own list\./);
  });
});
