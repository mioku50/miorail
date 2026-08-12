import {
  assertEntryAttemptV1,
  attemptCreateEffectV1,
  attemptTransitionRefusalV1,
  entryAttemptConflictV1,
  type B20EntrySubmissionAttemptV1,
  type B20EntrySubmissionRepositoryV1,
} from './b20EntrySubmissions.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed B20EntrySubmissionRepositoryV1.
//
// The document lives in `payload` and is re-parsed on read. The scalar columns
// exist to be queried and CONSTRAINED — in particular the partial unique index
// that makes "one live attempt per plan" a database guarantee rather than a
// promise this file makes.
// ---------------------------------------------------------------------------

function rowToAttemptV1(row: Record<string, unknown>): B20EntrySubmissionAttemptV1 {
  return assertEntryAttemptV1(row.payload, 'read');
}

export function createDatabaseB20EntrySubmissionRepository(
  sql: SqlTemplateExecutor,
): B20EntrySubmissionRepositoryV1 {
  const latestFor = async (
    planId: string,
    tenantId: string,
  ): Promise<B20EntrySubmissionAttemptV1 | null> => {
    const rows = await sql`
      SELECT payload FROM b20_entry_submissions
      WHERE plan_id = ${planId} AND tenant_id = ${tenantId}
      ORDER BY created_at DESC, id DESC
      LIMIT 1`;
    return rows[0] ? rowToAttemptV1(rows[0] as Record<string, unknown>) : null;
  };

  return {
    async createAttempt(attempt) {
      const next = assertEntryAttemptV1(attempt, 'write');
      const existing = await latestFor(next.planId, next.tenantId);
      const effect = attemptCreateEffectV1({ existing, next });
      if (effect.effect === 'conflict') throw entryAttemptConflictV1(effect.reason);
      if (effect.effect === 'return_existing') return existing!;

      const inserted = await sql`
        INSERT INTO b20_entry_submissions (
          id, tenant_id, wallet_address, chain_id, plan_id, clearance_id,
          submitted_calls_hash, batch_id, status, terminal_outcome, error_code,
          submitted_at, payload
        ) VALUES (
          ${next.id}, ${next.tenantId}, ${next.walletAddress}, ${next.chainId},
          ${next.planId}, ${next.clearanceId}, ${next.submittedCallsHash},
          ${next.batchId}, ${next.status}, ${next.terminalOutcome}, ${next.errorCode},
          ${next.submittedAt}, ${JSON.stringify(next)}::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING payload`;
      if (inserted.length > 0) return rowToAttemptV1(inserted[0] as Record<string, unknown>);

      // The partial unique index rejected it: something else already holds the
      // live attempt for this plan. Read it rather than guess, and never
      // overwrite — an overwrite here means a second wallet batch.
      const raced = await latestFor(next.planId, next.tenantId);
      if (!raced) throw entryAttemptConflictV1('The submission attempt could not be stored');
      if (raced.id === next.id) return raced;
      throw entryAttemptConflictV1('A submission for this plan is already in progress');
    },

    async getAttempt(input) {
      const rows = await sql`
        SELECT payload FROM b20_entry_submissions
        WHERE id = ${input.attemptId}
          AND tenant_id = ${input.tenantId}
          AND wallet_address = ${input.walletAddress.toLowerCase()}
        LIMIT 1`;
      return rows[0] ? rowToAttemptV1(rows[0] as Record<string, unknown>) : null;
    },

    async latestForPlan(input) {
      return latestFor(input.planId, input.tenantId);
    },

    async findByBatch(batchId) {
      const rows = await sql`
        SELECT payload FROM b20_entry_submissions WHERE batch_id = ${batchId} LIMIT 1`;
      return rows[0] ? rowToAttemptV1(rows[0] as Record<string, unknown>) : null;
    },

    async updateAttempt(input) {
      const rows = await sql`
        SELECT payload FROM b20_entry_submissions
        WHERE id = ${input.attemptId} AND tenant_id = ${input.tenantId} LIMIT 1`;
      if (!rows[0]) return null;
      const from = rowToAttemptV1(rows[0] as Record<string, unknown>);

      const terminalOutcome = input.terminalOutcome ?? null;
      const batchId = input.batchId ?? null;
      const refusal = attemptTransitionRefusalV1({
        from,
        to: input.status,
        terminalOutcome,
        batchId,
      });
      if (refusal) throw entryAttemptConflictV1(refusal);

      const next = assertEntryAttemptV1(
        {
          ...from,
          status: input.status,
          terminalOutcome,
          batchId: batchId ?? from.batchId,
          errorCode: input.errorCode ?? from.errorCode,
          submittedAt: batchId && !from.submittedAt ? input.now.toISOString() : from.submittedAt,
          transactionHashes: input.transactionHashes ?? from.transactionHashes,
          receipts: input.receipts ?? from.receipts,
          reconciliation: input.reconciliation ?? from.reconciliation,
          updatedAt: input.now.toISOString(),
        },
        'write',
      );

      // Guarded by the state we read, so two concurrent reconciliations cannot
      // both win. A losing writer sees zero rows and re-reads.
      const updated = await sql`
        UPDATE b20_entry_submissions SET
          status = ${next.status},
          terminal_outcome = ${next.terminalOutcome},
          batch_id = ${next.batchId},
          error_code = ${next.errorCode},
          submitted_at = ${next.submittedAt},
          payload = ${JSON.stringify(next)}::jsonb,
          updated_at = ${input.now.toISOString()}
        WHERE id = ${next.id} AND tenant_id = ${next.tenantId} AND status = ${from.status}
        RETURNING payload`;
      if (updated.length === 0) {
        throw entryAttemptConflictV1('The attempt changed while this update was being applied');
      }
      return rowToAttemptV1(updated[0] as Record<string, unknown>);
    },
  };
}
