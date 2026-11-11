import assert from 'node:assert/strict';
import test from 'node:test';

import { repayExactOverDebtWordsV1, repayExactRoundsToZeroWordsV1, repayMaximumBelowDebtWordsV1, repayWalletBelowMaximumWordsV1, usdcWordsV1 } from './repayWords.js';

// 2026-11-03: a wallet holding the 2 USDC it had borrowed asked to repay all
// with a maximum of 2 when the debt was 2.000003, and read no number at all.
test('a repayment that cannot be prepared is said in the wallet’s own numbers', () => {
  assert.equal(usdcWordsV1(2_000_003n), '2.000003 USDC');
  assert.equal(usdcWordsV1(2_000_000n), '2 USDC');
  assert.equal(usdcWordsV1(3n), '0.000003 USDC');
  assert.equal(
    repayMaximumBelowDebtWordsV1({ debt: 2_000_003n, maximum: 2_000_000n, wallet: 2_000_000n }),
    'The debt is 2.000003 USDC now, more than your maximum of 2 USDC: interest adds to it every second. Set the maximum a little above the debt; what is not needed stays in your wallet. This wallet holds 2 USDC, 0.000003 USDC short of the debt: send it a little more USDC than that, then read the position again.',
  );
  // Audit LEND-2 (2026-11-10): "at least the debt" was the advice that left a tail on Aave. There the least
  // bound is named, and what the wallet is short of it.
  assert.equal(
    repayMaximumBelowDebtWordsV1({ debt: 2_000_003n, maximum: 2_000_003n, wallet: 2_000_060n, minimum: 2_020_000n }),
    'The debt is 2.000003 USDC now and your maximum is 2.000003 USDC: interest adds to the debt every second, and with so little room a part of it would be left owing. Set the maximum to at least 2.02 USDC; what is not needed stays in your wallet. This wallet holds 2.00006 USDC, 0.01994 USDC short of that: send it at least that much more USDC, then read the position again.',
  );
  assert.equal(
    repayMaximumBelowDebtWordsV1({ debt: 2_000_003n, maximum: 2_000_000n, wallet: 5_000_000n, minimum: 2_020_000n }),
    'The debt is 2.000003 USDC now, more than your maximum of 2 USDC: interest adds to it every second. Set the maximum to at least 2.02 USDC; what is not needed stays in your wallet.',
  );
  for (const words of [repayMaximumBelowDebtWordsV1({ debt: 5n, maximum: 4n, wallet: 9n }), repayMaximumBelowDebtWordsV1({ debt: 5n, maximum: 5n, wallet: 9n, minimum: 20_000n })]) {
    assert.doesNotMatch(words, /at least the debt/);
  }
  assert.equal(
    repayWalletBelowMaximumWordsV1({ debt: 1_000_000n, maximum: 3_000_000n, wallet: 2_000_000n, minimum: 1_010_000n }),
    'This wallet holds 2 USDC, less than your maximum of 3 USDC. The debt is 1 USDC and Repay all is asked with at least 1.01 USDC, so a maximum between that and what the wallet holds covers it.',
  );
  assert.equal(
    repayWalletBelowMaximumWordsV1({ debt: 1_000_000n, maximum: 1_010_000n, wallet: 1_004_000n, minimum: 1_010_000n }),
    'This wallet holds 1.004 USDC, less than your maximum of 1.01 USDC. The debt is 1 USDC and Repay all is asked with at least 1.01 USDC, 0.006 USDC more than the wallet holds: send it at least that much more USDC, then read the position again.',
  );
  assert.doesNotMatch(repayMaximumBelowDebtWordsV1({ debt: 2_000_003n, maximum: 2_000_000n, wallet: 5_000_000n }), /short/);
  assert.equal(
    repayWalletBelowMaximumWordsV1({ debt: 1_000_000n, maximum: 3_000_000n, wallet: 2_000_000n }),
    'This wallet holds 2 USDC, less than your maximum of 3 USDC. The debt is 1 USDC, so a maximum between that and what the wallet holds covers it.',
  );
  assert.match(repayWalletBelowMaximumWordsV1({ debt: 2_000_003n, maximum: 3_000_000n, wallet: 2_000_000n }), /The debt is 2\.000003 USDC, 0\.000003 USDC more than the wallet holds/);
});

// 2026-11-07: Exact USDC with the Morpho debt shown, 0.840001 USDC, whose shares were worth between
// 0.84 and 0.840001, read only "could not be established".
test('an exact repayment Morpho cannot take says why and names Repay all', () => {
  const words = repayExactOverDebtWordsV1({ assets: 840_001n, debt: 840_001n, block: 54_327_906n });
  assert.match(words, /^An exact repayment of 0\.840001 USDC is more than this debt\. Morpho keeps a debt as shares: at block 54,327,906 these are worth no more than 0\.840001 USDC, the debt shown, which is rounded up\./);
  assert.match(words, /To repay all of it, choose Repay all debt/);
  assert.equal(repayExactRoundsToZeroWordsV1({ assets: 1n }),
    'An exact repayment of 0.000001 USDC is less than one share of this Morpho debt is worth, so it would repay nothing. Enter a larger amount.');
});
