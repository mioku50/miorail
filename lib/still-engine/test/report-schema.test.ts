import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeMirror } from '../src/mirror.js';
import { MirrorReportSchema } from '../src/report-schema.js';
import type { MirrorReport } from '../src/report.js';
import { EXAMPLE, SATURDAY, calendar, reverted, snapshot, universe } from './fixtures.js';

const subject = { address: '0x00000000000000000000000000000000000b0b0b' as const, name: null, input: 'example' };
const run = (s = snapshot(EXAMPLE)): MirrorReport =>
  computeMirror({ universe: universe(), snapshot: s, calendar: calendar(), subject, assembledAt: new Date('2026-10-21T15:00:01Z') });
/** What a client receives: the report after JSON, never the object in memory. */
const wire = (report: MirrorReport): unknown => JSON.parse(JSON.stringify(report));

describe('the client schema', () => {
  it('accepts every report the Mirror computes: a loan, a weekend, failed reads, nothing at all', () => {
    const failed = snapshot(EXAMPLE);
    failed.aave!.usdcDebt = reverted();
    failed.morpho.get('cbBTC')!.price = reverted();
    for (const report of [run(), run(snapshot(EXAMPLE, SATURDAY)), run(failed), run(snapshot({}))]) {
      assert.deepEqual(MirrorReportSchema.parse(wire(report)), wire(report));
    }
  });

  it('refuses a report with a field it does not know, a missing one, or a number for an amount', () => {
    const report = wire(run()) as { headline: unknown; venues: Array<Record<string, unknown>> };
    assert.equal(MirrorReportSchema.safeParse({ ...report, extra: 1 }).success, false);
    const { headline: _headline, ...missing } = report;
    assert.equal(MirrorReportSchema.safeParse(missing).success, false);
    const venues = report.venues.map((v, i) => (i === 0 ? { ...v, debtCents: 24017 } : v));
    assert.equal(MirrorReportSchema.safeParse({ ...report, venues }).success, false);
  });
});
