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
      return orderedRunsV1(input)[0] ?? null;
    },

    async previousCompletedRun(input) {
      return orderedRunsV1(input)[1] ?? null;
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
