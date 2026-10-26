// Exact integer arithmetic for money. Onchain amounts stay bigint end to end; every division
// names its rounding direction. A safety margin or an amount the person may borrow rounds down,
// a debt or a liquidation price rounds up: rounding always works against the transaction.

export const WAD = 10n ** 18n;
export const RAY = 10n ** 27n;
export const BPS = 10_000n;

export type Rounding = 'down' | 'up';

export function mulDiv(a: bigint, b: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator <= 0n) throw new RangeError('mulDiv: denominator must be positive');
  if (a < 0n || b < 0n) throw new RangeError('mulDiv: operands must not be negative');
  const product = a * b;
  const quotient = product / denominator;
  return rounding === 'up' && quotient * denominator !== product ? quotient + 1n : quotient;
}

export function divide(a: bigint, denominator: bigint, rounding: Rounding): bigint {
  return mulDiv(a, 1n, denominator, rounding);
}

export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** USDC has 6 decimals; a cent is 10^4 of its base units. */
const USDC_UNITS_PER_CENT = 10n ** 4n;

export function usdcToCents(raw: bigint, rounding: Rounding): bigint {
  return divide(raw, USDC_UNITS_PER_CENT, rounding);
}
