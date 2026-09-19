import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  lendingMarketsViewV1,
  lendingMarketsHeadlineV1,
  LENDING_PERSONAL_CAVEAT_V1,
  type LendingMarketWireV1,
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
    assert.equal(view.caveats[0], LENDING_PERSONAL_CAVEAT_V1);
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
    assert.equal(view.rows[0]!.availableUsd, null);
    assert.equal(view.rows[0]!.collateral, null);
    assert.match(view.rows[0]!.note, /did not say how much is available/);
    // And under a dollar is money, not nothing — in the cell AND in the
    // sentence printed next to it.
    const dust = lendingMarketsViewV1({
      venueName: 'Morpho',
      markets: [{ ...NVDA_MARKETS[1]!, liquidityUsd: 0.4 }],
    })!;
    assert.equal(dust.rows[0]!.available, '<$1');
    assert.match(dust.rows[0]!.note, /under \$1 available to borrow/);
    assert.doesNotMatch(dust.rows[0]!.note, /nothing/i);
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
    assert.match(real, /^4 markets here, 1 on the venue’s list\./);
    assert.match(real, /The most available to borrow right now is \$835, in a market on the venue’s list\./);

    const dry = lendingMarketsHeadlineV1(
      lendingMarketsViewV1({
        venueName: 'Morpho',
        markets: [{ ...NVDA_MARKETS[1]!, liquidityUsd: 0 }],
      }),
    )!;
    assert.match(dry, /Nothing available to borrow in it right now\./);

    const strangersOnly = lendingMarketsHeadlineV1(
      lendingMarketsViewV1({ venueName: 'Morpho', markets: [NVDA_MARKETS[0]!, NVDA_MARKETS[2]!] }),
    )!;
    assert.match(strangersOnly, /^2 markets here, none on the venue’s own list\./);
  });
});

// ---------------------------------------------------------------------------
// A summary may be coarser than its list. It may not disagree with it.
//
// The headline used to be computed over the CURATED subset while the table
// under it showed every market. On the shape below that printed "nothing
// available to borrow right now" above a row whose own cell read $97 — two
// sentences on one screen contradicting each other, and the coarser one is the
// one a reader quotes.
// ---------------------------------------------------------------------------
describe('the headline is quantified over the list it heads', () => {
  test('a dry curated market beside a funded stranger does not print "nothing"', () => {
    const view = lendingMarketsViewV1({
      venueName: 'Morpho',
      markets: [{ ...NVDA_MARKETS[1]!, liquidityUsd: 0 }, NVDA_MARKETS[2]!],
    })!;
    const headline = lendingMarketsHeadlineV1(view)!;
    assert.doesNotMatch(headline, /nothing/i);
    assert.match(headline, /The most available to borrow right now is \$97/);
    // And it says whose market that is, so the figure is not read as the
    // venue's endorsement of the asset.
    assert.match(headline, /in a market the venue did not list/);
    // The row it points at is in the table below it.
    assert.equal(view.rows.some((row) => row.available === '$97'), true);
  });

  test('a market the venue did not price cannot be summarised as empty', () => {
    const headline = lendingMarketsHeadlineV1(
      lendingMarketsViewV1({
        venueName: 'Morpho',
        markets: [
          { ...NVDA_MARKETS[1]!, liquidityUsd: 0 },
          { ...NVDA_MARKETS[2]!, liquidityUsd: null },
        ],
      }),
    )!;
    // "Nothing in any of them" would be a claim about a market nobody read.
    assert.doesNotMatch(headline, /in any of them right now/);
    assert.match(headline, /gave figures for, and it gave none for the other 1/);
  });

  test('every market unpriced is "we were not told", never "there is none"', () => {
    const headline = lendingMarketsHeadlineV1(
      lendingMarketsViewV1({
        venueName: 'Morpho',
        markets: [
          { ...NVDA_MARKETS[1]!, liquidityUsd: null },
          { ...NVDA_MARKETS[2]!, liquidityUsd: undefined },
        ],
      }),
    )!;
    assert.match(headline, /The venue did not say how much is available to borrow in any of them\./);
    assert.doesNotMatch(headline, /Nothing available/);
  });

  test('dust in the deepest market is under a dollar, not nothing', () => {
    const headline = lendingMarketsHeadlineV1(
      lendingMarketsViewV1({
        venueName: 'Morpho',
        markets: [{ ...NVDA_MARKETS[1]!, liquidityUsd: 0.4 }, NVDA_MARKETS[0]!],
      }),
    )!;
    assert.match(headline, /Under \$1 available to borrow in any of them right now\./);
  });

  // The sweep. Whatever shape the venue hands us, the one-line answer and the
  // table have to be able to sit on the same screen.
  test('no combination of markets makes the headline contradict a row', () => {
    const LIQUIDITY: Array<number | null> = [null, 0, 0.4, 97, 835];
    const CURATED = [true, false];
    const shapes: LendingMarketWireV1[][] = [];
    const one = (liq: number | null, curated: boolean, i: number): LendingMarketWireV1 => ({
      ...NVDA_MARKETS[1]!,
      marketId: `0x${String(i).padStart(64, '0')}`,
      curated,
      liquidityUsd: liq,
    });
    for (const aLiq of LIQUIDITY)
      for (const aCur of CURATED) {
        shapes.push([one(aLiq, aCur, 1)]);
        for (const bLiq of LIQUIDITY)
          for (const bCur of CURATED) {
            shapes.push([one(aLiq, aCur, 1), one(bLiq, bCur, 2)]);
            for (const cLiq of LIQUIDITY)
              for (const cCur of CURATED)
                shapes.push([one(aLiq, aCur, 1), one(bLiq, bCur, 2), one(cLiq, cCur, 3)]);
          }
      }
    assert.equal(shapes.length, 1110);

    for (const markets of shapes) {
      const view = lendingMarketsViewV1({ venueName: 'Morpho', markets })!;
      const headline = lendingMarketsHeadlineV1(view)!;
      const where = `${headline} :: ${markets.map((m) => `${m.curated ? 'C' : 'u'}${m.liquidityUsd}`).join(' ')}`;
      const priced = view.rows.filter((row) => row.availableUsd !== null);
      const funded = priced.filter((row) => row.availableUsd! >= 1);
      const anyMoney = priced.some((row) => row.availableUsd! > 0);

      // 1. Absence is only claimed where absence was measured.
      if (/Nothing available/.test(headline)) {
        assert.equal(anyMoney, false, `claimed nothing while a row holds money: ${where}`);
      }
      if (/in any of them right now|in it right now/.test(headline) && /Nothing available/.test(headline)) {
        assert.equal(priced.length, view.rows.length, `claimed nothing over an unpriced market: ${where}`);
      }
      if (/did not say how much is available to borrow in/.test(headline)) {
        assert.equal(priced.length, 0, `pleaded ignorance while holding a figure: ${where}`);
      }

      // 2. A figure in the headline is the largest figure in the table, and it
      //    is one a row actually shows.
      const named = /The most available to borrow right now is (\$[0-9,]*[0-9])/.exec(headline);
      if (funded.length > 0) {
        assert.notEqual(named, null, `held money and named none: ${where}`);
        const deepest = [...funded].sort((a, b) => b.availableUsd! - a.availableUsd!)[0]!;
        assert.equal(named![1], deepest.available, `named a figure no row holds: ${where}`);
        assert.equal(
          view.rows.some((row) => row.available === named![1]),
          true,
          `named a figure absent from the table: ${where}`,
        );
        // Which market it is in is stated, because a stranger's liquidity is
        // not the venue's endorsement.
        assert.match(
          headline,
          deepest.curated === true ? /in a market on the venue’s list/ : /the venue did not list/,
          where,
        );
      } else {
        assert.equal(named, null, `named a borrowable figure with none over $1: ${where}`);
      }
      if (/Under \$1/.test(headline)) {
        assert.equal(funded.length, 0, where);
        assert.equal(anyMoney, true, where);
      }

      // 3. The count clause counts the same list.
      assert.match(headline, new RegExp(`^${view.rows.length} markets? here,`), where);

      // 4. Nothing in this view is ever a claim about the reader.
      assert.doesNotMatch(headline, /\byou(r|rs)?\b/i, where);
      for (const row of view.rows) {
        assert.doesNotMatch(row.note, /\byou(r|rs)?\b/i, where);
        // A row's sentence never contradicts its own cell either.
        if (row.available === '<$1') assert.doesNotMatch(row.note, /nothing/i, where);
      }

      // 5. Claim (3) is refused whatever the liquidity turned out to be.
      assert.equal(view.caveats.includes(LENDING_PERSONAL_CAVEAT_V1), true, where);
    }
  });

  test('a market with more money in it than anyone would borrow still answers nothing about the reader', () => {
    // Personal availability is not derived from market availability, in either
    // direction and at any size. The refusal is a constant, not something a
    // deep market switches off.
    const view = lendingMarketsViewV1({
      venueName: 'Morpho',
      markets: [{ ...NVDA_MARKETS[1]!, liquidityUsd: 10_000_000 }],
    })!;
    const headline = lendingMarketsHeadlineV1(view)!;
    assert.match(headline, /\$10,000,000/);
    assert.doesNotMatch(headline, /\byou(r|rs)?\b/i);
    assert.doesNotMatch(headline, /\b(can|could|may|are able to) borrow\b/i);
    assert.equal(view.caveats.includes(LENDING_PERSONAL_CAVEAT_V1), true);
  });
});
