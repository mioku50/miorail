import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { stockReleaseFailureCopyV1 } from '../src/console/stockActionReviewConsole';

// ---------------------------------------------------------------------------
// What a person is told when the batch never reached their wallet.
//
// Every sentence here is read at the moment somebody expected a wallet to open
// and it did not. Two rules hold across all of them: the reason belongs to
// whoever owns it — the issuer, the market, this server — and none of them is
// allowed to read as a judgement about the reader or about the security.
// ---------------------------------------------------------------------------

describe('a release that did not happen', () => {
  test('the issuer executor refusal names the contract, not the person', () => {
    const copy = stockReleaseFailureCopyV1(new Error('stock_action_executor_not_authorized'));
    assert.match(copy, /issuer/i);
    assert.match(copy, /contract/i);
    assert.match(copy, /not a statement about you/i);
    // The trap it exists to close: the allowance would have been granted.
    assert.match(copy, /approving is not policy gated/i);
    assert.match(copy, /never asked/i);
  });

  test('a declined wallet is not a server failure, and a server failure is not a verdict', () => {
    assert.match(
      stockReleaseFailureCopyV1(new Error('User rejected the request')),
      /you declined/i,
    );
    assert.match(
      stockReleaseFailureCopyV1(new Error('something nobody has seen before')),
      /not a statement about the security/i,
    );
  });

  test('no sentence carries an endpoint, a key or a stack', () => {
    for (const code of [
      'stock_action_executor_not_authorized',
      'stock_action_refresh_required',
      'stock_action_blocked',
      'stock_action_route_unavailable',
      'stock_action_sell_requires_exact_size',
      'anything else at all',
    ]) {
      const copy = stockReleaseFailureCopyV1(new Error(code));
      assert.ok(copy.length > 40, `${code} has no explanation`);
      assert.doesNotMatch(copy, /https?:|api[_-]?key|at Object\./i);
      // The code itself is a system word and never the sentence.
      assert.doesNotMatch(copy, /stock_action_/);
    }
  });
});
