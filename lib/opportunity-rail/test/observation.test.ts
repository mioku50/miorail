import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  B20_OBSERVATION_REJECTION_COPY_V1,
  B20_OBSERVATION_REJECTION_REASONS_V1,
  B20_OBSERVATION_STATES_V1,
  B20_OBSERVATION_STATE_COPY_V1,
  B20_OBSERVATION_UNMEASURED_COPY_V1,
  B20_OBSERVATION_UNMEASURED_REASONS_V1,
  B20_PRE_ENTRY_NOTICE_V1,
  B20_TRANSFER_POLICY_COPY_V1,
  b20ObservationVerdictV1,
  exitCapacityV1,
  exitLadderStableV1,
  exitProbeLadderV1,
  priceImpactLadderV1,
  roundTripV1,
  type B20ObservationControlsV1,
  type B20ObservationInputV1,
  type OpportunityCoverageV1,
} from '../src/index.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// T69-B §5–§10 — what a wallet-less public measurement may conclude.
//
// The thing every test below is really guarding: this runs unattended, over
// tokens nobody asked about, and publishes the result. A wallet-bound check
// that gets it wrong shows one user a bad answer they can question. This shows
// everyone an answer with nobody to question it.
// ---------------------------------------------------------------------------

const PROFILE = {
  quoteAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  positionAtomic: '100000000',
  maxRoundTripBps: 300,
  maxExitSlippageBps: 300,
} as const;

const COMPLETE: OpportunityCoverageV1 = {
  coverage: 'complete',
  viableRouteConfirmed: true,
  bestRouteConfirmed: true,
};
const PARTIAL: OpportunityCoverageV1 = {
  coverage: 'partial',
  viableRouteConfirmed: true,
  bestRouteConfirmed: false,
};

const OPEN_CONTROLS: B20ObservationControlsV1 = {
  factoryConfirmed: true,
  initialized: true,
  transfersPaused: false,
  transferPolicyState: 'open',
  controlsComplete: true,
};

/** A round trip that comes in at 100 bps — inside the 300 bps tolerance. */
const cheapRoundTrip = roundTripV1({
  entry: { provider: 'aerodrome', inputAtomic: '100000000', outputAtomic: '4000000000000000000000' },
  exit: { provider: 'aerodrome', inputAtomic: '4000000000000000000000', outputAtomic: '99000000' },
  measurement: 'quoted_pre_entry',
})!;

/** 20% — far outside it. */
const expensiveRoundTrip = roundTripV1({
  entry: { provider: 'aerodrome', inputAtomic: '100000000', outputAtomic: '4000000000000000000000' },
  exit: { provider: 'aerodrome', inputAtomic: '4000000000000000000000', outputAtomic: '80000000' },
  measurement: 'quoted_pre_entry',
})!;

const ACQUIRED = '4000000000000000000000';

/** Capacity that comfortably covers the acquired position. */
const roomyCapacity = exitCapacityV1(
  [
    { sizeAtomic: '2000000000000000000000', slippageBps: 10 },
    { sizeAtomic: ACQUIRED, slippageBps: 50 },
    { sizeAtomic: '8000000000000000000000', slippageBps: 90 },
  ],
  300,
);

function observe(overrides: Partial<B20ObservationInputV1> = {}) {
  return b20ObservationVerdictV1({
    profile: PROFILE,
    cheapFilter: 'candidate',
    controls: OPEN_CONTROLS,
    coverage: COMPLETE,
    roundTrip: cheapRoundTrip,
    exitCapacity: roomyCapacity,
    acquiredAtomic: ACQUIRED,
    ...overrides,
  });
}

describe('a background observation can never certify', () => {
  test('the state union has no qualified member at all', () => {
    // §16.11. Not a policy check — there is nowhere to put the value.
    assert.deepEqual([...B20_OBSERVATION_STATES_V1].sort(), [
      'candidate',
      'provisional',
      'rejected',
      'unmeasured',
    ]);
    assert.ok(!(B20_OBSERVATION_STATES_V1 as readonly string[]).includes('qualified'));
  });

  test('a clean pass is provisional, and says why it is only provisional', () => {
    // §16.9.
    const outcome = observe();
    assert.equal(outcome.state, 'provisional');
    assert.equal(outcome.state === 'provisional' && outcome.reason, 'quoted_pre_entry');
  });

  test('the pass is routed through the shared promotion rule', () => {
    // The rule that makes `qualified` unreachable lives in clearance.ts and is
    // shared with the wallet-bound path. Re-implementing it here is how the two
    // would drift.
    const source = readFileSync(path.join(here, '..', 'src', 'observation.ts'), 'utf8');
    assert.match(source, /provisionalOutcomeV1\(\{\s*measurement: 'quoted_pre_entry'/);
    assert.match(source, /a pre-entry measurement may never certify/);
  });

  test('every state and reason has copy, and none of it grades the token', () => {
    for (const state of B20_OBSERVATION_STATES_V1) {
      assert.ok(B20_OBSERVATION_STATE_COPY_V1[state].length > 40, `${state} needs a real sentence`);
    }
    for (const reason of B20_OBSERVATION_REJECTION_REASONS_V1) {
      assert.ok(B20_OBSERVATION_REJECTION_COPY_V1[reason], `${reason} would render as a bare code`);
    }
    for (const reason of B20_OBSERVATION_UNMEASURED_REASONS_V1) {
      assert.ok(B20_OBSERVATION_UNMEASURED_COPY_V1[reason], `${reason} would render as a bare code`);
    }
    const all = [
      ...Object.values(B20_OBSERVATION_STATE_COPY_V1),
      ...Object.values(B20_OBSERVATION_REJECTION_COPY_V1),
      ...Object.values(B20_OBSERVATION_UNMEASURED_COPY_V1),
    ]
      .join(' ')
      .toLowerCase();
    for (const forbidden of ['is safe', 'unsafe', 'scam', 'rug', 'guaranteed', 'will rise', 'good buy']) {
      assert.ok(!all.includes(forbidden), `no copy may say "${forbidden}"`);
    }
  });

  test('a provisional pass carries the pre-entry warning verbatim', () => {
    assert.ok(B20_OBSERVATION_STATE_COPY_V1.provisional.includes(B20_PRE_ENTRY_NOTICE_V1));
    assert.match(B20_PRE_ENTRY_NOTICE_V1, /the real round-trip can be worse/);
  });

  test('a missing route is described as Miorail’s routes, not as Base', () => {
    // "This token cannot be traded anywhere on Base" is a claim nothing here
    // measured.
    for (const reason of ['no_entry_route', 'no_exit_route'] as const) {
      assert.match(B20_OBSERVATION_REJECTION_COPY_V1[reason], /not about every venue on Base/);
    }
  });
});

describe('an endpoint failure never becomes a verdict about a token', () => {
  test('a degraded route search is unmeasured, not a rejection', () => {
    // §16.6/§16.8. The AERO incident, in one assertion.
    const outcome = observe({ cheapFilter: 'route_search_degraded', controls: null });
    assert.equal(outcome.state, 'unmeasured');
    assert.equal(outcome.state === 'unmeasured' && outcome.reason, 'route_search_degraded');
  });

  test('a complete search that found no entry may reject; a partial one may not', () => {
    // §16.5 and §16.6.
    assert.equal(observe({ cheapFilter: 'no_entry_route', coverage: COMPLETE }).state, 'rejected');
    assert.equal(observe({ cheapFilter: 'no_entry_route', coverage: PARTIAL }).state, 'unmeasured');
  });

  test('a complete search that found no exit may reject; a partial one may not', () => {
    // §16.7 and §16.8.
    const rejected = observe({ cheapFilter: 'no_exit_route', coverage: COMPLETE });
    assert.equal(rejected.state, 'rejected');
    assert.equal(rejected.state === 'rejected' && rejected.reason, 'no_exit_route');
    assert.equal(observe({ cheapFilter: 'no_exit_route', coverage: PARTIAL }).state, 'unmeasured');
  });

  test('a cost rejection is refused when an unanswered candidate might have beaten it', () => {
    // §16.13. The subtle half of the AERO lesson: it is not only the
    // missing-route conclusions that go unsound when coverage drops.
    assert.equal(observe({ roundTrip: expensiveRoundTrip, coverage: COMPLETE }).state, 'rejected');
    const partial = observe({ roundTrip: expensiveRoundTrip, coverage: PARTIAL });
    assert.equal(partial.state, 'unmeasured');
    assert.equal(partial.state === 'unmeasured' && partial.reason, 'route_search_degraded');
  });

  test('a capacity rejection is refused under partial coverage too', () => {
    const thin = exitCapacityV1([{ sizeAtomic: '1000000000000000000000', slippageBps: 10 }], 300);
    assert.equal(observe({ exitCapacity: thin, coverage: COMPLETE }).state, 'rejected');
    assert.equal(observe({ exitCapacity: thin, coverage: PARTIAL }).state, 'unmeasured');
  });

  test('a route that exists but could not be quoted is unmeasured', () => {
    const outcome = observe({ cheapFilter: 'quote_unavailable', controls: null });
    assert.equal(outcome.state, 'unmeasured');
    assert.equal(outcome.state === 'unmeasured' && outcome.reason, 'quote_unavailable');
  });

  test('a factory that soundly said no still rejects under a degraded endpoint', () => {
    // Decided before a single quote was spent, so no amount of throttling can
    // have caused it.
    assert.equal(observe({ cheapFilter: 'not_b20', coverage: PARTIAL, controls: null }).state, 'rejected');
  });
});

describe('controls are prior to price', () => {
  test('a transfer pause rejects', () => {
    // §16.18.
    const outcome = observe({ controls: { ...OPEN_CONTROLS, transfersPaused: true } });
    assert.equal(outcome.state, 'rejected');
    assert.equal(outcome.state === 'rejected' && outcome.reason, 'transfers_paused');
  });

  test('a mint pause alone does not reject', () => {
    // §16.19. `transfersPaused` is the only pause this domain sees, and the
    // reader that computes it looks for TRANSFER specifically — a token whose
    // mint is paused can still be sold.
    assert.equal(observe({ controls: { ...OPEN_CONTROLS, transfersPaused: false } }).state, 'provisional');
  });

  test('an open policy is not a gate', () => {
    // §16.20. ALWAYS_ALLOW is the open value; treating it as a restriction
    // would reject nearly every token.
    assert.equal(observe({ controls: { ...OPEN_CONTROLS, transferPolicyState: 'open' } }).state, 'provisional');
  });

  test('a restricted policy is recorded, not converted into a rejection', () => {
    // §9. There is no wallet here to be refused, and B20 cannot enumerate who a
    // policy admits — so the public feed states the gate rather than resolving
    // it against a user who does not exist.
    const outcome = observe({ controls: { ...OPEN_CONTROLS, transferPolicyState: 'restricted' } });
    assert.equal(outcome.state, 'provisional');
    assert.match(B20_TRANSFER_POLICY_COPY_V1.restricted, /no way to list who it admits/);
  });

  test('an unavailable policy read differs from one this variant does not have', () => {
    // §16.21. One is something going wrong; the other is permanent and
    // expected. Fusing them makes a fully-read token look throttled.
    assert.equal(observe({ controls: { ...OPEN_CONTROLS, transferPolicyState: 'unavailable' } }).state, 'unmeasured');
    assert.equal(
      observe({ controls: { ...OPEN_CONTROLS, transferPolicyState: 'unsupported_by_variant' } }).state,
      'provisional',
    );
  });

  test('incomplete mandatory controls are unmeasured, never a pass', () => {
    // §16.22.
    const outcome = observe({ controls: { ...OPEN_CONTROLS, controlsComplete: false } });
    assert.equal(outcome.state, 'unmeasured');
    assert.equal(outcome.state === 'unmeasured' && outcome.reason, 'controls_incomplete');
  });

  test('a token the factory does not confirm rejects whatever the economics say', () => {
    const outcome = observe({ controls: { ...OPEN_CONTROLS, factoryConfirmed: false } });
    assert.equal(outcome.state === 'rejected' && outcome.reason, 'not_b20');
  });

  test('an uninitialised token rejects', () => {
    assert.equal(
      observe({ controls: { ...OPEN_CONTROLS, initialized: false } }).state === 'rejected',
      true,
    );
    assert.equal(observe({ cheapFilter: 'uninitialized', controls: null }).state, 'rejected');
  });
});

describe('the cheap filter and the deep read are separate states', () => {
  test('a passed filter with no control read yet is a candidate', () => {
    // §16.4 in domain form: the deep read has not happened, and the observation
    // says exactly that rather than borrowing a verdict it has not earned.
    assert.equal(observe({ controls: null }).state, 'candidate');
  });

  test('no cheap filter at all is unmeasured, never a candidate', () => {
    assert.equal(observe({ cheapFilter: null, controls: null }).state, 'unmeasured');
  });
});

describe('capacity reports measured boundaries and nothing between them', () => {
  test('the shared ladder is reused rather than reimplemented', () => {
    // §16.14. One capacity implementation, and this is the one.
    const source = readFileSync(path.join(here, '..', 'src', 'observation.ts'), 'utf8');
    assert.ok(!source.includes('function exitCapacity'), 'no second capacity implementation');
    const ladder = exitProbeLadderV1('800000000', 4);
    // Halving from the top: 800, 400, 200, 100 — so a reference position of 100
    // USDC is itself a rung when the top is a power-of-two multiple of it.
    assert.deepEqual(ladder, ['100000000', '200000000', '400000000', '800000000']);
  });

  test('capacity is a size that was probed, never one between two probes', () => {
    // §16.15/§16.16.
    const capacity = exitCapacityV1(
      [
        { sizeAtomic: '1000', slippageBps: 10 },
        { sizeAtomic: '2500', slippageBps: 900 },
      ],
      300,
    );
    assert.equal(capacity.capacityAtomic, '1000', 'the largest measured pass');
    assert.equal(capacity.firstFailingAtomic, '2500');
    // Nothing invented between 1000 and 2500, where a curve fit would have put
    // a number in the units of somebody's savings.
    assert.equal(capacity.probeCount, 2);
  });

  test('a ladder that passes above a failure is unstable', () => {
    // §16.17. Two probes moments apart against a pool somebody else is trading.
    const probes = [
      { sizeAtomic: '1000', slippageBps: 10 },
      { sizeAtomic: '2000', slippageBps: 900 },
      { sizeAtomic: '4000', slippageBps: 20 },
    ];
    assert.equal(exitLadderStableV1(probes, 300), false);
    // And the capacity never takes the later flattering value.
    assert.equal(exitCapacityV1(probes, 300).capacityAtomic, '1000');
  });

  test('a monotonic ladder is stable', () => {
    assert.equal(
      exitLadderStableV1(
        [
          { sizeAtomic: '1000', slippageBps: 10 },
          { sizeAtomic: '2000', slippageBps: 50 },
          { sizeAtomic: '4000', slippageBps: 900 },
        ],
        300,
      ),
      true,
    );
  });

  test('a size nothing could price stays unpriced rather than becoming bad slippage', () => {
    const ladder = priceImpactLadderV1([
      { sizeAtomic: '1000', outputAtomic: '1000' },
      { sizeAtomic: '2000', outputAtomic: null },
    ]);
    assert.equal(ladder.probes[1]?.slippageBps, null);
    // It bounds the capacity from above like any other failure — an absent
    // pool is not "very bad slippage", but it is equally not a pass.
    const capacity = exitCapacityV1(ladder.probes, 300);
    assert.equal(capacity.capacityAtomic, '1000');
    assert.equal(capacity.firstFailingAtomic, '2000');
    // Monotonic, though: nothing passed above it, so the ladder still agrees
    // with itself.
    assert.equal(exitLadderStableV1(ladder.probes, 300), true);
  });

  test('no capacity at all is unmeasured, not a rejection', () => {
    const nothing = exitCapacityV1([{ sizeAtomic: '1000', slippageBps: null }], 300);
    const outcome = observe({ exitCapacity: nothing });
    assert.equal(outcome.state, 'unmeasured');
    assert.equal(outcome.state === 'unmeasured' && outcome.reason, 'capacity_unmeasured');
  });
});

describe('viability and optimality are different claims', () => {
  test('one proven route with unanswered alternatives confirms viability only', () => {
    // §16.12. "A route exists" and "this is the best route" must not collapse.
    assert.equal(PARTIAL.viableRouteConfirmed, true);
    assert.equal(PARTIAL.bestRouteConfirmed, false);
    // And a passing route under partial coverage may still be provisional.
    assert.equal(observe({ coverage: PARTIAL }).state, 'provisional');
  });
});
