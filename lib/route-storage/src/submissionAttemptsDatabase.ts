import {
  RECOVERABLE_ATTEMPT_STATUSES_V1,
  type SubmissionAttemptV1,
} from '@mioagent/route-domain';

import {
  applySubmissionAttemptUpdateV1,
  assertSubmissionAttemptV1,
  newSubmissionAttemptV1,
  submissionAttemptBatchEffectV1,
  submissionAttemptConflictV1,
  submissionAttemptCreateEffectV1,
  type BindSubmissionBatchInputV1,
  type CreateSubmissionAttemptInputV1,
  type SubmissionAttemptRepositoryV1,
  type UpdateSubmissionAttemptInputV1,
} from './submissionAttempts.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed SubmissionAttemptRepositoryV1.
//
// Two invariants are the DATABASE'S, not this file's:
//
//   * `submission_attempts_batch_unique` — one wallet batch, one attempt. The
//     insert below can lose a race and the unique index is what decides it,
//     so two tabs binding the same batch cannot end up with two owners.
//   * `submission_attempts_active_unique` — one open attempt per blueprint.
//
// Both are partial indexes, so a terminal attempt frees the blueprint and a
// revoked handle stops competing. Where a write can lose such a race, the code
// re-reads and asks the shared decision function again rather than assuming.
// ---------------------------------------------------------------------------

// The SQL predicate and the schema's notion of "still open" are the SAME list.
// Two copies would drift, and the drift would show up as an attempt that the
// UI offers to resume and the query never returns.
const OPEN_STATUSES_V1 = [...RECOVERABLE_ATTEMPT_STATUSES_V1];

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function rowToAttemptV1(row: Record<string, unknown>): SubmissionAttemptV1 {
  return assertSubmissionAttemptV1(
    {
      schemaVersion: 'submission-attempt/v1',
      id: String(row.id),
      tenantId: String(row.user_id),
      walletAddress: String(row.wallet_address),
      chainId: Number(row.chain_id),
      goal: String(row.goal),
      routeRunId: String(row.route_run_id),
      blueprintId: String(row.blueprint_id),
      proofId: row.proof_id === null ? null : String(row.proof_id),
      approvedCallsHash: String(row.approved_calls_hash),
      batchId: row.batch_id === null ? null : String(row.batch_id),
      status: String(row.status),
      errorCode: row.error_code === null ? null : String(row.error_code),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      completedAt: row.completed_at === null ? null : iso(row.completed_at),
    },
    'read',
  );
}

export function createDatabaseSubmissionAttemptRepository(
  sql: SqlTemplateExecutor,
  options: { newId?: () => string } = {},
): SubmissionAttemptRepositoryV1 {
  const newId = options.newId ?? (() => `submission-attempt:${crypto.randomUUID().replace(/-/g, '')}`);

  async function readOne(rows: Record<string, unknown>[]): Promise<SubmissionAttemptV1 | null> {
    const row = rows[0];
    return row ? rowToAttemptV1(row) : null;
  }

  const repository: SubmissionAttemptRepositoryV1 = {
    async createAttempt(input: CreateSubmissionAttemptInputV1): Promise<SubmissionAttemptV1> {
      const open = await repository.findOpenAttemptByBlueprint(input.tenantId, input.blueprintId);
      const decision = submissionAttemptCreateEffectV1(open, input);
      if (decision.effect === 'conflict') throw submissionAttemptConflictV1(decision.reason);
      if (decision.effect === 'return_existing') return open!;

      const attempt = newSubmissionAttemptV1(newId(), input);
      const inserted = await sql`
        INSERT INTO submission_attempts (
          id, user_id, wallet_address, chain_id, goal, route_run_id, blueprint_id,
          proof_id, approved_calls_hash, batch_id, status, error_code,
          created_at, updated_at, completed_at
        ) VALUES (
          ${attempt.id}, ${attempt.tenantId}, ${attempt.walletAddress}, ${attempt.chainId},
          ${attempt.goal}, ${attempt.routeRunId}, ${attempt.blueprintId}, ${attempt.proofId},
          ${attempt.approvedCallsHash}, ${attempt.batchId}, ${attempt.status}, ${attempt.errorCode},
          ${attempt.createdAt}, ${attempt.updatedAt}, ${attempt.completedAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, user_id, wallet_address, chain_id, goal, route_run_id, blueprint_id,
          proof_id, approved_calls_hash, batch_id, status, error_code,
          created_at, updated_at, completed_at`;

      if (inserted.length === 0) {
        // The active-unique index refused it: another request opened an attempt
        // for this blueprint between the read above and this insert. Re-read and
        // let the same decision function judge the winner.
        const raced = await repository.findOpenAttemptByBlueprint(input.tenantId, input.blueprintId);
        if (!raced) throw submissionAttemptConflictV1('The submission attempt could not be stored');
        const recheck = submissionAttemptCreateEffectV1(raced, input);
        if (recheck.effect !== 'return_existing') {
          throw submissionAttemptConflictV1(
            recheck.effect === 'conflict' ? recheck.reason : 'The submission attempt could not be stored',
          );
        }
        return raced;
      }
      return rowToAttemptV1(inserted[0] as Record<string, unknown>);
    },

    async getAttempt(id: string, tenantId: string): Promise<SubmissionAttemptV1 | null> {
      // The tenant is part of the WHERE clause, so another tenant's attempt is
      // simply not selected rather than selected and then refused.
      const rows = await sql`
        SELECT id, user_id, wallet_address, chain_id, goal, route_run_id, blueprint_id,
          proof_id, approved_calls_hash, batch_id, status, error_code,
          created_at, updated_at, completed_at
        FROM submission_attempts WHERE id = ${id} AND user_id = ${tenantId} LIMIT 1`;
      return readOne(rows as Record<string, unknown>[]);
    },

    async findOpenAttemptByBlueprint(tenantId, blueprintId): Promise<SubmissionAttemptV1 | null> {
      const rows = await sql`
        SELECT id, user_id, wallet_address, chain_id, goal, route_run_id, blueprint_id,
          proof_id, approved_calls_hash, batch_id, status, error_code,
          created_at, updated_at, completed_at
        FROM submission_attempts
        WHERE user_id = ${tenantId} AND blueprint_id = ${blueprintId}
          AND status = ANY(${OPEN_STATUSES_V1})
        ORDER BY updated_at DESC LIMIT 1`;
      return readOne(rows as Record<string, unknown>[]);
    },

    async findAttemptByBatch(batchId: string): Promise<SubmissionAttemptV1 | null> {
      // Deliberately NOT tenant-scoped: this answers "is this batch already
      // claimed by anyone?", which is what the unique index enforces.
      const rows = await sql`
        SELECT id, user_id, wallet_address, chain_id, goal, route_run_id, blueprint_id,
          proof_id, approved_calls_hash, batch_id, status, error_code,
          created_at, updated_at, completed_at
        FROM submission_attempts WHERE batch_id = ${batchId} LIMIT 1`;
      return readOne(rows as Record<string, unknown>[]);
    },

    async bindBatch(input: BindSubmissionBatchInputV1): Promise<SubmissionAttemptV1 | null> {
      const existing = await repository.getAttempt(input.attemptId, input.tenantId);
      if (!existing) return null;
      const decision = submissionAttemptBatchEffectV1(existing, input.batchId);
      if (decision.effect === 'conflict') throw submissionAttemptConflictV1(decision.reason);
      if (decision.effect === 'return_existing') return existing;

      const owner = await repository.findAttemptByBatch(input.batchId);
      if (owner && owner.id !== existing.id) {
        throw submissionAttemptConflictV1('That wallet batch is already bound to another attempt');
      }

      const updated = applySubmissionAttemptUpdateV1(existing, {
        attemptId: existing.id,
        tenantId: input.tenantId,
        status: existing.status === 'wallet_pending' ? 'batch_observed' : existing.status,
        batchId: input.batchId,
        now: input.now,
      });
      // The `batch_id IS NULL` predicate makes this a compare-and-set: a
      // concurrent bind of a different batch updates zero rows instead of
      // overwriting the one that got there first.
      const rows = await sql`
        UPDATE submission_attempts
        SET batch_id = ${updated.batchId}, status = ${updated.status}, updated_at = ${updated.updatedAt}
        WHERE id = ${existing.id} AND user_id = ${input.tenantId} AND batch_id IS NULL
        RETURNING id, user_id, wallet_address, chain_id, goal, route_run_id, blueprint_id,
          proof_id, approved_calls_hash, batch_id, status, error_code,
          created_at, updated_at, completed_at`;
      if (rows.length === 0) {
        const raced = await repository.getAttempt(input.attemptId, input.tenantId);
        if (raced && raced.batchId === input.batchId) return raced;
        throw submissionAttemptConflictV1('This attempt is already bound to a different wallet batch');
      }
      return rowToAttemptV1(rows[0] as Record<string, unknown>);
    },

    async updateAttempt(input: UpdateSubmissionAttemptInputV1): Promise<SubmissionAttemptV1 | null> {
      const existing = await repository.getAttempt(input.attemptId, input.tenantId);
      if (!existing) return null;
      const updated = applySubmissionAttemptUpdateV1(existing, input);
      const rows = await sql`
        UPDATE submission_attempts
        SET status = ${updated.status}, proof_id = ${updated.proofId},
          error_code = ${updated.errorCode}, batch_id = ${updated.batchId},
          updated_at = ${updated.updatedAt}, completed_at = ${updated.completedAt}
        WHERE id = ${existing.id} AND user_id = ${input.tenantId}
        RETURNING id, user_id, wallet_address, chain_id, goal, route_run_id, blueprint_id,
          proof_id, approved_calls_hash, batch_id, status, error_code,
          created_at, updated_at, completed_at`;
      return readOne(rows as Record<string, unknown>[]);
    },

    async listRecoverable(tenantId: string, walletAddress: string): Promise<SubmissionAttemptV1[]> {
      const rows = await sql`
        SELECT id, user_id, wallet_address, chain_id, goal, route_run_id, blueprint_id,
          proof_id, approved_calls_hash, batch_id, status, error_code,
          created_at, updated_at, completed_at
        FROM submission_attempts
        WHERE user_id = ${tenantId} AND wallet_address = ${walletAddress.toLowerCase()}
          AND status = ANY(${OPEN_STATUSES_V1})
        ORDER BY updated_at DESC LIMIT 20`;
      return (rows as Record<string, unknown>[]).map(rowToAttemptV1);
    },
  };

  return repository;
}
