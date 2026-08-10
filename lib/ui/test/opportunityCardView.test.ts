import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { hookLabelsV1 } from '../src/console/opportunityCardView';

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
