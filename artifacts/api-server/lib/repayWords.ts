// ---------------------------------------------------------------------------
// A repayment the server cannot prepare, said in the wallet's own numbers. On
// 2026-11-03 a wallet holding the 2 USDC it had borrowed asked to repay all
// with a maximum of 2, eleven minutes later, when the debt was 2.000003. The
// review said "The recorded debt exceeds your explicit maximum USDC budget."
// and nothing else. The page, the chat card and an assistant all read these.
// ---------------------------------------------------------------------------

/** "2.000003 USDC": exact, with no rounding and no trailing zeros. */
export function usdcWordsV1(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} USDC`;
}

function shortWordsV1(debt: bigint, wallet: bigint): string {
  return wallet < debt
    ? ` This wallet holds ${usdcWordsV1(wallet)}, ${usdcWordsV1(debt - wallet)} short of the debt: add a little more than that, then read the position again.`
    : '';
}

/** Repay all with a maximum below the debt as it is now. */
export function repayMaximumBelowDebtWordsV1(input: { debt: bigint; maximum: bigint; wallet: bigint }): string {
  return `The debt is ${usdcWordsV1(input.debt)} now, more than your maximum of ${usdcWordsV1(input.maximum)}: interest adds to it every second. `
    + `Set the maximum to at least the debt; what is not needed stays in your wallet.${shortWordsV1(input.debt, input.wallet)}`;
}

/** A maximum the wallet's USDC does not cover. */
export function repayWalletBelowMaximumWordsV1(input: { debt: bigint; maximum: bigint; wallet: bigint }): string {
  return `This wallet holds ${usdcWordsV1(input.wallet)}, less than your maximum of ${usdcWordsV1(input.maximum)}.`
    + (input.wallet >= input.debt
      ? ` The debt is ${usdcWordsV1(input.debt)}, so a maximum between that and what the wallet holds covers it.`
      : ` The debt is ${usdcWordsV1(input.debt)}, ${usdcWordsV1(input.debt - input.wallet)} more than the wallet holds: add a little more than that, then read the position again.`);
}

/** An exact repayment at or above a Morpho debt. Morpho keeps a debt as shares, and the debt shown
 * is rounded up from them, so repaying exactly that amount is more than is owed, and Morpho would
 * revert it (2026-11-07: Max put the 0.840001 USDC shown into Exact USDC; the shares were worth
 * between 0.84 and 0.840001, and the review said only that it could not be established). */
export function repayExactOverDebtWordsV1(input: { assets: bigint; debt: bigint; block: bigint | number }): string {
  return `An exact repayment of ${usdcWordsV1(input.assets)} is more than this debt. Morpho keeps a debt as shares: at block `
    + `${BigInt(input.block).toLocaleString('en-US')} these are worth no more than ${usdcWordsV1(input.debt)}, the debt shown, which is rounded up. `
    + 'An exact repayment has to be less than the debt. To repay all of it, choose Repay all debt: it repays the shares themselves, '
    + 'with the interest until the transaction lands, and leaves nothing behind.';
}

/** An exact repayment too small to repay one debt share. */
export function repayExactRoundsToZeroWordsV1(input: { assets: bigint }): string {
  return `An exact repayment of ${usdcWordsV1(input.assets)} is less than one share of this Morpho debt is worth, so it would repay nothing. Enter a larger amount.`;
}
