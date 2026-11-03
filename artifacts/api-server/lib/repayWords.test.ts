import assert from 'node:assert/strict';
import test from 'node:test';

import { repayMaximumBelowDebtWordsV1, repayWalletBelowMaximumWordsV1, usdcWordsV1 } from './repayWords.js';

// 2026-11-03: a wallet holding the 2 USDC it had borrowed asked to repay all
// with a maximum of 2 when the debt was 2.000003, and read no number at all.
test('a repayment that cannot be prepared is said in the wallet’s own numbers', () => {
  assert.equal(usdcWordsV1(2_000_003n), '2.000003 USDC');
  assert.equal(usdcWordsV1(2_000_000n), '2 USDC');
  assert.equal(usdcWordsV1(3n), '0.000003 USDC');
  assert.equal(
    repayMaximumBelowDebtWordsV1({ debt: 2_000_003n, maximum: 2_000_000n, wallet: 2_000_000n }),
    'The debt is 2.000003 USDC now, more than your maximum of 2 USDC: interest adds to it every second. Set the maximum to at least the debt; what is not needed stays in your wallet. This wallet holds 2 USDC, 0.000003 USDC short of the debt: add a little more than that, then read the position again.',
  );
  assert.doesNotMatch(repayMaximumBelowDebtWordsV1({ debt: 2_000_003n, maximum: 2_000_000n, wallet: 5_000_000n }), /short/);
  assert.equal(
    repayWalletBelowMaximumWordsV1({ debt: 1_000_000n, maximum: 3_000_000n, wallet: 2_000_000n }),
    'This wallet holds 2 USDC, less than your maximum of 3 USDC. The debt is 1 USDC, so a maximum between that and what the wallet holds covers it.',
  );
  assert.match(repayWalletBelowMaximumWordsV1({ debt: 2_000_003n, maximum: 3_000_000n, wallet: 2_000_000n }), /The debt is 2\.000003 USDC, 0\.000003 USDC more than the wallet holds/);
});
