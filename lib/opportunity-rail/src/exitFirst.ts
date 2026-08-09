// ---------------------------------------------------------------------------
// T68 Stage 1 — Exit-First analysis.
//
// The question this module answers is not "is this token promising". It is:
//
//   If I put $100 in right now, can I get out, and what does getting straight
//   back out cost me?
//
// That is answerable from the chain, unlike anything about a new token's
// future. It is also where the money actually goes: on a token hours old, the
// dominant loss is not picking wrong, it is discovering after the fact that
// there was no exit — transfers pausable, a receiver policy that refuses the
// router, or a pool too thin to sell back into.
//
// THREE PROPERTIES THIS MODULE ENFORCES
//
//   1. Control refusals outrank economics. If transfers are paused there is no
//      point reporting a round-trip cost: the position cannot be sold at any
//      price. A card that leads with "6.30%" under a paused token is worse than
//      no card.
//
//   2. An optimistic measurement may REJECT but may not CERTIFY. Quoting the
//      exit leg against the pool as it stands — before the entry moves it —
//      understates the round trip, always in the flattering direction and most
//      on thin pools. If even that number fails the tolerance, the real one
//      fails worse, so a rejection is sound. A pass is not: it is carried as
//      `optimistic` and the surface has to say so.
//
//   3. Exit capacity is the largest MEASURED size that qualified, never an
//      interpolation between two probes. "You can exit $1,840" invented from
//      a curve fit between a $1,000 probe and a $2,500 probe is a number
//      nobody measured, presented in the units of someone's savings.
// ---------------------------------------------------------------------------

const BPS_DENOMINATOR = 10_000n;

/** One leg of a trade as a provider actually quoted it. */
export interface QuoteLegV1 {
  provider: string;
  inputAtomic: string;
  outputAtomic: string;
}

export type RoundTripMeasurementV1 =
  /** Both legs executed in one simulated block, so the exit saw the pool the
   * entry left behind. No modelling assumption at all. */
  | 'simulated'
  /** The exit was quoted against the pool BEFORE the entry moved it. An
   * optimistic bound, never a result. */
  | 'quoted_pre_entry';

export interface RoundTripV1 {
  measurement: RoundTripMeasurementV1;
  entry: QuoteLegV1;
  exit: QuoteLegV1;
  /** Basis points of the original input that do not come back. */
  costBps: number;
  /** What comes back, in the input asset's atomic units. */
  returnedAtomic: string;
  /** True whenever the figure is a bound rather than a measurement. */
  optimistic: boolean;
}

/**
 * The cost of going in and straight back out.
 *
 * `entry.inputAtomic` and `exit.outputAtomic` are in the SAME asset — this is a
 * round trip, so it starts and ends in what the user spends. The intermediate
 * token amount is `entry.outputAtomic`, which must equal `exit.inputAtomic`:
 * selling a different quantity than the entry produced is not a round trip, and
 * is refused rather than silently rescaled.
 */
export function roundTripV1(input: {
  entry: QuoteLegV1;
  exit: QuoteLegV1;
  measurement: RoundTripMeasurementV1;
}): RoundTripV1 | null {
  const spent = BigInt(input.entry.inputAtomic);
  const acquired = BigInt(input.entry.outputAtomic);
  const sold = BigInt(input.exit.inputAtomic);
  const returned = BigInt(input.exit.outputAtomic);
  if (spent <= 0n || acquired <= 0n) return null;
  // The two legs must describe the same position.
  if (sold !== acquired) return null;

  // Integer basis points, rounded AWAY from the user: a round trip that costs
  // 6.301% is reported as 6.31%, never 6.30%. The rounding direction is the
  // only defensible one when the number is a cost.
  const lost = spent - returned;
  const costBps =
    lost <= 0n
      ? 0
      : Number((lost * BPS_DENOMINATOR + spent - 1n) / spent);

  return {
    measurement: input.measurement,
    entry: input.entry,
    exit: input.exit,
    costBps,
    returnedAtomic: returned.toString(),
    optimistic: input.measurement === 'quoted_pre_entry',
  };
}

// --- Exit capacity -----------------------------------------------------------

export interface ExitProbeV1 {
  /** The position size that was probed, in the token being sold. */
  sizeAtomic: string;
  /** Slippage the provider quoted at this size. Null means no route existed at
   * this size at all — which is a different answer from "very bad slippage". */
  slippageBps: number | null;
}

export interface ExitCapacityV1 {
  /** The largest PROBED size that came in under the tolerance. Null when none
   * did, including when the smallest probe already failed. */
  capacityAtomic: string | null;
  /** The smallest probed size that failed, so a reader can see how coarse the
   * answer is. Null when nothing failed. */
  firstFailingAtomic: string | null;
  toleranceBps: number;
  /** How many sizes were actually measured. A capacity from two probes is a
   * much weaker statement than one from eight, and the card says which. */
  probeCount: number;
}

/**
 * The largest position that can be exited within a slippage tolerance.
 *
 * Deliberately returns a MEASURED size. There is no interpolation between
 * probes and no curve fit: the honest answer to "can I get $1,840 out" is only
 * available if $1,840 was one of the sizes probed.
 */
export function exitCapacityV1(
  probes: readonly ExitProbeV1[],
  toleranceBps: number,
): ExitCapacityV1 {
  const sorted = [...probes].sort((left, right) =>
    BigInt(left.sizeAtomic) < BigInt(right.sizeAtomic) ? -1 : 1,
  );
  let capacity: string | null = null;
  let firstFailing: string | null = null;
  for (const probe of sorted) {
    const passes = probe.slippageBps !== null && probe.slippageBps <= toleranceBps;
    if (passes) {
      capacity = probe.sizeAtomic;
      continue;
    }
    // The first failure bounds the answer from above. Sizes beyond it are not
    // considered even if one of them happens to quote well: a pool that fails
    // at $1,000 and passes at $2,000 is reporting something unstable, and
    // taking the larger number would be taking the flattering one.
    if (firstFailing === null) firstFailing = probe.sizeAtomic;
    break;
  }
  return {
    capacityAtomic: capacity,
    firstFailingAtomic: firstFailing,
    toleranceBps,
    probeCount: sorted.length,
  };
}

// --- The verdict -------------------------------------------------------------

/** What the B20 control read says about being able to sell at all. Separate
 * from economics because it is prior to them. */
export interface ExitControlsV1 {
  /** The factory confirmed this address is a B20 token. */
  factoryConfirmed: boolean;
  /** Transfers are paused right now. Nothing can be sold. */
  transfersPaused: boolean;
  /** A transfer policy is active, so a specific address may be refused. Miorail
   * cannot enumerate who — only that the gate exists. */
  transferPolicyActive: boolean;
  /** Every control read succeeded. A partial read cannot clear a token. */
  controlsFullyRead: boolean;
}

export type OpportunityRejectionV1 =
  | 'not_b20'
  | 'controls_unreadable'
  | 'transfers_paused'
  | 'transfer_policy_may_block'
  | 'no_entry_route'
  | 'no_exit_route'
  | 'round_trip_above_tolerance'
  | 'exit_capacity_below_position';

export interface OpportunityProfileV1 {
  /** What the user said they would put in, atomic units of the spend asset. */
  positionAtomic: string;
  /** The round-trip cost they will accept, in basis points. */
  maxRoundTripBps: number;
  /** The slippage tolerance the exit capacity is measured against. */
  maxSlippageBps: number;
}

export type OpportunityVerdictV1 =
  | {
      status: 'qualifies';
      /** `simulated` certifies; `quoted_pre_entry` does not, and the surface
       * must say the pass rests on an optimistic exit quote. */
      measurement: RoundTripMeasurementV1;
      optimistic: boolean;
    }
  | { status: 'rejected'; reason: OpportunityRejectionV1; sound: true };

/** Human sentences. Each names what was measured and what it means for a
 * position — never what the token will do. */
export const OPPORTUNITY_REJECTION_COPY_V1: Record<OpportunityRejectionV1, string> = {
  not_b20: 'The B20 factory does not recognise this address, so none of the control checks apply to it.',
  controls_unreadable: 'This token’s controls could not be fully read, so nothing here clears it. A partial read is not a pass.',
  transfers_paused: 'Transfers of this token are paused right now. A position could be bought and not sold.',
  transfer_policy_may_block:
    'A transfer policy is active on this token, so it can refuse specific addresses. Miorail cannot see who is on it — B20 offers no way to enumerate a policy — so an exit cannot be confirmed.',
  no_entry_route: 'No route into this token exists at this size.',
  // Measured, 2026-08-09: the sale reverts with Uniswap v4 core's
  // `NotEnoughLiquidity(poolId)` — the pool prices a buy and has nothing to
  // sell into. That is a DEPTH condition at one size and one moment, not a
  // permission and not a permanent property, so the wording no longer claims
  // that no route exists anywhere or that the position can never be sold.
  no_exit_route:
    'Entry priced; no sale could be priced at the measured size. Measured at one size, at one moment — not proof that no route exists anywhere.',
  round_trip_above_tolerance: 'Going in and straight back out costs more than your tolerance allows.',
  exit_capacity_below_position: 'The position you asked for is larger than what can be exited within your slippage tolerance.',
};

export interface OpportunityInputV1 {
  profile: OpportunityProfileV1;
  controls: ExitControlsV1;
  /** Null when no route into the token was found at the profile's size. */
  roundTrip: RoundTripV1 | null;
  entryRouteFound: boolean;
  exitRouteFound: boolean;
  exitCapacity: ExitCapacityV1;
}

/**
 * The verdict, resolved in a fixed order.
 *
 * The order is the design. Controls come first because they are prior to
 * price: a paused token has no round-trip cost worth computing, and reporting
 * one would put a number where a refusal belongs. Routes come next, because a
 * cost needs two legs to exist. Only then does anything economic get evaluated.
 */
export function opportunityVerdictV1(input: OpportunityInputV1): OpportunityVerdictV1 {
  const reject = (reason: OpportunityRejectionV1): OpportunityVerdictV1 => ({
    status: 'rejected',
    reason,
    // Every rejection below is sound even on an optimistic measurement: if the
    // flattering number already fails, the real one fails by more.
    sound: true,
  });

  if (!input.controls.factoryConfirmed) return reject('not_b20');
  if (!input.controls.controlsFullyRead) return reject('controls_unreadable');
  if (input.controls.transfersPaused) return reject('transfers_paused');
  if (input.controls.transferPolicyActive) return reject('transfer_policy_may_block');

  if (!input.entryRouteFound) return reject('no_entry_route');
  if (!input.exitRouteFound) return reject('no_exit_route');
  if (!input.roundTrip) return reject('no_exit_route');

  if (input.roundTrip.costBps > input.profile.maxRoundTripBps) {
    return reject('round_trip_above_tolerance');
  }

  const capacity = input.exitCapacity.capacityAtomic;
  if (capacity === null || BigInt(capacity) < BigInt(input.profile.positionAtomic)) {
    return reject('exit_capacity_below_position');
  }

  return {
    status: 'qualifies',
    measurement: input.roundTrip.measurement,
    optimistic: input.roundTrip.optimistic,
  };
}

/**
 * The headline line.
 *
 * A capability statement, never a rating. "Qualifies for your 100 USDC / 3%
 * profile" is checkable against the numbers beside it; "87/100" is not
 * checkable against anything.
 */
export function opportunityHeadlineV1(
  verdict: OpportunityVerdictV1,
  profile: { positionLabel: string; slippagePercentLabel: string },
): string {
  if (verdict.status === 'rejected') {
    return `Rejected · ${OPPORTUNITY_REJECTION_COPY_V1[verdict.reason]}`;
  }
  const base = `Qualifies for your ${profile.positionLabel} / ${profile.slippagePercentLabel} profile`;
  return verdict.optimistic
    ? `${base} — on an exit quote taken before the entry moves the pool, so the real round trip is worse`
    : base;
}

/** Basis points as a percentage string, for display. Integer arithmetic: a
 * float here renders 6.3% as 6.299999999999999. */
export function bpsPercentLabelV1(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return `${whole}.${fraction.toString().padStart(2, '0')}%`;
}
