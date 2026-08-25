import {
  assertWatchScheduleV1,
  type WatchScheduleRepositoryV1,
  type WatchScheduleRowV1,
} from './watchSchedule.js';

/**
 * The in-memory twin.
 *
 * It holds the same rules Postgres holds: a failed check never moves
 * `lastCompletedAt`, re-promising never resets a debt, and a check recorded
 * for an unscheduled address is refused rather than silently inserted. A fake
 * that is more permissive lets a test pass on a schedule production cannot
 * produce.
 */
export function createMemoryWatchScheduleRepository(): WatchScheduleRepositoryV1 {
  const rows = new Map<string, WatchScheduleRowV1>();
  const key = (chainId: number, tokenAddress: string) => `${chainId}:${tokenAddress.toLowerCase()}`;

  return {
    async ensureScheduled(input) {
      const addresses = [...new Set(input.tokenAddresses.map((value) => value.toLowerCase()))];
      const created: string[] = [];
      const repromised: string[] = [];
      for (const address of addresses) {
        const id = key(input.chainId, address);
        const existing = rows.get(id);
        if (existing) {
          // The interval moves; the debt does not.
          rows.set(id, { ...existing, intervalSeconds: input.intervalSeconds });
          repromised.push(address);
          continue;
        }
        rows.set(
          id,
          assertWatchScheduleV1(
            {
              chainId: input.chainId,
              tokenAddress: address,
              intervalSeconds: input.intervalSeconds,
              lastCheckedAt: null,
              lastCompletedAt: null,
              lastOutcome: null,
              // Due immediately: a promise starts the moment somebody makes it.
              nextDueAt: input.now,
              checks: 0,
              completedChecks: 0,
              createdAt: input.now,
            },
            'write',
          ),
        );
        created.push(address);
      }
      const retired: string[] = [];
      for (const [id, row] of [...rows]) {
        if (row.chainId !== input.chainId) continue;
        if (addresses.includes(row.tokenAddress)) continue;
        rows.delete(id);
        retired.push(row.tokenAddress);
      }
      return { created: created.sort(), repromised: repromised.sort(), retired: retired.sort() };
    },

    async dueForCheck(input) {
      const now = Date.parse(input.now);
      return [...rows.values()]
        .filter((row) => row.chainId === input.chainId && Date.parse(row.nextDueAt) <= now)
        .sort(
          (left, right) =>
            Date.parse(left.nextDueAt) - Date.parse(right.nextDueAt) ||
            left.tokenAddress.localeCompare(right.tokenAddress),
        )
        .slice(0, Math.max(1, Math.min(200, input.limit)))
        .map((row) => ({ ...row }));
    },

    async recordCheck(input) {
      const id = key(input.chainId, input.tokenAddress);
      const existing = rows.get(id);
      if (!existing) {
        throw new Error(
          `no watch schedule for ${input.tokenAddress}: a check was recorded for an address nobody watches`,
        );
      }
      const completed = input.outcome === 'measured';
      const next = assertWatchScheduleV1(
        {
          ...existing,
          intervalSeconds: input.intervalSeconds,
          lastCheckedAt: input.at,
          lastCompletedAt: completed ? input.at : existing.lastCompletedAt,
          lastOutcome: input.outcome,
          nextDueAt: new Date(Date.parse(input.at) + input.intervalSeconds * 1000).toISOString(),
          checks: existing.checks + 1,
          completedChecks: existing.completedChecks + (completed ? 1 : 0),
        },
        'write',
      );
      rows.set(id, next);
      return { ...next };
    },

    async readSchedules(input) {
      const addresses = new Set(input.tokenAddresses.map((value) => value.toLowerCase()));
      return [...rows.values()]
        .filter((row) => row.chainId === input.chainId && addresses.has(row.tokenAddress))
        .sort((left, right) => left.tokenAddress.localeCompare(right.tokenAddress))
        .map((row) => ({ ...row }));
    },

    async scheduledAddressCount(input) {
      return [...rows.values()].filter((row) => row.chainId === input.chainId).length;
    },
  };
}
