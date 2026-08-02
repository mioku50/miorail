import { z } from 'zod';

// ---------------------------------------------------------------------------
// T68D — what "this token can be entered" is allowed to mean.
//
// The gap this file closes: `opportunityVerdictV1` could return `qualifies`
// from a round trip whose exit was quoted against the pool BEFORE the entry
// moved it. The domain already called that measurement optimistic, and an
// optimistic measurement can soundly REJECT — if the flattering number fails,
// the real one fails by more — but it can never CERTIFY. Certifying from it
// would put the product's one affirmative claim on the one measurement that
// systematically overstates, worst on exactly the thin pools where a user
// would be hurt most.
//
// So viability has four states, not two, and the promotion rule is one-way:
// only a sequential simulation of both legs against one state can produce
// `qualified`.
// ---------------------------------------------------------------------------

/** Base mainnet USDC. The only quote asset a round trip may start and end in. */
export const OPPORTUNITY_QUOTE_ASSET_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

/**
 * The profile a user actually chose.
 *
 * V2 exists because V1's numbers were a server constant with a UI label. The
 * profile is now the identity of an evaluation: a result for 100 USDC says
 * nothing about 500, and a cache that answered one with the other would be
 * answering a question nobody asked.
 *
 * Amounts are atomic integer strings throughout. USDC has six decimals and a
 * float cannot hold a cent reliably at that scale.
 */
export const OpportunityProfileV2Schema = z
  .object({
    quoteAsset: z.literal(OPPORTUNITY_QUOTE_ASSET_V1),
    positionAtomic: z.string().regex(/^[1-9][0-9]{0,17}$/, 'Expected a positive atomic amount'),
    maxRoundTripBps: z.number().int().min(1).max(10_000),
    maxExitSlippageBps: z.number().int().min(1).max(10_000),
  })
  .strict();
export type OpportunityProfileV2 = z.infer<typeof OpportunityProfileV2Schema>;

/** Server bounds, so a profile cannot ask for a probe nobody intended to fund
 * or a tolerance that makes the check meaningless. */
export interface OpportunityProfileBoundsV1 {
  minPositionAtomic: bigint;
  maxPositionAtomic: bigint;
  maxRoundTripBps: number;
  maxExitSlippageBps: number;
}

export const OPPORTUNITY_PROFILE_BOUNDS_V1: OpportunityProfileBoundsV1 = {
  /** 1 USDC. Below this the probe ladder degenerates and price impact is noise. */
  minPositionAtomic: 1_000_000n,
  /** 10,000 USDC. A simulation spends the wallet's real balance, so the ceiling
   * is about what an operator is willing to have probed, not about the pool. */
  maxPositionAtomic: 10_000_000_000n,
  /** 50%. A round trip costing more than half the position is not a tolerance,
   * it is a way to make anything pass. */
  maxRoundTripBps: 5_000,
  maxExitSlippageBps: 5_000,
};

export type ProfileRefusalV1 =
  | 'position_below_minimum'
  | 'position_above_maximum'
  | 'round_trip_tolerance_too_wide'
  | 'slippage_tolerance_too_wide';

/** Bounds checked on integers. Every comparison here is BigInt or an integer
 * basis-point count; nothing is parsed through a float. */
export function profileRefusalV1(
  profile: OpportunityProfileV2,
  bounds: OpportunityProfileBoundsV1 = OPPORTUNITY_PROFILE_BOUNDS_V1,
): ProfileRefusalV1 | null {
  const position = BigInt(profile.positionAtomic);
  if (position < bounds.minPositionAtomic) return 'position_below_minimum';
  if (position > bounds.maxPositionAtomic) return 'position_above_maximum';
  if (profile.maxRoundTripBps > bounds.maxRoundTripBps) return 'round_trip_tolerance_too_wide';
  if (profile.maxExitSlippageBps > bounds.maxExitSlippageBps) return 'slippage_tolerance_too_wide';
  return null;
}

/**
 * The evaluation identity of a profile.
 *
 * Changing ANY field changes it. This is what stops a cached result for one
 * profile being served for another — the cache key is the identity, so the two
 * cannot collide rather than merely being unlikely to.
 */
export function profileIdentityV1(profile: OpportunityProfileV2): string {
  return [
    profile.quoteAsset.toLowerCase(),
    profile.positionAtomic,
    String(profile.maxRoundTripBps),
    String(profile.maxExitSlippageBps),
  ].join(':');
}

// --- Viability ---------------------------------------------------------------

/**
 * The four states a user can be shown.
 *
 * `provisional` is the one this task exists to add. It is not a hedge and not a
 * weak pass: it says the numbers came from quotes taken before the entry moved
 * the pool, and that no sequential execution has been observed. The product
 * treats it as "not yet" — there is no entry plan behind it.
 */
export type OpportunityViabilityV1 = 'rejected' | 'provisional' | 'qualified' | 'unmeasured';

/** How complete the route search was. Separate from viability because a route
 * that was PROVEN to work is a different fact from a route search that saw
 * every candidate. */
export type RouteCoverageV1 = 'complete' | 'partial';

export interface OpportunityCoverageV1 {
  coverage: RouteCoverageV1;
  /** One route was proven to work end to end. */
  viableRouteConfirmed: boolean;
  /** Every candidate answered, so the chosen route is provably the best of
   * them. False does NOT mean a worse route was chosen — it means Miorail
   * cannot prove it did not. */
  bestRouteConfirmed: boolean;
}

/**
 * Coverage, from what the route search actually saw.
 *
 * The AERO incident is the reason this is separate from viability: a throttled
 * search that found nothing was reported as "no route out of this token
 * exists". Coverage says what was seen; viability says what was concluded; and
 * a degraded search may still confirm a route it DID prove, while never
 * claiming that route is the best one.
 */
export function coverageV1(input: {
  candidatesTotal: number;
  candidatesAnswered: number;
  simulationProvedRoute: boolean;
}): OpportunityCoverageV1 {
  const complete = input.candidatesAnswered >= input.candidatesTotal && input.candidatesTotal > 0;
  return {
    coverage: complete ? 'complete' : 'partial',
    viableRouteConfirmed: input.simulationProvedRoute,
    // A best-route claim needs every candidate to have answered. One silent
    // candidate is enough to make it unprovable.
    bestRouteConfirmed: complete && input.simulationProvedRoute,
  };
}

export type OpportunityUnmeasuredReasonV1 =
  | 'endpoint_degraded'
  | 'simulation_unavailable'
  | 'insufficient_probe_balance'
  | 'simulation_undecodable'
  | 'controls_unread';

export type OpportunityRejectionReasonV1 =
  | 'not_b20'
  | 'controls_unreadable'
  | 'transfers_paused'
  | 'transfer_policy_may_block'
  | 'no_entry_route'
  | 'no_exit_route'
  | 'round_trip_above_tolerance'
  | 'exit_capacity_below_position'
  | 'simulation_reverted'
  | 'simulated_round_trip_above_tolerance';

export type OpportunityOutcomeV2 =
  | { viability: 'rejected'; reason: OpportunityRejectionReasonV1 }
  | { viability: 'provisional'; reason: 'quoted_pre_entry' }
  | { viability: 'qualified' }
  | { viability: 'unmeasured'; reason: OpportunityUnmeasuredReasonV1 };

/**
 * The promotion rule, in one place.
 *
 * `quoted_pre_entry` can reject and can be provisional. It can NEVER qualify.
 * That is the whole point of the type: the only path to `qualified` runs
 * through `certifiedOutcomeV1`, which requires an observed sequential
 * execution.
 */
export function provisionalOutcomeV1(input: {
  measurement: 'quoted_pre_entry' | 'simulated' | null;
  quotedVerdict: { status: 'qualifies' } | { status: 'rejected'; reason: OpportunityRejectionReasonV1 } | { status: 'unmeasured'; reason: OpportunityUnmeasuredReasonV1 };
}): OpportunityOutcomeV2 {
  if (input.quotedVerdict.status === 'rejected') {
    // Sound on an optimistic measurement: if the flattering number already
    // fails, the real one fails by more.
    return { viability: 'rejected', reason: input.quotedVerdict.reason };
  }
  if (input.quotedVerdict.status === 'unmeasured') {
    return { viability: 'unmeasured', reason: input.quotedVerdict.reason };
  }
  // A pass. Which measurement produced it decides what the pass is worth.
  if (input.measurement === 'simulated') return { viability: 'qualified' };
  return { viability: 'provisional', reason: 'quoted_pre_entry' };
}

/** Sentences. Every one names what was measured; none says what the token will
 * do next, because nothing here measured that. */
export const OPPORTUNITY_VIABILITY_COPY_V1: Record<OpportunityViabilityV1, string> = {
  rejected: 'Rejected for this profile.',
  provisional:
    'Provisional exit — the exit was quoted before the entry moved the pool, so the round trip is a bound, not a result. Nothing has been simulated yet.',
  qualified: 'Exit confirmed for your profile.',
  unmeasured:
    'Not measured — a check this needs did not answer. Nothing here is a statement about the token.',
};

export const OPPORTUNITY_UNMEASURED_COPY_V1: Record<OpportunityUnmeasuredReasonV1, string> = {
  endpoint_degraded:
    'Too many router quotes went unanswered to conclude anything. Try again in a moment.',
  simulation_unavailable: 'The simulation provider did not answer, so nothing could be certified.',
  insufficient_probe_balance:
    'This wallet does not hold enough USDC to simulate the position you asked about. That is about the wallet, not the token.',
  simulation_undecodable:
    'The simulation ran but its asset movements could not be decoded, so the round trip could not be proven.',
  controls_unread: 'This token’s controls have not been read yet, and nothing clears without them.',
};

export const OPPORTUNITY_REJECTION_COPY_V2: Record<OpportunityRejectionReasonV1, string> = {
  not_b20: 'The B20 factory does not recognise this address, so none of the control checks apply to it.',
  controls_unreadable:
    'This token’s controls could not be fully read, so nothing here clears it. A partial read is not a pass.',
  transfers_paused: 'Transfers of this token are paused right now. A position could be bought and not sold.',
  transfer_policy_may_block:
    'A transfer policy is active on this token, so it can refuse specific addresses. B20 offers no way to list who is on it, so an exit cannot be confirmed.',
  no_entry_route: 'No route into this token exists at this size.',
  no_exit_route: 'No route out of this token exists. A position could be bought and not sold.',
  round_trip_above_tolerance:
    'Even quoted before the entry moves the pool — the flattering direction — the round trip costs more than your limit allows.',
  exit_capacity_below_position:
    'The position you asked for is larger than what can be exited within your slippage tolerance.',
  simulation_reverted:
    'One of the four steps reverted when simulated against the live chain. The round trip does not execute as quoted.',
  simulated_round_trip_above_tolerance:
    'Simulated end to end, the round trip costs more than your limit allows.',
};

/** The one line a surface shows. Both consoles call this, so neither can
 * invent its own vocabulary for a state. */
export function opportunityHeadlineV2(
  outcome: OpportunityOutcomeV2,
  coverage: OpportunityCoverageV1 | null,
): string {
  if (outcome.viability === 'rejected') return OPPORTUNITY_REJECTION_COPY_V2[outcome.reason];
  if (outcome.viability === 'unmeasured') return OPPORTUNITY_UNMEASURED_COPY_V1[outcome.reason];
  if (outcome.viability === 'provisional') return OPPORTUNITY_VIABILITY_COPY_V1.provisional;
  const base = OPPORTUNITY_VIABILITY_COPY_V1.qualified;
  if (coverage && coverage.viableRouteConfirmed && !coverage.bestRouteConfirmed) {
    // Never collapsed into "no exit exists" or into "best route". Both would be
    // claims nothing measured.
    return `${base} Viable route confirmed · best route not confirmed — some route candidates did not answer.`;
  }
  return base;
}
