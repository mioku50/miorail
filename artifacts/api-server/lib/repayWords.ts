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
