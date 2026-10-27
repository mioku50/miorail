// Still's allowance, shared by the Mirror and a server-side borrowing review. This is a share of
// the TOTAL protocol debt limit, minus debt, never a haircut on the remaining protocol headroom.
// Inputs are already-read atomic units. Missing reads must be refused by the caller, not defaulted.

import {
  morphoAfterBorrowV1,
  morphoMaxBorrowAssetsV1,
  toAssetsUpV1,
  type MorphoMarketStateV1,
  type MorphoPositionV1,
} from '@mioagent/rwa-issuer/morphoBorrowMath';
import { BPS, max, min, mulDiv, usdcToCents } from './math.js';
import { TERMS } from './policy.js';

const USDC_UNITS_PER_CENT = 10_000n;
const UINT256_MAX = (1n << 256n) - 1n;

function unsigned(value: bigint, label: string): void {
  if (value < 0n || value > UINT256_MAX) throw new RangeError(`Still capacity: ${label} is outside uint256`);
}

export interface StillBorrowLimitV1 {
  protocolLimitAssets: bigint;
  shareBps: bigint;
  /** Ceiling for total debt, in USDC atomic units. */
  limitAssets: bigint;
  /** The same ceiling rounded down for the Mirror's displayed accounting. */
  limitCents: bigint;
}

export function stillBorrowLimitV1(input: {
  protocolLimitAssets: bigint;
  shareBps?: bigint;
}): StillBorrowLimitV1 {
  unsigned(input.protocolLimitAssets, 'protocol limit');
  const shareBps = input.shareBps ?? TERMS.shareOfProtocolBps;
  if (shareBps < 0n || shareBps > BPS) throw new RangeError('Still capacity: share is outside basis points');
  const limitAssets = mulDiv(input.protocolLimitAssets, shareBps, BPS, 'down');
  return { protocolLimitAssets: input.protocolLimitAssets, shareBps, limitAssets, limitCents: usdcToCents(limitAssets, 'down') };
}

export interface StillBorrowCapacityV1 extends StillBorrowLimitV1 {
  debtAssets: bigint;
  debtCents: bigint;
  liquidityAssets: bigint;
  liquidityCents: bigint;
  /** Exact atomic headroom, before the more conservative displayed-cent accounting. */
  headroomAssets: bigint;
  /** floor(limit / cent) − ceil(debt / cent), floored at zero. */
  headroomCents: bigint;
  availableCents: bigint;
  /** The offered whole-cent amount, not a rounded-up conversion of atomic headroom. */
  availableAssets: bigint;
}

export function stillBorrowCapacityV1(input: {
  protocolLimitAssets: bigint;
  debtAssets: bigint;
  liquidityAssets: bigint;
  shareBps?: bigint;
}): StillBorrowCapacityV1 {
  const limit = stillBorrowLimitV1(input);
  unsigned(input.debtAssets, 'debt');
  unsigned(input.liquidityAssets, 'liquidity');
  const debtCents = usdcToCents(input.debtAssets, 'up');
  const liquidityCents = usdcToCents(input.liquidityAssets, 'down');
  const headroomCents = max(0n, limit.limitCents - debtCents);
  const availableCents = min(headroomCents, liquidityCents);
  return {
    ...limit,
    debtAssets: input.debtAssets,
    debtCents,
    liquidityAssets: input.liquidityAssets,
    liquidityCents,
    headroomAssets: max(0n, limit.limitAssets - input.debtAssets),
    headroomCents,
    availableCents,
    availableAssets: availableCents * USDC_UNITS_PER_CENT,
  };
}

export interface MorphoStillCapacityInputV1 {
  /** Totals accrued to the block at which the position and price were read. */
  market: MorphoMarketStateV1;
  position: MorphoPositionV1;
  /** Only the collateral explicitly chosen for this calculation; execution must validate funding. */
  additionalCollateralAssets?: bigint;
  /** Code-owned product policy, never an untrusted client-selected risk parameter. */
  shareBps?: bigint;
}

export interface MorphoStillCapacityV1 extends StillBorrowCapacityV1 {
  collateralAfterAssets: bigint;
  /** Whole cents withheld because a share-rounded projected debt would exceed the Still ceiling. */
  roundingMarginCents: bigint;
}

type MorphoAfterBorrowV1 = NonNullable<ReturnType<typeof morphoAfterBorrowV1>>;

function morphoInputs(input: MorphoStillCapacityInputV1): { position: MorphoPositionV1; capacity: StillBorrowCapacityV1 } {
  const { market, position } = input;
  const extra = input.additionalCollateralAssets ?? 0n;
  for (const [label, value] of [
    ['collateral', position.collateral], ['additional collateral', extra], ['borrow shares', position.borrowShares],
    ['price', market.collateralPrice], ['LLTV', market.lltvWad], ['supply assets', market.totalSupplyAssets],
    ['borrow assets', market.totalBorrowAssets], ['total borrow shares', market.totalBorrowShares],
  ] as const) unsigned(value, label);
  if (market.lltvWad > 10n ** 18n) throw new RangeError('Still capacity: LLTV exceeds WAD');
  if (position.borrowShares > market.totalBorrowShares) throw new RangeError('Still capacity: position shares exceed market total');
  const collateralAfterAssets = position.collateral + extra;
  unsigned(collateralAfterAssets, 'total collateral');
  const debtAssets = position.borrowShares === 0n ? 0n : toAssetsUpV1(position.borrowShares, market.totalBorrowAssets, market.totalBorrowShares);
  return {
    position: { collateral: collateralAfterAssets, borrowShares: position.borrowShares },
    capacity: stillBorrowCapacityV1({
      protocolLimitAssets: morphoMaxBorrowAssetsV1(collateralAfterAssets, market.collateralPrice, market.lltvWad),
      debtAssets,
      liquidityAssets: max(0n, market.totalSupplyAssets - market.totalBorrowAssets),
      shareBps: input.shareBps,
    }),
  };
}

/** The offered maximum must pass the same share-rounded projection as the execution review. */
export function morphoStillCapacityV1(input: MorphoStillCapacityInputV1): MorphoStillCapacityV1 {
  const { position, capacity } = morphoInputs(input);
  const passes = (cents: bigint): boolean => {
    if (cents === 0n) return true; // no new draw, not a zero-amount transaction
    const after = morphoAfterBorrowV1({ market: input.market, position, assets: cents * USDC_UNITS_PER_CENT });
    return after !== null && after.health.borrowedAssets <= capacity.limitAssets;
  };
  let availableCents = capacity.availableCents;
  if (!passes(availableCents)) {
    // Usually one cent back is enough. The bounded search also covers a pathological share
    // exchange rate, where one rounded share can be worth more than one cent. The candidate is
    // uint256-sized, so this takes at most 256 pure arithmetic steps and performs no reads.
    let low = 0n;
    let high = availableCents;
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      if (passes(middle)) low = middle;
      else high = middle - 1n;
    }
    availableCents = low;
  }
  return {
    ...capacity,
    availableCents,
    availableAssets: availableCents * USDC_UNITS_PER_CENT,
    collateralAfterAssets: position.collateral,
    roundingMarginCents: capacity.availableCents - availableCents,
  };
}

export type MorphoStillDrawV1 =
  | { ok: true; capacity: MorphoStillCapacityV1; after: MorphoAfterBorrowV1 }
  | {
      ok: false;
      capacity: MorphoStillCapacityV1;
      refusal: 'nothing_asked_for' | 'over_market_liquidity' | 'over_still_limit' | 'would_not_be_healthy' | 'projected_debt_over_still_limit';
    };

/** Recheck the exact atomic draw, including the total resulting debt, on the measured standing. */
export function morphoStillDrawV1(input: MorphoStillCapacityInputV1 & { borrowAssets: bigint }): MorphoStillDrawV1 {
  const capacity = morphoStillCapacityV1(input);
  if (input.borrowAssets <= 0n) return { ok: false, capacity, refusal: 'nothing_asked_for' };
  unsigned(input.borrowAssets, 'draw');
  if (input.borrowAssets > capacity.liquidityCents * USDC_UNITS_PER_CENT) return { ok: false, capacity, refusal: 'over_market_liquidity' };
  if (input.borrowAssets > capacity.availableAssets) return { ok: false, capacity, refusal: 'over_still_limit' };
  const after = morphoAfterBorrowV1({
    market: input.market,
    position: { collateral: capacity.collateralAfterAssets, borrowShares: input.position.borrowShares },
    assets: input.borrowAssets,
  });
  if (after === null) return { ok: false, capacity, refusal: 'would_not_be_healthy' };
  if (after.health.borrowedAssets > capacity.limitAssets) return { ok: false, capacity, refusal: 'projected_debt_over_still_limit' };
  return { ok: true, capacity, after };
}
