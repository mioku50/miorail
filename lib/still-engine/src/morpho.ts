// Morpho Blue arithmetic (SharesMathLib, MathLib, MorphoBalancesLib), so a debt read from shares
// matches the protocol to the unit, interest included up to the block that was read.

import { WAD, mulDiv } from './math.js';

export interface MarketState {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

// Virtual shares and assets protect the first depositor.
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

export function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDiv(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES, 'up');
}

export function toSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDiv(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS, 'down');
}

/** e^(rate·elapsed) − 1 by its third-order Taylor expansion, as Morpho Blue compounds. */
export function wTaylorCompounded(ratePerSecondWad: bigint, elapsedSeconds: bigint): bigint {
  const first = ratePerSecondWad * elapsedSeconds;
  const second = mulDiv(first, first, 2n * WAD, 'down');
  const third = mulDiv(second, first, 3n * WAD, 'down');
  return first + second + third;
}

/** Market totals with interest accrued from lastUpdate to `timestamp` (MorphoBalancesLib.expectedMarketBalances). */
export function accrueMarket(state: MarketState, borrowRatePerSecondWad: bigint, timestamp: bigint): MarketState {
  const elapsed = timestamp - state.lastUpdate;
  if (elapsed <= 0n || state.totalBorrowAssets === 0n || borrowRatePerSecondWad === 0n) return state;
  const interest = mulDiv(state.totalBorrowAssets, wTaylorCompounded(borrowRatePerSecondWad, elapsed), WAD, 'down');
  const totalBorrowAssets = state.totalBorrowAssets + interest;
  const totalSupplyAssets = state.totalSupplyAssets + interest;
  let totalSupplyShares = state.totalSupplyShares;
  if (state.fee !== 0n) {
    const feeAmount = mulDiv(interest, state.fee, WAD, 'down');
    totalSupplyShares += toSharesDown(feeAmount, totalSupplyAssets - feeAmount, totalSupplyShares);
  }
  return { ...state, totalBorrowAssets, totalSupplyAssets, totalSupplyShares, lastUpdate: timestamp };
}

/** What a borrower owes now, rounded up as Morpho rounds a debt. */
export function borrowAssets(borrowShares: bigint, accrued: MarketState): bigint {
  return borrowShares === 0n ? 0n : toAssetsUp(borrowShares, accrued.totalBorrowAssets, accrued.totalBorrowShares);
}
