import {
  assertEntryExecutionRunV1,
  assertPreparedPlanV1,
  entryPlanConflictV1,
  entryPlanIdempotencyKeyV1,
  entryPlanWriteRefusalV1,
  type B20EntryExecutionRunV1,
  type B20EntryPlanRepositoryV1,
  type B20PreparedEntryPlanV1,
} from './b20EntryPlans.js';

/**
 * The in-memory prepared-plan store.
 *
 * Same immutability, same idempotency identity and same conflict rule as
 * Postgres. Three production bugs in this codebase came from a fake that
 * accepted what the database refuses, so this file exists to behave
 * identically rather than conveniently.
 */
export class InMemoryB20EntryPlanRepositoryV1 implements B20EntryPlanRepositoryV1 {
  private readonly plans = new Map<string, B20PreparedEntryPlanV1>();
  private readonly runs = new Map<string, B20EntryExecutionRunV1>();
  /** idempotency identity → plan id, mirroring the unique index. */
  private readonly identities = new Map<string, string>();

  async insertPreparedPlan(input: {
    plan: B20PreparedEntryPlanV1;
    run: B20EntryExecutionRunV1;
  }): Promise<{ plan: B20PreparedEntryPlanV1; run: B20EntryExecutionRunV1 }> {
    const plan = assertPreparedPlanV1(input.plan, 'write');
    const run = assertEntryExecutionRunV1(input.run, 'write');
    const refusal = entryPlanWriteRefusalV1({ plan, run });
    if (refusal) throw entryPlanConflictV1(refusal);

    const identity = entryPlanIdempotencyKeyV1(plan);
    const existingId = this.identities.get(identity);
    if (existingId) {
      const existing = this.plans.get(existingId)!;
      // The blueprint hash covers every executable byte and every binding, so
      // a match is an ordinary retry. A mismatch is two different plans
      // claiming one idempotency identity, and neither silently wins.
      if (existing.blueprintHash !== plan.blueprintHash) {
        throw entryPlanConflictV1(
          'A different entry plan already exists for this request id',
        );
      }
      return { plan: existing, run: this.runs.get(existingId)! };
    }
    if (this.plans.has(plan.id)) {
      throw entryPlanConflictV1('A different entry plan already exists with this id');
    }

    this.plans.set(plan.id, plan);
    this.runs.set(plan.id, run);
    this.identities.set(identity, plan.id);
    return { plan, run };
  }

  async getPreparedPlan(input: {
    planId: string;
    tenantId: string;
    walletAddress: string;
  }): Promise<B20PreparedEntryPlanV1 | null> {
    const row = this.plans.get(input.planId);
    // A filter, not a check the caller is trusted to make. Another wallet gets
    // exactly what a nonexistent plan gets.
    if (
      !row ||
      row.tenantId !== input.tenantId ||
      row.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()
    ) {
      return null;
    }
    return assertPreparedPlanV1(row, 'read');
  }

  async findByIdempotency(input: {
    tenantId: string;
    walletAddress: string;
    clearanceId: string;
    requestId: string;
  }): Promise<B20PreparedEntryPlanV1 | null> {
    const planId = this.identities.get(entryPlanIdempotencyKeyV1(input));
    const row = planId ? this.plans.get(planId) : undefined;
    return row ? assertPreparedPlanV1(row, 'read') : null;
  }

  async getExecutionRun(input: {
    planId: string;
    tenantId: string;
  }): Promise<B20EntryExecutionRunV1 | null> {
    const row = this.runs.get(input.planId);
    if (!row || row.tenantId !== input.tenantId) return null;
    return assertEntryExecutionRunV1(row, 'read');
  }
}
