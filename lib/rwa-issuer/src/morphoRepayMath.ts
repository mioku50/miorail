import { toAssetsUpV1, toSharesDownV1, type MorphoMarketTotalsV1, type MorphoPositionV1 } from './morphoBorrowMath.js';

/** Exact USDC assets, or the owner's full debt-share balance. A displayed
 * rounded debt amount is never used as a substitute for a full repayment. */
export type MorphoRepayAmountV1 = { mode: 'assets'; assets: bigint } | { mode: 'all' };

export type MorphoRepayProjectionV1 =
  | { ok: true; repaidAssets: bigint; repaidShares: bigint; position: MorphoPositionV1; totals: MorphoMarketTotalsV1 }
  | { ok: false; refusal: 'repay_inputs_invalid' | 'nothing_to_repay' | 'repay_maximum_exceeded' | 'repay_exceeds_debt' | 'repay_rounds_to_zero' };

const UINT128_MAX = (1n << 128n) - 1n;
const uint128 = (value: bigint): boolean => typeof value === 'bigint' && value >= 0n && value <= UINT128_MAX;

/** Morpho.sol::repay on ALREADY ACCRUED totals. The caller establishes the
 * accrual at a block (or in the evolving simulation), not this pure helper.
 *
 * Repayment does not depend on an oracle, liquidity, health or Still's limit
 * for new borrowing. It must remain possible to reduce an unhealthy debt.
 * Source: morpho-org/morpho-blue/src/Morpho.sol, checked 2026-10-28.
 */
export function morphoRepayProjectionV1(input: {
  totals: MorphoMarketTotalsV1;
  position: MorphoPositionV1;
  amount: MorphoRepayAmountV1;
  maximumAssets: bigint;
}): MorphoRepayProjectionV1 {
  const { totals, position, amount, maximumAssets } = input;
  const fail = (refusal: Extract<MorphoRepayProjectionV1, { ok: false }>['refusal']): MorphoRepayProjectionV1 => ({ ok: false, refusal });
  if (![totals.totalSupplyAssets, totals.totalSupplyShares, totals.totalBorrowAssets, totals.totalBorrowShares,
    totals.lastUpdate, totals.fee, position.collateral, position.borrowShares, maximumAssets].every(uint128) ||
      totals.fee > 10n ** 18n || maximumAssets === 0n || position.borrowShares > totals.totalBorrowShares ||
      (amount.mode !== 'assets' && amount.mode !== 'all') ||
      (amount.mode === 'assets' && (!uint128(amount.assets) || amount.assets === 0n))) return fail('repay_inputs_invalid');
  if (position.borrowShares === 0n) return fail('nothing_to_repay');

  const repaidShares = amount.mode === 'all' ? position.borrowShares
    : toSharesDownV1(amount.assets, totals.totalBorrowAssets, totals.totalBorrowShares);
  const repaidAssets = amount.mode === 'assets' ? amount.assets
    : toAssetsUpV1(repaidShares, totals.totalBorrowAssets, totals.totalBorrowShares);
  if (repaidAssets > maximumAssets) return fail('repay_maximum_exceeded');
  if (repaidShares === 0n) return fail('repay_rounds_to_zero');
  if (repaidShares > position.borrowShares || repaidAssets > totals.totalBorrowAssets + 1n) return fail('repay_exceeds_debt');
  return {
    ok: true, repaidAssets, repaidShares,
    position: { ...position, borrowShares: position.borrowShares - repaidShares },
    totals: {
      ...totals,
      totalBorrowAssets: repaidAssets >= totals.totalBorrowAssets ? 0n : totals.totalBorrowAssets - repaidAssets,
      totalBorrowShares: totals.totalBorrowShares - repaidShares,
    },
  };
}
