import type { ReviewedIssuerIdV1 } from './issuers.js';

// ---------------------------------------------------------------------------
// Two ways out, and they are not comparable.
//
// Everything Miorail has measured about tokenized stocks so far is ONE of them:
// sell the token to whoever is on the other side of a pool, at the size asked
// for, and count the cash that comes back. That is a permissionless, measurable
// round trip, and it is what the cash-exit ladder does.
//
// The other one is redemption: hand the token back to the issuer and receive
// value through the issuer's own rails. Dinari's is the clear case — orders,
// accounts, KYC, USD+ — and it is not a route, has no venue, no slippage and
// no size ladder. It also has an eligibility test that has nothing to do with
// the chain: whether the holder has an account at all.
//
// The reason these are declared before either is implemented is that the two
// answer the same consumer question — "can I get out?" — with evidence that
// cannot be averaged, compared or ranked against each other. A surface that
// showed "best exit" across both would be comparing a measured basis-point
// cost with an eligibility the product cannot observe.
//
// Nothing here ranks anything. There is no score, no ordering and no "best".
// ---------------------------------------------------------------------------

export const EXIT_FAMILIES_V1 = ['secondary_market_cash', 'issuer_redemption'] as const;
export type ExitFamilyV1 = (typeof EXIT_FAMILIES_V1)[number];

/** How a holder becomes eligible, and who can tell. */
export const EXIT_ELIGIBILITY_V1 = [
  /** Anyone holding the token, subject only to on-chain transfer policy. */
  'permissionless',
  /** An off-chain relationship with the issuer. Miorail cannot observe it. */
  'issuer_account_required',
] as const;
export type ExitEligibilityV1 = (typeof EXIT_ELIGIBILITY_V1)[number];

/** What evidence a claim in this family can ever be made of. */
export const EXIT_EVIDENCE_V1 = [
  /** A quote and a round trip measured at an exact size, on a named venue. */
  'measured_round_trip',
  /** A statement in a reviewed document. Never a measurement. */
  'documented_process',
] as const;
export type ExitEvidenceV1 = (typeof EXIT_EVIDENCE_V1)[number];

export interface ExitFamilyModelV1 {
  family: ExitFamilyV1;
  eligibility: ExitEligibilityV1;
  evidence: ExitEvidenceV1;
  /** Whether a size ladder means anything in this family. */
  sizeDependent: boolean;
  /** Whether Miorail can observe the outcome itself. */
  observableByUs: boolean;
  note: string;
}

export const EXIT_FAMILY_MODELS_V1: Readonly<Record<ExitFamilyV1, ExitFamilyModelV1>> = {
  secondary_market_cash: {
    family: 'secondary_market_cash',
    eligibility: 'permissionless',
    evidence: 'measured_round_trip',
    sizeDependent: true,
    observableByUs: true,
    note: 'Sell into a venue at an exact size and count the cash back. Cost is a measured number and it moves with size.',
  },
  issuer_redemption: {
    family: 'issuer_redemption',
    eligibility: 'issuer_account_required',
    evidence: 'documented_process',
    sizeDependent: false,
    observableByUs: false,
    note: 'Return the token to the issuer through its own rails. Whether a given holder may do this is an off-chain fact Miorail cannot observe, so it is never a measured cost.',
  },
};

/** Which families an issuer has at all. Presence is not availability, and it is
 * certainly not eligibility for any particular holder. */
export const ISSUER_EXIT_FAMILIES_V1: Readonly<
  Record<ReviewedIssuerIdV1, readonly ExitFamilyV1[]>
> = {
  coinbase: ['secondary_market_cash'],
  dinari: ['secondary_market_cash', 'issuer_redemption'],
  backed: ['secondary_market_cash', 'issuer_redemption'],
};

export class ExitFamilyMismatchError extends Error {
  constructor(left: ExitFamilyV1, right: ExitFamilyV1) {
    super(
      `refusing to compare a ${left} exit with a ${right} exit: one is a measured cost at a size and the other is an eligibility we cannot observe`,
    );
    this.name = 'ExitFamilyMismatchError';
  }
}

/**
 * The guard that keeps the two from being collapsed by accident.
 *
 * Called before anything puts two exit observations on one axis. It throws
 * rather than returning false because a caller that silently skipped the check
 * is the failure being prevented — and because there is no correct fallback:
 * the answer is not "compare them anyway", it is "these do not belong on the
 * same axis".
 */
export function assertSameExitFamilyV1(left: ExitFamilyV1, right: ExitFamilyV1): void {
  if (left !== right) throw new ExitFamilyMismatchError(left, right);
}
