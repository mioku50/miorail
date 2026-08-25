import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// One schedule per ADDRESS, however many people are watching it.
//
// The subscription lives in `b20_watchlist`, one row per user per token. This
// is the other half: what is owed on the contract itself. Two accounts
// watching one token is one check, and that is not an optimisation — it is
// what makes the interval a promise the operator can afford to keep.
//
// The rule this interface enforces everywhere: a failed check moves the clock
// and establishes nothing. `lastCheckedAt` advances so a broken address cannot
// monopolise the queue; `lastCompletedAt` does not, so no surface can read
// freshness out of an outage.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');

/** What a scheduled check produced. `unreadable` is a chain read that failed;
 * `measurement_failed` is the router. Both are ours, and neither is a finding. */
export const WATCH_CHECK_OUTCOMES_V1 = ['measured', 'measurement_failed', 'unreadable'] as const;
export type WatchCheckOutcomeV1 = (typeof WATCH_CHECK_OUTCOMES_V1)[number];

export const WatchScheduleRowV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    intervalSeconds: z.number().int().min(900).max(86_400),
    lastCheckedAt: z.string().datetime().nullable(),
    lastCompletedAt: z.string().datetime().nullable(),
    lastOutcome: z.enum(WATCH_CHECK_OUTCOMES_V1).nullable(),
    nextDueAt: z.string().datetime(),
    checks: z.number().int().min(0),
    completedChecks: z.number().int().min(0),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if ((row.lastOutcome === null) !== (row.lastCheckedAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an outcome with no check behind it describes a read that never happened',
      });
    }
    if (row.lastCompletedAt !== null) {
      if (row.lastCheckedAt === null || Date.parse(row.lastCompletedAt) > Date.parse(row.lastCheckedAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a completion is a check, and cannot be newer than the last one',
        });
      }
    }
    if (row.completedChecks > row.checks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'more completions than checks',
      });
    }
  });

export type WatchScheduleRowV1 = z.infer<typeof WatchScheduleRowV1Schema>;

export function assertWatchScheduleV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): WatchScheduleRowV1 {
  const parsed = WatchScheduleRowV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`watch schedule row failed validation on ${direction}: ${detail}`);
}

export interface WatchScheduleRepositoryV1 {
  /**
   * Make sure every watched address has a schedule, and re-promise the
   * interval on all of them.
   *
   * One call rather than two because the interval is derived from the SET: a
   * new address changes what every other address can be promised, so writing
   * one row without re-promising the rest would leave the list advertising a
   * pace the budget no longer supports.
   *
   * A brand-new address is due immediately. An address already scheduled keeps
   * its place in the queue: re-promising must not reset a debt.
   */
  ensureScheduled(input: {
    chainId: number;
    tokenAddresses: readonly string[];
    intervalSeconds: number;
    now: string;
  }): Promise<{ created: string[]; repromised: string[]; retired: string[] }>;

  /** What is owed, oldest debt first. The queue reads `nextDueAt` and nothing
   * else, so a broken address cannot be starved by a busy one or vice versa. */
  dueForCheck(input: { chainId: number; now: string; limit: number }): Promise<WatchScheduleRowV1[]>;

  /**
   * Records that the sweep reached this address.
   *
   * `completed` false moves the clock and nothing else: `lastCompletedAt`
   * stays where it was, so freshness is never claimed from an outage.
   */
  recordCheck(input: {
    chainId: number;
    tokenAddress: string;
    at: string;
    outcome: WatchCheckOutcomeV1;
    intervalSeconds: number;
  }): Promise<WatchScheduleRowV1>;

  /** The schedule for a set of addresses, for the surface that renders the
   * promise beside each row. */
  readSchedules(input: {
    chainId: number;
    tokenAddresses: readonly string[];
  }): Promise<WatchScheduleRowV1[]>;

  /** How many distinct addresses are scheduled — the capacity model's only
   * input from storage. */
  scheduledAddressCount(input: { chainId: number }): Promise<number>;
}

/** Whether a scheduled check is overdue, and by how much. Shared so a worker
 * and a screen cannot disagree about what "due" means. */
export function watchDebtSecondsV1(row: WatchScheduleRowV1, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(row.nextDueAt)) / 1000));
}
