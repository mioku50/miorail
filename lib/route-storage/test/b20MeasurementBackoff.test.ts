import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_OBSERVATION_REJECTION_REASONS_V1,
  B20_OBSERVATION_UNMEASURED_REASONS_V1,
} from '@mioagent/opportunity-rail';

import {
  B20_MEASUREMENT_BACKOFF_V1,
  B20_REPRICEABLE_REJECTIONS_V1,
  B20_ROUTE_EXISTENCE_REJECTIONS_V1,
  b20ReMeasureIntervalMsV1,
} from '../src/b20MeasurementBackoff.js';

const HOUR = 3_600_000;

describe('every rejection reason has a deliberate interval', () => {
  test('the two lists name only reasons that exist', () => {
    // A typo here is silent: an unknown reason falls through to the base
    // interval, which is the burn we are removing.
    for (const reason of [...B20_REPRICEABLE_REJECTIONS_V1, ...B20_ROUTE_EXISTENCE_REJECTIONS_V1]) {
      assert.ok(
        (B20_OBSERVATION_REJECTION_REASONS_V1 as readonly string[]).includes(reason),
        `${reason} is not a rejection an observation can carry`,
      );
    }
  });

  test('a new rejection reason cannot be added without deciding its interval', () => {
    // `uninitialized` is the one deliberate omission: a pool mid-birth is
    // minutes from being worth another look.
    const decided = new Set([
      ...B20_REPRICEABLE_REJECTIONS_V1,
      ...B20_ROUTE_EXISTENCE_REJECTIONS_V1,
      'uninitialized',
    ]);
    const undecided = B20_OBSERVATION_REJECTION_REASONS_V1.filter((reason) => !decided.has(reason));
    assert.deepEqual(undecided, [], 'add it to a list, or to the omission above with a reason');
  });

  test('our own failures never earn a long silence', () => {
    // These carry `unmeasured`, not `rejected` — the distinction is what keeps
    // a throttled endpoint from being backed off like a settled verdict.
    for (const reason of B20_OBSERVATION_UNMEASURED_REASONS_V1) {
      const interval = b20ReMeasureIntervalMsV1({ state: 'unmeasured', reasonCode: reason, repeats: 99 });
      assert.equal(interval, B20_MEASUREMENT_BACKOFF_V1.baseMs, reason);
    }
  });
});

describe('the interval matches what the verdict is about', () => {
  test('never measured gets the base interval', () => {
    assert.equal(
      b20ReMeasureIntervalMsV1({ state: null, reasonCode: null, repeats: 0 }),
      B20_MEASUREMENT_BACKOFF_V1.baseMs,
    );
  });

  test('provisional keeps the short interval however often it repeats', () => {
    // The tokens the rail exists for. Backing these off would save RPC by
    // giving up the only measurements anyone wants.
    assert.equal(
      b20ReMeasureIntervalMsV1({ state: 'provisional', reasonCode: 'quoted_pre_entry', repeats: 500 }),
      B20_MEASUREMENT_BACKOFF_V1.baseMs,
    );
  });

  test('a price rejection stays at an hour no matter how often it repeats', () => {
    for (const repeats of [1, 3, 50]) {
      assert.equal(
        b20ReMeasureIntervalMsV1({ state: 'rejected', reasonCode: 'round_trip_above_tolerance', repeats }),
        HOUR,
        `repeats=${repeats}`,
      );
    }
  });

  test('a route-existence rejection escalates from six hours to a day', () => {
    const settling = b20ReMeasureIntervalMsV1({ state: 'rejected', reasonCode: 'no_entry_route', repeats: 1 });
    const settled = b20ReMeasureIntervalMsV1({ state: 'rejected', reasonCode: 'no_entry_route', repeats: 3 });
    assert.equal(settling, 6 * HOUR);
    assert.equal(settled, 24 * HOUR);
    assert.ok(settled > settling);
  });

  test('uninitialized is short — the pool is about to exist', () => {
    assert.equal(
      b20ReMeasureIntervalMsV1({ state: 'rejected', reasonCode: 'uninitialized', repeats: 9 }),
      B20_MEASUREMENT_BACKOFF_V1.baseMs,
    );
  });

  test('the caller’s base interval overrides only the base', () => {
    // The worker passes `--min-interval`; it must not silently rescale the
    // settled intervals with it.
    const backoff = { ...B20_MEASUREMENT_BACKOFF_V1, baseMs: 90 * 60_000 };
    assert.equal(
      b20ReMeasureIntervalMsV1({ state: 'provisional', reasonCode: null, repeats: 0, backoff }),
      90 * 60_000,
    );
    assert.equal(
      b20ReMeasureIntervalMsV1({ state: 'rejected', reasonCode: 'no_entry_route', repeats: 5, backoff }),
      24 * HOUR,
    );
  });
});

describe('what this actually saves', () => {
  test('a token rejected for good is measured single digits over 48 hours', () => {
    // Production before the change: 72 observations per token per 24 hours,
    // `count(distinct state) = 1`, 144 over the launch window. This walks the
    // policy forward the way the worker would.
    let elapsed = 0;
    let repeats = 0;
    let measurements = 0;
    while (elapsed <= 48 * HOUR) {
      measurements += 1;
      repeats += 1;
      elapsed += b20ReMeasureIntervalMsV1({
        state: 'rejected',
        reasonCode: 'no_entry_route',
        repeats,
      });
    }
    assert.ok(measurements <= 8, `expected single digits over 48h, got ${measurements}`);
    assert.ok(measurements >= 3, 'but not so few that a pool appearing is never noticed');
  });
});
