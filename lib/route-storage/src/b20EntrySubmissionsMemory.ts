import {
  assertEntryAttemptV1,
  attemptCreateEffectV1,
  attemptTransitionRefusalV1,
  entryAttemptConflictV1,
  type B20EntrySubmissionAttemptV1,
  type B20EntrySubmissionRepositoryV1,
} from './b20EntrySubmissions.js';

/**
 * The in-memory submission store.
 *
 * Same create rule, same transition rule, same tenant filtering as Postgres.
 * A fake that let two attempts exist for one plan would hide the failure this
 * whole file exists to prevent: two wallet batches, one plan, real money.
 */
export class InMemoryB20EntrySubmissionRepositoryV1 implements B20EntrySubmissionRepositoryV1 {
  private readonly rows = new Map<string, B20EntrySubmissionAttemptV1>();

  private latestFor(planId: string, tenantId: string): B20EntrySubmissionAttemptV1 | null {
    const forPlan = [...this.rows.values()]
      .filter((row) => row.planId === planId && row.tenantId === tenantId)
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id),
      );
    return forPlan[0] ?? null;
  }

  async createAttempt(attempt: B20EntrySubmissionAttemptV1): Promise<B20EntrySubmissionAttemptV1> {
    const next = assertEntryAttemptV1(attempt, 'write');
    const existing = this.latestFor(next.planId, next.tenantId);
    const effect = attemptCreateEffectV1({ existing, next });
    if (effect.effect === 'conflict') throw entryAttemptConflictV1(effect.reason);
    if (effect.effect === 'return_existing') return existing!;
    this.rows.set(next.id, next);
    return next;
  }

  async getAttempt(input: {
    attemptId: string;
    tenantId: string;
    walletAddress: string;
  }): Promise<B20EntrySubmissionAttemptV1 | null> {
    const row = this.rows.get(input.attemptId);
    // A filter, not a check the caller is trusted to make.
    if (
      !row ||
      row.tenantId !== input.tenantId ||
      row.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()
    ) {
      return null;
    }
    return assertEntryAttemptV1(row, 'read');
  }

  async latestForPlan(input: {
    planId: string;
    tenantId: string;
  }): Promise<B20EntrySubmissionAttemptV1 | null> {
    const row = this.latestFor(input.planId, input.tenantId);
    return row ? assertEntryAttemptV1(row, 'read') : null;
  }

  async findByBatch(batchId: string): Promise<B20EntrySubmissionAttemptV1 | null> {
    const row = [...this.rows.values()].find((candidate) => candidate.batchId === batchId);
    return row ? assertEntryAttemptV1(row, 'read') : null;
  }

  async updateAttempt(input: {
    attemptId: string;
    tenantId: string;
    status: B20EntrySubmissionAttemptV1['status'];
    terminalOutcome?: B20EntrySubmissionAttemptV1['terminalOutcome'];
    batchId?: string | null;
    errorCode?: string | null;
    reconciliation?: B20EntrySubmissionAttemptV1['reconciliation'];
    transactionHashes?: string[];
    receipts?: B20EntrySubmissionAttemptV1['receipts'];
    now: Date;
  }): Promise<B20EntrySubmissionAttemptV1 | null> {
    const from = this.rows.get(input.attemptId);
    if (!from || from.tenantId !== input.tenantId) return null;

    const terminalOutcome = input.terminalOutcome ?? null;
    const batchId = input.batchId ?? null;
    const refusal = attemptTransitionRefusalV1({ from, to: input.status, terminalOutcome, batchId });
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
    this.rows.set(next.id, next);
    return next;
  }
}
