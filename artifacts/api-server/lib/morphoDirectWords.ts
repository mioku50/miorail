// What a Still loan on Morpho says about its calls, now that the wallet calls
// Morpho Blue itself (2026-11-07). One place, so a borrow, an ETH loan and a
// repayment never describe the same calls differently.

/** Every Morpho review carries this note. */
export const MORPHO_DIRECT_CALLS_WARNING_V1 =
  'Still wrote these calls from Morpho Blue’s verified ABI and simulated them. Your wallet calls Morpho Blue itself, so no contract is given the right to act for it.';

/** A Morpho loan or repayment one transaction at a time, for a wallet that cannot send a batch. */
export function morphoStepsWarningV1(count: number, operation: 'borrow' | 'repay', returning = false): string {
  const steps = count === 1 ? 'one transaction' : `${count} steps, one transaction each`;
  return operation === 'borrow'
    ? `Your wallet sends this as ${steps}, and pays each network fee. Still reviews each next step again before your wallet asks for it. Stopping between steps takes no loan: an allowance or a pledge already sent stays in place, and a pledge comes back with Take back.`
    : `Your wallet sends this as ${steps}, and pays each network fee. Stopping after the allowance repays nothing. Whatever the repayment leaves of the allowance stays with Morpho Blue, which takes funds only for calls your own wallet makes.${
      returning ? ' Stopping after the repayment leaves the collateral deposited, to take back later.' : ''}`;
}
