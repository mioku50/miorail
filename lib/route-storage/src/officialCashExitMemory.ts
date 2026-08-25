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
      const tokenAddress = input.tokenAddress.toLowerCase();
      const tenantId = input.tenantId ?? null;
      if (input.scope === 'tenant_position' && tenantId === null)
        throw new RouteStorageTenantError('tenant position read requires tenantId');
      if (input.scope === 'public_ladder' && tenantId !== null)
        throw new RouteStorageTenantError('public ladder is not tenant scoped');
      return (
        runs
          .filter(
            (run) =>
              run.chainId === input.chainId &&
              run.tokenAddress === tokenAddress &&
              run.scope === input.scope &&
              run.tenantId === tenantId,
          )
          .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0] ?? null
      );
    },
  };
}
