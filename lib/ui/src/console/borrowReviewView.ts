// ---------------------------------------------------------------------------
// The review a borrow has to pass through before anybody signs it.
//
// Base's own borrowing guide states the rule this module implements, in one
// line: "Re-fetch and display health immediately before signing, and warn
// clearly before a transaction creates unsafe debt." Everything here is that
// sentence, made mandatory and made deterministic.
//
// WHAT IS DIFFERENT ABOUT THIS SCREEN
//
// Every other lending surface in this product refuses the third claim by name
// — "whether YOU could borrow depends on what you already hold, and Miorail
// does not read your position" ([[defi-listing-vs-permissionless-market]]).
// This is the one place that DOES read it, so this is the one place allowed to
// answer it. The permission is exactly as wide as the reading: when the
// position was not read, this view refuses in the same words as the rest of
// the product, and when it was, it says which block it was read at.
//
// THE POSITION SHOWN IS THE ONE THE TRANSACTION WOULD CREATE
//
// A review that shows the position a reader HAS is a review of the wrong
// thing. Both are here, side by side, and the health that decides the warnings
// is the one AFTER.
//
// NOTHING HERE IS AN APPROVAL
//
// The verdict is `ready_for_your_approval`, never "safe" and never "approved".
// Miorail holds no key, signs nothing, and broadcasts nothing; the reader
// approves in their own wallet or does not. A screen that says "approved"
// about somebody else's money has told them a decision was already made.
// ---------------------------------------------------------------------------

export interface BorrowReviewMarketWireV1 {
  marketId: string;
  curated: boolean | null;
  lltvBps: number;
  collateralSymbol: string | null;
  loanSymbol: string | null;
  collateralDecimals: number | null;
  loanDecimals: number | null;
  /** WAD-scaled borrow rate, or null when the venue published none. */
  borrowApyWad: bigint | null;
  blockNumber: number | null;
}

export interface BorrowReviewPositionWireV1 {
  /** Collateral, in collateral-token atomic units. */
  collateral: bigint;
  /** Debt as the CONTRACT computes it, not as the venue publishes it. */
  borrowedAssets: bigint;
  /** WAD-scaled, or null when there is no debt — null is not infinity. */
  healthFactorWad: bigint | null;
  /** Oracle price at which the position stops being healthy, 1e36-scaled. */
  liquidationPrice: bigint | null;
}

export interface BorrowReviewLineV1 {
  collateral: string;
  debt: string;
  /** "1.25", or "no debt" — never a number standing in for the absence of one. */
  health: string;
  /** "$177.93", or "—" when there is no such price. */
  liquidationPrice: string;
}

export interface BorrowReviewV1 {
  title: string;
  market: {
    id: string;
    shortId: string;
    pair: string;
    /** What the venue's own list says about THIS market. */
    standing: string;
    lltv: string;
    /** "6.2% variable" — a cost, so rounded UP — or the honest absence of a rate. */
    rate: string;
  };
  /** What is being asked for, rendered. */
  ask: string;
  before: BorrowReviewLineV1;
  after: BorrowReviewLineV1 | null;
  /** Computed from the numbers, in the order a reader needs them. */
  warnings: readonly string[];
  /** What this review does not answer. Constant, and never trimmed. */
  notStated: readonly string[];
  /** The clock, said once and plainly. */
  measuredAt: string;
  verdict: 'ready_for_your_approval' | 'refused';
  /** Present exactly when the verdict is `refused`. */
  refusal: string | null;
}

/** Why a borrow cannot be put in front of a reader at all. */
export const BORROW_REVIEW_REFUSALS_V1 = {
  position_unread:
    'Miorail did not read this wallet’s position in this market, so it cannot say what this borrow would do to it. Nothing is being offered for approval.',
  would_not_be_healthy:
    'This amount would leave the position under the market’s liquidation threshold, so the transaction would revert. Nothing is being offered for approval.',
  over_market_liquidity:
    'The market does not hold this much to lend right now. This is a fact about the market, not about this wallet’s collateral.',
  nothing_to_borrow:
    'There is nothing to borrow here right now — either the collateral supports none or the market holds none. The rows above say which.',
  // The three the simulation produces. A review may not reach
  // `ready_for_your_approval` without a measured execution behind it.
  simulation_not_run:
    'No provider executed these calls, so nothing about them has been measured. That is a gap in Miorail’s reading rather than a finding about the transaction — and it is not a pass.',
  simulation_reverted:
    'These calls revert when executed against current state. Signing them would spend gas to achieve nothing.',
  simulation_delivered_something_else:
    'The calls execute, and what reaches this wallet is not what this review describes. Nothing is being offered for approval on that basis.',
} as const;
export type BorrowReviewRefusalV1 = keyof typeof BORROW_REVIEW_REFUSALS_V1;

const WAD_V1 = 10n ** 18n;
const ORACLE_SCALE_V1 = 10n ** 36n;

function amountV1(atomic: bigint | null, decimals: number | null, symbol: string | null): string {
  if (atomic === null || decimals === null) return '—';
  const unit = 10n ** BigInt(decimals);
  const whole = atomic / unit;
  const fraction = atomic % unit;
  // Two places is what a reader reads; the atomic figure travels elsewhere for
  // anyone who needs all of it.
  const cents = (fraction * 100n) / unit;
  const rendered = `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
  return symbol ? `${rendered} ${symbol}` : rendered;
}

/** A 1e36 oracle price, in whole loan-asset units per whole collateral token. */
function priceV1(
  price: bigint | null,
  collateralDecimals: number | null,
  loanDecimals: number | null,
): string {
  if (price === null || collateralDecimals === null || loanDecimals === null) return '—';
  const perWholeToken = (price * 10n ** BigInt(collateralDecimals)) / ORACLE_SCALE_V1;
  return `$${amountV1(perWholeToken, loanDecimals, null)}`;
}

function healthV1(wad: bigint | null): string {
  if (wad === null) return 'no debt';
  const whole = wad / WAD_V1;
  const hundredths = ((wad % WAD_V1) * 100n) / WAD_V1;
  return `${whole}.${hundredths.toString().padStart(2, '0')}`;
}

/**
 * A WAD fraction as a percentage to one decimal, rounded in a named direction.
 *
 * Which direction is not a detail. Every figure here is either a margin or a
 * cost, and the rounding has to go the way that does not flatter the position:
 * a margin is shown at its SMALLEST plausible value and a cost at its LARGEST.
 * 14.399% of margin printed as "14.4%" reads as more room than exists; a 6.12%
 * rate printed as "6.1%" reads as cheaper than it is. Both are a tenth of a
 * percent, and both lean the same wrong way — toward the transaction.
 */
function percentDownV1(wad: bigint | null): string | null {
  if (wad === null) return null;
  const tenths = (wad * 1000n) / WAD_V1;
  return `${Number(tenths) / 10}%`;
}

function percentUpV1(wad: bigint | null): string | null {
  if (wad === null) return null;
  const scaled = wad * 1000n;
  const tenths = scaled % WAD_V1 === 0n ? scaled / WAD_V1 : scaled / WAD_V1 + 1n;
  return `${Number(tenths) / 10}%`;
}

function shortIdV1(id: string): string {
  return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

/** What this review does not answer, whatever the numbers turn out to be. */
export const BORROW_REVIEW_NOT_STATED_V1: readonly string[] = [
  'The rate is variable. It is what the venue published at the block above, not what it will be while the debt is open.',
  'The collateral price moves, and a liquidation does not need your involvement or your attention.',
  'Miorail reads this one market. It does not know what else this wallet owes anywhere, and the figures here are not a view of total exposure.',
  'This is not advice about whether to borrow, and Miorail has no opinion on that.',
];

export function borrowReviewV1(input: {
  market: BorrowReviewMarketWireV1;
  /** Null means the position was NOT READ — never a wallet with nothing. */
  before: BorrowReviewPositionWireV1 | null;
  /** Null means the borrow was refused; `refusal` says why. */
  after: BorrowReviewPositionWireV1 | null;
  /** The amount asked for, in loan-asset atomic units. */
  askAssets: bigint;
  /** The oracle price behind these figures, 1e36-scaled. */
  collateralPrice: bigint | null;
  /** WAD-scaled, from `morphoLiquidationIncentiveWadV1`. */
  liquidationIncentiveWad: bigint | null;
  /** What the market itself has left to lend, in loan-asset atomic units. */
  marketLiquidityAssets: bigint | null;
  readAt: string;
  refusal?: BorrowReviewRefusalV1 | null;
}): BorrowReviewV1 {
  const { market } = input;
  const pair =
    market.collateralSymbol && market.loanSymbol
      ? `${market.collateralSymbol} / ${market.loanSymbol}`
      : shortIdV1(market.marketId);

  const line = (p: BorrowReviewPositionWireV1 | null): BorrowReviewLineV1 | null =>
    p === null
      ? null
      : {
          collateral: amountV1(p.collateral, market.collateralDecimals, market.collateralSymbol),
          debt: amountV1(p.borrowedAssets, market.loanDecimals, market.loanSymbol),
          health: healthV1(p.healthFactorWad),
          liquidationPrice: priceV1(p.liquidationPrice, market.collateralDecimals, market.loanDecimals),
        };

  const warnings: string[] = [];
  const after = line(input.after);

  // Ordered by what a reader needs first: how close this puts them to losing
  // the collateral, then what that would cost, then what set the size.
  if (input.after?.healthFactorWad !== undefined && input.after?.healthFactorWad !== null) {
    const hf = input.after.healthFactorWad;
    const dropToLiquidation =
      input.collateralPrice !== null && input.after.liquidationPrice !== null && input.collateralPrice > 0n
        ? ((input.collateralPrice - input.after.liquidationPrice) * WAD_V1) / input.collateralPrice
        : null;
    // A margin: shown at its smallest.
    const drop = percentDownV1(dropToLiquidation);
    if (drop !== null) {
      warnings.push(
        `A ${drop} fall in the ${market.collateralSymbol ?? 'collateral'} price liquidates this position. That is the whole margin, and nobody has to warn you first.`,
      );
    }
    if (hf < 12n * 10n ** 17n) {
      warnings.push(
        `This leaves a health factor of ${healthV1(hf)}. Below 1.00 the collateral can be sold to repay the debt, and small price moves get there.`,
      );
    }
  }

  if (input.liquidationIncentiveWad !== null && input.liquidationIncentiveWad > WAD_V1) {
    // A cost: shown at its largest.
    const extra = percentUpV1(input.liquidationIncentiveWad - WAD_V1);
    if (extra !== null) {
      warnings.push(
        `If it is liquidated, whoever does it takes ${extra} more collateral than the debt they repay. That is the cost of crossing the line, on top of losing the borrowed amount’s worth of collateral.`,
      );
    }
  }

  if (
    input.marketLiquidityAssets !== null &&
    input.askAssets > 0n &&
    input.askAssets * 10n >= input.marketLiquidityAssets * 9n
  ) {
    warnings.push(
      'This takes almost everything the market has left to lend. Repaying is always possible; borrowing more here may not be until somebody supplies.',
    );
  }

  const refusal = input.refusal ?? (input.before === null ? 'position_unread' : null);

  return {
    title: `Borrow ${amountV1(input.askAssets, market.loanDecimals, market.loanSymbol)}`,
    market: {
      id: market.marketId,
      shortId: shortIdV1(market.marketId),
      pair,
      standing:
        market.curated === true
          ? 'On the venue’s own list'
          : market.curated === false
            ? 'Deployed by anyone — not on the venue’s own list'
            : 'The venue did not say whether this market is on its list',
      lltv:
        Number.isInteger(market.lltvBps) && market.lltvBps > 0
          ? `${market.lltvBps % 100 === 0 ? market.lltvBps / 100 : (market.lltvBps / 100).toFixed(1)}%`
          : '—',
      rate:
        market.borrowApyWad === null
          ? 'The venue did not publish a rate'
          : `${percentUpV1(market.borrowApyWad)} variable`,
    },
    ask: amountV1(input.askAssets, market.loanDecimals, market.loanSymbol),
    before: line(input.before) ?? { collateral: '—', debt: '—', health: 'not read', liquidationPrice: '—' },
    after,
    warnings,
    notStated: BORROW_REVIEW_NOT_STATED_V1,
    measuredAt:
      market.blockNumber === null
        ? `Read at ${input.readAt}. The venue did not say which block.`
        : `Read at block ${market.blockNumber.toLocaleString('en-US')}, ${input.readAt}. Prices and the rate move; these are not the numbers at the moment you sign.`,
    verdict: refusal === null && after !== null ? 'ready_for_your_approval' : 'refused',
    refusal: refusal === null ? null : BORROW_REVIEW_REFUSALS_V1[refusal],
  };
}
