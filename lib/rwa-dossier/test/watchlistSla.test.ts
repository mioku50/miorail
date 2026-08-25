import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  ALERT_ELIGIBLE_KINDS_V1,
  WATCH_BUDGET_V1,
  WATCH_CHECK_COST_V1,
  WATCH_INTERVAL_TIERS_SECONDS_V1,
  alertEligibilityV1,
  watchlistCapacityV1,
} from '../src/watchlistSla.js';

// ---------------------------------------------------------------------------
// The promise has to be arithmetic, not a constant. Every case here is a way
// the advertised interval could become a sentence the product cannot keep.
// ---------------------------------------------------------------------------

describe('the watchlist capacity model', () => {
  test('the advertised interval is never faster than the budget supports', () => {
    // The property, over the whole plausible range. A tier printed on screen
    // that capacity cannot sustain is the failure this model exists to stop.
    for (let addresses = 1; addresses <= 500; addresses += 1) {
      const capacity = watchlistCapacityV1({ distinctAddresses: addresses });
      assert.ok(
        capacity.advertisedIntervalSeconds >= capacity.achievableIntervalSeconds ||
          capacity.beyondSlowestTier,
        `${addresses} addresses advertised ${capacity.advertisedIntervalSeconds}s against an achievable ${capacity.achievableIntervalSeconds}s`,
      );
      assert.ok(
        (WATCH_INTERVAL_TIERS_SECONDS_V1 as readonly number[]).includes(
          capacity.advertisedIntervalSeconds,
        ),
        'a surface may only say a tier',
      );
    }
  });

  test('the interval grows with the list, monotonically', () => {
    let previous = 0;
    for (let addresses = 1; addresses <= 400; addresses += 1) {
      const capacity = watchlistCapacityV1({ distinctAddresses: addresses });
      assert.ok(
        capacity.achievableIntervalSeconds >= previous,
        'a longer list cannot be cheaper to keep',
      );
      previous = capacity.achievableIntervalSeconds;
    }
  });

  test('the reserve is taken out before the promise is made', () => {
    // §13.3 — Investigate is a human waiting and outranks every scheduled
    // read. A model that spent the whole budget would make that impossible by
    // construction.
    const withReserve = watchlistCapacityV1({ distinctAddresses: 40 });
    const withoutReserve = watchlistCapacityV1({
      distinctAddresses: 40,
      budget: { ...WATCH_BUDGET_V1, reserveFraction: 0 },
    });
    assert.ok(withReserve.achievableIntervalSeconds > withoutReserve.achievableIntervalSeconds);
  });

  test('the slower of the two budgets decides, never the roomier one', () => {
    const capacity = watchlistCapacityV1({
      distinctAddresses: 100,
      cost: WATCH_CHECK_COST_V1,
      // Plenty of router quotes, almost no chain reads.
      budget: { rpcCallsPerMinute: 1, routerQuotesPerMinute: 10_000, reserveFraction: 0 },
    });
    assert.equal(capacity.limitedBy, 'rpc');
    assert.equal(capacity.achievableIntervalSeconds, 100 * 60);
  });

  test('a list that outgrows the slowest tier says so instead of printing a number', () => {
    const capacity = watchlistCapacityV1({
      distinctAddresses: 10_000,
      budget: { rpcCallsPerMinute: 1, routerQuotesPerMinute: 1, reserveFraction: 0.4 },
    });
    assert.equal(capacity.beyondSlowestTier, true);
    // The surface still gets a tier to render, and the flag is what tells it
    // the promise is not keepable.
    assert.equal(capacity.advertisedIntervalSeconds, 24 * 60 * 60);
  });

  test('an empty watchlist promises nothing and spends nothing', () => {
    const capacity = watchlistCapacityV1({ distinctAddresses: 0 });
    assert.equal(capacity.limitedBy, 'nothing_watched');
    assert.equal(capacity.utilisation, 0);
    assert.equal(capacity.achievableIntervalSeconds, 0);
  });

  test('the shipped defaults, pinned so a budget change cannot move a promise quietly', () => {
    // What the product actually advertises today, at three sizes. Changing a
    // budget number changes a sentence on somebody's screen, and it should
    // have to change a test to do it.
    assert.equal(watchlistCapacityV1({ distinctAddresses: 10 }).advertisedIntervalSeconds, 15 * 60);
    assert.equal(watchlistCapacityV1({ distinctAddresses: 100 }).advertisedIntervalSeconds, 30 * 60);
    assert.equal(watchlistCapacityV1({ distinctAddresses: 200 }).advertisedIntervalSeconds, 60 * 60);
    for (const addresses of [10, 100, 200]) {
      assert.ok(watchlistCapacityV1({ distinctAddresses: addresses }).utilisation <= 1);
    }
  });

  test('a small list is limited by the fastest tier we publish, not by the budget', () => {
    // Saying "limited by the router" here would send an operator to widen a
    // budget that has room.
    const capacity = watchlistCapacityV1({ distinctAddresses: 5 });
    assert.equal(capacity.limitedBy, 'tier_floor');
    assert.ok(capacity.achievableIntervalSeconds < 15 * 60);
  });
});

describe('what may become an alert', () => {
  test('a provider failure is never eligible, whatever it was measuring', () => {
    // The acceptance criterion for this phase, as a function: an alert about
    // an outage is an alert about Miorail, and it will be read as an alert
    // about somebody's money.
    for (const kind of ALERT_ELIGIBLE_KINDS_V1) {
      const decision = alertEligibilityV1({
        kind,
        recordedTransition: true,
        measurementCompleted: false,
      });
      assert.deepEqual(decision, { eligible: false, refusal: 'measurement_did_not_complete' });
    }
  });

  test('a state that was re-read is not a transition and is not eligible', () => {
    const decision = alertEligibilityV1({
      kind: 'official_asset_market_became_active',
      recordedTransition: false,
      measurementCompleted: true,
    });
    assert.deepEqual(decision, { eligible: false, refusal: 'not_a_recorded_transition' });
  });

  test('a kind nobody asked to hear about is refused', () => {
    const decision = alertEligibilityV1({
      kind: 'official_source_added_asset',
      recordedTransition: true,
      measurementCompleted: true,
    });
    assert.deepEqual(decision, { eligible: false, refusal: 'kind_not_eligible' });
  });

  test('a completed transition of an eligible kind is eligible', () => {
    assert.deepEqual(
      alertEligibilityV1({
        kind: 'official_asset_market_became_unreachable',
        recordedTransition: true,
        measurementCompleted: true,
      }),
      { eligible: true },
    );
  });
});
