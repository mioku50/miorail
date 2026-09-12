import {
  assertCashExitRunV1,
  type CashExitMeasurementRunV1,
  type OfficialCashExitRepositoryV1,
} from './officialCashExit.js';
import { stableHashV1 } from '@mioagent/route-domain';
import { RouteStorageConflictError, RouteStorageTenantError } from './types.js';

export function createMemoryOfficialCashExitRepository(): OfficialCashExitRepositoryV1 {
  const runs: CashExitMeasurementRunV1[] = [];
  return {
    async recordCompletedRun(value) {
      const run = assertCashExitRunV1(value, 'write');
      const existing = runs.find((row) => row.runId === run.runId);
      if (existing) {
        if (
          stableHashV1('official-cash-exit-run-record/v1', existing) !==
          stableHashV1('official-cash-exit-run-record/v1', run)
        )
          throw new RouteStorageConflictError('cash-exit run hash collision');
        return;
      }
      runs.push(run);
    },
    async latestCompletedRun(input) {
      const ordered = orderedRunsV1(input);
      // The same preference Postgres applies, written the same way round: a
      // run that measured the asked-for size wins, and when none did the newest
      // run is still returned. The two implementations must agree — a fake that
      // accepts what the database refuses (or vice versa) is how three shipped
      // bugs got past the tests.
      const wanted = input.containingRequestedCashAtomic ?? null;
      const covered =
        input.containingAllRequestedCashAtomic && input.containingAllRequestedCashAtomic.length > 0
          ? [...input.containingAllRequestedCashAtomic]
          : null;
      if (wanted === null && covered === null) return ordered[0] ?? null;
      // Scored rather than searched twice, because Postgres orders by both
      // CASE expressions before `completed_at`: among the runs that answer the
      // exact size, one that also covers the whole set still sorts first. Two
      // sequential `find`s would quietly disagree with that.
      const score = (run: CashExitMeasurementRunV1): number => {
        const has = (size: string) =>
          run.observations.some((row) => row.requestedCashAtomic === size);
        return (wanted !== null && has(wanted) ? 2 : 0) + (covered?.every(has) ? 1 : 0);
      };
      // `ordered` is newest first, so a stable max keeps the newest of a tie —
      // the same total order the database produces.
      let best = ordered[0] ?? null;
      let bestScore = best ? score(best) : -1;
      for (const run of ordered) {
        const current = score(run);
        if (current > bestScore) {
          best = run;
          bestScore = current;
        }
      }
      return best;
    },

    async previousCompletedRun(input) {
      return orderedRunsV1(input)[1] ?? null;
    },

    async completedRunsSince(input) {
      const since = Date.parse(input.since);
      return orderedRunsV1(input)
        // Inclusive on `completedAt`, matching the SQL: a run that started
        // before the window and finished inside it belongs to the window.
        .filter((run) => Date.parse(run.completedAt) >= since)
        .slice(0, Math.max(1, Math.min(500, input.limit)));
    },
  };

  /** The same total order Postgres produces: newest completion first, then the
   * run id, so two runs stamped in the same second cannot swap places between
   * the newest read and the previous one and invent a change. */
  function orderedRunsV1(input: {
    chainId: 8453;
    tokenAddress: string;
    scope: 'public_ladder' | 'tenant_position';
    tenantId?: string | null;
  }) {
    const tokenAddress = input.tokenAddress.toLowerCase();
    const tenantId = input.tenantId ?? null;
    if (input.scope === 'tenant_position' && tenantId === null)
      throw new RouteStorageTenantError('tenant position read requires tenantId');
    if (input.scope === 'public_ladder' && tenantId !== null)
      throw new RouteStorageTenantError('public ladder is not tenant scoped');
    return runs
      .filter(
        (run) =>
          run.chainId === input.chainId &&
          run.tokenAddress === tokenAddress &&
          run.scope === input.scope &&
          run.tenantId === tenantId,
      )
      .sort(
        (left, right) =>
          right.completedAt.localeCompare(left.completedAt) ||
          right.runId.localeCompare(left.runId),
      );
  }
}
