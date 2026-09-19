import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  MORPHO_LIQUIDATION_CURSOR_V1,
  MORPHO_MAX_LIQUIDATION_INCENTIVE_V1,
  MORPHO_ORACLE_PRICE_SCALE_V1,
  MORPHO_VIRTUAL_ASSETS_V1,
  MORPHO_VIRTUAL_SHARES_V1,
  MORPHO_WAD_V1,
  morphoAfterBorrowV1,
  morphoBorrowCapacityV1,
  morphoHealthV1,
  morphoLiquidationIncentiveWadV1,
  morphoLiquidationPriceV1,
  toAssetsDownV1,
  toAssetsUpV1,
  type MorphoMarketStateV1,
  type MorphoPositionV1,
} from '../src/morphoBorrowMath.js';

// ---------------------------------------------------------------------------
// The contract decides, so these tests are about agreeing with it exactly —
// at the boundary, and in the direction it rounds.
//
// The fixture uses an 18-decimal collateral against 6-decimal USDC at NVDAc's
// real 62.5% LLTV, because 18 decimals make the arithmetic readable. The real
// NVDAc has EIGHT — measured, not assumed — and the point of this note is that
// it does not matter here: Morpho's oracle absorbs the decimal difference into
// its own scaling, carrying `36 + loanDecimals - collateralDecimals` decimals,
// so `collateral * price / 1e36` lands in loan atomic units whatever the token
// uses and nothing in this module does decimal bookkeeping of its own. A module
// that "helpfully" scaled by 10^18 would be wrong by ten orders of magnitude on
// the live market while still printing a plausible number.
// ---------------------------------------------------------------------------

const NVDA_PRICE_V1 = 178n * 10n ** 24n; // $178.00 per NVDAc
const LLTV_625_V1 = 625n * 10n ** 15n; // 62.5%
const USDC = (whole: number): bigint => BigInt(whole) * 10n ** 6n;
const NVDAC = (whole: number): bigint => BigInt(whole) * 10n ** 18n;

function market(over: Partial<MorphoMarketStateV1> = {}): MorphoMarketStateV1 {
  return {
    collateralPrice: NVDA_PRICE_V1,
    lltvWad: LLTV_625_V1,
    totalSupplyAssets: USDC(8_388),
    totalBorrowAssets: USDC(7_605),
    totalBorrowShares: USDC(7_605) * MORPHO_VIRTUAL_SHARES_V1,
    blockNumber: 36_000_000,
    ...over,
  };
}

function position(over: Partial<MorphoPositionV1> = {}): MorphoPositionV1 {
  return { collateral: NVDAC(100), borrowShares: 0n, ...over };
}

describe('the constants are the published ones', () => {
  test('a wrong scale prints a plausible number, so they are pinned', () => {
    // morpho-blue/src/libraries/ConstantsLib.sol and SharesMathLib.sol.
    assert.equal(MORPHO_ORACLE_PRICE_SCALE_V1, 10n ** 36n);
    assert.equal(MORPHO_WAD_V1, 10n ** 18n);
    assert.equal(MORPHO_VIRTUAL_SHARES_V1, 10n ** 6n);
    assert.equal(MORPHO_VIRTUAL_ASSETS_V1, 1n);
    assert.equal(MORPHO_LIQUIDATION_CURSOR_V1, 3n * 10n ** 17n);
    assert.equal(MORPHO_MAX_LIQUIDATION_INCENTIVE_V1, 115n * 10n ** 16n);
  });
});

describe('_isHealthy, mirrored', () => {
  test('the maximum is the collateral valued by the oracle and cut by LLTV', () => {
    // 100 NVDAc * $178 = $17,800 of collateral; 62.5% of it is $11,125.
    const health = morphoHealthV1({ market: market(), position: position() });
    assert.equal(health.maxBorrowAssets, USDC(11_125));
    assert.equal(health.borrowedAssets, 0n);
    assert.equal(health.healthy, true);
    assert.equal(health.headroomAssets, USDC(11_125));
  });

  test('no debt has no health factor — null is not infinity and not "safe"', () => {
    const health = morphoHealthV1({ market: market(), position: position() });
    assert.equal(health.healthFactorWad, null);
    // And a position with neither collateral nor debt is healthy and empty,
    // never a division.
    const empty = morphoHealthV1({
      market: market(),
      position: { collateral: 0n, borrowShares: 0n },
    });
    assert.equal(empty.healthFactorWad, null);
    assert.equal(empty.maxBorrowAssets, 0n);
    assert.equal(empty.healthy, true);
  });

  test('the boundary is exactly where the contract puts it', () => {
    // `maxBorrow >= borrowed`: equal is healthy, one atomic unit more is not.
    const m = market();
    const atMax = sharesForAssets(USDC(11_125), m);
    const healthy = morphoHealthV1({ market: m, position: position({ borrowShares: atMax }) });
    assert.equal(healthy.borrowedAssets, USDC(11_125));
    assert.equal(healthy.healthy, true);
    assert.equal(healthy.headroomAssets, 0n);
    assert.equal(healthy.healthFactorWad, MORPHO_WAD_V1);

    const overMax = sharesForAssets(USDC(11_125) + 1n, m);
    const unhealthy = morphoHealthV1({ market: m, position: position({ borrowShares: overMax }) });
    assert.equal(unhealthy.borrowedAssets, USDC(11_125) + 1n);
    assert.equal(unhealthy.healthy, false);
    assert.equal(unhealthy.headroomAssets, 0n);
    assert.ok(unhealthy.healthFactorWad! < MORPHO_WAD_V1);
  });

  test('the debt is rounded against the borrower, never in their favour', () => {
    // toAssetsUp: one share more than an exact conversion still owes a whole
    // extra unit. A reader shown the rounded-down figure is shown a debt the
    // contract does not agree with.
    const m = market({ totalBorrowAssets: 0n, totalBorrowShares: 0n });
    assert.equal(toAssetsUpV1(1n, 0n, 0n), 1n);
    assert.equal(toAssetsUpV1(MORPHO_VIRTUAL_SHARES_V1, 0n, 0n), 1n);
    assert.equal(toAssetsUpV1(MORPHO_VIRTUAL_SHARES_V1 + 1n, 0n, 0n), 2n);
    const health = morphoHealthV1({
      market: m,
      position: position({ borrowShares: MORPHO_VIRTUAL_SHARES_V1 + 1n }),
    });
    assert.equal(health.borrowedAssets, 2n);
  });
});

describe('the venue publishes a different debt from the one the contract checks', () => {
  test('every live borrower, one atomic unit apart, in the same direction', () => {
    // Measured 2026-09-19 against Morpho's own API for the curated NVDAc
    // market at block 51,521,606: `state.borrowAssets` is `toAssetsDown`,
    // while `_isHealthy` compares `toAssetsUp`. Every one of the six live
    // borrowers differed by exactly one unit, in the protocol's favour.
    //
    // It is one atomic unit and it is not cosmetic: a reader who repays the
    // figure the venue publishes still owes a unit, and a health factor built
    // on it is fractionally optimistic — the only direction that matters.
    const totalBorrowAssets = 7_607_011_096n;
    const totalBorrowShares = 7_589_420_204_446_323n;
    const live: Array<[bigint, bigint]> = [
      [1_000_970_009_920n, 1_003_290n],
      [3_195_178_864_074n, 3_202_584n],
      [7_146_881_511_822_990n, 7_163_446_679n],
      [9_977_334_494_917n, 10_000_460n],
      [4_983_082_656_124n, 4_994_632n],
      [423_382_126_598_298n, 424_363_449n],
    ];
    for (const [borrowShares, publishedByVenue] of live) {
      assert.equal(
        toAssetsDownV1(borrowShares, totalBorrowAssets, totalBorrowShares),
        publishedByVenue,
        'the venue publishes toAssetsDown',
      );
      const ours = morphoHealthV1({
        market: market({ totalBorrowAssets, totalBorrowShares }),
        position: position({ borrowShares }),
      }).borrowedAssets;
      assert.equal(ours, publishedByVenue + 1n, 'and we carry the one the contract checks');
    }
  });
});

describe('what could be borrowed, and which fact is the limit', () => {
  test('the collateral is the limit when the market has more than it', () => {
    const m = market({ totalSupplyAssets: USDC(1_000_000), totalBorrowAssets: USDC(7_605) });
    const capacity = morphoBorrowCapacityV1({ market: m, position: position() });
    assert.equal(capacity.bound, 'collateral');
    assert.equal(capacity.collateralHeadroomAssets, USDC(11_125) - 1n);
    assert.equal(capacity.assets, USDC(11_125) - 1n);
  });

  test('the market is the limit when it holds less than the collateral allows', () => {
    // The whole point of telling these apart: this reader does NOT need more
    // collateral, and a single number would tell them they do.
    const m = market(); // $8,388 supplied, $7,605 borrowed → $783 available
    const capacity = morphoBorrowCapacityV1({ market: m, position: position() });
    assert.equal(capacity.bound, 'market_liquidity');
    assert.equal(capacity.marketLiquidityAssets, USDC(783));
    assert.equal(capacity.assets, USDC(783));
    // The collateral would have allowed far more, and that stays visible.
    assert.equal(capacity.collateralHeadroomAssets, USDC(11_125) - 1n);
  });

  test('both at once is its own answer', () => {
    const m = market({
      totalSupplyAssets: USDC(7_605) + (USDC(11_125) - 1n),
      totalBorrowAssets: USDC(7_605),
    });
    const capacity = morphoBorrowCapacityV1({ market: m, position: position() });
    assert.equal(capacity.bound, 'collateral_and_market_liquidity');
    assert.equal(capacity.assets, USDC(11_125) - 1n);
  });

  test('an empty market offers nothing, whatever the collateral is worth', () => {
    const m = market({ totalSupplyAssets: USDC(7_605), totalBorrowAssets: USDC(7_605) });
    const capacity = morphoBorrowCapacityV1({ market: m, position: position() });
    assert.equal(capacity.marketLiquidityAssets, 0n);
    assert.equal(capacity.assets, 0n);
    assert.equal(capacity.bound, 'nothing_available');
  });

  test('a position with no collateral can borrow nothing, and says so the same way', () => {
    const capacity = morphoBorrowCapacityV1({
      market: market({ totalSupplyAssets: USDC(1_000_000) }),
      position: { collateral: 0n, borrowShares: 0n },
    });
    assert.equal(capacity.collateralHeadroomAssets, 0n);
    assert.equal(capacity.assets, 0n);
    assert.equal(capacity.bound, 'nothing_available');
    // And no phantom rounding subtraction below zero.
    assert.equal(capacity.roundingMarginAssets, 0n);
  });

  test('the offer steps back from the ceiling the protocol admits it rounds', () => {
    // "Rounds in favor of the protocol, so one might not be able to borrow
    // exactly maxBorrow but one unit less." — Morpho.sol
    const m = market({ totalSupplyAssets: USDC(1_000_000) });
    const health = morphoHealthV1({ market: m, position: position() });
    const capacity = morphoBorrowCapacityV1({ market: m, position: position() });
    assert.equal(capacity.roundingMarginAssets, 1n);
    assert.equal(capacity.assets, health.headroomAssets - 1n);
    assert.ok(capacity.assets < health.headroomAssets);
  });

  test('a safety margin is applied only when a caller asks for one', () => {
    const m = market({ totalSupplyAssets: USDC(1_000_000) });
    const full = morphoBorrowCapacityV1({ market: m, position: position() });
    const eighty = morphoBorrowCapacityV1({
      market: m,
      position: position(),
      safetyMarginWad: 8n * 10n ** 17n,
    });
    assert.equal(eighty.assets, (USDC(11_125) * 8n) / 10n - 1n);
    assert.ok(eighty.assets < full.assets);
  });
});

describe('the price at which it stops being healthy', () => {
  test('it is the inverse of the health check, not an estimate of it', () => {
    // The strongest property available: at the returned price the position is
    // still healthy, and one unit below it is not. Anything that merely looks
    // about right fails this.
    const m = market();
    const borrowShares = sharesForAssets(USDC(5_000), m);
    const price = morphoLiquidationPriceV1({ market: m, position: position({ borrowShares }) })!;
    assert.notEqual(price, null);

    const atPrice = morphoHealthV1({
      market: market({ collateralPrice: price }),
      position: position({ borrowShares }),
    });
    assert.equal(atPrice.healthy, true);

    const belowPrice = morphoHealthV1({
      market: market({ collateralPrice: price - 1n }),
      position: position({ borrowShares }),
    });
    assert.equal(belowPrice.healthy, false);
  });

  test('no debt and no collateral have no such price, and it is not zero', () => {
    const m = market();
    assert.equal(morphoLiquidationPriceV1({ market: m, position: position() }), null);
    assert.equal(
      morphoLiquidationPriceV1({
        market: m,
        position: { collateral: 0n, borrowShares: sharesForAssets(USDC(1), m) },
      }),
      null,
    );
  });

  test('a $5,000 debt against 100 NVDAc liquidates around $80', () => {
    // A sanity figure a human can check: $5,000 / (100 * 0.625) = $80.00.
    const m = market();
    const price = morphoLiquidationPriceV1({
      market: m,
      position: position({ borrowShares: sharesForAssets(USDC(5_000), m) }),
    })!;
    // Back to dollars: price is scaled by 1e36 for one whole 18-decimal token,
    // quoted in 6-decimal USDC.
    const dollars = (price * NVDAC(1)) / MORPHO_ORACLE_PRICE_SCALE_V1;
    assert.equal(dollars / 10n ** 6n, 80n);
  });
});

describe('what crossing the line costs', () => {
  test('the incentive is the published formula, and the cap binds', () => {
    // 1 / (1 - 0.3 * (1 - 0.625)) = 1 / 0.8875 ≈ 1.1267
    const at625 = morphoLiquidationIncentiveWadV1(LLTV_625_V1);
    assert.equal(at625, 1_126_760_563_380_281_690n);
    assert.ok(at625 < MORPHO_MAX_LIQUIDATION_INCENTIVE_V1);

    // A low LLTV would compute past the cap, so the cap is what applies.
    const at30 = morphoLiquidationIncentiveWadV1(3n * 10n ** 17n);
    assert.equal(at30, MORPHO_MAX_LIQUIDATION_INCENTIVE_V1);

    // A 100% LLTV market has no incentive to compute.
    assert.equal(morphoLiquidationIncentiveWadV1(MORPHO_WAD_V1), MORPHO_WAD_V1);
  });
});

describe('the position this would create', () => {
  test('a review shows the position after, not the position now', () => {
    const m = market({ totalSupplyAssets: USDC(1_000_000) });
    const after = morphoAfterBorrowV1({ market: m, position: position(), assets: USDC(5_000) })!;
    assert.notEqual(after, null);
    // The debt the contract would record, rounded up into shares and back.
    assert.ok(after.health.borrowedAssets >= USDC(5_000));
    assert.equal(after.health.healthy, true);
    assert.ok(after.health.healthFactorWad! > MORPHO_WAD_V1);
    assert.notEqual(after.liquidationPrice, null);
    // The collateral did not move.
    assert.equal(after.position.collateral, NVDAC(100));
  });

  test('a borrow that would not be healthy is refused, not rendered', () => {
    // Printing the numbers of a position that cannot exist invites a reader to
    // sign a transaction that reverts.
    const m = market({ totalSupplyAssets: USDC(1_000_000) });
    assert.equal(morphoAfterBorrowV1({ market: m, position: position(), assets: USDC(12_000) }), null);
    assert.equal(morphoAfterBorrowV1({ market: m, position: position(), assets: 0n }), null);
  });

  test('a borrow larger than the market holds is refused before health is considered', () => {
    const m = market(); // $783 available
    assert.equal(morphoAfterBorrowV1({ market: m, position: position(), assets: USDC(1_000) }), null);
    assert.notEqual(morphoAfterBorrowV1({ market: m, position: position(), assets: USDC(700) }), null);
  });

  test('borrowing the offered capacity leaves a healthy position', () => {
    // The round trip that matters: what we offer must be what the contract
    // accepts. If the rounding step-back were wrong, this is where it shows.
    for (const supply of [USDC(1_000_000), USDC(7_605) + USDC(783)]) {
      const m = market({ totalSupplyAssets: supply });
      const capacity = morphoBorrowCapacityV1({ market: m, position: position() });
      const after = morphoAfterBorrowV1({ market: m, position: position(), assets: capacity.assets });
      assert.notEqual(after, null, `capacity ${capacity.assets} was refused`);
      assert.equal(after!.health.healthy, true);
    }
  });
});

/** Shares that convert back to exactly `assets` under `toAssetsUp`. */
function sharesForAssets(assets: bigint, m: MorphoMarketStateV1): bigint {
  // toSharesDown, then walk up until toAssetsUp lands on the target — the test
  // needs an exact debt, and solving it by construction rather than by formula
  // keeps the fixture honest about the rounding it is testing.
  let shares =
    (assets * (m.totalBorrowShares + MORPHO_VIRTUAL_SHARES_V1)) /
    (m.totalBorrowAssets + MORPHO_VIRTUAL_ASSETS_V1);
  while (toAssetsUpV1(shares, m.totalBorrowAssets, m.totalBorrowShares) < assets) shares += 1n;
  while (shares > 0n && toAssetsUpV1(shares - 1n, m.totalBorrowAssets, m.totalBorrowShares) >= assets) {
    shares -= 1n;
  }
  return shares;
}
