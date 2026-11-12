// ---------------------------------------------------------------------------
// What a new loan would face if prices fell at once, and if its collateral's
// transfers were paused (operator, 2026-11-13: «да сделать пункты 1 и 3, а
// пункт 2 после проверки на контракте»).
//
// Base's Stocks Maxxing brief (2026-11-12) asks a stock-backed loan to "model
// overnight price gaps and paused collateral transfers" and to show "a stress
// scenario and the exact market used". Both are read here from the simulated
// position a review already proves, at its own block. Nothing is estimated.
//
// A fall at once. Aave V4 and Morpho both weigh collateral at its oracle price
// times a fixed factor against a debt that does not move with that price, so
// the health ratio is proportional to the collateral's price: if all of it is
// worth 20% less, the ratio is 20% lower. A price that jumps (after a weekend, a
// holiday, a night) leaves no moment between to repay; the rows say where each
// fall leaves the loan. Liquidation can start below 1.00 on both venues: Aave V4
// requires `healthFactor < HEALTH_FACTOR_LIQUIDATION_THRESHOLD` (1e18), and
// Morpho Blue liquidates a position that is not `_isHealthy`.
//
// A pause, read from the contracts (2026-11-13):
// - A B20 stock can pause TRANSFER, and then `transfer` and `transferFrom`
//   revert `ContractPaused(0)` (Base's B20 spec, Roles and Pause §3). On the Aave
//   V4 Spoke (implementation 0x81a7…3b19, Sourcify match) `repay` moves only the
//   debt asset, `withdraw` has the Hub transfer the stock to the wallet, and
//   `liquidationCall(…, receiveShares)` lets a liquidator take the supplied
//   shares inside the Spoke with no transfer at all, when the collateral reserve
//   has `receiveSharesEnabled` and is not frozen. All eight stock reserves had it
//   at block 56,655,653. So during a pause repaying works, taking the stock back
//   waits, and a liquidation does not.
// - cbBTC (FiatTokenV2_1, Sourcify exact match) and PAXG can pause, and then a
//   transfer out of Morpho Blue reverts (measured with a state override at block
//   56,656,573: "Pausable: paused" for cbBTC; PAXG's source is not published, so
//   its pause was measured the same way). Morpho Blue's `liquidate` and
//   `withdrawCollateral` hand the collateral over with `safeTransfer`, and `repay`
//   moves only USDC. So during a pause repaying works, and both taking the
//   collateral back and a liquidation wait until transfers resume.
// - WETH has no pause.
// ---------------------------------------------------------------------------

const WAD = 10n ** 18n;
const BPS = 10_000n;
const ORACLE_PRICE_SCALE = 10n ** 36n;

/** The falls a review shows, each at once: a bad day, a gap like the largest a big company has had, and one past it. */
export const LENDING_STRESS_FALLS_BPS_V1 = [1_000, 2_000, 3_000] as const;

export interface LendingStressTransfersV1 {
  /** Whether the collateral's own contract can pause its transfers: a B20 stock, cbBTC and PAXG can; WETH cannot. */
  pausable: boolean;
  /** Read at the review's block. Null when it could not be read; false when the token cannot pause. */
  paused: boolean | null;
  /** Whether a liquidation has to move the collateral token, and so waits while transfers are paused. */
  liquidationMovesToken: boolean;
}

export interface LendingStressV1 {
  /** What falls in each row: this collateral, the account's only one, or all the collateral the account counts. */
  scope: 'collateral' | 'all_collateral';
  scenarios: { fallBps: number; healthWad: string; liquidatable: boolean }[];
  /** How far the collateral can fall at once before liquidation can start, in tenths of a percent; rounded down. */
  marginTenths: number;
  /** One collateral: its price per whole token as the venue reads it, in cents; rounded down. */
  priceCents: string | null;
  /** One collateral: the price per whole token below which liquidation can start, in cents; rounded up. */
  liquidationPriceCents: string | null;
  transfers: LendingStressTransfersV1;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const NO_DEBT_HEALTH_SENTINEL = 1n << 128n;

function scenariosV1(healthWad: bigint): LendingStressV1['scenarios'] {
  return LENDING_STRESS_FALLS_BPS_V1.map((fallBps) => {
    const after = (healthWad * (BPS - BigInt(fallBps))) / BPS;
    return { fallBps, healthWad: after.toString(), liquidatable: after < WAD };
  });
}

/** A health ratio a stress can be read from: a loan with debt, measured. */
function usableHealthV1(healthWad: bigint | null | undefined): healthWad is bigint {
  return typeof healthWad === 'bigint' && healthWad > 0n && healthWad < NO_DEBT_HEALTH_SENTINEL;
}

/**
 * An Aave V4 loan. With one collateral the price that starts a liquidation is the price at which the
 * ratio reaches 1.00, `price / health`; with several, only how far all of them can fall together is said.
 */
export function aaveLendingStressV1(input: {
  healthAfterWad: bigint | null;
  /** The account's collateral count after this loan, as the Spoke counts it (`getUserAccountData`). */
  activeCollateralCount: bigint | null;
  /** Whether the selected stock is that collateral after this loan. */
  selectedIsCollateral: boolean;
  /** The selected stock's oracle price after this loan, in oracle units. */
  price: bigint | null;
  oracleDecimals: number;
  /** The selected stock's reserve flags after this loan. */
  receiveSharesEnabled: boolean | null;
  frozen: boolean | null;
  /** B20 `isPaused(TRANSFER)` for the selected stock, read at the review's block. */
  transfersPaused: boolean | null;
}): LendingStressV1 | null {
  const health = input.healthAfterWad;
  if (!usableHealthV1(health) || !Number.isInteger(input.oracleDecimals) || input.oracleDecimals < 2 || input.oracleDecimals > 36) return null;
  const single = input.activeCollateralCount === 1n && input.selectedIsCollateral;
  const unit = 10n ** BigInt(input.oracleDecimals - 2);
  const price = single && input.price !== null && input.price > 0n ? input.price : null;
  return {
    scope: single ? 'collateral' : 'all_collateral',
    scenarios: scenariosV1(health),
    marginTenths: health <= WAD ? 0 : Number(((health - WAD) * 1000n) / health),
    priceCents: price === null ? null : (price / unit).toString(),
    liquidationPriceCents: price === null ? null : ceilDiv(price * WAD, health * unit).toString(),
    transfers: {
      pausable: true,
      paused: input.transfersPaused,
      // A liquidator may take the deposit inside the Spoke only where the reserve allows it.
      liquidationMovesToken: !(input.receiveSharesEnabled === true && input.frozen === false),
    },
  };
}

/**
 * A Morpho loan: always one collateral. The margin is read exactly as the review's own risk note reads it,
 * from the oracle price and Morpho's liquidation price, so the two sentences cannot disagree.
 */
export function morphoLendingStressV1(input: {
  healthAfterWad: bigint | null;
  /** Morpho oracle prices, 1e36-scaled loan units per collateral unit. */
  collateralPrice: bigint | null;
  liquidationPrice: bigint | null;
  collateralDecimals: number;
  loanDecimals: number;
  /** False for WETH, which cannot pause. */
  pausable: boolean;
  /** `paused()` on the collateral token, read at the review's block. */
  transfersPaused: boolean | null;
}): LendingStressV1 | null {
  const health = input.healthAfterWad;
  if (!usableHealthV1(health) || input.collateralPrice === null || input.collateralPrice <= 0n || input.liquidationPrice === null || input.liquidationPrice <= 0n) return null;
  if (!Number.isInteger(input.collateralDecimals) || !Number.isInteger(input.loanDecimals) || input.loanDecimals < 2) return null;
  const whole = 10n ** BigInt(input.collateralDecimals), cent = 10n ** BigInt(input.loanDecimals - 2);
  const margin = input.collateralPrice > input.liquidationPrice
    ? ((input.collateralPrice - input.liquidationPrice) * WAD) / input.collateralPrice : 0n;
  return {
    scope: 'collateral',
    scenarios: scenariosV1(health),
    marginTenths: Number((margin * 1000n) / WAD),
    priceCents: ((input.collateralPrice * whole) / (ORACLE_PRICE_SCALE * cent)).toString(),
    liquidationPriceCents: ceilDiv(input.liquidationPrice * whole, ORACLE_PRICE_SCALE * cent).toString(),
    transfers: { pausable: input.pausable, paused: input.pausable ? input.transfersPaused : false, liquidationMovesToken: true },
  };
}

/** Said when a new loan is refused because its collateral cannot move. */
export function collateralTransfersPausedWordsV1(input: { symbol: string; venue: 'aave-v4' | 'morpho'; blockNumber: number }): string {
  return `${input.symbol} transfers are paused onchain (Base block ${input.blockNumber.toLocaleString('en-US')}). Still opens no new loan against it while they are: ` +
    `${input.symbol} could not be taken back${input.venue === 'aave-v4' ? ', and Aave could still liquidate the loan' : ''}. Repaying works.`;
}
