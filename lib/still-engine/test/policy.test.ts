import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WAD } from '../src/math.js';
import { TERMS, earningsWindow, earningsWindowOf, marketDate, safetyFromHealthFactor, stillShareBps, weekendWindow } from '../src/policy.js';
import { assertMatches } from './matches.js';

const at = (iso: string) => new Date(iso);

describe('the New York weekend window', () => {
  it('opens at Friday 20:00 and closes at Sunday 20:00 local time (EDT, UTC−4)', () => {
    assert.equal(weekendWindow(at('2026-10-23T23:59:59Z')).active, false); // Fri 19:59:59
    assert.equal(weekendWindow(at('2026-10-24T00:00:00Z')).active, true); // Fri 20:00:00
    assert.equal(weekendWindow(at('2026-10-25T23:59:59Z')).active, true); // Sun 19:59:59
    assert.equal(weekendWindow(at('2026-10-26T00:00:00Z')).active, false); // Sun 20:00:00
    const w = weekendWindow(at('2026-10-25T14:47:13Z'));
    assert.equal(w.startsAt.toISOString(), '2026-10-24T00:00:00.000Z');
    assert.equal(w.endsAt.toISOString(), '2026-10-26T00:00:00.000Z');
  });

  it('ends at 20:00 EST on the Sunday clocks fall back (Nov 1, 2026)', () => {
    const w = weekendWindow(at('2026-10-31T12:00:00Z'));
    assert.equal(w.active, true);
    assert.equal(w.startsAt.toISOString(), '2026-10-31T00:00:00.000Z'); // Fri 20:00 EDT
    assert.equal(w.endsAt.toISOString(), '2026-11-02T01:00:00.000Z'); // Sun 20:00 EST
    assert.equal(weekendWindow(at('2026-11-02T00:59:59Z')).active, true);
    assert.equal(weekendWindow(at('2026-11-02T01:00:00Z')).active, false);
  });

  it('ends at 20:00 EDT on the Sunday clocks spring forward (Mar 8, 2026)', () => {
    const w = weekendWindow(at('2026-03-07T12:00:00Z'));
    assert.equal(w.startsAt.toISOString(), '2026-03-07T01:00:00.000Z'); // Fri 20:00 EST
    assert.equal(w.endsAt.toISOString(), '2026-03-09T00:00:00.000Z'); // Sun 20:00 EDT
  });

  it('points at the next window on a weekday', () => {
    const w = weekendWindow(at('2026-10-21T15:00:00Z')); // Wednesday
    assert.equal(w.active, false);
    assert.equal(w.startsAt.toISOString(), '2026-10-24T00:00:00.000Z');
    assert.equal(weekendWindow(at('2026-10-26T00:00:00Z')).startsAt.toISOString(), '2026-10-31T00:00:00.000Z');
  });

  it('agrees with its own bounds at every minute of two weeks, across a clock change', { timeout: 60_000 }, () => {
    const start = Date.parse('2026-10-19T00:00:00Z');
    for (let t = start; t < start + 14 * 86_400_000; t += 60_000) {
      const now = new Date(t);
      const w = weekendWindow(now);
      assert.ok((w.endsAt.getTime() - w.startsAt.getTime()) >= 48 * 3_600_000);
      assert.ok((w.endsAt.getTime() - w.startsAt.getTime()) <= 49 * 3_600_000);
      if (w.active) assert.equal(now >= w.startsAt && now < w.endsAt, true);
      else assert.equal(now < w.startsAt, true);
    }
  });
});

describe('terms', () => {
  it('lends at half the protocol factor, and 40% of it for stocks on weekends and around earnings', () => {
    assert.equal(stillShareBps('stock', false), 5_000n);
    assert.equal(stillShareBps('stock', true), 4_000n);
    assert.equal(stillShareBps('stock', false, true), 4_000n);
    assert.equal(stillShareBps('stock', true, true), 4_000n); // never stacked
    assert.equal(stillShareBps('crypto', true, true), 5_000n);
    assert.equal(TERMS.shareOfProtocolBps, 5_000n);
  });

  it('classifies safety at the Draw thresholds, health factor 1.6 and 1.25', () => {
    assert.deepEqual(safetyFromHealthFactor(2n * WAD), { marginBps: 5_000n, state: 'calm' });
    assert.deepEqual(safetyFromHealthFactor(1_600_000_000_000_000_000n), { marginBps: 3_750n, state: 'calm' });
    assert.equal(safetyFromHealthFactor(1_599_999_999_999_999_999n).state, 'watch');
    assert.deepEqual(safetyFromHealthFactor(1_250_000_000_000_000_000n), { marginBps: 2_000n, state: 'watch' });
    assert.equal(safetyFromHealthFactor(1_249_999_999_999_999_999n).state, 'act');
    assert.deepEqual(safetyFromHealthFactor(WAD), { marginBps: 0n, state: 'liquidation' });
    assert.equal(safetyFromHealthFactor(WAD / 2n).state, 'liquidation');
  });
});

describe('the earnings window', () => {
  it('runs from 00:00 the day before the report date to 20:00 the day after, New York time', () => {
    const w = earningsWindowOf('2026-10-28');
    assert.equal(w.startsAt.toISOString(), '2026-10-27T04:00:00.000Z'); // Tue 00:00 EDT
    assert.equal(w.endsAt.toISOString(), '2026-10-30T00:00:00.000Z'); // Thu 20:00 EDT
  });

  it('keeps New York hours across the clock change (Nov 1, 2026)', () => {
    const w = earningsWindowOf('2026-11-02');
    assert.equal(w.startsAt.toISOString(), '2026-11-01T04:00:00.000Z'); // Sun 00:00 EDT, before 02:00
    assert.equal(w.endsAt.toISOString(), '2026-11-04T01:00:00.000Z'); // Tue 20:00 EST
    assert.equal(earningsWindowOf('2026-03-01').startsAt.toISOString(), '2026-02-28T05:00:00.000Z'); // across a month end
  });

  it('finds the open window first, else the nearest next, else none', () => {
    const dates = ['2026-10-21', '2026-10-28', '2027-01-27'];
    assertMatches(earningsWindow(at('2026-10-22T23:59:59Z'), dates), { reportDate: '2026-10-21', active: true });
    assertMatches(earningsWindow(at('2026-10-23T00:00:00Z'), dates), { reportDate: '2026-10-28', active: false });
    assertMatches(earningsWindow(at('2026-10-27T04:00:00Z'), dates), { reportDate: '2026-10-28', active: true });
    assertMatches(earningsWindow(at('2026-11-15T12:00:00Z'), dates), { reportDate: '2027-01-27', active: false });
    assert.equal(earningsWindow(at('2027-02-01T00:00:00Z'), dates), null);
    assert.equal(earningsWindow(at('2026-10-25T12:00:00Z'), []), null);
  });

  it('names the New York day of an instant', () => {
    assert.equal(marketDate(at('2026-10-28T03:59:59Z')), '2026-10-27');
    assert.equal(marketDate(at('2026-10-28T04:00:00Z')), '2026-10-28');
    assert.equal(marketDate(at('2026-11-02T04:59:59Z')), '2026-11-01');
  });
});
