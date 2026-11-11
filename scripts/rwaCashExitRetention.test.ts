import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CASH_EXIT_RETENTION_BATCH_V1,
  CASH_EXIT_RETENTION_MIN_DAYS_V1,
  cashExitRetentionDaysV1,
  cashExitRetentionLineV1,
  cashExitRetentionPlanV1,
} from './rwaCashExitRetention.js';

const env = (value?: string) => ({ ...(value === undefined ? {} : { RWA_CASH_EXIT_RETENTION_DAYS: value }) }) as NodeJS.ProcessEnv;

test('retention is off until a whole number of days, no fewer than two weeks, turns it on', () => {
  assert.equal(cashExitRetentionDaysV1(env()), null, 'unset: a deploy removes nothing by itself');
  assert.equal(cashExitRetentionDaysV1(env('')), null);
  assert.equal(cashExitRetentionDaysV1(env('30')), 30);
  assert.equal(cashExitRetentionDaysV1(env(' 45 ')), 45);
  assert.equal(cashExitRetentionDaysV1(env(String(CASH_EXIT_RETENTION_MIN_DAYS_V1))), 14);
  // Fewer days than anything reads back is not a setting, and neither is a word.
  for (const value of ['13', '7', '0', '-30', '30.5', '30d', 'true', '1e2', '99999']) {
    assert.equal(cashExitRetentionDaysV1(env(value)), null, value);
  }
});

test('the plan removes what finished before the day, and keeps each window with an hour on both sides', () => {
  const now = Date.parse('2026-11-11T20:00:00.000Z');
  const plan = cashExitRetentionPlanV1({
    days: 30,
    nowMs: now,
    windows: [
      { since: '2026-09-11T08:00:00.000Z', until: '2026-09-11T15:00:00.000Z' },
      { since: '2026-11-11T08:00:00.000Z', until: '2026-11-11T20:00:00.000Z' },
    ],
  });
  assert.deepEqual(plan, {
    before: '2026-10-12T20:00:00.000Z',
    keep: [
      { since: '2026-09-11T07:00:00.000Z', until: '2026-09-11T16:00:00.000Z' },
      { since: '2026-11-11T07:00:00.000Z', until: '2026-11-11T21:00:00.000Z' },
    ],
  });
  // No window at all is a plan too: a calendar with no multiplier change yet reads none.
  assert.deepEqual(cashExitRetentionPlanV1({ days: 30, nowMs: now, windows: [] }), { before: '2026-10-12T20:00:00.000Z', keep: [] });
});

test('a window that is not a time, or days that are not a setting, remove nothing', () => {
  const now = Date.parse('2026-11-11T20:00:00.000Z');
  const good = { since: '2026-09-11T08:00:00.000Z', until: '2026-09-11T15:00:00.000Z' };
  assert.equal(cashExitRetentionPlanV1({ days: 30, nowMs: now, windows: [good, { since: 'soon', until: good.until }] }), null);
  assert.equal(cashExitRetentionPlanV1({ days: 30, nowMs: now, windows: [{ since: good.until, until: good.since }] }), null, 'a window that ends before it starts');
  assert.equal(cashExitRetentionPlanV1({ days: 13, nowMs: now, windows: [good] }), null);
  assert.equal(cashExitRetentionPlanV1({ days: 30.5, nowMs: now, windows: [good] }), null);
  assert.equal(cashExitRetentionPlanV1({ days: 30, nowMs: Number.NaN, windows: [good] }), null);
});

test('the journal line says how many went and how many windows were kept', () => {
  assert.equal(cashExitRetentionLineV1({ days: 30, removed: 2000, kept: 12 }), 'retention: removed 2000 public ladders that finished more than 30 days ago; 12 windows kept for the dividend calendar');
  assert.equal(cashExitRetentionLineV1({ days: 30, removed: 1, kept: 1 }), 'retention: removed 1 public ladder that finished more than 30 days ago; 1 window kept for the dividend calendar');
  assert.ok(CASH_EXIT_RETENTION_BATCH_V1 <= 20_000, 'no more a pass than the repository allows');
});
