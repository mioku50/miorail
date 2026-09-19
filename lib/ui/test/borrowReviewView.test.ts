import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  BORROW_REVIEW_NOT_STATED_V1,
  BORROW_REVIEW_REFUSALS_V1,
  borrowReviewV1,
  type BorrowReviewMarketWireV1,
  type BorrowReviewPositionWireV1,
} from '../src/console/borrowReviewView';

// ---------------------------------------------------------------------------
// The live curated NVDAc market at block 51,521,606: 8-decimal collateral,
// 6-decimal USDC, 62.5% LLTV, oracle at $222.37, and a real borrower holding
// 64.4152 NVDAc against $7,163.45 of debt at a health factor of 1.2497.
//
// Every number in this file came off the venue, so a test that passes here is
// a test that passes on the shape a reader will actually meet.
// ---------------------------------------------------------------------------

const PRICE_V1 = 2_223_700_000_000_000_000_000_000_000_000_000_000n; // $222.37
const INCENTIVE_625_V1 = 1_126_760_563_380_281_690n; // 1.1268x at 62.5% LLTV

function market(over: Partial<BorrowReviewMarketWireV1> = {}): BorrowReviewMarketWireV1 {
  return {
    marketId: '0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13',
    curated: true,
    lltvBps: 6250,
    collateralSymbol: 'NVDAc',
    loanSymbol: 'USDC',
    collateralDecimals: 8,
    loanDecimals: 6,
    borrowApyWad: 61_200_000_000_000_000n, // 6.12%
    blockNumber: 51_521_606,
    ...over,
  };
}

const BEFORE_V1: BorrowReviewPositionWireV1 = {
  collateral: 6_441_519_897n,
  borrowedAssets: 7_163_446_680n,
  healthFactorWad: 1_249_748_238_943_974_500n,
  liquidationPrice: 1_779_300_000_000_000_000_000_000_000_000_000_000n, // $177.93
};

const AFTER_V1: BorrowReviewPositionWireV1 = {
  collateral: 6_441_519_897n,
  borrowedAssets: 7_663_446_680n,
  healthFactorWad: 1_168_200_000_000_000_000n,
  liquidationPrice: 1_903_500_000_000_000_000_000_000_000_000_000_000n, // $190.35
};

const base = {
  market: market(),
  before: BEFORE_V1,
  after: AFTER_V1,
  askAssets: 500_000_000n, // $500
  collateralPrice: PRICE_V1,
  liquidationIncentiveWad: INCENTIVE_625_V1,
  marketLiquidityAssets: 823_884_954n,
  readAt: '2026-09-19T15:55:07.391Z',
};

describe('a review shows the position the transaction would create', () => {
  test('before and after are both on the screen, and the after is the live one', () => {
    const view = borrowReviewV1(base);
    assert.equal(view.before.collateral, '64.41 NVDAc');
    assert.equal(view.before.debt, '7,163.44 USDC');
    assert.equal(view.before.health, '1.24');
    assert.equal(view.before.liquidationPrice, '$177.93');
    assert.equal(view.after!.debt, '7,663.44 USDC');
    assert.equal(view.after!.health, '1.16');
    assert.equal(view.after!.liquidationPrice, '$190.35');
    // The collateral did not move, and the review does not imply it did.
    assert.equal(view.after!.collateral, view.before.collateral);
  });

  test('the exact market is named, with what the venue says about it', () => {
    const view = borrowReviewV1(base);
    assert.equal(view.market.id, base.market.marketId);
    assert.match(view.market.shortId, /^0xb4b42dd6/);
    assert.equal(view.market.pair, 'NVDAc / USDC');
    assert.equal(view.market.standing, 'On the venue’s own list');
    assert.equal(view.market.lltv, '62.5%');
    assert.equal(view.market.rate, '6.2% variable');

    // A market anyone deployed says so, in the same place, not as a colour.
    const stranger = borrowReviewV1({ ...base, market: market({ curated: false }) });
    assert.match(stranger.market.standing, /Deployed by anyone/);
    const unsaid = borrowReviewV1({ ...base, market: market({ curated: null }) });
    assert.match(unsaid.market.standing, /did not say/);
  });

  test('a venue that published no rate is not given one', () => {
    const view = borrowReviewV1({ ...base, market: market({ borrowApyWad: null }) });
    assert.equal(view.market.rate, 'The venue did not publish a rate');
  });

  test('the clock is on the screen, and it says the numbers move', () => {
    const view = borrowReviewV1(base);
    assert.match(view.measuredAt, /block 51,521,606/);
    assert.match(view.measuredAt, /2026-09-19T15:55:07/);
    assert.match(view.measuredAt, /not the numbers at the moment you sign/);
    const noBlock = borrowReviewV1({ ...base, market: market({ blockNumber: null }) });
    assert.match(noBlock.measuredAt, /did not say which block/);
  });
});

describe('the warnings are computed, not decorative', () => {
  test('the distance to liquidation is stated as a price fall, in percent', () => {
    // $222.37 spot, $190.35 liquidation → a 14.399% fall, printed as 14.3%:
    // a margin is shown at its smallest, never rounded up toward the reader.
    const view = borrowReviewV1(base);
    const drop = view.warnings.find((line) => /fall in the NVDAc price/.test(line));
    assert.notEqual(drop, undefined);
    assert.match(drop!, /14\.3%/);
    assert.match(drop!, /nobody has to warn you first/);
  });

  test('what a liquidation costs is named, because "health factor 1.0" does not say it', () => {
    const view = borrowReviewV1(base);
    const cost = view.warnings.find((line) => /takes 12\.7% more collateral/.test(line));
    assert.notEqual(cost, undefined);
  });

  test('a thin health factor gets its own sentence, and a comfortable one does not', () => {
    const thin = borrowReviewV1({
      ...base,
      after: { ...AFTER_V1, healthFactorWad: 1_050_000_000_000_000_000n },
    });
    assert.ok(thin.warnings.some((line) => /health factor of 1\.05/.test(line)));

    const roomy = borrowReviewV1({
      ...base,
      after: { ...AFTER_V1, healthFactorWad: 3_000_000_000_000_000_000n },
    });
    assert.equal(roomy.warnings.some((line) => /health factor of/.test(line)), false);
  });

  test('taking nearly all of the market’s liquidity is said out loud', () => {
    const view = borrowReviewV1({ ...base, askAssets: 800_000_000n });
    assert.ok(view.warnings.some((line) => /almost everything the market has left/.test(line)));
    // And a small ask does not carry that sentence.
    assert.equal(
      borrowReviewV1({ ...base, askAssets: 10_000_000n }).warnings.some((line) =>
        /almost everything/.test(line),
      ),
      false,
    );
  });
});

describe('what a review refuses to put in front of a reader', () => {
  test('an unread position is refused in the same words the rest of the product uses', () => {
    const view = borrowReviewV1({ ...base, before: null, after: null });
    assert.equal(view.verdict, 'refused');
    assert.equal(view.refusal, BORROW_REVIEW_REFUSALS_V1.position_unread);
    assert.match(view.refusal!, /Nothing is being offered for approval/);
    assert.equal(view.before.health, 'not read');
    assert.equal(view.after, null);
  });

  test('a borrow that would not be healthy is refused, and its numbers are not rendered', () => {
    const view = borrowReviewV1({ ...base, after: null, refusal: 'would_not_be_healthy' });
    assert.equal(view.verdict, 'refused');
    assert.match(view.refusal!, /would revert/);
    assert.equal(view.after, null);
  });

  test('the market running out is a fact about the market, and says so', () => {
    const view = borrowReviewV1({ ...base, after: null, refusal: 'over_market_liquidity' });
    assert.match(view.refusal!, /about the market, not about this wallet’s collateral/);
  });

  test('a review cannot be ready for approval without a measured execution behind it', () => {
    // The three the simulation produces, each in its own words. "No provider
    // answered" and "it reverts" are opposite facts and must never share a
    // sentence.
    for (const refusal of ['simulation_not_run', 'simulation_reverted', 'simulation_delivered_something_else'] as const) {
      const view = borrowReviewV1({ ...base, after: null, refusal });
      assert.equal(view.verdict, 'refused');
      assert.equal(view.refusal, BORROW_REVIEW_REFUSALS_V1[refusal]);
    }
    assert.match(BORROW_REVIEW_REFUSALS_V1.simulation_not_run, /not a pass/);
    assert.match(BORROW_REVIEW_REFUSALS_V1.simulation_not_run, /gap in Miorail’s reading/);
    assert.match(BORROW_REVIEW_REFUSALS_V1.simulation_reverted, /revert when executed/);
    assert.doesNotMatch(BORROW_REVIEW_REFUSALS_V1.simulation_not_run, /revert/);
  });

  test('nothing here is ever an approval', () => {
    const ready = borrowReviewV1(base);
    assert.equal(ready.verdict, 'ready_for_your_approval');
    // The one word this screen must never use about somebody else's money.
    const everything = JSON.stringify(ready);
    assert.doesNotMatch(everything, /\bapproved\b/i);
    assert.doesNotMatch(everything, /\bsafe\b/i);
    assert.doesNotMatch(everything, /\brecommend/i);
  });

  test('what it does not answer travels with every review, refused or not', () => {
    for (const view of [borrowReviewV1(base), borrowReviewV1({ ...base, before: null, after: null })]) {
      assert.deepEqual(view.notStated, BORROW_REVIEW_NOT_STATED_V1);
      assert.ok(view.notStated.some((line) => /rate is variable/.test(line)));
      assert.ok(view.notStated.some((line) => /does not know what else this wallet owes/.test(line)));
      assert.ok(view.notStated.some((line) => /not advice/.test(line)));
    }
  });
});
