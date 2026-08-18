import type { B20VerifyResultV1 } from './verify.js';

// ---------------------------------------------------------------------------
// Re-reading a claim that has gone un-current, and taking one back.
//
// The verified layer shipped with no expiry and no way out. `Product — Live`
// meant an endpoint answered a real request AT A MOMENT; nothing asked again,
// and nothing could ever move a claim out of `verified`. So the one statement
// in this product that can quietly become false was also the one nobody was
// re-reading. Production on 2026-08-18 was serving a product probe observed 36
// hours earlier with no sign of its age.
//
// The whole difficulty is in one distinction, and it is the same one that runs
// through the rest of this codebase:
//
//   the file is served and no longer names this token  → the claim is REFUTED
//   Miorail could not fetch the file                   → the claim is UNTOUCHED
//
// A timeout is our failure. Refuting a project because their host was slow
// would be the worst version of this feature — it would take a verified badge
// away on the strength of a network error, and the project would have no idea
// why.
// ---------------------------------------------------------------------------

/** What a re-verification pass decided to do with one claim. */
export const B20_REVERIFY_OUTCOMES_V1 = ['reverified', 'refuted', 'unreadable', 'failed'] as const;
export type B20ReverifyOutcomeV1 = (typeof B20_REVERIFY_OUTCOMES_V1)[number];

/**
 * Refusals that are statements about the CLAIM, not about the request.
 *
 * The file came back and said something other than "this token is ours" — it
 * was served and did not name the token, or it was served and was not a claim
 * file at all. Both are the project's own answer, and both end a claim.
 *
 * `unreachable` is deliberately NOT here. It is the network, and the network is
 * ours to fail at.
 */
export const B20_REVERIFY_REFUTING_REFUSALS_V1: readonly string[] = [
  'token_not_named',
  'not_json',
  'invalid_schema',
  'claim_refuted',
];

export interface B20ReverifyDecisionV1 {
  outcome: B20ReverifyOutcomeV1;
  /** The claim status to store, or null to leave the record exactly as it is. */
  status: 'verified' | 'unverified' | 'refuted' | null;
  /** True when the stored evidence should be replaced by what this pass read.
   * False leaves the old rows alone — a pass that read nothing must not erase
   * what an earlier one established. */
  writeEvidence: boolean;
  /** One line for the pass log. Never a URL, never a provider message. */
  reason: string;
}

/**
 * What to do with one re-read. Pure, so the rule is testable without a network.
 *
 * Note what it never returns: a decision to refute on `unreachable`, and a
 * decision to write empty evidence over a claim it could not re-read.
 */
export function b20ReverifyDecisionV1(result: {
  claim: B20VerifyResultV1['claim'];
  refusal: string | null;
}): B20ReverifyDecisionV1 {
  if (result.claim && result.claim.status === 'verified') {
    return {
      outcome: 'reverified',
      status: 'verified',
      writeEvidence: true,
      reason: 'the claim file still names this token',
    };
  }
  if (result.claim && result.claim.status === 'refuted') {
    return {
      outcome: 'refuted',
      status: 'refuted',
      // The evidence goes with it. Findings exist because a claim permitted
      // them, and a refuted claim permits none.
      writeEvidence: true,
      reason: 'a link the claim asserted was contradicted',
    };
  }
  if (result.refusal !== null && B20_REVERIFY_REFUTING_REFUSALS_V1.includes(result.refusal)) {
    return {
      outcome: 'refuted',
      status: 'unverified',
      writeEvidence: true,
      reason: `the claim file no longer establishes this token (${result.refusal})`,
    };
  }
  // `unreachable` is the network, and a pass that produced no refusal at all
  // read nothing either. Both leave the record exactly as it was. An
  // UNKNOWN refusal falls through to `failed` instead — also untouched, but
  // named separately, so a refusal kind this build does not understand shows
  // up in the log rather than hiding inside "could not read".
  if (result.refusal === 'unreachable' || result.refusal === null) {
    // Untouched. The stored claim keeps its status and its evidence, and the
    // card keeps saying how old that evidence is — which is the honest state:
    // Miorail could not look, so nothing changed.
    return {
      outcome: 'unreadable',
      status: null,
      writeEvidence: false,
      reason: 'the claim file could not be read, so nothing was changed',
    };
  }
  return {
    outcome: 'failed',
    status: null,
    writeEvidence: false,
    reason: 'the pass produced no claim and no known refusal',
  };
}
