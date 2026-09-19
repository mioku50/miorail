// ---------------------------------------------------------------------------
// Morpho Blue's own arithmetic, mirrored exactly — including where it rounds.
//
// This module answers the third claim. "A market exists", "there is money in
// it" and "YOU could borrow" are different questions
// ([[defi-listing-vs-permissionless-market]]), and the screen has been
// refusing the third by name because nothing here read a position. This is the
// arithmetic that answers it once a position HAS been read, and it refuses in
// exactly the same way whenever an input is missing.
//
// WHY MIRROR RATHER THAN APPROXIMATE
//
// The contract decides. A borrow either passes `_isHealthy` at execution or
// reverts, and a number we print that is one wei on the wrong side of that
// check is a number that sends a user into a failed transaction. So every
// operation here is the Solidity operation, on BigInt, with the same rounding
// direction — never a float, never a convenience `Math.floor`.
//
// From `Morpho.sol::_isHealthy`, verbatim:
//
//   uint256 borrowed = position.borrowShares
//       .toAssetsUp(totalBorrowAssets, totalBorrowShares);
//   uint256 maxBorrow = position.collateral
//       .mulDivDown(collateralPrice, ORACLE_PRICE_SCALE)
//       .wMulDown(marketParams.lltv);
//   return maxBorrow >= borrowed;
//
// and its own comment above it, which is the single most important sentence
// for anyone printing a "maximum":
//
//   "Rounds in favor of the protocol, so one might not be able to borrow
//    exactly `maxBorrow` but one unit less."
//
// TWO CONSTRAINTS, AND THEY ARE NOT THE SAME REFUSAL
//
// `borrow()` requires BOTH `_isHealthy` AND
// `totalBorrowAssets <= totalSupplyAssets`. "Your collateral does not support
// this" and "the market does not have it" are different facts about different
// parties, and collapsing them into one number tells a user to add collateral
// when the market is simply empty. Every capacity answer here says which bound
// it hit.
//
// EVERYTHING IS AS OF A BLOCK
//
// `totalBorrowAssets` grows with accrued interest and the oracle moves, so a
// reading is a measurement at a block and not a promise about the next one.
// This module carries no clock; callers pass the block they read at and are
// expected to print it. Base's own borrowing guide says the same thing in one
// line: "Re-fetch and display health immediately before signing."
// ---------------------------------------------------------------------------

/** Morpho's oracle scale: `price()` is quoted at 1e36. */
export const MORPHO_ORACLE_PRICE_SCALE_V1 = 10n ** 36n;
/** Morpho's fixed-point unit, and the scale `lltv` is expressed in. */
export const MORPHO_WAD_V1 = 10n ** 18n;
/** `SharesMathLib.VIRTUAL_SHARES` — the anti-inflation offset on every share conversion. */
export const MORPHO_VIRTUAL_SHARES_V1 = 10n ** 6n;
/** `SharesMathLib.VIRTUAL_ASSETS`. */
export const MORPHO_VIRTUAL_ASSETS_V1 = 1n;
/** `ConstantsLib.LIQUIDATION_CURSOR`. */
export const MORPHO_LIQUIDATION_CURSOR_V1 = 3n * 10n ** 17n;
/** `ConstantsLib.MAX_LIQUIDATION_INCENTIVE_FACTOR`. */
export const MORPHO_MAX_LIQUIDATION_INCENTIVE_V1 = 115n * 10n ** 16n;

/* -------------------------------------------------------------------------
 * MathLib / SharesMathLib, operation for operation.
 * ---------------------------------------------------------------------- */

export function mulDivDownV1(x: bigint, y: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('morpho math: division by zero');
  return (x * y) / d;
}

export function mulDivUpV1(x: bigint, y: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('morpho math: division by zero');
  return (x * y + (d - 1n)) / d;
}

export function wMulDownV1(x: bigint, y: bigint): bigint {
  return mulDivDownV1(x, y, MORPHO_WAD_V1);
}

export function wDivDownV1(x: bigint, y: bigint): bigint {
  return mulDivDownV1(x, MORPHO_WAD_V1, y);
}

export function wDivUpV1(x: bigint, y: bigint): bigint {
  return mulDivUpV1(x, MORPHO_WAD_V1, y);
}

/** `SharesMathLib.toAssetsUp` — what the borrower OWES, rounded against them. */
export function toAssetsUpV1(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUpV1(
    shares,
    totalAssets + MORPHO_VIRTUAL_ASSETS_V1,
    totalShares + MORPHO_VIRTUAL_SHARES_V1,
  );
}

/** `SharesMathLib.toAssetsDown`. */
export function toAssetsDownV1(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDownV1(
    shares,
    totalAssets + MORPHO_VIRTUAL_ASSETS_V1,
    totalShares + MORPHO_VIRTUAL_SHARES_V1,
  );
}

/* -------------------------------------------------------------------------
 * The market and the position, as measured.
 * ---------------------------------------------------------------------- */

/** One market, in the units the contract itself holds. */
export interface MorphoMarketStateV1 {
  /** `IOracle.price()`, scaled by 1e36. The number the contract will read. */
  collateralPrice: bigint;
  /** `marketParams.lltv`, WAD-scaled. 62.5% is 625000000000000000n. */
  lltvWad: bigint;
  totalSupplyAssets: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  /** The block this was read at. Carried so a caller can print it, never used in the arithmetic. */
  blockNumber: number | null;
}

/** One borrower in one market. */
export interface MorphoPositionV1 {
  /** Collateral supplied, in collateral-token atomic units. */
  collateral: bigint;
  /** Debt, in SHARES. Assets are derived; the shares are what is stored. */
  borrowShares: bigint;
}

/* -------------------------------------------------------------------------
 * The answers.
 * ---------------------------------------------------------------------- */

export interface MorphoHealthV1 {
  /** What `_isHealthy` compares, in loan-asset atomic units. */
  maxBorrowAssets: bigint;
  /** What is owed right now, rounded UP exactly as the contract rounds it. */
  borrowedAssets: bigint;
  /** `maxBorrow >= borrowed` — the contract's own test, not an approximation of it. */
  healthy: boolean;
  /**
   * `maxBorrow - borrowed`, floored at zero.
   *
   * A CEILING, not an amount to borrow: the protocol rounds in its own favour,
   * so the last unit of this may be refused. `morphoBorrowCapacityV1` is what a
   * caller should offer a user.
   */
  headroomAssets: bigint;
  /**
   * `maxBorrow / borrowed`, WAD-scaled, or null when nothing is owed.
   *
   * Null is not infinity and not "safe": it means the ratio has no value
   * because its denominator is zero, and a caller must say "no debt" rather
   * than print a number.
   */
  healthFactorWad: bigint | null;
}

export function morphoHealthV1(input: {
  market: MorphoMarketStateV1;
  position: MorphoPositionV1;
}): MorphoHealthV1 {
  const { market, position } = input;
  const borrowedAssets =
    position.borrowShares === 0n
      ? 0n
      : toAssetsUpV1(position.borrowShares, market.totalBorrowAssets, market.totalBorrowShares);
  const maxBorrowAssets = wMulDownV1(
    mulDivDownV1(position.collateral, market.collateralPrice, MORPHO_ORACLE_PRICE_SCALE_V1),
    market.lltvWad,
  );
  return {
    maxBorrowAssets,
    borrowedAssets,
    healthy: maxBorrowAssets >= borrowedAssets,
    headroomAssets: maxBorrowAssets > borrowedAssets ? maxBorrowAssets - borrowedAssets : 0n,
    healthFactorWad: borrowedAssets === 0n ? null : wDivDownV1(maxBorrowAssets, borrowedAssets),
  };
}

/** Which fact stopped the number from being larger. Never merged into one. */
export type MorphoCapacityBoundV1 =
  /** The borrower's collateral is the limit. */
  | 'collateral'
  /** The market's own liquidity is the limit — a fact about the market, not the borrower. */
  | 'market_liquidity'
  /** Both, at the same figure. */
  | 'collateral_and_market_liquidity'
  /** Nothing can be borrowed at all, and `reason` says which side is at zero. */
  | 'nothing_available';

export interface MorphoBorrowCapacityV1 {
  /** What could actually be borrowed now, in loan-asset atomic units. */
  assets: bigint;
  bound: MorphoCapacityBoundV1;
  /** The health headroom alone, before the market's liquidity is considered. */
  collateralHeadroomAssets: bigint;
  /** What the market itself has to lend: `totalSupplyAssets - totalBorrowAssets`. */
  marketLiquidityAssets: bigint;
  /**
   * How much was subtracted for the protocol's own rounding.
   *
   * `_isHealthy` rounds `maxBorrow` DOWN and the debt UP, so borrowing the
   * headroom exactly can revert by one unit. Stepping back is the difference
   * between an offer that executes and one that teaches a user our numbers
   * cannot be trusted.
   */
  roundingMarginAssets: bigint;
}

/**
 * What this borrower could borrow right now, and which fact set the figure.
 *
 * `safetyMarginWad` is an optional haircut a caller may apply on top — a UI
 * that offers 100% of capacity offers a position one block from liquidation.
 * It defaults to none, because a default haircut would be this module quietly
 * inventing a risk policy.
 */
export function morphoBorrowCapacityV1(input: {
  market: MorphoMarketStateV1;
  position: MorphoPositionV1;
  /** WAD-scaled fraction of the headroom to offer, e.g. 8e17 for 80%. */
  safetyMarginWad?: bigint;
}): MorphoBorrowCapacityV1 {
  const { market, position } = input;
  const health = morphoHealthV1({ market, position });

  const marketLiquidityAssets =
    market.totalSupplyAssets > market.totalBorrowAssets
      ? market.totalSupplyAssets - market.totalBorrowAssets
      : 0n;

  let collateralHeadroomAssets = health.headroomAssets;
  if (input.safetyMarginWad !== undefined) {
    collateralHeadroomAssets = wMulDownV1(collateralHeadroomAssets, input.safetyMarginWad);
  }
  // One unit back from the ceiling, by the contract's own admission. Only ever
  // subtracted from a non-zero figure: there is no "minus one" below nothing.
  const roundingMarginAssets = collateralHeadroomAssets > 0n ? 1n : 0n;
  collateralHeadroomAssets -= roundingMarginAssets;

  const assets =
    collateralHeadroomAssets < marketLiquidityAssets ? collateralHeadroomAssets : marketLiquidityAssets;

  let bound: MorphoCapacityBoundV1;
  if (assets === 0n) bound = 'nothing_available';
  else if (collateralHeadroomAssets === marketLiquidityAssets) bound = 'collateral_and_market_liquidity';
  else if (collateralHeadroomAssets < marketLiquidityAssets) bound = 'collateral';
  else bound = 'market_liquidity';

  return {
    assets,
    bound,
    collateralHeadroomAssets,
    marketLiquidityAssets,
    roundingMarginAssets,
  };
}

/**
 * The collateral price at which this position stops being healthy.
 *
 * Derived from the same equation, solved for price:
 *
 *   borrowed = collateral * price / 1e36 * lltv / 1e18
 *   price    = borrowed * 1e36 * 1e18 / (collateral * lltv)
 *
 * Rounded UP, because the boundary is `maxBorrow >= borrowed`: the first price
 * that FAILS is the first one strictly below this, so this figure is the last
 * price that still passes. Null when there is no debt or no collateral —
 * "there is no such price" is an answer, and zero would be a dangerous one.
 */
export function morphoLiquidationPriceV1(input: {
  market: Pick<MorphoMarketStateV1, 'lltvWad' | 'totalBorrowAssets' | 'totalBorrowShares'>;
  position: MorphoPositionV1;
}): bigint | null {
  const { market, position } = input;
  if (position.borrowShares === 0n || position.collateral === 0n || market.lltvWad === 0n) return null;
  const borrowed = toAssetsUpV1(
    position.borrowShares,
    market.totalBorrowAssets,
    market.totalBorrowShares,
  );
  if (borrowed === 0n) return null;
  return mulDivUpV1(
    borrowed * MORPHO_ORACLE_PRICE_SCALE_V1,
    MORPHO_WAD_V1,
    position.collateral * market.lltvWad,
  );
}

/**
 * `min(MAX_LIQUIDATION_INCENTIVE_FACTOR, 1 / (1 - cursor * (1 - lltv)))`, WAD-scaled.
 *
 * What a liquidator takes on top of the debt they repay — the actual cost of
 * crossing the line, which "health factor 1.0" does not convey on its own.
 */
export function morphoLiquidationIncentiveWadV1(lltvWad: bigint): bigint {
  if (lltvWad >= MORPHO_WAD_V1) return MORPHO_WAD_V1;
  const denominator =
    MORPHO_WAD_V1 - wMulDownV1(MORPHO_LIQUIDATION_CURSOR_V1, MORPHO_WAD_V1 - lltvWad);
  const factor = wDivDownV1(MORPHO_WAD_V1, denominator);
  return factor < MORPHO_MAX_LIQUIDATION_INCENTIVE_V1 ? factor : MORPHO_MAX_LIQUIDATION_INCENTIVE_V1;
}

/**
 * The position as it WOULD stand after borrowing `assets`, without borrowing.
 *
 * The review screen's whole job: show the reader the position they are about to
 * have, not the one they have. Shares are converted with `toSharesUp` so the
 * projected debt is the one the contract would record, and the projection is
 * refused outright when the borrow would not be healthy — a projected unhealthy
 * position is a transaction that reverts, and printing its numbers invites a
 * user to sign it.
 */
export function morphoAfterBorrowV1(input: {
  market: MorphoMarketStateV1;
  position: MorphoPositionV1;
  assets: bigint;
}): { position: MorphoPositionV1; health: MorphoHealthV1; liquidationPrice: bigint | null } | null {
  const { market, position, assets } = input;
  if (assets <= 0n) return null;
  if (assets > market.totalSupplyAssets - market.totalBorrowAssets) return null;

  const addedShares = mulDivUpV1(
    assets,
    market.totalBorrowShares + MORPHO_VIRTUAL_SHARES_V1,
    market.totalBorrowAssets + MORPHO_VIRTUAL_ASSETS_V1,
  );
  const after: MorphoPositionV1 = {
    collateral: position.collateral,
    borrowShares: position.borrowShares + addedShares,
  };
  const marketAfter: MorphoMarketStateV1 = {
    ...market,
    totalBorrowAssets: market.totalBorrowAssets + assets,
    totalBorrowShares: market.totalBorrowShares + addedShares,
  };
  const health = morphoHealthV1({ market: marketAfter, position: after });
  if (!health.healthy) return null;
  return {
    position: after,
    health,
    liquidationPrice: morphoLiquidationPriceV1({ market: marketAfter, position: after }),
  };
}
