import {
  assertEntryExecutionRunV1,
  assertPreparedPlanV1,
  entryPlanConflictV1,
  entryPlanWriteRefusalV1,
  type B20EntryExecutionRunV1,
  type B20EntryPlanRepositoryV1,
  type B20PreparedEntryPlanV1,
} from './b20EntryPlans.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed B20EntryPlanRepositoryV1.
//
// The whole document lives in `payload` and is re-parsed on read: a row that
// stopped satisfying its own schema is refused rather than used to authorise a
// signature. The scalar columns exist to be queried, indexed and CONSTRAINED —
// the database refuses a bad plan even if this file were replaced tomorrow.
// ---------------------------------------------------------------------------

function rowToPlanV1(row: Record<string, unknown>): B20PreparedEntryPlanV1 {
  return assertPreparedPlanV1(row.payload, 'read');
}

function rowToRunV1(row: Record<string, unknown>): B20EntryExecutionRunV1 {
  return assertEntryExecutionRunV1(row.payload, 'read');
}

export function createDatabaseB20EntryPlanRepository(
  sql: SqlTemplateExecutor,
): B20EntryPlanRepositoryV1 {
  const readPlanById = async (planId: string): Promise<B20PreparedEntryPlanV1 | null> => {
    const rows = await sql`
      SELECT payload FROM b20_entry_plans WHERE id = ${planId} LIMIT 1`;
    return rows[0] ? rowToPlanV1(rows[0] as Record<string, unknown>) : null;
  };

  return {
    async insertPreparedPlan(input) {
      const plan = assertPreparedPlanV1(input.plan, 'write');
      const run = assertEntryExecutionRunV1(input.run, 'write');
      const refusal = entryPlanWriteRefusalV1({ plan, run });
      if (refusal) throw entryPlanConflictV1(refusal);

      const inserted = await sql`
        INSERT INTO b20_entry_plans (
          id, tenant_id, wallet_address, chain_id, clearance_id, clearance_hash,
          profile_identity, token_address, quote_asset, position_atomic,
          entry_provider_id, entry_source_key, entry_route_hash,
          blueprint_hash, calls_hash, fresh_quote_hash,
          certification_control_snapshot_hash, prepare_control_snapshot_hash,
          certification_simulation_evidence_hash, prepare_simulation_evidence_hash,
          expected_output_atomic, minimum_output_atomic,
          coverage, viable_route_confirmed, best_route_confirmed,
          certification_block_number, prepare_control_block_number,
          prepare_simulation_block_number,
          lifecycle, submission_id, request_id, expires_at, payload
        ) VALUES (
          ${plan.id}, ${plan.tenantId}, ${plan.walletAddress}, ${plan.chainId},
          ${plan.clearanceId}, ${plan.clearanceHash}, ${plan.profileIdentity},
          ${plan.tokenAddress}, ${plan.quoteAsset}, ${plan.positionAtomic},
          ${plan.entryProviderId}, ${plan.entrySourceKey}, ${plan.entryRouteHash},
          ${plan.blueprintHash}, ${plan.callsHash}, ${plan.freshQuoteHash},
          ${plan.certificationControlSnapshotHash}, ${plan.prepareControlSnapshotHash},
          ${plan.certificationSimulationEvidenceHash}, ${plan.prepareSimulationEvidenceHash},
          ${plan.expectedOutputAtomic}, ${plan.minimumOutputAtomic},
          ${plan.coverage}, ${plan.viableRouteConfirmed}, ${plan.bestRouteConfirmed},
          ${plan.certificationBlockNumber}, ${plan.prepareControlBlockNumber},
          ${plan.prepareSimulationBlockNumber},
          ${plan.lifecycle}, ${plan.submissionId}, ${plan.requestId},
          ${plan.expiresAt}, ${JSON.stringify(plan)}::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING payload`;

      if (inserted.length === 0) {
        // Either the id or the idempotency identity already exists. Read what
        // is actually stored rather than assuming which.
        const existingRows = await sql`
          SELECT payload FROM b20_entry_plans
          WHERE tenant_id = ${plan.tenantId}
            AND wallet_address = ${plan.walletAddress.toLowerCase()}
            AND clearance_id = ${plan.clearanceId}
            AND request_id = ${plan.requestId}
          LIMIT 1`;
        const stored = existingRows[0]
          ? rowToPlanV1(existingRows[0] as Record<string, unknown>)
          : await readPlanById(plan.id);
        if (!stored) throw entryPlanConflictV1('The entry plan could not be stored or re-read');
        // The blueprint hash covers every executable byte and every binding, so
        // a match is an ordinary retry. A mismatch is two different plans
        // claiming one identity, and neither silently wins.
        if (stored.blueprintHash !== plan.blueprintHash) {
          throw entryPlanConflictV1('A different entry plan already exists for this request id');
        }
        const storedRun = await sql`
          SELECT payload FROM b20_entry_executions WHERE prepared_plan_id = ${stored.id} LIMIT 1`;
        if (!storedRun[0]) {
          throw entryPlanConflictV1('The stored entry plan has no execution run');
        }
        return { plan: stored, run: rowToRunV1(storedRun[0] as Record<string, unknown>) };
      }

      const insertedRun = await sql`
        INSERT INTO b20_entry_executions (
          id, tenant_id, wallet_address, chain_id, execution_family,
          prepared_plan_id, clearance_id, state, submission_id, payload
        ) VALUES (
          ${run.id}, ${run.tenantId}, ${run.walletAddress}, ${run.chainId},
          ${run.executionFamily}, ${run.preparedPlanId}, ${run.clearanceId},
          ${run.state}, ${run.submissionId}, ${JSON.stringify(run)}::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING payload`;
      if (insertedRun.length === 0) {
        throw entryPlanConflictV1('A different execution run already exists for this plan');
      }
      return {
        plan: rowToPlanV1(inserted[0] as Record<string, unknown>),
        run: rowToRunV1(insertedRun[0] as Record<string, unknown>),
      };
    },

    async getPreparedPlan(input) {
      const rows = await sql`
        SELECT payload FROM b20_entry_plans
        WHERE id = ${input.planId}
          AND tenant_id = ${input.tenantId}
          AND wallet_address = ${input.walletAddress.toLowerCase()}
        LIMIT 1`;
      return rows[0] ? rowToPlanV1(rows[0] as Record<string, unknown>) : null;
    },

    async findByIdempotency(input) {
      const rows = await sql`
        SELECT payload FROM b20_entry_plans
        WHERE tenant_id = ${input.tenantId}
          AND wallet_address = ${input.walletAddress.toLowerCase()}
          AND clearance_id = ${input.clearanceId}
          AND request_id = ${input.requestId}
        LIMIT 1`;
      return rows[0] ? rowToPlanV1(rows[0] as Record<string, unknown>) : null;
    },

    async getExecutionRun(input) {
      const rows = await sql`
        SELECT payload FROM b20_entry_executions
        WHERE prepared_plan_id = ${input.planId} AND tenant_id = ${input.tenantId}
        LIMIT 1`;
      return rows[0] ? rowToRunV1(rows[0] as Record<string, unknown>) : null;
    },
  };
}
