// ---------------------------------------------------------------------------
// How soon it is worth asking the same question again.
//
// The worker re-measured every launch every 20 minutes for 48 hours: 144
// measurements per token. Production on 2026-08-10 showed what that bought —
// 750 tokens, 72 observations each in 24 hours, `count(distinct state) = 1`.
// 36,453 of them re-confirmed `no_entry_route` on 541 tokens. Nine and a half
// million RPC compute units a day to re-learn nothing.
//
// The backoff is NOT a claim that a verdict is permanent. Nothing here is
// terminal, and the 48-hour launch window is what ends a token's measurement,
// not this. It is a claim about sampling: a token that has answered the same
// way N times running has shown that its answer is stable at this cadence, so
// the next look is worth more later than sooner. Every observation still
// carries its own `measured_at`, so a reading that has gone stale still says
// so — backing off changes how often we look, never what we claim to have
// seen.
//
// The corollary that decides the table below: the shorter intervals belong to
// the tokens the rail exists for. Watching 740 dead tokens every 20 minutes
// while a provisional one waits its turn is the burn AND the wrong priority.
// ---------------------------------------------------------------------------

export interface B20MeasurementBackoffV1 {
  /** Never measured, still measurable, or in a state worth watching closely. */
  baseMs: number;
  /** A rejection about price, depth or a control that can be lifted. */
  repriceableMs: number;
  /** A rejection about whether a route exists at all, the first few times. */
  settlingMs: number;
  /** The same route verdict, over and over. */
  settledMs: number;
  /** Identical verdicts before `settledMs` takes over. */
  settledAfterRepeats: number;
}

export const B20_MEASUREMENT_BACKOFF_V1: B20MeasurementBackoffV1 = {
  baseMs: 20 * 60_000,
  repriceableMs: 60 * 60_000,
  settlingMs: 6 * 3_600_000,
  settledMs: 24 * 3_600_000,
  settledAfterRepeats: 3,
};

/**
 * Rejections that describe a number or a switch, not a fact about the token.
 *
 * `round_trip_above_tolerance` and `exit_capacity_below_position` are both
 * measured against the profile's size at one moment; liquidity moves and so do
 * they. `transfers_paused` is a control an issuer can lift, and the moment it
 * lifts is the moment the token becomes interesting. None of these is settled
 * by repetition, so they get an hour and stay there however often they repeat.
 */
export const B20_REPRICEABLE_REJECTIONS_V1: readonly string[] = [
  'exit_capacity_below_position',
  'round_trip_above_tolerance',
  'transfers_paused',
];

/**
 * Rejections about whether a route exists at the measured size.
 *
 * `no_entry_route` means no pool was found to price a buy — the slowest thing
 * on this list to change, because it changes when somebody creates a pool.
 * `no_exit_route` is subtler and the copy says so: the pool priced a buy and
 * reverted the sale with `NotEnoughLiquidity`, which is a DEPTH condition at
 * one size, not a permission. It is here rather than above because depth on a
 * token nobody is trading does not move in twenty minutes either — but that is
 * why this class escalates to a day instead of stopping.
 *
 * `not_b20` is the one genuinely permanent member: the factory does not know
 * the address, and it never will.
 */
export const B20_ROUTE_EXISTENCE_REJECTIONS_V1: readonly string[] = [
  'no_entry_route',
  'no_exit_route',
  'not_b20',
];

// `uninitialized` is in NEITHER list, deliberately. A pool that has not been
// initialized yet is a token in the middle of being born, minutes from being
// worth another look — the one rejection where the short interval is right.
//
// Everything shaped like OUR failure — `route_search_degraded`,
// `quote_unavailable`, `controls_unread`, `controls_incomplete`,
// `capacity_unmeasured`, `anchor_unavailable` — carries the state `unmeasured`
// rather than `rejected`, so it never reaches these lists at all and keeps the
// base interval. That is the correct handling and not an accident: the answer
// to a read that did not complete is to read again soon, never to wait a day.
// `b20MeasurementBackoff.test.ts` pins both facts against the canonical enums.

export interface B20ReMeasureInputV1 {
  /** The most recent observation's state, or null when never measured. */
  state: string | null;
  /** The most recent observation's reason code, or null. */
  reasonCode: string | null;
  /** How many observations in a row carry that same state and reason. */
  repeats: number;
  backoff?: B20MeasurementBackoffV1;
}

/** The interval that must have passed before this launch is worth measuring. */
export function b20ReMeasureIntervalMsV1(input: B20ReMeasureInputV1): number {
  const backoff = input.backoff ?? B20_MEASUREMENT_BACKOFF_V1;
  if (input.state !== 'rejected') return backoff.baseMs;
  const reason = input.reasonCode ?? '';
  if (B20_REPRICEABLE_REJECTIONS_V1.includes(reason)) return backoff.repriceableMs;
  if (B20_ROUTE_EXISTENCE_REJECTIONS_V1.includes(reason)) {
    return input.repeats >= backoff.settledAfterRepeats ? backoff.settledMs : backoff.settlingMs;
  }
  return backoff.baseMs;
}
