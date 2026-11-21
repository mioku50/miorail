import assert from 'node:assert/strict';
import test from 'node:test';

import { morphoStepsWarningV1 } from './morphoDirectWords.js';

// Audit 11-20 LM-1: with a loan already open in the market, Take back first repays all of it, so a pledge
// sent before stopping does not come back on its own.
test('a loan in steps says how a pledge comes back, with and without a loan already open in the market', () => {
  const fresh = morphoStepsWarningV1(3, 'borrow');
  assert.match(fresh, /Stopping between steps takes no loan: an allowance or a pledge already sent stays in place, and a pledge comes back with Take back\.$/);
  const open = morphoStepsWarningV1(3, 'borrow', false, false, true);
  assert.match(open, /a pledge comes back only with Repay all and take back, which first repays this market’s whole loan and then returns all its collateral\.$/);
  assert.doesNotMatch(open, /comes back with Take back/);
  // An ETH loan says both: the wrap, and how the pledge comes back.
  const eth = morphoStepsWarningV1(4, 'borrow', false, true, true);
  assert.match(eth, /Repay all and take back.*The first step wraps your ETH/);
  // A repayment is unchanged by the flag.
  assert.equal(morphoStepsWarningV1(2, 'repay', true, false, true), morphoStepsWarningV1(2, 'repay', true));
});
