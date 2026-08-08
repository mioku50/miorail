import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { toDriverParameter } from './index.js';

// ---------------------------------------------------------------------------
// The bug this exists to stop coming back.
//
// Every timestamp-writing repository in this codebase was written against
// Neon's HTTP driver, which takes a JS Date parameter without complaint. The
// move to a local PostgreSQL swapped in postgres-js, which throws on one
// before the query leaves the process — so confirming a Base Account spend
// permission answered 500, and so would fifty-seven other writes.
//
// Nothing about that failure is visible in a repository's own tests: they run
// against the in-memory fake or against whichever driver the suite happens to
// have. It is a property of the boundary, and this is the boundary.
// ---------------------------------------------------------------------------

describe('a Date never reaches postgres-js', () => {
  test('a Date becomes an ISO string', () => {
    assert.equal(
      toDriverParameter(new Date(Date.UTC(2026, 7, 8, 15, 24, 4, 521))),
      '2026-08-08T15:24:04.521Z',
    );
  });

  test('the no-expiry sentinel survives, because that is the one that broke', () => {
    // PAID_EVIDENCE_NO_EXPIRY_MS_V1 — a permission the wallet granted with no
    // end date. Year 9999 is inside the range of both a JS Date and a
    // Postgres timestamp, so the conversion must not clamp or round it.
    assert.equal(
      toDriverParameter(new Date(Date.UTC(9999, 11, 31, 23, 59, 59))),
      '9999-12-31T23:59:59.000Z',
    );
  });

  test('everything else is handed over untouched', () => {
    // Not "converted to something reasonable" — untouched. The driver's own
    // type inference is correct for all of these, and second-guessing it here
    // would be a new source of surprises.
    const values: unknown[] = [
      'a string',
      42,
      0,
      -1.5,
      true,
      false,
      null,
      undefined,
      BigInt('123456789012345678901234567890'),
      '2026-08-08T15:24:04.521Z',
    ];
    for (const value of values) {
      assert.equal(toDriverParameter(value), value, `${String(value)} was altered`);
    }
  });

  test('an object that merely looks like a Date is not rewritten', () => {
    // `instanceof`, not duck typing: a row projection with its own toISOString
    // is not a timestamp, and turning it into one would corrupt a write
    // silently rather than loudly.
    const impostor = { toISOString: () => 'nope' };
    assert.equal(toDriverParameter(impostor), impostor);
  });

  test('an Invalid Date is not smuggled through as null', () => {
    // `new Date(NaN).toISOString()` throws RangeError. That is the correct
    // outcome — it fails at the call site with a real stack instead of writing
    // a wrong timestamp — and this test pins the behaviour so nobody
    // "helpfully" swallows it later.
    assert.throws(() => toDriverParameter(new Date(Number.NaN)), RangeError);
  });
});
