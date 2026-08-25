import type { SubmissionAttemptV1 } from '@mioagent/route-domain';

import {
  applySubmissionAttemptUpdateV1,
  assertSubmissionAttemptV1,
  newSubmissionAttemptV1,
  submissionAttemptBatchEffectV1,
  submissionAttemptConflictV1,
  submissionAttemptCreateEffectV1,
  submissionAttemptIsOpenV1,
  type BindSubmissionBatchInputV1,
  type CreateSubmissionAttemptInputV1,
  type SubmissionAttemptRepositoryV1,
  type UpdateSubmissionAttemptInputV1,
} from './submissionAttempts.js';

/**
 * The in-memory submission-attempt repository.
 *
 * Every refusal Postgres makes is made here too, through the same decision
 * functions and the same schema — including the two unique indexes, which are
 * emulated explicitly below rather than left to chance. A fake that accepts
 * what the database rejects hides exactly the bugs it exists to catch.
 */
export class InMemorySubmissionAttemptRepositoryV1 implements SubmissionAttemptRepositoryV1 {
  private readonly rows = new Map<string, SubmissionAttemptV1>();
  private readonly nextId: () => string;

  constructor(
    /** Injected so a test can produce stable ids; production passes a random
     * generator. Never derived from the blueprint: a terminal attempt frees the
     * blueprint for a genuinely new one, which must not reuse the old id. */
    nextId: () => string = () =>
      `submission-attempt:${Math.random().toString(16).slice(2)}`,
  ) {
    this.nextId = nextId;
  }

  private clone(value: SubmissionAttemptV1): SubmissionAttemptV1 {
    return structuredClone(value);
  }

  async createAttempt(input: CreateSubmissionAttemptInputV1): Promise<SubmissionAttemptV1> {
    const open = await this.findOpenAttemptByBlueprint(input.tenantId, input.blueprintId);
    const decision = submissionAttemptCreateEffectV1(open, input);
    if (decision.effect === 'conflict') throw submissionAttemptConflictV1(decision.reason);
    if (decision.effect === 'return_existing') return this.clone(open!);

    const attempt = newSubmissionAttemptV1(this.nextId(), input);
    this.rows.set(attempt.id, this.clone(attempt));
    return attempt;
  }

  async getAttempt(id: string, tenantId: string): Promise<SubmissionAttemptV1 | null> {
    const row = this.rows.get(id);
    // Tenant isolation is the lookup itself: another tenant's attempt is not
    // found, never found-and-refused, so its existence never leaks.
    if (!row || row.tenantId !== tenantId) return null;
    return this.clone(assertSubmissionAttemptV1(row, 'read'));
  }

  async findOpenAttemptByBlueprint(
    tenantId: string,
    blueprintId: string,
  ): Promise<SubmissionAttemptV1 | null> {
    const match = [...this.rows.values()].find(
      (row) =>
        row.tenantId === tenantId && row.blueprintId === blueprintId && submissionAttemptIsOpenV1(row),
    );
    return match ? this.clone(assertSubmissionAttemptV1(match, 'read')) : null;
  }

  async findAttemptByBatch(batchId: string): Promise<SubmissionAttemptV1 | null> {
    const match = [...this.rows.values()].find((row) => row.batchId === batchId);
    return match ? this.clone(assertSubmissionAttemptV1(match, 'read')) : null;
  }

  async bindBatch(input: BindSubmissionBatchInputV1): Promise<SubmissionAttemptV1 | null> {
    // A missing attempt and another tenant's attempt are the same answer here:
    // null, which the route turns into an indistinguishable 404.
    const existing = await this.getAttempt(input.attemptId, input.tenantId);
    if (!existing) return null;
    const decision = submissionAttemptBatchEffectV1(existing, input.batchId);
    if (decision.effect === 'conflict') throw submissionAttemptConflictV1(decision.reason);
    if (decision.effect === 'return_existing') return existing;

    // Mirrors the partial unique index on batch_id: one wallet batch belongs to
    // exactly one attempt, whoever asks.
    const owner = await this.findAttemptByBatch(input.batchId);
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
    this.rows.set(updated.id, this.clone(updated));
    return updated;
  }

  async updateAttempt(input: UpdateSubmissionAttemptInputV1): Promise<SubmissionAttemptV1 | null> {
    const existing = await this.getAttempt(input.attemptId, input.tenantId);
    if (!existing) return null;
    const updated = applySubmissionAttemptUpdateV1(existing, input);
    this.rows.set(updated.id, this.clone(updated));
    return updated;
  }

  async listRecoverable(tenantId: string, walletAddress: string): Promise<SubmissionAttemptV1[]> {
    const wallet = walletAddress.toLowerCase();
    return [...this.rows.values()]
      .filter(
        (row) => row.tenantId === tenantId && row.walletAddress === wallet && submissionAttemptIsOpenV1(row),
      )
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .map((row) => this.clone(assertSubmissionAttemptV1(row, 'read')));
  }
}
