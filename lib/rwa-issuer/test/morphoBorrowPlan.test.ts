import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  MORPHO_BLUE_BASE_V1,
  MORPHO_BORROW_VERDICT_REFUSALS_V1,
  MORPHO_PLAN_SELECTORS_V1,
  morphoBorrowPlanV1,
  morphoBorrowVerdictV1,
  type MorphoBorrowSimulationV1,
  type PreparedTransactionV1,
} from '../src/morphoBorrowPlan.js';

// ---------------------------------------------------------------------------
// The two transactions Morpho actually returned for a 10 USDC borrow on the
// curated NVDAc market, verbatim, 2026-09-19. Not a guess at the shape: an
// earlier version of this module decoded the head of each call as Morpho's
// five-word MarketParams struct, which is what a DIRECT protocol call looks
// like and is not what arrives.
// ---------------------------------------------------------------------------

const WALLET = '0xfb132f4c6d9dcf4f80483ea7d96c5a5dccfcfe83';
const BUNDLER = '0x6bfd8137e702540e7a42b74178a4a49ba43920c4';
const ADAPTER = '0xb98c948cfa24072e58935bc004a8a7b376ae746a';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const AUTHORIZE_V1: PreparedTransactionV1 = {
  to: MORPHO_BLUE_BASE_V1,
  data: `0xeecea000000000000000000000000000${ADAPTER.slice(2)}0000000000000000000000000000000000000000000000000000000000000001`,
  value: '0',
  description: 'Authorize Morpho GeneralAdapter1',
};

const BUNDLE_V1: PreparedTransactionV1 = {
  to: BUNDLER,
  data: '0x374f435d0000000000000000000000000000000000000000000000000000000000000020',
  value: '0',
  description: 'Borrow 10 USDC',
};

const PREPARED_V1 = [AUTHORIZE_V1, BUNDLE_V1];

describe('what the venue prepared, read for what can be proven', () => {
  test('the authorisation is decoded and named, because it outlives the borrow', () => {
    // A `setAuthorization` grants an adapter the right to act for this wallet
    // inside the protocol until it is revoked. A reader who approves a "borrow"
    // and is not shown this has approved something broader than they were told.
    const result = morphoBorrowPlanV1({ prepared: PREPARED_V1, walletAddress: WALLET });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.authorizations.length, 1);
    assert.deepEqual(result.plan.authorizations[0], { index: 0, authorized: ADAPTER, granted: true });
    assert.equal(result.plan.steps[0]!.decodedByMiorail, true);
    assert.match(result.plan.steps[0]!.reading, /right to act for this wallet inside Morpho/);
    assert.match(result.plan.steps[0]!.reading, /until it is revoked/);
  });

  test('a revocation reads as a revocation, not as a grant', () => {
    const revoke: PreparedTransactionV1 = {
      ...AUTHORIZE_V1,
      data: AUTHORIZE_V1.data.slice(0, -1) + '0',
    };
    const result = morphoBorrowPlanV1({ prepared: [revoke], walletAddress: WALLET });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.authorizations[0]!.granted, false);
    assert.match(result.plan.steps[0]!.reading, /Takes back/);
  });

  test('the bundler frame is carried as unread, and says so in its own words', () => {
    // The alternative is a second, unreviewed ABI reader whose failure mode is
    // a confident wrong answer about somebody's money.
    const result = morphoBorrowPlanV1({ prepared: PREPARED_V1, walletAddress: WALLET });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const bundle = result.plan.steps[1]!;
    assert.equal(bundle.decodedByMiorail, false);
    assert.match(bundle.reading, /Miorail did not read what this call does/);
    assert.match(bundle.reading, /measured in the simulation/);
    // The venue's label travels, clearly marked as the venue's.
    assert.equal(bundle.venueDescription, 'Borrow 10 USDC');
  });

  test('every contract the batch touches is listed, not hidden behind an allowlist', () => {
    const result = morphoBorrowPlanV1({ prepared: PREPARED_V1, walletAddress: WALLET });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([...result.plan.targets].sort(), [BUNDLER, MORPHO_BLUE_BASE_V1].sort());
  });

  test('an approval names its spender and its ceiling', () => {
    const approve: PreparedTransactionV1 = {
      to: USDC,
      data: `${MORPHO_PLAN_SELECTORS_V1.approve}000000000000000000000000${MORPHO_BLUE_BASE_V1.slice(2)}${'f'.repeat(64)}`,
      value: '0',
    };
    const result = morphoBorrowPlanV1({ prepared: [approve], walletAddress: WALLET });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.calls[0]!.callType, 'approval');
    assert.equal(result.plan.calls[0]!.spender, MORPHO_BLUE_BASE_V1);
    // An unlimited approval is rendered as the number it actually is.
    assert.equal(result.plan.calls[0]!.amountAtomic, (2n ** 256n - 1n).toString());
  });
});

describe('what is refused before a reader ever sees it', () => {
  test('a lending call that moves native value', () => {
    const result = morphoBorrowPlanV1({
      prepared: [{ ...BUNDLE_V1, value: '1' }],
      walletAddress: WALLET,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refusal, 'call_moves_native_value');
  });

  test('an authorisation this build cannot read', () => {
    const result = morphoBorrowPlanV1({
      prepared: [{ ...AUTHORIZE_V1, data: `${MORPHO_PLAN_SELECTORS_V1.setAuthorization}00` }],
      walletAddress: WALLET,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refusal, 'authorization_not_readable');
  });

  test('an empty preparation, and a malformed one', () => {
    assert.equal(morphoBorrowPlanV1({ prepared: [], walletAddress: WALLET }).ok, false);
    const bad = morphoBorrowPlanV1({ prepared: [{ to: 'nope', data: '0x1234' }], walletAddress: WALLET });
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.equal(bad.refusal, 'call_not_decodable');
  });
});

describe('the verdict is bound to the measurement, not to the calldata', () => {
  const plan = (() => {
    const result = morphoBorrowPlanV1({ prepared: PREPARED_V1, walletAddress: WALLET });
    assert.equal(result.ok, true);
    return (result as Extract<typeof result, { ok: true }>).plan;
  })();

  const executed: MorphoBorrowSimulationV1 = {
    state: 'executed',
    blockNumber: 51_521_606,
    loanReceivedAssets: 10_000_000n,
  };

  test('a batch that executes and delivers the reviewed amount passes', () => {
    const verdict = morphoBorrowVerdictV1({ plan, simulation: executed, expectedAssets: 10_000_000n });
    assert.equal(verdict.ok, true);
  });

  test('no provider answering is never a pass', () => {
    // Our gap, not a finding about the transaction — and the two must not share
    // a sentence.
    const verdict = morphoBorrowVerdictV1({
      plan,
      simulation: { state: 'not_simulated', reason: 'no provider configured' },
      expectedAssets: 10_000_000n,
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.refusal, 'not_simulated');
    assert.match(MORPHO_BORROW_VERDICT_REFUSALS_V1.not_simulated, /not a pass/);
    assert.match(MORPHO_BORROW_VERDICT_REFUSALS_V1.not_simulated, /gap in Miorail’s reading/);
  });

  test('a measured revert is refused whatever the venue said', () => {
    const verdict = morphoBorrowVerdictV1({
      plan,
      simulation: { state: 'reverted', failedCallIndex: 1, reason: 'insufficient liquidity' },
      expectedAssets: 10_000_000n,
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.refusal, 'reverted');
  });

  test('the venue reverting while we succeed stops the flow rather than picking a winner', () => {
    // Measured 2026-09-19: asked for 1,200 USDC on a market holding 823, Morpho
    // returned SIMULATION_REVERTED — insufficient liquidity — AND two signable
    // transactions. A client reading `transactions` and not `warnings` hands a
    // user a transaction that reverts.
    const disagreeing = { ...plan, venueSimulation: { reverted: true, reason: 'insufficient liquidity' } };
    const verdict = morphoBorrowVerdictV1({
      plan: disagreeing,
      simulation: executed,
      expectedAssets: 10_000_000n,
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.refusal, 'venue_and_miorail_disagree');
    assert.equal(verdict.detail, 'insufficient liquidity');
  });

  test('a batch that executes cleanly and delivers something else is refused', () => {
    // The check decoding cannot do. Clean execution is not the same as doing
    // what the review said.
    const wrong = morphoBorrowVerdictV1({
      plan,
      simulation: { ...executed, loanReceivedAssets: 9_000_000n },
      expectedAssets: 10_000_000n,
    });
    assert.equal(wrong.ok, false);
    if (wrong.ok) return;
    assert.equal(wrong.refusal, 'wrong_amount_arrived');

    const nothing = morphoBorrowVerdictV1({
      plan,
      simulation: { ...executed, loanReceivedAssets: 0n },
      expectedAssets: 10_000_000n,
    });
    assert.equal(nothing.ok, false);
    if (nothing.ok) return;
    assert.equal(nothing.refusal, 'nothing_arrived');

    const unread = morphoBorrowVerdictV1({
      plan,
      simulation: { ...executed, loanReceivedAssets: null },
      expectedAssets: 10_000_000n,
    });
    assert.equal(unread.ok, false);
  });
});
