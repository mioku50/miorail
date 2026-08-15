import type { B20OpportunityObservationV1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// What a stored observation says about getting OUT — and, just as loudly, at
// what size it says it.
//
// Every observation in this product is measured at ONE reference position.
// Nobody has ever measured the size a particular wallet is holding. So the
// only honest exit statement is bounded by that reference, and the moment a
// caller asks about a different size the answer is `requested_size_not_measured`
// rather than a number scaled from one that was measured.
//
// This was a private function inside the x402 seller. Stage 08 needs the same
// judgement for a holder's own positions, and a second copy of "can you get
// out" is the last place in this product that should have one: the paid
// surface and the portfolio would drift, and they would drift towards the
// permissive answer, because that is the one a portfolio screen wants.
// ---------------------------------------------------------------------------

/** Base USDC. The only asset a requested position may be quoted in. */
export const B20_REFERENCE_USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const BPS_V1 = 10_000n;

export function decimalToAtomicUsdcV1(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
}

export type B20ExitAssessmentStatusV1 =
  | 'not_measured'
  | 'no_supported_exit_route'
  | 'capacity_not_measured'
  | 'measured_reference_bound';

export type B20ExitRequestComparisonV1 =
  /** No size was asked about; the reference bound is the whole answer. */
  | 'reference_profile_only'
  /** The observation is quoted in something other than USDC, so a USDC size
   * cannot be compared to it at all. */
  | 'requested_usdc_not_comparable_to_reference_asset'
  /** A size was asked about and it is not the one that was measured. */
  | 'requested_size_not_measured'
  | 'covered_at_exact_reference_size'
  | 'not_fully_covered_at_exact_reference_size';

export interface B20ExitAssessmentV1 {
  status: B20ExitAssessmentStatusV1;
  requestComparison?: B20ExitRequestComparisonV1;
  requestedPositionUsdc?: string | null;
  referenceQuoteAsset?: string;
  referencePositionAtomic?: string;
  acquiredTokenAtomic?: string;
  largestPassingTokenAtomic?: string;
  firstFailingTokenAtomic?: string | null;
  /**
   * Measured exit capacity as a share of what the reference entry bought,
   * capped at 100%. Null when the entry output was zero — a share of nothing
   * is not a number, and zero here would read as "no capacity".
   */
  coverageBps?: number | null;
  capacityToleranceBps?: number;
  capacityProbeCount?: number;
  capacityStable?: boolean | null;
}

/**
 * The exit statement one stored observation supports.
 *
 * `requestedPositionUsdc` is what a caller asked about, in USDC. It never
 * changes the measurement — it only decides which of the comparisons above is
 * true of it.
 */
export function referenceExitAssessmentV1(
  stored: B20OpportunityObservationV1 | null,
  requestedPositionUsdc: string | null,
): B20ExitAssessmentV1 {
  if (!stored) return { status: 'not_measured' };
  if (!stored.exitRouteFound) return { status: 'no_supported_exit_route' };
  if (stored.entryOutputAtomic === null || stored.largestPassingSizeAtomic === null) {
    return { status: 'capacity_not_measured' };
  }
  const acquired = BigInt(stored.entryOutputAtomic);
  const capacity = BigInt(stored.largestPassingSizeAtomic);
  const coverageBps = acquired === 0n
    ? null
    : Number(((capacity * BPS_V1) / acquired) > BPS_V1 ? BPS_V1 : ((capacity * BPS_V1) / acquired));
  const requestedAtomic = requestedPositionUsdc ? decimalToAtomicUsdcV1(requestedPositionUsdc) : null;
  const requestComparison: B20ExitRequestComparisonV1 = requestedAtomic === null
    ? 'reference_profile_only'
    : stored.referenceQuoteAsset !== B20_REFERENCE_USDC_V1
      ? 'requested_usdc_not_comparable_to_reference_asset'
      : requestedAtomic !== stored.referencePositionAtomic
        ? 'requested_size_not_measured'
        : coverageBps !== null && coverageBps >= 10_000
          ? 'covered_at_exact_reference_size'
          : 'not_fully_covered_at_exact_reference_size';
  return {
    status: 'measured_reference_bound',
    requestComparison,
    requestedPositionUsdc,
    referenceQuoteAsset: stored.referenceQuoteAsset,
    referencePositionAtomic: stored.referencePositionAtomic,
    acquiredTokenAtomic: stored.entryOutputAtomic,
    largestPassingTokenAtomic: stored.largestPassingSizeAtomic,
    firstFailingTokenAtomic: stored.firstFailingSizeAtomic,
    coverageBps,
    capacityToleranceBps: stored.capacityToleranceBps,
    capacityProbeCount: stored.capacityProbeCount,
    capacityStable: stored.capacityStable,
  };
}
