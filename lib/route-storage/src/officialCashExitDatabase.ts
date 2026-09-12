import {
  assertCashExitRunV1,
  type CashExitMeasurementRunV1,
  type OfficialCashExitRepositoryV1,
} from './officialCashExit.js';
import { stableHashV1 } from '@mioagent/route-domain';
import {
  RouteStorageConflictError,
  RouteStorageTenantError,
  type SqlTemplateExecutor,
} from './types.js';

function runFromRowV1(row: Record<string, unknown>): CashExitMeasurementRunV1 {
  return assertCashExitRunV1({
    schemaVersion: 'official-cash-exit-run/v1',
    runId: row.run_id,
    chainId: Number(row.chain_id),
    tokenAddress: row.token_address,
    scope: row.scope,
    tenantId: row.tenant_id ?? null,
    approvedSources: row.approved_sources,
    destinations: row.destinations,
    startedAt: new Date(row.started_at as string).toISOString(),
    completedAt: new Date(row.completed_at as string).toISOString(),
    observations: row.observations,
    ...(row.market_reality_snapshots === null || row.market_reality_snapshots === undefined
      ? {}
      : { marketRealitySnapshots: row.market_reality_snapshots }),
  });
}

export function createDatabaseOfficialCashExitRepository(
  sql: SqlTemplateExecutor,
): OfficialCashExitRepositoryV1 {
  return {
    async recordCompletedRun(value) {
      const run = assertCashExitRunV1(value, 'write');
      await sql`
        INSERT INTO official_cash_exit_runs (
          run_id, chain_id, token_address, scope, tenant_id, approved_sources,
          destinations, started_at, completed_at, observations, market_reality_snapshots
        ) VALUES (
          ${run.runId}, ${run.chainId}, ${run.tokenAddress}, ${run.scope}, ${run.tenantId},
          ${JSON.stringify(run.approvedSources)}::text::jsonb,
          ${JSON.stringify(run.destinations)}::text::jsonb,
          ${run.startedAt}, ${run.completedAt},
          ${JSON.stringify(run.observations)}::text::jsonb,
          ${
            run.marketRealitySnapshots === undefined || run.marketRealitySnapshots === null
              ? null
              : JSON.stringify(run.marketRealitySnapshots)
          }::text::jsonb
        )
        ON CONFLICT (run_id) DO NOTHING`;
      const stored = await sql`
        SELECT run_id, chain_id, token_address, scope, tenant_id, approved_sources,
               destinations, started_at, completed_at, observations, market_reality_snapshots
        FROM official_cash_exit_runs
        WHERE run_id = ${run.runId}`;
      if (
        !stored[0] ||
        stableHashV1('official-cash-exit-run-record/v1', runFromRowV1(stored[0])) !==
          stableHashV1('official-cash-exit-run-record/v1', run)
      ) {
        throw new RouteStorageConflictError('cash-exit run hash collision');
      }
    },
    async latestCompletedRun(input) {
      const tenantId = input.tenantId ?? null;
      if (input.scope === 'tenant_position' && tenantId === null)
        throw new RouteStorageTenantError('tenant position read requires tenantId');
      if (input.scope === 'public_ladder' && tenantId !== null)
        throw new RouteStorageTenantError('public ladder is not tenant scoped');
      // A PREFERENCE, not a filter: runs that measured the asked-for size sort
      // first, and when none did the newest run is still returned so the caller
      // refuses exactly as it did before. Null size sorts everything equally,
      // which is the old behaviour to the letter.
      const wanted = input.containingRequestedCashAtomic ?? null;
      // The set preference, applied AFTER the single-size one so a caller that
      // asks for both still gets the run that answers its exact question.
      const covered =
        input.containingAllRequestedCashAtomic && input.containingAllRequestedCashAtomic.length > 0
          ? [...input.containingAllRequestedCashAtomic]
          : null;
      const rows = await sql`
        SELECT run_id, chain_id, token_address, scope, tenant_id, approved_sources,
               destinations, started_at, completed_at, observations, market_reality_snapshots
        FROM official_cash_exit_runs
        WHERE chain_id = ${input.chainId}
          AND token_address = ${input.tokenAddress.toLowerCase()}
          AND scope = ${input.scope}
          AND tenant_id IS NOT DISTINCT FROM ${tenantId}
        ORDER BY
          CASE
            WHEN ${wanted}::text IS NULL THEN 0
            WHEN EXISTS (
              SELECT 1 FROM jsonb_array_elements(observations) AS o
              WHERE o->>'requestedCashAtomic' = ${wanted}::text
            ) THEN 1
            ELSE 0
          END DESC,
          CASE
            WHEN ${covered}::text[] IS NULL THEN 0
            WHEN NOT EXISTS (
              SELECT 1
                FROM unnest(${covered}::text[]) AS want(size)
               WHERE NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements(observations) AS o
                  WHERE o->>'requestedCashAtomic' = want.size
               )
            ) THEN 1
            ELSE 0
          END DESC,
          completed_at DESC, run_id DESC
        LIMIT 1`;
      return rows[0] ? runFromRowV1(rows[0]) : null;
    },

    async previousCompletedRun(input) {
      const tenantId = input.tenantId ?? null;
      if (input.scope === 'tenant_position' && tenantId === null)
        throw new RouteStorageTenantError('tenant position read requires tenantId');
      if (input.scope === 'public_ladder' && tenantId !== null)
        throw new RouteStorageTenantError('public ladder is not tenant scoped');
      // OFFSET 1 on the same total order the newest read uses, so the pair a
      // caller compares is always adjacent. Ordering by completed_at alone
      // would let two runs stamped in the same second swap places between the
      // two reads and produce a change that never happened.
      const rows = await sql`
        SELECT run_id, chain_id, token_address, scope, tenant_id, approved_sources,
               destinations, started_at, completed_at, observations, market_reality_snapshots
        FROM official_cash_exit_runs
        WHERE chain_id = ${input.chainId}
          AND token_address = ${input.tokenAddress.toLowerCase()}
          AND scope = ${input.scope}
          AND tenant_id IS NOT DISTINCT FROM ${tenantId}
        ORDER BY completed_at DESC, run_id DESC
        LIMIT 1 OFFSET 1`;
      return rows[0] ? runFromRowV1(rows[0]) : null;
    },

    async completedRunsSince(input) {
      const tenantId = input.tenantId ?? null;
      if (input.scope === 'tenant_position' && tenantId === null)
        throw new RouteStorageTenantError('tenant position read requires tenantId');
      if (input.scope === 'public_ladder' && tenantId !== null)
        throw new RouteStorageTenantError('public ladder is not tenant scoped');
      // The same total order the newest and previous reads use, so a series and
      // a pair drawn from it can never disagree about which run came first.
      const rows = await sql`
        SELECT run_id, chain_id, token_address, scope, tenant_id, approved_sources,
               destinations, started_at, completed_at, observations, market_reality_snapshots
        FROM official_cash_exit_runs
        WHERE chain_id = ${input.chainId}
          AND token_address = ${input.tokenAddress.toLowerCase()}
          AND scope = ${input.scope}
          AND tenant_id IS NOT DISTINCT FROM ${tenantId}
          AND completed_at >= ${input.since}::timestamptz
        ORDER BY completed_at DESC, run_id DESC
        LIMIT ${Math.max(1, Math.min(500, input.limit))}`;
      return rows.map(runFromRowV1);
    },
  };
}
