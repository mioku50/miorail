import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  countdownLabelV1,
  intervalLabelV1,
  watchRowScheduleViewV1,
  watchSlaViewV1,
  type WatchSlaWireV1,
} from '../src/console/watchSlaView';

const NOW = new Date('2026-08-25T12:00:00.000Z');

function slaV1(overrides: Partial<WatchSlaWireV1> = {}): WatchSlaWireV1 {
  return {
    distinctAddresses: 12,
    advertisedIntervalSeconds: 1_800,
    achievableIntervalSeconds: 160,
    limitedBy: 'tier_floor',
    utilisation: 0.1,
    beyondSlowestTier: false,
    scheduleActive: true,
    ...overrides,
  };
}

describe('the freshness promise, in words', () => {
  test('an interval is a round number of minutes or hours, never arithmetic', () => {
    assert.equal(intervalLabelV1(3_600), 'hourly');
    assert.equal(intervalLabelV1(1_800), 'every 30 minutes');
    assert.equal(intervalLabelV1(6 * 3_600), 'every 6 hours');
  });

  test('overdue is stated, never hidden behind "any moment now"', () => {
    assert.equal(countdownLabelV1('2026-08-25T12:11:00.000Z', NOW), 'in 11m');
    assert.equal(countdownLabelV1('2026-08-25T12:00:30.000Z', NOW), 'in 30s');
    assert.equal(countdownLabelV1('2026-08-25T11:59:40.000Z', NOW), 'due now');
    // A queue that has fallen behind is a fact the promise owes the reader.
    assert.equal(countdownLabelV1('2026-08-25T11:20:00.000Z', NOW), 'overdue by 40m');
  });

  test('an unreconciled schedule promises nothing rather than printing a number', () => {
    const view = watchSlaViewV1(slaV1({ scheduleActive: false }));
    assert.match(view.headline, /Nothing is scheduled yet/);
    assert.equal(/\d+ minutes|hourly/.test(view.headline), false);
  });

  test('a list past the slowest tier says the promise is not being kept', () => {
    const view = watchSlaViewV1(slaV1({ beyondSlowestTier: true, distinctAddresses: 4_000 }));
    assert.equal(view.tone, 'warn');
    assert.match(view.detail, /not being kept/);
  });

  test('the promise names the dedupe rule, because it is what makes it affordable', () => {
    const view = watchSlaViewV1(slaV1());
    assert.equal(view.headline, 'Checked every 30 minutes.');
    assert.match(view.detail, /two people watching one token is one check/);
  });
});

describe('one row’s promise', () => {
  test('a row nobody has scheduled says so, and shows no countdown', () => {
    const view = watchRowScheduleViewV1(null, NOW);
    assert.equal(view.next, 'not scheduled yet');
    assert.equal(view.lastCompleted, 'never checked on a schedule');
    assert.equal(view.tone, 'off');
  });

  test('freshness comes from the last COMPLETED check, never the last attempt', () => {
    // The failure this prevents: an outage at 11:55 reported as a reading at
    // 11:55, five minutes fresh, on a measurement that established nothing.
    const view = watchRowScheduleViewV1(
      {
        intervalSeconds: 1_800,
        nextDueAt: '2026-08-25T12:25:00.000Z',
        lastCheckedAt: '2026-08-25T11:55:00.000Z',
        lastCompletedAt: '2026-08-25T10:00:00.000Z',
        lastOutcome: 'measurement_failed',
        checks: 4,
        completedChecks: 3,
      },
      NOW,
    );
    assert.equal(view.next, 'next check in 25m');
    assert.equal(view.lastCompleted, 'last measured 2h ago');
    assert.match(view.lastFailure!, /did not complete/);
    assert.match(view.lastFailure!, /Nothing here changed as a result/);
    assert.equal(view.tone, 'warn');
  });

  test('a chain read that failed is about the endpoint, not the token', () => {
    const view = watchRowScheduleViewV1(
      {
        intervalSeconds: 1_800,
        nextDueAt: '2026-08-25T12:25:00.000Z',
        lastCheckedAt: '2026-08-25T11:55:00.000Z',
        lastCompletedAt: null,
        lastOutcome: 'unreadable',
        checks: 1,
        completedChecks: 0,
      },
      NOW,
    );
    assert.equal(view.lastCompleted, 'nothing measured yet');
    assert.match(view.lastFailure!, /about the endpoint, not the token/);
  });
});
