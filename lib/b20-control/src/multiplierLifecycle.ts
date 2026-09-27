// ---------------------------------------------------------------------------
// A scheduled multiplier change is a PLAN, and a plan is not an event.
//
// Cobalt makes `updateUIMultiplier(newMultiplier, effectiveAt)` the canonical
// path for splits and reinvested dividends. Three properties of that setter
// decide everything in this file:
//
//   1. The log fires when the change is SCHEDULED, not when it takes effect.
//   2. NOTHING FIRES AT MATURATION. `multiplier()` simply starts returning the
//      new value once `block.timestamp >= effectiveAt`. No indexer is told.
//   3. A live pending update can be CANCELLED, or SUPERSEDED by the instant
//      emergency setter, and then it never happens at all.
//
// Put together: a feed that treats the log as the action publishes a corporate
// action that has not happened, may never happen, and whose value the token
// does not yet convert with. That is the same failure as
// [[announced-is-not-live]] wearing a different name, and it lands on the one
// number that says how many real shares a token is.
//
// SO THE STATE IS DERIVED, NEVER STORED. It is a function of the events on
// record plus ONE READING of the token's own `multiplier()`, and it is
// recomputed every time somebody asks. A stored state would be a cache of a
// clock, and a clock cache is wrong for exactly as long as nobody looks.
//
// FOUR STATES, AND THE FOURTH IS OURS
//
//   scheduled                  announced, `effectiveAt` still ahead. The
//                              EFFECTIVE multiplier is the old one, and that
//                              is what a holder converts with.
//   effective                  the time passed AND a reading of the token at a
//                              block confirms the value. Confirmation is not
//                              optional: the clock says a change was due, the
//                              chain says what the token actually holds, and
//                              only the second one is a measurement.
//   not_executed_as_planned    cancelled, or superseded by a later change
//                              before it matured. Stays in the record and
//                              never appears as a live corporate action.
//   awaiting_confirmation      the time passed and we have not read the token
//                              since. This is a gap in OUR reading, not a
//                              state of the asset, and it is named rather than
//                              rounded to a neighbour — rounding up would
//                              publish an unconfirmed value as effective, and
//                              rounding down would keep calling a matured
//                              change "scheduled" forever.
//
// AN INSTANT CHANGE IS NEVER `scheduled`. The emergency setter emits the same
// event with `effectiveAt == block.timestamp`, so it was already in force in
// the block that carried it. It goes straight to `effective` or
// `awaiting_confirmation` — the same confirmation rule, a different path in.
// ---------------------------------------------------------------------------

/** The four states a multiplier change can be in. */
export const B20_MULTIPLIER_CHANGE_STATES_V1 = [
  'scheduled',
  'effective',
  'not_executed_as_planned',
  'awaiting_confirmation',
] as const;
export type B20MultiplierChangeStateV1 = (typeof B20_MULTIPLIER_CHANGE_STATES_V1)[number];

/** Why a change is `not_executed_as_planned`. Two different things happened
 * and a reader who is owed one of them is not served by the other. */
export type B20MultiplierNotExecutedCauseV1 = 'cancelled' | 'superseded';

/** How a change reached the chain. `immediate` is the deprecated emergency
 * setter, which is a documented failsafe rather than a fault. */
export type B20MultiplierChangeRouteV1 = 'scheduled_setter' | 'immediate_setter';

/** One decoded multiplier event, in the shape this module needs.
 *
 * Deliberately structural rather than imported from storage: the lifecycle is
 * arithmetic over timestamps and must not acquire a database dependency to be
 * testable, and a row that could not be decoded has no schedule to reason
 * about and is filtered out before it gets here. */
export interface B20MultiplierEventV1 {
  event: 'multiplier_updated' | 'ui_multiplier_updated' | 'ui_multiplier_update_cancelled';
  /** WAD-scaled. */
  multiplierWad: string;
  /** ISO instant. Null only on the deprecated `MultiplierUpdated`, which
   * declares no schedule. */
  effectiveAt: string | null;
  /** The block's own timestamp, ISO. When the LOG happened. */
  blockTime: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

/** What the token itself says, read at a block. The only thing that can
 * confirm a change. */
export interface B20MultiplierReadingV1 {
  /** WAD-scaled, exactly as `multiplier()` returned it. */
  multiplierWad: string;
  /** The block the read was pinned to. */
  blockNumber: number;
  /** That block's timestamp, ISO. A reading confirms a change only if the
   * block it was taken at is at or after the change's `effectiveAt`. */
  blockTime: string;
}

export interface B20MultiplierChangeV1 {
  state: B20MultiplierChangeStateV1;
  /** Set only on `not_executed_as_planned`. */
  cause: B20MultiplierNotExecutedCauseV1 | null;
  route: B20MultiplierChangeRouteV1;
  /** The multiplier this change would produce, WAD-scaled. NOT the one in
   * force unless `state === 'effective'`. */
  multiplierWad: string;
  /** When it takes (or took) effect. Null for the deprecated setter, which is
   * in force from its own block. */
  effectiveAt: string | null;
  /** When the log was emitted. Never the same field as `effectiveAt`. */
  announcedAt: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  /** The reading that confirmed it, when one did. */
  confirmedBy: { blockNumber: number; blockTime: string } | null;
}

/**
 * Everything known about one token's multiplier, as one answer.
 *
 * `effectiveMultiplierWad` is the whole point of the module. Ask Miorail, the
 * MCP tools and the paid surface all answer "how many underlying shares is one
 * token" from this field and never from a change, because a scheduled change
 * carries a number that is real, published by the issuer, and WRONG for that
 * question until its date arrives.
 */
export interface B20MultiplierStandingV1 {
  /** What one token converts with RIGHT NOW, from the token's own reading.
   * Null when nothing has been read — never filled in from a change. */
  effectiveMultiplierWad: string | null;
  /** The reading that established it. */
  effectiveAsOf: { blockNumber: number; blockTime: string } | null;
  /** Announced, dated, and not yet in force. Empty is the ordinary case. */
  scheduled: readonly B20MultiplierChangeV1[];
  /** Every change on record, newest first, whatever became of it. */
  history: readonly B20MultiplierChangeV1[];
}

function msV1(iso: string): number {
  return Date.parse(iso);
}

/** Newest first, and stable: two logs in one block are ordered by log index,
 * which is the order the chain put them in. */
function newestFirstV1(a: B20MultiplierEventV1, b: B20MultiplierEventV1): number {
  if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
  return b.logIndex - a.logIndex;
}

/**
 * The lifecycle of every multiplier change on one token.
 *
 * `reading` is the token's own `multiplier()` at a block. It is optional
 * because a caller may have nothing yet, and its absence must produce
 * `awaiting_confirmation` rather than a guess.
 */
export function b20MultiplierStandingV1(input: {
  events: readonly B20MultiplierEventV1[];
  reading: B20MultiplierReadingV1 | null;
  now: Date;
}): B20MultiplierStandingV1 {
  const now = input.now.getTime();
  const reading = input.reading;

  // A cancellation names the plan it calls off by (multiplier, effectiveAt).
  // Matching on the pair rather than on "the most recent pending" is what
  // keeps a cancellation from retiring the wrong change if two ever overlap.
  const cancelled = new Set<string>();
  for (const event of input.events) {
    if (event.event !== 'ui_multiplier_update_cancelled') continue;
    if (event.effectiveAt === null) continue;
    cancelled.add(`${event.multiplierWad}@${event.effectiveAt}`);
  }

  const changes = input.events
    .filter((event) => event.event !== 'ui_multiplier_update_cancelled')
    .slice()
    .sort(newestFirstV1);

  // When a change takes effect: its date, or its own block for the instant
  // setter, which was in force the moment it was logged.
  const maturedAt = (event: B20MultiplierEventV1): number =>
    event.effectiveAt === null ? msV1(event.blockTime) : msV1(event.effectiveAt);

  // Newest first, so a change can lean on what came after it.
  const resolved: B20MultiplierChangeV1[] = [];
  for (const event of changes) {
    const route: B20MultiplierChangeRouteV1 =
      event.event === 'multiplier_updated' ||
      event.effectiveAt === null ||
      msV1(event.effectiveAt) <= msV1(event.blockTime)
        ? 'immediate_setter'
        : 'scheduled_setter';
    const matures = maturedAt(event);
    const base = {
      cause: null,
      route,
      multiplierWad: event.multiplierWad,
      effectiveAt: event.effectiveAt,
      announcedAt: event.blockTime,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      confirmedBy: null,
    };

    if (event.effectiveAt !== null && cancelled.has(`${event.multiplierWad}@${event.effectiveAt}`)) {
      resolved.push({ ...base, state: 'not_executed_as_planned', cause: 'cancelled' });
      continue;
    }

    // SUPERSEDED: another change was logged after this one and before its
    // date. Only one pending update can be live at a time (Base's Cobalt spec):
    // a second schedule is refused while one is live, and the instant setter
    // clears it. So whatever was logged in that window took its place, whether
    // or not it has matured yet. A change logged AFTER this one's date
    // replaced nothing: this one had already happened.
    const supersededBy = changes.find(
      (other) =>
        other !== event &&
        (other.blockNumber > event.blockNumber ||
          (other.blockNumber === event.blockNumber && other.logIndex > event.logIndex)) &&
        msV1(other.blockTime) < matures,
    );
    if (supersededBy !== undefined) {
      resolved.push({ ...base, state: 'not_executed_as_planned', cause: 'superseded' });
      continue;
    }

    if (matures > now) {
      resolved.push({ ...base, state: 'scheduled' });
      continue;
    }

    // Matured. Only the token can say it actually holds this value.
    if (reading !== null && msV1(reading.blockTime) >= matures && reading.multiplierWad === event.multiplierWad) {
      resolved.push({
        ...base,
        state: 'effective',
        confirmedBy: { blockNumber: reading.blockNumber, blockTime: reading.blockTime },
      });
      continue;
    }

    // Or a later change says it: one logged after this one had matured, and
    // itself confirmed by the token. Nothing fires at maturation, so the token
    // converted at this value from its date until that later change, and the
    // reading that confirms the later one confirms the record in between. This
    // is what keeps last quarter's dividend from reading as "not executed" the
    // day the next one lands.
    const followedBy = resolved.find(
      (later) => later.state === 'effective' && msV1(later.announcedAt) >= matures,
    );
    if (followedBy !== undefined) {
      resolved.push({ ...base, state: 'effective', confirmedBy: followedBy.confirmedBy });
      continue;
    }

    // The reading is FROM AFTER this change matured and says something else,
    // and no later change on record explains it. Something replaced it that we
    // have no log for — a fact about our record, not about the token, and it is
    // not `effective`.
    if (reading !== null && msV1(reading.blockTime) >= matures) {
      resolved.push({ ...base, state: 'not_executed_as_planned', cause: 'superseded' });
      continue;
    }

    resolved.push({ ...base, state: 'awaiting_confirmation' });
  }

  return {
    // Straight from the token, never assembled from a change. A caller that
    // wants "how many shares is one token" gets a measurement or nothing.
    effectiveMultiplierWad: reading?.multiplierWad ?? null,
    effectiveAsOf:
      reading === null ? null : { blockNumber: reading.blockNumber, blockTime: reading.blockTime },
    scheduled: resolved.filter((change) => change.state === 'scheduled'),
    history: resolved,
  };
}

/** Whether a change may be shown as something that has happened.
 *
 * Written out rather than left to each surface, because `!== 'scheduled'` is
 * the natural thing to type and it would publish both an unconfirmed change
 * and a cancelled one as live corporate actions. */
export function b20MultiplierChangeHasHappenedV1(change: B20MultiplierChangeV1): boolean {
  return change.state === 'effective';
}
