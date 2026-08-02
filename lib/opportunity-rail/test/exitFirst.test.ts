import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bpsPercentLabelV1,
  exitCapacityV1,
  OPPORTUNITY_REJECTION_COPY_V1,
  opportunityHeadlineV1,
  opportunityVerdictV1,
  roundTripV1,
  type ExitControlsV1,
  type OpportunityInputV1,
} from '../src/exitFirst.js';

// ---------------------------------------------------------------------------
// T68 Stage 1 — Exit-First.
//
// These tests are mostly about numbers that would be wrong in a flattering
// direction. That is the failure mode worth guarding: a round trip quoted
// against the wrong pool state, a capacity interpolated between probes, or a
// pass certified on a bound rather than a measurement — each of them makes a
// token look more exitable than it is, and each is in the units of somebody's
// savings.
// ---------------------------------------------------------------------------

const CLEAN_CONTROLS: ExitControlsV1 = {
  factoryConfirmed: true,
  transfersPaused: false,
  transferPolicyActive: false,
  controlsFullyRead: true,
};

function legs(spend: string, acquire: string, back: string) {
  return {
    entry: { provider: 'aerodrome', inputAtomic: spend, outputAtomic: acquire },
    exit: { provider: 'aerodrome', inputAtomic: acquire, outputAtomic: back },
  };
}

describe('the round trip', () => {
  test('the cost is what does not come back', () => {
    // 100 USDC in, 93.70 out.
    const trip = roundTripV1({ ...legs('100000000', '1284000', '93700000'), measurement: 'simulated' });
    assert.equal(trip!.costBps, 630);
    assert.equal(bpsPercentLabelV1(trip!.costBps), '6.30%');
    assert.equal(trip!.optimistic, false);
  });

  test('a pre-entry exit quote is marked optimistic', () => {
    // Quoting the exit against the pool as it stands assumes the entry never
    // happened. It is a bound, never a result.
    const trip = roundTripV1({
      ...legs('100000000', '1284000', '97000000'),
      measurement: 'quoted_pre_entry',
    });
    assert.equal(trip!.optimistic, true);
    assert.equal(trip!.measurement, 'quoted_pre_entry');
  });

  test('the cost rounds against the user, never towards them', () => {
    // 6.301% must not be reported as 6.30%.
    const trip = roundTripV1({ ...legs('1000000', '1', '936990'), measurement: 'simulated' });
    assert.equal(trip!.costBps, 631);
  });

  test('a profitable round trip is zero cost, not a negative one', () => {
    // Getting more back than you put in is an arbitrage, not a negative fee,
    // and a negative percentage in a "cost" field reads as a gain guarantee.
    const trip = roundTripV1({ ...legs('100000000', '1284000', '101000000'), measurement: 'simulated' });
    assert.equal(trip!.costBps, 0);
  });

  test('selling a different quantity than the entry produced is not a round trip', () => {
    // Silently rescaling here would let a card compare an entry at one size
    // with an exit at another and call the difference a cost.
    const trip = roundTripV1({
      entry: { provider: 'aerodrome', inputAtomic: '100000000', outputAtomic: '1284000' },
      exit: { provider: 'aerodrome', inputAtomic: '900000', outputAtomic: '95000000' },
      measurement: 'simulated',
    });
    assert.equal(trip, null);
  });

  test('a zero-output entry is not a trade', () => {
    assert.equal(roundTripV1({ ...legs('100000000', '0', '0'), measurement: 'simulated' }), null);
  });
});

describe('exit capacity is measured, never interpolated', () => {
  test('the answer is the largest size that actually passed', () => {
    const capacity = exitCapacityV1(
      [
        { sizeAtomic: '1000', slippageBps: 90 },
        { sizeAtomic: '2000', slippageBps: 210 },
        { sizeAtomic: '4000', slippageBps: 640 },
      ],
      300,
    );
    // NOT some value between 2000 and 4000. Nobody measured that.
    assert.equal(capacity.capacityAtomic, '2000');
    assert.equal(capacity.firstFailingAtomic, '4000');
    assert.equal(capacity.probeCount, 3);
  });

  test('a failure at the smallest probe means no capacity at all', () => {
    const capacity = exitCapacityV1([{ sizeAtomic: '1000', slippageBps: 900 }], 300);
    assert.equal(capacity.capacityAtomic, null);
    assert.equal(capacity.firstFailingAtomic, '1000');
  });

  test('no route at a size is not the same as bad slippage', () => {
    const capacity = exitCapacityV1(
      [
        { sizeAtomic: '1000', slippageBps: 100 },
        { sizeAtomic: '2000', slippageBps: null },
      ],
      300,
    );
    assert.equal(capacity.capacityAtomic, '1000');
    assert.equal(capacity.firstFailingAtomic, '2000');
  });

  test('a size that passes ABOVE a failure is not taken', () => {
    // A pool that fails at 2000 and quotes well at 4000 is reporting something
    // unstable. Taking the larger number would be taking the flattering one.
    const capacity = exitCapacityV1(
      [
        { sizeAtomic: '1000', slippageBps: 100 },
        { sizeAtomic: '2000', slippageBps: 800 },
        { sizeAtomic: '4000', slippageBps: 120 },
      ],
      300,
    );
    assert.equal(capacity.capacityAtomic, '1000');
  });

  test('probes are ordered by size, not by arrival', () => {
    const capacity = exitCapacityV1(
      [
        { sizeAtomic: '4000', slippageBps: 640 },
        { sizeAtomic: '1000', slippageBps: 90 },
        { sizeAtomic: '2000', slippageBps: 210 },
      ],
      300,
    );
    assert.equal(capacity.capacityAtomic, '2000');
  });

  test('the probe count travels with the answer', () => {
    // A capacity from two probes is a much weaker statement than one from
    // eight, and the card has to be able to say which.
    assert.equal(exitCapacityV1([{ sizeAtomic: '1', slippageBps: 1 }], 300).probeCount, 1);
  });
});

describe('controls outrank economics', () => {
  function input(overrides: Partial<OpportunityInputV1> = {}): OpportunityInputV1 {
    return {
      profile: { positionAtomic: '100000000', maxRoundTripBps: 700, maxSlippageBps: 300 },
      controls: CLEAN_CONTROLS,
      roundTrip: roundTripV1({ ...legs('100000000', '1284000', '93700000'), measurement: 'simulated' }),
      entryRouteFound: true,
      exitRouteFound: true,
      exitCapacity: exitCapacityV1([{ sizeAtomic: '200000000', slippageBps: 200 }], 300),
      ...overrides,
    };
  }

  test('a clean token with room qualifies', () => {
    const verdict = opportunityVerdictV1(input());
    assert.equal(verdict.status, 'qualifies');
    assert.equal(verdict.status === 'qualifies' && verdict.optimistic, false);
  });

  test('paused transfers are refused before any price is considered', () => {
    // A card that leads with "6.30%" under a paused token is worse than no
    // card: the position cannot be sold at any price.
    const verdict = opportunityVerdictV1(
      input({ controls: { ...CLEAN_CONTROLS, transfersPaused: true } }),
    );
    assert.equal(verdict.status === 'rejected' && verdict.reason, 'transfers_paused');
  });

  test('an active transfer policy blocks certification', () => {
    // Miorail cannot enumerate a policy, so it cannot confirm the user's own
    // address will be allowed out.
    const verdict = opportunityVerdictV1(
      input({ controls: { ...CLEAN_CONTROLS, transferPolicyActive: true } }),
    );
    assert.equal(verdict.status === 'rejected' && verdict.reason, 'transfer_policy_may_block');
  });

  test('a partial control read is not a pass', () => {
    const verdict = opportunityVerdictV1(
      input({ controls: { ...CLEAN_CONTROLS, controlsFullyRead: false } }),
    );
    assert.equal(verdict.status === 'rejected' && verdict.reason, 'controls_unreadable');
  });

  test('a non-B20 address is refused first of all', () => {
    const verdict = opportunityVerdictV1(
      input({ controls: { ...CLEAN_CONTROLS, factoryConfirmed: false, controlsFullyRead: false } }),
    );
    assert.equal(verdict.status === 'rejected' && verdict.reason, 'not_b20');
  });

  test('no exit route is refused even when entry is cheap', () => {
    const verdict = opportunityVerdictV1(input({ exitRouteFound: false }));
    assert.equal(verdict.status === 'rejected' && verdict.reason, 'no_exit_route');
  });

  test('a round trip above tolerance is refused', () => {
    const verdict = opportunityVerdictV1(
      input({ profile: { positionAtomic: '100000000', maxRoundTripBps: 300, maxSlippageBps: 300 } }),
    );
    assert.equal(verdict.status === 'rejected' && verdict.reason, 'round_trip_above_tolerance');
  });

  test('a position larger than the measured capacity is refused', () => {
    const verdict = opportunityVerdictV1({
      ...input(),
      exitCapacity: exitCapacityV1([{ sizeAtomic: '50000000', slippageBps: 100 }], 300),
    });
    assert.equal(verdict.status === 'rejected' && verdict.reason, 'exit_capacity_below_position');
  });
});

describe('an optimistic measurement may reject but may not certify', () => {
  const optimistic = roundTripV1({
    ...legs('100000000', '1284000', '97000000'),
    measurement: 'quoted_pre_entry',
  });

  function input(maxRoundTripBps: number): OpportunityInputV1 {
    return {
      profile: { positionAtomic: '100000000', maxRoundTripBps, maxSlippageBps: 300 },
      controls: CLEAN_CONTROLS,
      roundTrip: optimistic,
      entryRouteFound: true,
      exitRouteFound: true,
      exitCapacity: exitCapacityV1([{ sizeAtomic: '200000000', slippageBps: 200 }], 300),
    };
  }

  test('a rejection on an optimistic number is sound', () => {
    // If the flattering figure already fails, the real one fails by more.
    const verdict = opportunityVerdictV1(input(100));
    assert.equal(verdict.status, 'rejected');
    assert.equal(verdict.status === 'rejected' && verdict.sound, true);
  });

  test('a pass carries the caveat rather than hiding it', () => {
    const verdict = opportunityVerdictV1(input(700));
    assert.equal(verdict.status, 'qualifies');
    assert.equal(verdict.status === 'qualifies' && verdict.optimistic, true);
  });

  test('the headline says the real round trip is worse', () => {
    const headline = opportunityHeadlineV1(opportunityVerdictV1(input(700)), {
      positionLabel: '100 USDC',
      slippagePercentLabel: '3%',
    });
    assert.match(headline, /before the entry moves the pool/);
    assert.match(headline, /the real round trip is worse/);
  });

  test('a simulated pass carries no caveat', () => {
    const verdict = opportunityVerdictV1({
      ...input(700),
      roundTrip: roundTripV1({ ...legs('100000000', '1284000', '97000000'), measurement: 'simulated' }),
    });
    const headline = opportunityHeadlineV1(verdict, {
      positionLabel: '100 USDC',
      slippagePercentLabel: '3%',
    });
    assert.equal(headline, 'Qualifies for your 100 USDC / 3% profile');
  });
});

describe('the vocabulary', () => {
  test('no verdict is a score, a rating or a prediction', () => {
    const headlines = [
      opportunityHeadlineV1(
        { status: 'qualifies', measurement: 'simulated', optimistic: false },
        { positionLabel: '100 USDC', slippagePercentLabel: '3%' },
      ),
      opportunityHeadlineV1(
        { status: 'rejected', reason: 'no_exit_route', sound: true },
        { positionLabel: '100 USDC', slippagePercentLabel: '3%' },
      ),
    ];
    for (const headline of headlines) {
      for (const forbidden of ['/100', 'score', 'rating', 'safe', 'promising', 'potential', 'likely', 'moon']) {
        assert.ok(
          !headline.toLowerCase().includes(forbidden.toLowerCase()),
          `"${headline}" contains "${forbidden}"`,
        );
      }
    }
  });

  test('every rejection says what it means for a POSITION, not for the token', () => {
    for (const [reason, copy] of Object.entries(OPPORTUNITY_REJECTION_COPY_V1)) {
      for (const forbidden of ['scam', 'rug', 'fraud', 'avoid this token', 'bad token']) {
        assert.ok(!copy.toLowerCase().includes(forbidden), `${reason} says "${forbidden}"`);
      }
    }
  });

  test('percentages are integer arithmetic', () => {
    // A float renders 6.3% as 6.299999999999999.
    assert.equal(bpsPercentLabelV1(630), '6.30%');
    assert.equal(bpsPercentLabelV1(3), '0.03%');
    assert.equal(bpsPercentLabelV1(10_000), '100.00%');
  });
});
