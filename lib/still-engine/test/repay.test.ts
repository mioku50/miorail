import assert from 'node:assert/strict';
import { test } from 'node:test';

import { repayAllBoundAtomicV1 } from '../src/repay.js';

// Audit LEND-2 (2026-11-10): one formula for the bound of Repay all, read by the page's Max and by
// the server that refuses an Aave Repay all below it.
test('the bound of Repay all is the debt up to the cent, and one cent or 0.1% of it more, whichever is more', () => {
  const cases: Array<[string, string]> = [
    ['850328', '870000'], ['2000000', '2010000'], ['2000003', '2020000'], ['3125001', '3140000'], ['1', '20000'],
    // Above ten USDC the room is 0.1%, rounded up to the cent: 10,000.123456 owed, 10,010.14 bound.
    ['10000123456', '10010140000'], ['20000000', '20020000'],
  ];
  for (const [debt, bound] of cases) {
    assert.equal(repayAllBoundAtomicV1(debt).toString(), bound, debt);
    assert.equal(repayAllBoundAtomicV1(BigInt(debt)).toString(), bound, debt);
    // Always above the debt, by a cent at least, and a whole number of cents.
    assert.ok(repayAllBoundAtomicV1(debt) - BigInt(debt) >= BigInt(10_000));
    assert.equal(repayAllBoundAtomicV1(debt) % BigInt(10_000), BigInt(0));
  }
});
