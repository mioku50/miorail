import { rwaAgeLabelV1 } from './rwaDiscoverView';

// ---------------------------------------------------------------------------
// Phase 8 — the freshness promise, in words.
//
// The whole point of this module is that the two halves of the sentence come
// from the SAME fact. "Checked every 30 minutes" and "next check in 11
// minutes" printed from a constant and a timestamp will disagree the day the
// list grows, and the reader has no way to tell which half is stale.
//
// So the interval is read from the schedule row the sweep wrote, and the
// countdown from that row's own `nextDueAt`. When no row exists the surface
// says no promise has been made — never a number, because a number there would
// be a schedule nothing is keeping.
// ---------------------------------------------------------------------------

export interface WatchScheduleWireV1 {
  intervalSeconds: number;
  nextDueAt: string;
  lastCheckedAt: string | null;
  lastCompletedAt: string | null;
  lastOutcome: 'measured' | 'measurement_failed' | 'unreadable' | null;
  checks: number;
  completedChecks: number;
}

export interface WatchSlaWireV1 {
  distinctAddresses: number;
  advertisedIntervalSeconds: number;
  achievableIntervalSeconds: number;
  limitedBy: 'rpc' | 'router' | 'tier_floor' | 'nothing_watched';
  utilisation: number;
  beyondSlowestTier: boolean;
  scheduleActive: boolean;
}

/** A whole number of minutes or hours. Anything else is arithmetic leaking
 * into a promise. */
export function intervalLabelV1(seconds: number): string {
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return hours === 1 ? 'hourly' : `every ${hours} hours`;
  }
  return `every ${Math.round(seconds / 60)} minutes`;
}

/** How long until a due time, or how overdue it is. Never a negative number
 * dressed as a countdown. */
export function countdownLabelV1(nextDueAt: string, now: Date): string {
  const seconds = Math.round((Date.parse(nextDueAt) - now.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds <= 0) {
    const overdue = Math.abs(seconds);
    // Overdue is stated, not hidden behind "any moment now". A queue that has
    // fallen behind is a fact the promise owes the reader.
    return overdue < 60 ? 'due now' : `overdue by ${Math.floor(overdue / 60)}m`;
  }
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3_600) return `in ${Math.floor(seconds / 60)}m`;
  return `in ${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

export interface WatchSlaViewV1 {
  /** The promise, or why there is not one. */
  headline: string;
  /** What the promise is derived from. An operator reads this; a user may. */
  detail: string;
  tone: 'good' | 'warn' | 'off';
}

export function watchSlaViewV1(sla: WatchSlaWireV1): WatchSlaViewV1 {
  if (sla.distinctAddresses === 0 || !sla.scheduleActive) {
    return {
      headline: 'Nothing is scheduled yet.',
      detail:
        'A watched address is checked on a schedule once the background sweep has reconciled it. Until then this page shows only what was read while somebody was here.',
      tone: 'off',
    };
  }
  if (sla.beyondSlowestTier) {
    return {
      headline: 'The watchlist has outgrown the slowest schedule Miorail publishes.',
      // Stated rather than silently slipped. The alternative is a page that
      // keeps printing an interval while every card ages past it.
      detail: `${sla.distinctAddresses} addresses are watched across all accounts, and the measurement budget cannot reach them all inside 24 hours. Checks continue oldest-first, and the promise on each row is not being kept.`,
      tone: 'warn',
    };
  }
  return {
    headline: `Checked ${intervalLabelV1(sla.advertisedIntervalSeconds)}.`,
    detail: `${sla.distinctAddresses} address${
      sla.distinctAddresses === 1 ? '' : 'es'
    } watched across all accounts — two people watching one token is one check. The budget supports ${intervalLabelV1(
      Math.max(60, Math.round(sla.achievableIntervalSeconds / 60) * 60),
    )} at this size${
      sla.limitedBy === 'tier_floor'
        ? ', and this is the fastest schedule Miorail publishes'
        : `, limited by ${sla.limitedBy === 'router' ? 'the router quote budget' : 'the chain-read budget'}`
    }.`,
    tone: 'good',
  };
}

export interface WatchRowScheduleViewV1 {
  /** "Next check in 11m", or why there is no next check. */
  next: string;
  /** When something was last ESTABLISHED — never the last attempt. */
  lastCompleted: string;
  /** Present only when the last attempt did not complete. */
  lastFailure: string | null;
  tone: 'good' | 'warn' | 'off';
}

export function watchRowScheduleViewV1(
  schedule: WatchScheduleWireV1 | null,
  now: Date,
): WatchRowScheduleViewV1 {
  if (schedule === null) {
    return {
      next: 'not scheduled yet',
      lastCompleted: 'never checked on a schedule',
      lastFailure: null,
      tone: 'off',
    };
  }
  const failed = schedule.lastOutcome !== null && schedule.lastOutcome !== 'measured';
  return {
    next: `next check ${countdownLabelV1(schedule.nextDueAt, now)}`,
    // The completed clock, never the attempted one: a surface that showed the
    // last attempt would report freshness after an outage.
    lastCompleted:
      schedule.lastCompletedAt === null
        ? 'nothing measured yet'
        : `last measured ${rwaAgeLabelV1(schedule.lastCompletedAt, now) ?? 'at an unknown time'}`,
    lastFailure: failed
      ? schedule.lastOutcome === 'unreadable'
        ? 'The last attempt could not read this contract. That is about the endpoint, not the token.'
        : 'The last attempt did not complete. Nothing here changed as a result.'
      : null,
    tone: failed ? 'warn' : schedule.lastCompletedAt === null ? 'off' : 'good',
  };
}
