// What a Still loan on Morpho says about its calls, now that the wallet calls
// Morpho Blue itself (2026-11-07). One place, so a borrow, an ETH loan and a
// repayment never describe the same calls differently.

/** Every Morpho review carries this note. */
export const MORPHO_DIRECT_CALLS_WARNING_V1 =
  'Still wrote these calls from Morpho Blue’s verified ABI and simulated them. Your wallet calls Morpho Blue itself, so no contract is given the right to act for it.';

/** A Morpho loan or repayment one transaction at a time, for a wallet that cannot send a batch. `openDebt`: the
 * market already holds a loan of this wallet's, read at the review's block. */
export function morphoStepsWarningV1(count: number, operation: 'borrow' | 'repay', returning = false, wrapsEth = false, openDebt = false): string {
  const steps = count === 1 ? 'one transaction' : `${count} steps, one transaction each`;
  // A loan against ETH wraps it first (audit LEND-5): stopped after that step, the wallet holds WETH where it
  // held ETH, and Take back does not reach it, because it was never pledged. Said, so nobody looks for the ETH.
  const wrapped = wrapsEth ? ' The first step wraps your ETH: stopping after it leaves that amount in your wallet as WETH, not ETH, and not pledged.' : '';
  // With a loan already open in the market, Take back first repays all of it (audit 11-20 LM-1).
  const back = openDebt
    ? 'a pledge comes back only with Repay all and take back, which first repays this market’s whole loan and then returns all its collateral'
    : 'a pledge comes back with Take back';
  return operation === 'borrow'
    ? `Your wallet sends this as ${steps}, and pays each network fee. Still reviews each next step again before your wallet asks for it. Stopping between steps takes no loan: an allowance or a pledge already sent stays in place, and ${back}.${wrapped}`
    : `Your wallet sends this as ${steps}, and pays each network fee. Stopping after the allowance repays nothing. Whatever the repayment leaves of the allowance stays with Morpho Blue, which takes funds only for calls your own wallet makes.${
      returning ? ' Stopping after the repayment leaves the collateral deposited, to take back later.' : ''}`;
}
