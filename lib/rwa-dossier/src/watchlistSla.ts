// ---------------------------------------------------------------------------
// Phase 8 — the freshness promise, and the arithmetic that has to justify it.
//
// A watchlist is the one surface where Miorail says it will keep looking. That
// makes the interval a PROMISE, and a promise nobody checked against capacity
// is the failure this file exists to prevent: the product says "checked
// hourly", the list grows past what an hour buys, and every card quietly ages
// while still displaying the sentence.
//
// So the interval is not configured. It is DERIVED from three numbers — how
// many distinct addresses are watched, what one check costs, and what we are
// willing to spend per minute — and the advertised tier is never faster than
// the derived one. When the corpus outgrows the fastest tier the promise
// degrades in public rather than slipping in private.
//
// WHERE THE BUDGET NUMBERS COME FROM
//
// The RPC figure is measured: mainnet.base.org sustains about half an
// `eth_call` per second per IP, and Miorail shares that IP with the Discover
// and measurement workers. The router figure is NOT a discovered limit — the
// aggregator is a third party we do not pay, and it has never refused us. It
// is a courtesy rate we impose on ourselves, and calling it anything else
// would be inventing a fact about somebody else's service.
//
// THE RESERVE IS PART OF THE MODEL, NOT A SAFETY MARGIN AROUND IT
//
// Roadmap §13.3: do not operate at theoretical maximum. Investigate is a human
// waiting, and it outranks every scheduled read; a scheduler sized to consume
// the whole budget makes that impossible by construction. The reserve is
// subtracted BEFORE the interval is derived, so the advertised promise is one
// the product can keep on a busy afternoon rather than an idle night.
// ---------------------------------------------------------------------------

/** What one watched address costs to check, measured on the corpus worker. */
export interface WatchCheckCostV1 {
  /** `decimals()` at an anchored block. One call, one word. */
  rpcCalls: number;
  /** Four cash sizes against two destinations, buy leg and sell leg. */
  routerQuotes: number;
}

export const WATCH_CHECK_COST_V1: WatchCheckCostV1 = { rpcCalls: 1, routerQuotes: 8 };

export interface WatchBudgetV1 {
  /**
   * Measured: mainnet.base.org serves about 0.5 eth_call/s per IP, and this
   * process is not the only one on that IP. Deliberately below the observed
   * ceiling rather than at it.
   */
  rpcCallsPerMinute: number;
  /**
   * Self-imposed. The aggregator has never refused us; this is what we are
   * willing to ask of a service we do not pay for, and it is a policy rather
   * than a discovered limit. One per second, sustained — deliberate restraint
   * rather than a number we would have to defend as measured.
   */
  routerQuotesPerMinute: number;
  /**
   * Held back for the reads a human is waiting on. Subtracted before the
   * interval is derived — see the header.
   */
  reserveFraction: number;
}

export const WATCH_BUDGET_V1: WatchBudgetV1 = {
  rpcCallsPerMinute: 20,
  routerQuotesPerMinute: 60,
  reserveFraction: 0.4,
};

/**
 * The tiers a surface is allowed to say out loud.
 *
 * Round numbers on purpose. "Checked every 47 minutes" is arithmetic leaking
 * into a promise; a reader needs to know what to expect, and the model rounds
 * DOWN in frequency — never up — so the advertised tier is always slower than
 * or equal to what capacity supports.
 */
export const WATCH_INTERVAL_TIERS_SECONDS_V1 = [
  15 * 60,
  30 * 60,
  60 * 60,
  3 * 60 * 60,
  6 * 60 * 60,
  12 * 60 * 60,
  24 * 60 * 60,
] as const;

export type WatchLimitedByV1 = 'rpc' | 'router' | 'tier_floor' | 'nothing_watched';

export interface WatchCapacityV1 {
  /** Distinct addresses, not subscriptions. Two people watching one token is
   * one check — the whole point of the dedupe rule. */
  distinctAddresses: number;
  /** What the budget actually supports, to the second. Arithmetic, not a promise. */
  achievableIntervalSeconds: number;
  /** What a surface may say. Always >= achievable. */
  advertisedIntervalSeconds: number;
  /** Which input ran out first. `tier_floor` means capacity is comfortable and
   * the fastest tier we publish is the binding constraint. */
  limitedBy: WatchLimitedByV1;
  /**
   * How much of the spendable budget the advertised interval uses. Below 1 the
   * promise has room; at 1 it is exactly met and any growth breaks it.
   */
  utilisation: number;
  /** True when the corpus has outgrown the slowest tier we publish. The
   * promise is then not keepable and the surface must say so rather than
   * printing a number. */
  beyondSlowestTier: boolean;
}

/**
 * The interval the budget supports for one address, in seconds.
 *
 * Per-minute budget, spread across every watched address. With N addresses and
 * a spendable rate of R units per minute at C units per check, one address can
 * be checked every `N * C / R` minutes.
 */
function achievableFromV1(input: {
  distinctAddresses: number;
  costPerCheck: number;
  spendablePerMinute: number;
}): number {
  if (input.costPerCheck <= 0) return 0;
  if (input.spendablePerMinute <= 0) return Number.POSITIVE_INFINITY;
  return (input.distinctAddresses * input.costPerCheck * 60) / input.spendablePerMinute;
}

export function watchlistCapacityV1(input: {
  distinctAddresses: number;
  cost?: WatchCheckCostV1;
  budget?: WatchBudgetV1;
}): WatchCapacityV1 {
  const cost = input.cost ?? WATCH_CHECK_COST_V1;
  const budget = input.budget ?? WATCH_BUDGET_V1;
  const spendable = Math.max(0, 1 - budget.reserveFraction);
  const addresses = Math.max(0, Math.trunc(input.distinctAddresses));

  if (addresses === 0) {
    return {
      distinctAddresses: 0,
      achievableIntervalSeconds: 0,
      advertisedIntervalSeconds: WATCH_INTERVAL_TIERS_SECONDS_V1[0],
      limitedBy: 'nothing_watched',
      utilisation: 0,
      beyondSlowestTier: false,
    };
  }

  const byRpc = achievableFromV1({
    distinctAddresses: addresses,
    costPerCheck: cost.rpcCalls,
    spendablePerMinute: budget.rpcCallsPerMinute * spendable,
  });
  const byRouter = achievableFromV1({
    distinctAddresses: addresses,
    costPerCheck: cost.routerQuotes,
    spendablePerMinute: budget.routerQuotesPerMinute * spendable,
  });
  // The slower of the two. A budget with room in one dimension and none in the
  // other supports the pace of the dimension that ran out.
  const achievable = Math.max(byRpc, byRouter);

  const tiers = WATCH_INTERVAL_TIERS_SECONDS_V1;
  const advertised = tiers.find((tier) => tier >= achievable) ?? tiers[tiers.length - 1]!;
  const beyondSlowestTier = achievable > tiers[tiers.length - 1]!;

  return {
    distinctAddresses: addresses,
    achievableIntervalSeconds: Math.ceil(achievable),
    advertisedIntervalSeconds: advertised,
    // The tier floor first: below it the budget is not what decides the
    // promise, the fact that we refuse to publish a faster tier is. Saying
    // "limited by the router" there would send an operator to widen a budget
    // that has room.
    limitedBy:
      achievable <= tiers[0]! ? 'tier_floor' : byRouter > byRpc ? 'router' : 'rpc',
    // Against the tier we advertise, which is the promise being kept — not
    // against the raw arithmetic, which nobody sees.
    utilisation: advertised > 0 ? Math.min(1, achievable / advertised) : 0,
    beyondSlowestTier,
  };
}

/**
 * Whether a recorded change may become a notification.
 *
 * Phase 8 builds no notifications. It builds the CONTRACT for them, because
 * the decision that matters is made long before anything is delivered: an
 * alert about a provider outage is an alert about Miorail, and it will be read
 * as an alert about somebody's money.
 *
 * Three conditions, all necessary:
 *
 *   1. it is a recorded transition — a change against state we already held,
 *      never a state re-read and re-announced;
 *   2. the measurement that produced it COMPLETED. A router that timed out has
 *      established nothing, and the acceptance criterion for this phase names
 *      exactly that case;
 *   3. its kind is one a person asked to hear about.
 */
export const ALERT_ELIGIBLE_KINDS_V1 = [
  'official_asset_market_became_active',
  'official_asset_market_became_unreachable',
  'official_asset_cash_exit_changed',
  'official_source_removed_asset',
  'official_asset_lookalike_created',
] as const;
export type AlertEligibleKindV1 = (typeof ALERT_ELIGIBLE_KINDS_V1)[number];

export type AlertRefusalV1 =
  | 'not_a_recorded_transition'
  | 'measurement_did_not_complete'
  | 'kind_not_eligible';

export function alertEligibilityV1(input: {
  kind: string;
  /** True only for a row written by an emitter observing a transition. */
  recordedTransition: boolean;
  /** False when the pass that produced it failed, timed out or was throttled. */
  measurementCompleted: boolean;
}): { eligible: true } | { eligible: false; refusal: AlertRefusalV1 } {
  if (!input.recordedTransition) return { eligible: false, refusal: 'not_a_recorded_transition' };
  // Checked before the kind: a failed measurement is never eligible whatever
  // it was measuring, and ordering it this way makes that unconditional.
  if (!input.measurementCompleted) {
    return { eligible: false, refusal: 'measurement_did_not_complete' };
  }
  if (!(ALERT_ELIGIBLE_KINDS_V1 as readonly string[]).includes(input.kind)) {
    return { eligible: false, refusal: 'kind_not_eligible' };
  }
  return { eligible: true };
}
