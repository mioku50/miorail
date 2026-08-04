import {
  provisionalOutcomeV1,
  type OpportunityCoverageV1,
  type OpportunityProfileV2,
} from './clearance.js';
import type { ExitCapacityV1, RoundTripV1 } from './exitFirst.js';

// ---------------------------------------------------------------------------
// T69-B — what a PUBLIC, pre-entry, wallet-less measurement is allowed to say.
//
// This is deliberately a different function from `opportunityVerdictV1`, and
// the differences are the point:
//
//   * IT CANNOT PRODUCE `qualified`. Not by policy — by construction. The
//     promotion rule lives in `provisionalOutcomeV1`, which only returns
//     `qualified` for a `simulated` measurement, and a background worker has no
//     wallet to simulate with. The state union below has no `qualified` member
//     at all, so there is nowhere to put one.
//
//   * AN ACTIVE TRANSFER POLICY IS NOT A REJECTION HERE. The wallet-bound
//     verdict rejects on it, correctly: it is asked "can THIS address exit",
//     and a policy it cannot enumerate makes that unanswerable. This function
//     is asked "is there a market path at all", about no address in particular.
//     Rejecting every token with a policy would be converting non-enumerable
//     data into a wallet-specific conclusion about a wallet that does not
//     exist. The policy state is RECORDED and must be shown; it is not a gate.
//
//   * DEGRADED BEATS EVERYTHING ECONOMIC. Live Aerodrome, 2026-08-02: a
//     throttled route search for AERO — one of the deepest pools on Base —
//     came back empty and rendered as "no route out of this token exists". The
//     rejection was about the endpoint and wore the token's name. So once
//     coverage is partial, no economic conclusion is sound: not the
//     missing-route ones, and not a cost rejection either, because a candidate
//     that never answered might have beaten the one that did.
//
// Control rejections survive degradation, because they are decided before a
// single quote is spent and no amount of throttling can have caused them.
// ---------------------------------------------------------------------------

/**
 * The four states a background observation may hold.
 *
 * `candidate` means the cheap filter passed and the deep measurement has not
 * finished — a real, persistable state, not a placeholder.
 */
export const B20_OBSERVATION_STATES_V1 = ['candidate', 'provisional', 'rejected', 'unmeasured'] as const;
export type B20ObservationStateV1 = (typeof B20_OBSERVATION_STATES_V1)[number];

/** The outcome of the cheap pre-filter, before any deep control read. */
export const B20_CHEAP_FILTER_RESULTS_V1 = [
  /** The factory soundly returned false. */
  'not_b20',
  /** The factory confirmed B20, but initialisation is not complete. */
  'uninitialized',
  /** A COMPLETE search found no supported way in. */
  'no_entry_route',
  /** A COMPLETE search found no supported way out. */
  'no_exit_route',
  /** Required route candidates did not answer. Never a verdict about a token. */
  'route_search_degraded',
  /** A route exists but a mandatory quote could not be measured. */
  'quote_unavailable',
  /** Bidirectional supported paths exist. Proceed to deep measurement. */
  'candidate',
] as const;
export type B20CheapFilterResultV1 = (typeof B20_CHEAP_FILTER_RESULTS_V1)[number];

export const B20_OBSERVATION_REJECTION_REASONS_V1 = [
  'not_b20',
  'uninitialized',
  'transfers_paused',
  'no_entry_route',
  'no_exit_route',
  'round_trip_above_tolerance',
  'exit_capacity_below_position',
] as const;
export type B20ObservationRejectionV1 = (typeof B20_OBSERVATION_REJECTION_REASONS_V1)[number];

export const B20_OBSERVATION_UNMEASURED_REASONS_V1 = [
  'route_search_degraded',
  'quote_unavailable',
  'controls_incomplete',
  'controls_unread',
  'capacity_unmeasured',
  'anchor_unavailable',
] as const;
export type B20ObservationUnmeasuredV1 = (typeof B20_OBSERVATION_UNMEASURED_REASONS_V1)[number];

/**
 * What the transfer policy rows said.
 *
 * `restricted` is NOT a rejection and NOT a pass. B20 offers no way to list who
 * a policy admits, so the only honest public statement is that the gate exists.
 */
export const B20_TRANSFER_POLICY_STATES_V1 = [
  /** Every policy row is an open policy (ALWAYS_ALLOW). Not a gate. */
  'open',
  /** At least one policy is set to something other than open. */
  'restricted',
  /** A mandatory policy read failed. */
  'unavailable',
  /** This variant has no such method. Not a failed read. */
  'unsupported_by_variant',
] as const;
export type B20TransferPolicyStateV1 = (typeof B20_TRANSFER_POLICY_STATES_V1)[number];

export interface B20ObservationControlsV1 {
  /** `isB20` returned true at the observation block. */
  factoryConfirmed: boolean;
  /** `isB20Initialized` returned true. */
  initialized: boolean;
  /** A TRANSFER pause. A mint or burn pause is not this, and conflating them
   * would refuse tokens that can be exited perfectly well. */
  transfersPaused: boolean;
  transferPolicyState: B20TransferPolicyStateV1;
  /** Every MANDATORY control row answered. `unsupported_by_variant` and
   * `not_enumerable` are answers; only `unavailable` is a failure. */
  controlsComplete: boolean;
}

export interface B20ObservationInputV1 {
  profile: OpportunityProfileV2;
  /** Null before the cheap filter has run at all. */
  cheapFilter: B20CheapFilterResultV1 | null;
  /** Null until the deep control read has happened. */
  controls: B20ObservationControlsV1 | null;
  coverage: OpportunityCoverageV1;
  roundTrip: RoundTripV1 | null;
  /** Null when the capacity ladder could not be measured at all. */
  exitCapacity: ExitCapacityV1 | null;
  /** The token amount the reference position acquires — the units capacity is
   * measured in. Null when the entry could not be quoted. */
  acquiredAtomic: string | null;
}

export type B20ObservationOutcomeV1 =
  | { state: 'rejected'; reason: B20ObservationRejectionV1 }
  | { state: 'unmeasured'; reason: B20ObservationUnmeasuredV1 }
  | { state: 'candidate' }
  | { state: 'provisional'; reason: 'quoted_pre_entry' };

/**
 * The observation verdict, resolved in a fixed order.
 *
 * The order IS the design (§10):
 *
 *   1. provider completeness  — a degraded search makes economics meaningless
 *   2. factory status         — nothing else applies to a non-B20 address
 *   3. transfer controls      — prior to price: a paused token has no cost
 *                               worth computing
 *   4. route existence        — a cost needs two legs to exist
 *   5. optimistic round trip  — may reject, may never certify
 *   6. exit capacity          — measured boundaries only
 *
 * Anything that survives all six is `provisional`, never better.
 */
export function b20ObservationVerdictV1(input: B20ObservationInputV1): B20ObservationOutcomeV1 {
  const reject = (reason: B20ObservationRejectionV1): B20ObservationOutcomeV1 => ({
    state: 'rejected',
    reason,
  });
  const unmeasured = (reason: B20ObservationUnmeasuredV1): B20ObservationOutcomeV1 => ({
    state: 'unmeasured',
    reason,
  });

  // --- 2. Factory. Checked before completeness because a sound `false` from
  // the factory is a fact about the address that no endpoint trouble can
  // undo, and it costs nothing to state.
  if (input.cheapFilter === 'not_b20') return reject('not_b20');
  if (input.cheapFilter === 'uninitialized') return reject('uninitialized');

  // --- 1. Completeness. A search that did not see its candidates cannot
  // support ANY economic conclusion, including a negative one.
  if (input.cheapFilter === 'route_search_degraded') return unmeasured('route_search_degraded');
  if (input.cheapFilter === 'quote_unavailable') return unmeasured('quote_unavailable');

  // --- 3. Controls. Prior to price.
  if (input.controls) {
    if (!input.controls.factoryConfirmed) return reject('not_b20');
    if (!input.controls.initialized) return reject('uninitialized');
    // The one control state that soundly rejects: nothing can be sold at any
    // price while transfers are paused.
    if (input.controls.transfersPaused) return reject('transfers_paused');
    // A restricted transfer policy deliberately does NOT reject. See the file
    // header: there is no wallet here to be refused, and B20 cannot enumerate
    // who a policy admits.
    if (input.controls.transferPolicyState === 'unavailable') return unmeasured('controls_incomplete');
    if (!input.controls.controlsComplete) return unmeasured('controls_incomplete');
  }

  // --- 4. Routes. Only a COMPLETE search may conclude one does not exist.
  if (input.cheapFilter === 'no_entry_route') {
    return input.coverage.coverage === 'complete' ? reject('no_entry_route') : unmeasured('route_search_degraded');
  }
  if (input.cheapFilter === 'no_exit_route') {
    return input.coverage.coverage === 'complete' ? reject('no_exit_route') : unmeasured('route_search_degraded');
  }
  if (input.cheapFilter === null) return unmeasured('route_search_degraded');

  // The cheap filter passed but the deep read has not run yet. A real state.
  if (!input.controls) return { state: 'candidate' };

  // --- 5. The optimistic round trip.
  if (!input.roundTrip) return unmeasured('quote_unavailable');
  if (input.roundTrip.costBps > input.profile.maxRoundTripBps) {
    // Sound EVEN THOUGH the measurement is optimistic — if the flattering
    // number already fails, the real one fails by more. But only when the
    // search was complete: a candidate that never answered might have been
    // cheaper, and rejecting on a cost that another route could have beaten is
    // the AERO failure with different arithmetic.
    return input.coverage.coverage === 'complete'
      ? reject('round_trip_above_tolerance')
      : unmeasured('route_search_degraded');
  }

  // --- 6. Capacity. Measured boundaries only; never interpolated.
  if (!input.exitCapacity) return unmeasured('capacity_unmeasured');
  const capacity = input.exitCapacity.capacityAtomic;
  if (capacity === null) return unmeasured('capacity_unmeasured');
  if (input.acquiredAtomic === null) return unmeasured('quote_unavailable');
  if (BigInt(capacity) < BigInt(input.acquiredAtomic)) {
    return input.coverage.coverage === 'complete'
      ? reject('exit_capacity_below_position')
      : unmeasured('route_search_degraded');
  }

  // Everything passed. The promotion rule decides what a pass is WORTH, and it
  // is the same one the wallet-bound path uses — which is why this cannot
  // return `qualified`: the measurement is `quoted_pre_entry` by construction.
  const outcome = provisionalOutcomeV1({
    measurement: 'quoted_pre_entry',
    quotedVerdict: { status: 'qualifies' },
  });
  /* c8 ignore next */
  if (outcome.viability !== 'provisional') {
    // Unreachable: `quoted_pre_entry` cannot promote. Kept as a hard stop
    // rather than a comment, so a future change to the promotion rule breaks
    // here instead of quietly publishing a certified public feed.
    throw new Error('a pre-entry measurement may never certify');
  }
  return { state: 'provisional', reason: 'quoted_pre_entry' };
}

/**
 * Whether the ladder measured something monotonic.
 *
 * A pass at a size ABOVE a failure is not a deeper pool, it is an unstable
 * measurement — two probes taken moments apart against a pool somebody else is
 * also trading. `exitCapacityV1` already stops at the first failure, so it
 * never returns the later flattering value; this reports that it happened, so
 * a surface can say the depth reading is unreliable rather than presenting the
 * truncated answer as clean.
 */
export function exitLadderStableV1(
  probes: readonly { sizeAtomic: string; slippageBps: number | null }[],
  toleranceBps: number,
): boolean {
  const ascending = [...probes].sort((left, right) =>
    BigInt(left.sizeAtomic) < BigInt(right.sizeAtomic) ? -1 : 1,
  );
  let failed = false;
  for (const probe of ascending) {
    const passes = probe.slippageBps !== null && probe.slippageBps <= toleranceBps;
    if (!passes) {
      failed = true;
      continue;
    }
    // A pass after a failure. The ladder disagrees with itself.
    if (failed) return false;
  }
  return true;
}

/** The sentence a future card must show beside any pre-entry number. Kept here
 * so the API and both consoles cannot each invent their own wording. */
export const B20_PRE_ENTRY_NOTICE_V1 =
  'Pre-entry estimate. The entry has not yet moved the pool, so the real round-trip can be worse.';

/** Why a router quote is not anchored to the observation block. Aerodrome's
 * `getAmountsOut` takes no block tag, so quotes are read at `latest` while the
 * factory and control reads are pinned. Naming it is the requirement; hiding it
 * would present mixed-block data as one atomic snapshot. */
export const B20_QUOTE_ALIGNMENT_V1 = ['anchored', 'latest_not_anchored'] as const;
export type B20QuoteAlignmentV1 = (typeof B20_QUOTE_ALIGNMENT_V1)[number];

export const B20_OBSERVATION_STATE_COPY_V1: Record<B20ObservationStateV1, string> = {
  candidate:
    'A supported market path exists in both directions. The deeper measurement has not finished, so nothing here is a result yet.',
  provisional: `A supported round trip measured within the feed’s reference profile. ${B20_PRE_ENTRY_NOTICE_V1} Nothing has been simulated and no wallet has been checked.`,
  rejected: 'Ruled out by public evidence for the feed’s reference profile.',
  unmeasured:
    'Not measured — a check this needs did not answer. Nothing here is a statement about the token.',
};

export const B20_OBSERVATION_REJECTION_COPY_V1: Record<B20ObservationRejectionV1, string> = {
  not_b20: 'The B20 factory does not recognise this address, so none of the control checks apply to it.',
  uninitialized:
    'The factory confirmed this token but its initialisation is not complete, so its controls are not yet settled.',
  transfers_paused: 'Transfers of this token are paused right now. A position could be bought and not sold.',
  no_entry_route:
    'Miorail found no supported route into this token. That is a statement about the routes Miorail supports, not about every venue on Base.',
  no_exit_route:
    'Miorail found no supported route out of this token. That is a statement about the routes Miorail supports, not about every venue on Base.',
  round_trip_above_tolerance: `Going in and straight back out already costs more than the feed’s reference tolerance. ${B20_PRE_ENTRY_NOTICE_V1}`,
  exit_capacity_below_position:
    'The largest size measured within the slippage tolerance is smaller than the feed’s reference position.',
};

export const B20_OBSERVATION_UNMEASURED_COPY_V1: Record<B20ObservationUnmeasuredV1, string> = {
  route_search_degraded:
    'Too many route candidates went unanswered to conclude anything. That is about the endpoint, not the token.',
  quote_unavailable: 'A route exists but a quote it needs did not answer, so no cost could be measured.',
  controls_incomplete:
    'A mandatory control read did not answer. A partial read clears nothing.',
  controls_unread: 'This token’s controls have not been read yet, and nothing clears without them.',
  capacity_unmeasured: 'No exit size could be priced, so the depth of the exit is unknown.',
  anchor_unavailable: 'The block this observation would be anchored to could not be read.',
};

export const B20_TRANSFER_POLICY_COPY_V1: Record<B20TransferPolicyStateV1, string> = {
  open: 'Transfer policies are open — no address list gates a transfer.',
  restricted:
    'A transfer policy is active on this token, so it can refuse specific addresses. B20 offers no way to list who it admits, so this is stated rather than resolved.',
  unavailable: 'A transfer policy read did not answer.',
  unsupported_by_variant: 'This B20 variant has no transfer policy of this kind.',
};
