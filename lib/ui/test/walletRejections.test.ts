import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { borrowUserRejectedV1 } from '../src/console/borrowSubmissionGuard';
import { walletUserRejectedV1 } from '../src/console/walletBatchSupport';

// Audit WAL-1, 2026-11-20: WalletConnect answers a refusal with CAIP-25's 5000, which the chat card's provider passes on
// as it is. Read as "may have been sent", it held the loan's market for nothing.
describe('a refusal in the wallet', () => {
  it('is 4001, WalletConnect’s 5000, or viem’s UserRejectedRequestError, however deep in the causes', () => {
    for (const classify of [borrowUserRejectedV1, walletUserRejectedV1]) {
      assert.equal(classify({ code: 4001 }), true);
      assert.equal(classify({ code: 5000, message: 'User rejected.' }), true);
      assert.equal(classify({ name: 'UserRejectedRequestError' }), true);
      assert.equal(classify({ message: 'wrapped', cause: { cause: { code: 5000 } } }), true);
      assert.equal(classify({ code: -32603, message: 'Internal error' }), false);
      assert.equal(classify(new Error('timeout')), false);
      assert.equal(classify(null), false);
    }
  });
});
