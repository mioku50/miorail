import {
  assertWatchScheduleV1,
  type WatchScheduleRepositoryV1,
  type WatchScheduleRowV1,
} from './watchSchedule.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToScheduleV1(row: Record<string, unknown>): WatchScheduleRowV1 {
  const stamp = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
  return assertWatchScheduleV1(
    {
      chainId: Number(row.chain_id),
      tokenAddress: String(row.token_address),
      intervalSeconds: Number(row.interval_seconds),
      lastCheckedAt: stamp(row.last_checked_at),
      lastCompletedAt: stamp(row.last_completed_at),
      lastOutcome: row.last_outcome === null ? null : String(row.last_outcome),
      nextDueAt: new Date(row.next_due_at as string).toISOString(),
      checks: Number(row.checks),
      completedChecks: Number(row.completed_checks),
      createdAt: new Date(row.created_at as string).toISOString(),
    },
    'read',
  );
}

export function createDatabaseWatchScheduleRepository(
  sql: SqlTemplateExecutor,
): WatchScheduleRepositoryV1 {
  return {
    async ensureScheduled(input) {
      const addresses = [...new Set(input.tokenAddresses.map((value) => value.toLowerCase()))];
      const known = (await sql`
        SELECT token_address FROM watch_schedule WHERE chain_id = ${input.chainId}`) as Record<
        string,
        unknown
      >[];
      const scheduled = new Set(known.map((row) => String(row.token_address)));
      const created = addresses.filter((address) => !scheduled.has(address));
      const repromised = addresses.filter((address) => scheduled.has(address));
      // An address nobody watches any more stops costing anything. Retiring the
      // row rather than leaving it dormant is what keeps the capacity model's
      // denominator honest.
      const retired = [...scheduled].filter((address) => !addresses.includes(address));

      for (const address of created) {
        // Due immediately: a promise starts the moment somebody makes it.
        await sql`
          INSERT INTO watch_schedule (
            chain_id, token_address, interval_seconds, next_due_at, created_at
          ) VALUES (
            ${input.chainId}, ${address}, ${input.intervalSeconds},
            ${input.now}::timestamptz, ${input.now}::timestamptz
          )
          ON CONFLICT (chain_id, token_address) DO NOTHING`;
      }
      if (repromised.length > 0) {
        // The interval is re-promised and the debt is NOT reset: an address
        // already overdue stays overdue, or a growing list would perpetually
        // push its oldest entries back to the end of the queue.
        await sql`
          UPDATE watch_schedule
             SET interval_seconds = ${input.intervalSeconds}
           WHERE chain_id = ${input.chainId} AND token_address = ANY(${repromised})`;
      }
      if (retired.length > 0) {
        await sql`
          DELETE FROM watch_schedule
           WHERE chain_id = ${input.chainId} AND token_address = ANY(${retired})`;
      }
      return { created: created.sort(), repromised: repromised.sort(), retired: retired.sort() };
    },

    async dueForCheck(input) {
      const rows = (await sql`
        SELECT * FROM watch_schedule
         WHERE chain_id = ${input.chainId} AND next_due_at <= ${input.now}::timestamptz
         ORDER BY next_due_at ASC, token_address ASC
         LIMIT ${Math.max(1, Math.min(200, input.limit))}`) as Record<string, unknown>[];
      return rows.map(rowToScheduleV1);
    },

    async recordCheck(input) {
      const completed = input.outcome === 'measured';
      const rows = (await sql`
        UPDATE watch_schedule
           SET last_checked_at = ${input.at}::timestamptz,
               -- A failed check moves the clock and establishes nothing. This
               -- column is what a surface reads for freshness, so it stays
               -- where it was.
               last_completed_at = CASE WHEN ${completed}
                 THEN ${input.at}::timestamptz ELSE last_completed_at END,
               last_outcome = ${input.outcome},
               interval_seconds = ${input.intervalSeconds},
               next_due_at = ${input.at}::timestamptz
                 + make_interval(secs => ${input.intervalSeconds}),
               checks = checks + 1,
               completed_checks = completed_checks + CASE WHEN ${completed} THEN 1 ELSE 0 END
         WHERE chain_id = ${input.chainId} AND token_address = ${input.tokenAddress.toLowerCase()}
        RETURNING *`) as Record<string, unknown>[];
      const row = rows[0];
      if (!row) {
        throw new Error(
          `no watch schedule for ${input.tokenAddress}: a check was recorded for an address nobody watches`,
        );
      }
      return rowToScheduleV1(row);
    },

    async readSchedules(input) {
      const addresses = input.tokenAddresses.map((value) => value.toLowerCase());
      if (addresses.length === 0) return [];
      const rows = (await sql`
        SELECT * FROM watch_schedule
         WHERE chain_id = ${input.chainId} AND token_address = ANY(${addresses})
         ORDER BY token_address ASC`) as Record<string, unknown>[];
      return rows.map(rowToScheduleV1);
    },

    async scheduledAddressCount(input) {
      const rows = (await sql`
        SELECT count(*)::int AS total FROM watch_schedule WHERE chain_id = ${input.chainId}`) as Record<
        string,
        unknown
      >[];
      return Number(rows[0]?.total ?? 0);
    },
  };
}
