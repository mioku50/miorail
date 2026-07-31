// ---------------------------------------------------------------------------
// T67C.1 — deterministic order statistics over integers.
//
// Every reliability number a route is ranked by comes through here, so "the
// same outcomes produce the same snapshot hash" is only true if these are
// exactly reproducible. Floating point is not: a p90 computed by interpolation
// depends on the order the additions happened in, and two servers that
// disagree about a snapshot hash disagree about whether a snapshot is authentic.
//
// So: nearest-rank on sorted integers. No interpolation, no division into
// fractional ranks, no Number arithmetic on values that came from the chain.
// ---------------------------------------------------------------------------

/** Sorts a copy ascending. BigInt comparison, never `.sort()`'s string order. */
export function sortedAscendingV1(values: readonly bigint[]): bigint[] {
  return [...values].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
}

/**
 * Nearest-rank quantile: `index = ceil(q × n) - 1` over the sorted values.
 *
 * `q` is given in basis points rather than as a fraction, so the ceiling is an
 * integer operation end to end — `Math.ceil(0.9 * n)` is a float multiply, and
 * for some n it lands on the wrong side of an integer boundary.
 *
 * Returns null for an empty input. A quantile of nothing is not zero, and
 * reporting zero adverse shortfall for a provider with no history would be the
 * most flattering possible lie.
 */
export function nearestRankQuantileV1(values: readonly bigint[], quantileBps: number): bigint | null {
  if (!Number.isInteger(quantileBps) || quantileBps <= 0 || quantileBps > 10_000) {
    throw new RangeError('quantileBps must be an integer in (0, 10000]');
  }
  const sorted = sortedAscendingV1(values);
  if (sorted.length === 0) return null;
  // ceil(q × n) with integers: (q × n + 9999) / 10000, floored.
  const rank = Math.floor((quantileBps * sorted.length + 9_999) / 10_000);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

export const MEDIAN_BPS_V1 = 5_000;
export const P90_BPS_V1 = 9_000;

export function medianV1(values: readonly bigint[]): bigint | null {
  // Deliberately the lower of the two middles on an even count, because that is
  // what nearest-rank gives. Averaging them would introduce a value that no
  // route ever actually produced.
  return nearestRankQuantileV1(values, MEDIAN_BPS_V1);
}

export function p90V1(values: readonly bigint[]): bigint | null {
  return nearestRankQuantileV1(values, P90_BPS_V1);
}

/**
 * `count × 10000 / total`, rounded half-up, as an integer.
 *
 * Rates are stored in basis points for the same reason quantiles are: a rate
 * held as a float is a rate two machines can disagree about.
 */
export function rateBpsV1(count: number, total: number): number {
  if (!Number.isInteger(count) || !Number.isInteger(total) || count < 0 || total < 0) {
    throw new RangeError('rateBpsV1 takes non-negative integers');
  }
  if (total === 0) return 0;
  if (count > total) throw new RangeError('rateBpsV1 count cannot exceed total');
  return Number((BigInt(count) * 10_000n * 2n + BigInt(total)) / (BigInt(total) * 2n));
}
