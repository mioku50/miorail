// ---------------------------------------------------------------------------
// Which old cash-exit ladders the pass removes (audit OPS-7, 2026-11-10).
//
// official_cash_exit_runs had no retention: 285,000 rows and two gigabytes on
// 2026-11-11, a third of them older than a month. Everything that reads the
// table stops at a week, with one exception: the dividend calendar prices a
// stock at the moment each multiplier change took effect, however long ago.
//
// So the pass removes public ladders older than a number of days, a bounded
// number each time, and never one inside a window the calendar reads. The
// windows come from the calendar's own code (dividendPriceWindowsV1). It is
// off until RWA_CASH_EXIT_RETENTION_DAYS says how many days to keep: removing
// rows is not something a deploy should start by itself.
// ---------------------------------------------------------------------------

/** Nothing reads a public ladder older than a week and four hours; fewer days than this is refused. */
export const CASH_EXIT_RETENTION_MIN_DAYS_V1 = 14;
/** Ladders removed by one pass at most. A backlog of 100,000 clears in about fifty passes. */
export const CASH_EXIT_RETENTION_BATCH_V1 = 2_000;
/** Kept on each side of a window the calendar reads: it selects runs by when they started and ended. */
export const CASH_EXIT_RETENTION_PAD_MS_V1 = 3_600_000;

/** How many days of public ladders to keep, or null when retention is off. Only a whole number of
 * days, at least the minimum, turns it on: anything else is off, never a guess. */
export function cashExitRetentionDaysV1(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.RWA_CASH_EXIT_RETENTION_DAYS ?? '').trim();
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) return null;
  const days = Number(raw);
  return days >= CASH_EXIT_RETENTION_MIN_DAYS_V1 ? days : null;
}

export interface CashExitRetentionPlanV1 {
  before: string;
  keep: Array<{ since: string; until: string }>;
}

/** What to ask the repository for, or null when a window is not a time: then nothing is removed. */
export function cashExitRetentionPlanV1(input: {
  days: number;
  nowMs: number;
  windows: ReadonlyArray<{ since: string; until: string }>;
}): CashExitRetentionPlanV1 | null {
  if (!Number.isInteger(input.days) || input.days < CASH_EXIT_RETENTION_MIN_DAYS_V1 || !Number.isFinite(input.nowMs)) return null;
  const keep: Array<{ since: string; until: string }> = [];
  for (const window of input.windows) {
    const since = Date.parse(window.since);
    const until = Date.parse(window.until);
    if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) return null;
    keep.push({
      since: new Date(since - CASH_EXIT_RETENTION_PAD_MS_V1).toISOString(),
      until: new Date(until + CASH_EXIT_RETENTION_PAD_MS_V1).toISOString(),
    });
  }
  return { before: new Date(input.nowMs - input.days * 86_400_000).toISOString(), keep };
}

/** The line the pass prints, so the journal says what was removed and what was kept. */
export function cashExitRetentionLineV1(input: { days: number; removed: number; kept: number }): string {
  return `retention: removed ${input.removed} public ladder${input.removed === 1 ? '' : 's'} that finished more than ${input.days} days ago; ` +
    `${input.kept} window${input.kept === 1 ? '' : 's'} kept for the dividend calendar`;
}
