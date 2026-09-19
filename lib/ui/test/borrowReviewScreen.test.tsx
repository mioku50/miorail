import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BorrowReviewScreen, type BorrowReviewScreenModelV1 } from '../src/console/BorrowReviewScreen';
import { BORROW_REVIEW_REFUSALS_V1, borrowReviewV1 } from '../src/console/borrowReviewView';

void React;

// ---------------------------------------------------------------------------
// The live curated NVDAc market, rendered through the real projection rather
// than a hand-written object: a screen test that builds its own review can pass
// while the thing a reader actually sees is different.
// ---------------------------------------------------------------------------

const MARKET = {
  marketId: '0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13',
  curated: true,
  lltvBps: 6250,
  collateralSymbol: 'NVDAc',
  loanSymbol: 'USDC',
  collateralDecimals: 8,
  loanDecimals: 6,
  borrowApyWad: 61_200_000_000_000_000n,
  blockNumber: 51_521_606,
};

const BEFORE = {
  collateral: 6_441_519_897n,
  borrowedAssets: 7_163_446_680n,
  healthFactorWad: 1_249_748_238_943_974_500n,
  liquidationPrice: 1_779_300_000_000_000_000_000_000_000_000_000_000n,
};

const AFTER = {
  collateral: 6_441_519_897n,
  borrowedAssets: 7_663_446_680n,
  healthFactorWad: 1_168_200_000_000_000_000n,
  liquidationPrice: 1_903_500_000_000_000_000_000_000_000_000_000_000n,
};

const REVIEW_INPUT = {
  market: MARKET,
  before: BEFORE,
  after: AFTER,
  askAssets: 500_000_000n,
  collateralPrice: 2_223_700_000_000_000_000_000_000_000_000_000_000n,
  liquidationIncentiveWad: 1_126_760_563_380_281_690n,
  marketLiquidityAssets: 823_884_954n,
  readAt: '2026-09-19T15:55:07.391Z',
};

const STEPS = [
  {
    index: 0,
    to: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
    selector: '0xeecea000',
    venueDescription: 'Authorize Morpho GeneralAdapter1',
    readByMiorail: true,
    reading:
      'Gives 0xb98c948cfa24072e58935bc004a8a7b376ae746a the right to act for this wallet inside Morpho, until it is revoked.',
  },
  {
    index: 1,
    to: '0x6bfd8137e702540e7a42b74178a4a49ba43920c4',
    selector: '0x374f435d',
    venueDescription: 'Borrow 500 USDC',
    readByMiorail: false,
    reading: 'Miorail did not read what this call does. Its effect is measured in the simulation below.',
  },
];

function model(over: Partial<BorrowReviewScreenModelV1> = {}): BorrowReviewScreenModelV1 {
  return {
    loading: false,
    readError: null,
    review: borrowReviewV1(REVIEW_INPUT),
    steps: STEPS,
    measured: { blockNumber: 51_521_606, arrivedAtomic: '500000000', provider: 'base-rpc-eth-simulate-v1' },
    wallet: { onOpen: () => {}, pending: false, error: null, batchId: null },
    ...over,
  };
}

function render(over: Partial<BorrowReviewScreenModelV1> = {}): string {
  return renderToStaticMarkup(<BorrowReviewScreen model={model(over)} />);
}

describe('what a reader is shown before approving a borrow', () => {
  test('both positions are on the screen, and the after is labelled as the one this creates', () => {
    const html = render();
    assert.match(html, /64\.41 NVDAc/);
    assert.match(html, /7,163\.44 USDC/);
    assert.match(html, /7,663\.44 USDC/);
    assert.match(html, /After this borrow/);
    assert.match(html, /\$190\.35/);
  });

  test('the price fall to liquidation and what it costs are both shown, not just a health factor', () => {
    const html = render();
    assert.match(html, /14\.3%/);
    assert.match(html, /nobody has to warn you first/);
    assert.match(html, /12\.7% more collateral/);
  });

  test('the authorisation that outlives the borrow is on the screen, decoded and named', () => {
    const html = render();
    assert.match(html, /0xb98c948cfa24072e58935bc004a8a7b376ae746a/);
    assert.match(html, /until it is revoked/);
    // And the frame nobody read says so rather than wearing the venue's label.
    assert.match(html, /Miorail did not read what this call does/);
    assert.match(html, /The venue calls this/);
  });

  test('the measurement behind the verdict is stated, with its block', () => {
    const html = render();
    assert.match(html, /executed once against Base state at block 51,521,606/);
    assert.match(html, /500000000 base units of the loan asset reached this wallet/);
    assert.match(html, /not what the calldata says it does/);
  });

  test('the screen never says approved, safe, or recommended', () => {
    const html = render();
    assert.doesNotMatch(html, /\bapproved\b/i);
    assert.doesNotMatch(html, /\bsafe\b/i);
    assert.doesNotMatch(html, /\brecommend/i);
    // And it says plainly who can actually move anything.
    assert.match(html, /only your own Base Account can send them/);
  });
});

describe('a refusal is the whole screen', () => {
  test('there is no confirm button and no projected position beside a refusal', () => {
    const html = render({
      review: borrowReviewV1({ ...REVIEW_INPUT, after: null, refusal: 'simulation_reverted' }),
      steps: [],
      measured: null,
    });
    assert.match(html, /revert when executed/);
    assert.doesNotMatch(html, /After this borrow/);
    assert.doesNotMatch(html, /Open in your Base Account/);
    // A disabled button beside a refusal still reads as "nearly".
    assert.doesNotMatch(html, /<button/);
  });

  test('an unmeasured run and a reverting one do not share a sentence on screen', () => {
    const notRun = render({
      review: borrowReviewV1({ ...REVIEW_INPUT, after: null, refusal: 'simulation_not_run' }),
      steps: [],
      measured: null,
    });
    assert.match(notRun, /gap in Miorail’s reading/);
    assert.doesNotMatch(notRun, /revert/);
    assert.notEqual(
      BORROW_REVIEW_REFUSALS_V1.simulation_not_run,
      BORROW_REVIEW_REFUSALS_V1.simulation_effect_unread,
    );
  });
});

describe('the states around the review itself', () => {
  test('a read that failed is shown as a read that failed, not as an empty market', () => {
    const html = render({ readError: 'The venue could not be reached.', review: null });
    assert.match(html, /The venue could not be reached/);
    assert.doesNotMatch(html, /nothing to review/);
  });

  test('a submitted batch says whose wallet sent it', () => {
    const html = render({ wallet: { onOpen: () => {}, pending: false, error: null, batchId: '0xbatch' } });
    assert.match(html, /Submitted from your Base Account/);
    assert.match(html, /Miorail did not sign it and did not broadcast it/);
  });

  test('with nothing to hand over there is no button at all', () => {
    const html = render({ wallet: { onOpen: null, pending: false, error: null, batchId: null } });
    assert.doesNotMatch(html, /Open in your Base Account/);
  });
});
