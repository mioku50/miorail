import type { HashV1 } from '@mioagent/route-domain';
import {
  CalibratedNetResultV1Schema,
  SWAP_CALIBRATION_VERSION_V1,
  type CalibratedNetResultV1,
  type ProviderReliabilityAssessmentV1,
  type ProviderReliabilitySnapshotV1,
} from './contracts.js';

// ---------------------------------------------------------------------------
// T67C.1 §6 — history-adjusted expectations.
//
// The quote is never touched. What changes is what Miorail EXPECTS the quote to
// deliver, based on what this provider has actually delivered before. Both
// numbers travel together to the UI, because a user comparing routes deserves
// to see the difference between what they were offered and what we think they
// will get, rather than one number that quietly means neither.
// ---------------------------------------------------------------------------

/**
 * `expected × (10000 − medianAdverseShortfallBps) / 10000`, floored.
 *
 * Floored, not rounded: the discount lands against the provider by at most one
 * atomic unit. That is the right direction for a number a user might act on.
 *
 * Only the MEDIAN is applied, never the p90. The p90 is shown, and it drives
 * risk ranking, but calibrating the headline estimate against a tail would
 * systematically understate every provider — the typical trade is the one this
 * estimate is about.
 */
export function calibratedExpectedOutputV1(expected: bigint, medianAdverseShortfallBps: number): bigint {
  if (expected < 0n) throw new RangeError('expected output must not be negative');
  const shortfall = BigInt(Math.max(0, Math.min(10_000, Math.trunc(medianAdverseShortfallBps))));
  return (expected * (10_000n - shortfall)) / 10_000n;
}

export interface CalibrateNetResultInputV1 {
  candidateHash: HashV1;
  rawExpectedOutputAtomic: string;
  /**
   * Gas plus paid-intelligence cost, already converted into output atomic units
   * by the existing net-result logic. Null when that conversion was not
   * possible — the candidate is then Not scored for net result exactly as in
   * v1, and calibration does not invent a way around it.
   */
  costOutputAtomic: string | null;
  assessment: ProviderReliabilityAssessmentV1;
}

export function calibrateNetResultV1(input: CalibrateNetResultInputV1): CalibratedNetResultV1 {
  const rawExpected = BigInt(input.rawExpectedOutputAtomic);
  const eligible = input.assessment.status === 'eligible' && input.assessment.snapshot !== null;
  const snapshot = eligible ? (input.assessment.snapshot as ProviderReliabilitySnapshotV1) : null;
  const appliedShortfallBps = snapshot?.medianAdverseShortfallBps ?? 0;
  const calibratedExpected = snapshot
    ? calibratedExpectedOutputV1(rawExpected, appliedShortfallBps)
    : rawExpected;

  const cost = input.costOutputAtomic === null ? null : BigInt(input.costOutputAtomic);
  // A net result that is zero or negative is not a result — the same rule v1
  // already applies. Reporting a negative "net output" would suggest the user
  // receives a negative amount of a token.
  const positiveOrNull = (value: bigint): string | null => (value > 0n ? value.toString() : null);

  return CalibratedNetResultV1Schema.parse({
    schemaVersion: 'calibrated-net-result/v1',
    candidateHash: input.candidateHash,
    calibrated: snapshot !== null,
    scope: snapshot?.scope ?? null,
    snapshotHash: snapshot?.snapshotHash ?? null,
    cutoffAt: snapshot?.cutoffAt ?? null,
    appliedShortfallBps,
    rawExpectedOutputAtomic: rawExpected.toString(),
    calibratedExpectedOutputAtomic: calibratedExpected.toString(),
    rawNetOutputAtomic: cost === null ? null : positiveOrNull(rawExpected - cost),
    calibratedNetOutputAtomic: cost === null ? null : positiveOrNull(calibratedExpected - cost),
    calibrationVersion: SWAP_CALIBRATION_VERSION_V1,
  });
}

/**
 * The value `best_net_result` ranks on: the history-adjusted net result when
 * one exists, the raw one otherwise.
 *
 * A candidate that falls back to raw is marked uncalibrated so the comparison
 * can say so. Mixing a calibrated figure against an uncalibrated one is not
 * ideal, but the alternative — refusing to rank a provider Miorail has no
 * history for — would freeze out every new provider permanently.
 */
export function rankingNetOutputV1(result: CalibratedNetResultV1): bigint | null {
  const chosen = result.calibrated ? result.calibratedNetOutputAtomic : result.rawNetOutputAtomic;
  return chosen === null ? null : BigInt(chosen);
}

export interface RiskRankingRowV1 {
  providerId: string;
  assessment: ProviderReliabilityAssessmentV1;
}

/**
 * `lowest_risk` ordering: strictly lexicographic, never a weighted blend.
 *
 * 1. higher success rate
 * 2. lower p90 adverse shortfall
 * 3. lower floor breach rate
 * 4. lower p90 confirmation time
 * 5. provider id, so the result is total and stable
 *
 * Lexicographic because the four measures have no common unit. Any weighting
 * would be a hidden editorial claim about how many basis points of shortfall
 * equal one percentage point of failure — a claim with no defensible answer,
 * and one the user could neither see nor argue with.
 *
 * A candidate with no eligible snapshot sorts last: it is not ranked as risky,
 * it is simply unranked, and putting it above a measured provider would treat
 * absence of evidence as evidence.
 */
export function compareRiskLexicographicV1(left: RiskRankingRowV1, right: RiskRankingRowV1): number {
  const leftSnapshot = left.assessment.status === 'eligible' ? left.assessment.snapshot : null;
  const rightSnapshot = right.assessment.status === 'eligible' ? right.assessment.snapshot : null;
  if (leftSnapshot === null || rightSnapshot === null) {
    if (leftSnapshot !== rightSnapshot) return leftSnapshot === null ? 1 : -1;
    return left.providerId.localeCompare(right.providerId);
  }
  if (leftSnapshot.successRateBps !== rightSnapshot.successRateBps) {
    return rightSnapshot.successRateBps - leftSnapshot.successRateBps;
  }
  if (leftSnapshot.p90AdverseShortfallBps !== rightSnapshot.p90AdverseShortfallBps) {
    return leftSnapshot.p90AdverseShortfallBps - rightSnapshot.p90AdverseShortfallBps;
  }
  if (leftSnapshot.floorBreachRateBps !== rightSnapshot.floorBreachRateBps) {
    return leftSnapshot.floorBreachRateBps - rightSnapshot.floorBreachRateBps;
  }
  const leftConfirmation = leftSnapshot.p90ConfirmationMs;
  const rightConfirmation = rightSnapshot.p90ConfirmationMs;
  if (leftConfirmation !== rightConfirmation) {
    // An unmeasured confirmation time does not win the tie it cannot answer.
    if (leftConfirmation === null) return 1;
    if (rightConfirmation === null) return -1;
    return leftConfirmation - rightConfirmation;
  }
  return left.providerId.localeCompare(right.providerId);
}
