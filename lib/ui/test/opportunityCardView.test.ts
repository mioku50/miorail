import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  buyerLabelsV1,
  capacityLabelV1,
  consumerCapacityLabelV1,
  factValueClassV1,
  hookLabelsV1,
} from '../src/console/opportunityCardView';

// ---------------------------------------------------------------------------
// The pool hook is the one part of a B20 venue that can be verified by
// inspection — v4 spells a hook's permissions in the low bits of its own
// address, while a B20 token's own code cannot be read at all. So the card is
// allowed to state it, and is NOT allowed to state what the hook then does.
// ---------------------------------------------------------------------------

const FULL = {
  hook: '0x985c14baa2a18316ffda0aefb3a632fadfca2acc',
  mayChangeSwapAmounts: true,
  mayInterceptSwaps: true,
  mayGateLiquidity: true,
};

describe('the pool hook, in words', () => {
  test('a venue with no hook recorded says nothing at all', () => {
    assert.deepEqual(hookLabelsV1(null), { hookLabel: null, hookNote: null });
    assert.deepEqual(hookLabelsV1(undefined), { hookLabel: null, hookNote: null });
  });

  test('the usual hook is named as usual, and its permissions are listed', () => {
    const { hookLabel, hookNote } = hookLabelsV1({ standing: 'standard', permissions: FULL });
    assert.equal(hookLabel, 'Standard launch hook');
    assert.match(hookNote!, /change the amounts of every swap/);
    assert.match(hookNote!, /gate who adds or removes liquidity/);
  });

  test('an unusual hook is called out rather than blending in', () => {
    // 48 of 50 sampled launches share one hook, so the rare one is exactly the
    // case a reader needs told.
    const { hookLabel } = hookLabelsV1({
      standing: 'non_standard',
      permissions: { ...FULL, hook: '0xf85f1f3082cfbc5e1149972309b25054e4d420cc', mayGateLiquidity: false },
    });
    assert.equal(hookLabel, 'Not the usual hook');
  });

  test('an unreadable hook says so, and never defaults to standard', () => {
    // A silent default would be right 48 times in 50 — often enough to be
    // trusted, and wrong exactly where it matters.
    const { hookLabel, hookNote } = hookLabelsV1({ standing: 'unreadable', permissions: null });
    assert.equal(hookLabel, 'Not readable');
    assert.match(hookNote!, /could not be decoded/);
    assert.doesNotMatch(hookLabel!, /[Ss]tandard/);
  });

  test('no hook at all is a different statement from an unreadable one', () => {
    const { hookLabel, hookNote } = hookLabelsV1({ standing: 'no_hook', permissions: null });
    assert.equal(hookLabel, 'None');
    assert.match(hookNote!, /Nothing can intercept a swap/);
  });

  test('the sentence states permission and refuses to state behaviour', () => {
    const { hookNote } = hookLabelsV1({ standing: 'standard', permissions: FULL });
    assert.match(hookNote!, /It may /);
    // The disclaimer is the load-bearing half: a hook permitted to take a fee
    // may take none, and only the measured round trip says what an exit cost.
    assert.match(hookNote!, /What it actually does is not stated here/);
    assert.match(hookNote!, /only the measured round trip/);
    for (const forbidden of ['charges a fee of', 'takes ', 'will take']) {
      assert.ok(!hookNote!.includes(forbidden), `must not claim behaviour: ${forbidden}`);
    }
  });

  test('a hook claiming no swap-affecting permission says that plainly', () => {
    const { hookNote } = hookLabelsV1({
      standing: 'non_standard',
      permissions: {
        hook: `0x${'0'.repeat(36)}1000`,
        mayChangeSwapAmounts: false,
        mayInterceptSwaps: false,
        mayGateLiquidity: false,
      },
    });
    assert.match(hookNote!, /claims none of the permissions/);
  });

  test('the zero pool fee is why the hook matters, and the sentence says it', () => {
    const { hookNote } = hookLabelsV1({ standing: 'standard', permissions: FULL });
    assert.match(hookNote!, /charges no fee of its own/);
  });
});

describe('launch-window buying, in words', () => {
  test('an unmeasured window says nothing — never "0 buyers"', () => {
    // A launch whose 10,000-block window is still open has no answer yet.
    // Rendering that as zero would be a claim nobody made.
    assert.deepEqual(buyerLabelsV1(null), { buyersLabel: null, buyersNote: null });
    assert.deepEqual(buyerLabelsV1(undefined), { buyersLabel: null, buyersNote: null });
  });

  test('a measured zero says nobody bought, plainly', () => {
    // The common true answer: eight of ten sampled launches.
    const { buyersLabel, buyersNote } = buyerLabelsV1({
      buyerCount: 0, topBuyerShareBps: null, topThreeShareBps: null,
    });
    assert.equal(buyersLabel, 'Nobody');
    assert.match(buyersNote!, /no buying to concentrate/);
  });

  test('one wallet holding everything is called out as an exit dependency', () => {
    const { buyersLabel, buyersNote } = buyerLabelsV1({
      buyerCount: 1, topBuyerShareBps: 10_000, topThreeShareBps: 10_000,
    });
    assert.match(buyersLabel!, /1 wallet/);
    assert.match(buyersNote!, /depends on that wallet not selling first/);
  });

  test('many buyers carry the largest share, not just a count', () => {
    const { buyersLabel } = buyerLabelsV1({
      buyerCount: 76, topBuyerShareBps: 1482, topThreeShareBps: 2973,
    });
    assert.match(buyersLabel!, /76 wallets/);
    assert.match(buyersLabel!, /largest/);
  });

  test('it says bought, never held', () => {
    // Gross buying in a window. A wallet counted here may have sold it all
    // since, and calling it holdings would be unsupported by a Transfer log.
    for (const count of [1, 76]) {
      const { buyersNote } = buyerLabelsV1({
        buyerCount: count, topBuyerShareBps: 5_000, topThreeShareBps: 7_000,
      });
      assert.match(buyersNote!, /Bought, not held/);
    }
  });

  test('it never says "sniper" — intent is not on chain', () => {
    for (const buyers of [
      { buyerCount: 0, topBuyerShareBps: null, topThreeShareBps: null },
      { buyerCount: 1, topBuyerShareBps: 10_000, topThreeShareBps: 10_000 },
      { buyerCount: 76, topBuyerShareBps: 1482, topThreeShareBps: 2973 },
    ]) {
      const text = JSON.stringify(buyerLabelsV1(buyers)).toLowerCase();
      for (const forbidden of ['sniper', 'bot', 'insider', 'holds', 'holder']) {
        assert.ok(!text.includes(forbidden), `must not say "${forbidden}": ${text}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Exit capacity, at two resolutions.
//
// The collapsed card was rendering `at least 6048839.73523961386157531 BUILDING`
// — twenty-six digits of a figure whose whole meaning is "nothing above this
// was tried". The exact value is evidence and stays; it just stopped being the
// first thing a reader has to parse.
// ---------------------------------------------------------------------------
describe('exit capacity is exact below the fold and readable above it', () => {
  const LARGE = '6048839735239613861575313';

  test('the consumer bound is compact and the technical one is exact', () => {
    const consumer = consumerCapacityLabelV1({
      largestPassingSizeAtomic: LARGE,
      decimals: 18,
      symbol: 'BUILDING',
      capacityStable: true,
    });
    const technical = capacityLabelV1({
      largestPassingSizeAtomic: LARGE,
      firstFailingSizeAtomic: '12097679470479227723150626',
      decimals: 18,
      symbol: 'BUILDING',
      capacityStable: true,
    });
    assert.equal(consumer, 'at least 6.048M BUILDING');
    assert.match(technical ?? '', /6048839\.73523961386157531[0-9]* BUILDING/);
    assert.match(technical ?? '', /fails by/);
  });

  test('compacting a lower bound never claims more than was tested', () => {
    // `formatCompactAtomicAmount` truncates. A bound that rounded UP would
    // assert a size the ladder never priced.
    const compact = consumerCapacityLabelV1({
      largestPassingSizeAtomic: '6048999999999999999999999',
      decimals: 18,
      symbol: 'B',
      capacityStable: true,
    });
    assert.equal(compact, 'at least 6.048M B');
  });

  test('an unstable ladder keeps saying so, and unknown decimals are not divided', () => {
    assert.match(
      consumerCapacityLabelV1({
        largestPassingSizeAtomic: LARGE,
        decimals: 18,
        symbol: 'B',
        capacityStable: false,
      }) ?? '',
      /\(unstable\)$/,
    );
    assert.match(
      consumerCapacityLabelV1({
        largestPassingSizeAtomic: '1234',
        decimals: null,
        symbol: 'B',
        capacityStable: true,
      }) ?? '',
      /1234 \(atomic\)/,
    );
  });

  test('nothing measured stays null rather than becoming a zero bound', () => {
    assert.equal(
      consumerCapacityLabelV1({
        largestPassingSizeAtomic: null,
        decimals: 18,
        symbol: 'B',
        capacityStable: true,
      }),
      null,
    );
  });
});

describe('a fact value is monospaced only when it is a measurement', () => {
  test('figures get the number face and sentences do not', () => {
    assert.equal(factValueClassV1('4.35%'), 'mono');
    assert.equal(factValueClassV1('at least 6.048M BUILDING'), 'mono');
    assert.equal(factValueClassV1('Past the freshness window'), '');
    assert.equal(factValueClassV1('not measured'), '');
  });
});
