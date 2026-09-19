import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  b20MultiplierChangeHasHappenedV1,
  b20MultiplierStandingV1,
  type B20MultiplierEventV1,
  type B20MultiplierReadingV1,
} from '../src/multiplierLifecycle.js';

// ---------------------------------------------------------------------------
// A scheduled multiplier change is a plan, and a plan is not an event.
//
// Every test here is about one sentence being false: "the multiplier changed".
// Cobalt gives an issuer three ways to make that sentence false while a real
// log sits on the chain saying something — scheduled and not yet due, withdrawn
// before it was due, replaced before it was due — and the number involved is
// the one that says how many real shares a token is.
// ---------------------------------------------------------------------------

const ONE = (10n ** 18n).toString();
const TWO = (2n * 10n ** 18n).toString();
const HALF = (5n * 10n ** 17n).toString();

function at(iso: string): Date {
  return new Date(iso);
}

function scheduledV1(overrides: Partial<B20MultiplierEventV1> = {}): B20MultiplierEventV1 {
  return {
    event: 'ui_multiplier_updated',
    multiplierWad: TWO,
    effectiveAt: '2026-10-05T14:00:00.000Z',
    blockTime: '2026-10-01T09:00:00.000Z',
    blockNumber: 100,
    transactionHash: `0x${'aa'.repeat(32)}`,
    logIndex: 0,
    ...overrides,
  };
}

function readingV1(overrides: Partial<B20MultiplierReadingV1> = {}): B20MultiplierReadingV1 {
  return {
    multiplierWad: ONE,
    blockNumber: 200,
    blockTime: '2026-10-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('a multiplier change that has not happened yet', () => {
  test('before its date it is scheduled, and the effective value is still the old one', () => {
    const standing = b20MultiplierStandingV1({
      events: [scheduledV1()],
      reading: readingV1({ blockTime: '2026-10-02T00:00:00.000Z' }),
      now: at('2026-10-02T00:00:00.000Z'),
    });
    assert.equal(standing.history[0]!.state, 'scheduled');
    assert.equal(standing.scheduled.length, 1);
    // The whole point. A caller asking what one token converts with gets the
    // token's own reading, never the plan's number.
    assert.equal(standing.effectiveMultiplierWad, ONE);
    assert.notEqual(standing.effectiveMultiplierWad, TWO);
    assert.equal(b20MultiplierChangeHasHappenedV1(standing.history[0]!), false);
  });

  test('after its date it is effective only when the token itself says so', () => {
    const confirmed = b20MultiplierStandingV1({
      events: [scheduledV1()],
      reading: readingV1({ multiplierWad: TWO }),
      now: at('2026-10-06T00:00:00.000Z'),
    });
    assert.equal(confirmed.history[0]!.state, 'effective');
    assert.equal(confirmed.history[0]!.confirmedBy?.blockNumber, 200);
    assert.equal(confirmed.effectiveMultiplierWad, TWO);
    assert.equal(b20MultiplierChangeHasHappenedV1(confirmed.history[0]!), true);
  });

  test('the clock alone never makes it effective', () => {
    // The date passed and nobody has read the token since. Rounding this up to
    // `effective` would publish a value nothing measured; rounding it down to
    // `scheduled` would call a matured change pending forever.
    const noReading = b20MultiplierStandingV1({
      events: [scheduledV1()],
      reading: null,
      now: at('2026-10-06T00:00:00.000Z'),
    });
    assert.equal(noReading.history[0]!.state, 'awaiting_confirmation');
    assert.equal(noReading.effectiveMultiplierWad, null);
    assert.equal(noReading.scheduled.length, 0);
    assert.equal(b20MultiplierChangeHasHappenedV1(noReading.history[0]!), false);

    // A reading from BEFORE the change matured cannot confirm it either.
    const stale = b20MultiplierStandingV1({
      events: [scheduledV1()],
      reading: readingV1({ multiplierWad: TWO, blockTime: '2026-10-04T00:00:00.000Z' }),
      now: at('2026-10-06T00:00:00.000Z'),
    });
    assert.equal(stale.history[0]!.state, 'awaiting_confirmation');
  });
});

describe('a plan that was called off', () => {
  test('a cancellation matched by its pair retires exactly that change', () => {
    const standing = b20MultiplierStandingV1({
      events: [
        scheduledV1(),
        {
          event: 'ui_multiplier_update_cancelled',
          multiplierWad: TWO,
          effectiveAt: '2026-10-05T14:00:00.000Z',
          blockTime: '2026-10-03T11:00:00.000Z',
          blockNumber: 150,
          transactionHash: `0x${'bb'.repeat(32)}`,
          logIndex: 0,
        },
      ],
      reading: readingV1(),
      now: at('2026-10-06T00:00:00.000Z'),
    });
    const change = standing.history.find((row) => row.blockNumber === 100)!;
    assert.equal(change.state, 'not_executed_as_planned');
    assert.equal(change.cause, 'cancelled');
    assert.equal(standing.scheduled.length, 0);
    assert.equal(b20MultiplierChangeHasHappenedV1(change), false);
    // The cancellation is not itself a change and never appears as one.
    assert.equal(standing.history.length, 1);
  });

  test('a cancellation naming a different plan leaves this one alone', () => {
    // Matching on "the most recent pending" rather than on the pair would
    // retire a change the issuer never called off.
    const standing = b20MultiplierStandingV1({
      events: [
        scheduledV1(),
        {
          event: 'ui_multiplier_update_cancelled',
          multiplierWad: HALF,
          effectiveAt: '2026-10-05T14:00:00.000Z',
          blockTime: '2026-10-03T11:00:00.000Z',
          blockNumber: 150,
          transactionHash: `0x${'bb'.repeat(32)}`,
          logIndex: 0,
        },
      ],
      reading: readingV1({ blockTime: '2026-10-04T00:00:00.000Z' }),
      now: at('2026-10-04T00:00:00.000Z'),
    });
    assert.equal(standing.history[0]!.state, 'scheduled');
    assert.equal(standing.scheduled.length, 1);
  });
});

describe('a plan overtaken by another change', () => {
  test('an emergency change that matured first supersedes the plan behind it', () => {
    const standing = b20MultiplierStandingV1({
      events: [
        scheduledV1(),
        {
          event: 'multiplier_updated',
          multiplierWad: HALF,
          effectiveAt: null,
          blockTime: '2026-10-07T08:00:00.000Z',
          blockNumber: 300,
          transactionHash: `0x${'cc'.repeat(32)}`,
          logIndex: 0,
        },
      ],
      reading: readingV1({ multiplierWad: HALF, blockTime: '2026-10-08T00:00:00.000Z' }),
      now: at('2026-10-08T00:00:00.000Z'),
    });
    const planned = standing.history.find((row) => row.blockNumber === 100)!;
    const emergency = standing.history.find((row) => row.blockNumber === 300)!;
    assert.equal(planned.state, 'not_executed_as_planned');
    assert.equal(planned.cause, 'superseded');
    assert.equal(emergency.state, 'effective');
    assert.equal(standing.effectiveMultiplierWad, HALF);
  });

  test('an instant change is never called scheduled', () => {
    // The emergency setter emits the same event with `effectiveAt` equal to its
    // own block. It was in force when the log was written, so it goes straight
    // to a confirmed effective and never sits in the pending list.
    const standing = b20MultiplierStandingV1({
      events: [
        scheduledV1({
          effectiveAt: '2026-10-01T09:00:00.000Z',
          blockTime: '2026-10-01T09:00:00.000Z',
        }),
      ],
      reading: readingV1({ multiplierWad: TWO, blockTime: '2026-10-01T09:00:30.000Z' }),
      now: at('2026-10-01T10:00:00.000Z'),
    });
    assert.equal(standing.history[0]!.route, 'immediate_setter');
    assert.equal(standing.history[0]!.state, 'effective');
    assert.equal(standing.scheduled.length, 0);
  });

  test('a matured change the token does not carry is not effective', () => {
    // The date passed, we read the token AFTER it, and the value is something
    // else. Something replaced this change that we hold no log for — a fact
    // about our record, and never an excuse to call it effective.
    const standing = b20MultiplierStandingV1({
      events: [scheduledV1()],
      reading: readingV1({ multiplierWad: HALF }),
      now: at('2026-10-06T00:00:00.000Z'),
    });
    assert.equal(standing.history[0]!.state, 'not_executed_as_planned');
    assert.equal(standing.history[0]!.cause, 'superseded');
    assert.equal(standing.effectiveMultiplierWad, HALF);
  });

  test('two plans both still ahead stay scheduled — neither has replaced anything', () => {
    const standing = b20MultiplierStandingV1({
      events: [
        scheduledV1(),
        scheduledV1({
          multiplierWad: HALF,
          effectiveAt: '2026-10-09T14:00:00.000Z',
          blockTime: '2026-10-02T09:00:00.000Z',
          blockNumber: 120,
          transactionHash: `0x${'dd'.repeat(32)}`,
        }),
      ],
      reading: readingV1({ blockTime: '2026-10-03T00:00:00.000Z' }),
      now: at('2026-10-03T00:00:00.000Z'),
    });
    assert.equal(standing.scheduled.length, 2);
    assert.equal(
      standing.history.every((row) => row.state === 'scheduled'),
      true,
    );
  });
});

describe('what the record says when there is nothing in it', () => {
  test('no events and no reading is not a multiplier of one', () => {
    const standing = b20MultiplierStandingV1({ events: [], reading: null, now: at('2026-10-06T00:00:00.000Z') });
    assert.equal(standing.effectiveMultiplierWad, null);
    assert.equal(standing.effectiveAsOf, null);
    assert.deepEqual([...standing.scheduled], []);
    assert.deepEqual([...standing.history], []);
  });

  test('a reading with no events still answers the only question that matters', () => {
    const standing = b20MultiplierStandingV1({
      events: [],
      reading: readingV1(),
      now: at('2026-10-06T00:00:00.000Z'),
    });
    assert.equal(standing.effectiveMultiplierWad, ONE);
    assert.equal(standing.effectiveAsOf?.blockNumber, 200);
  });
});
