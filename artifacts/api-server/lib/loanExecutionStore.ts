import crypto from 'node:crypto';
import { ExecutionCallV1Schema, hashApprovedCallsV1, type HashV1 } from '@mioagent/route-domain';
import type { LendingRunV1 } from './lendingReview.js';

type ReadyRunV1 = Extract<LendingRunV1, { state: 'ready' }>;
export interface LoanOwnerV1 { tenantId: string; walletAddress: string }
export type LoanExecutionStateV1 = 'ready' | 'awaiting_wallet' | 'submitted' | 'unknown' | 'confirmed' | 'failed';
export interface LoanExecutionV1 extends LoanOwnerV1 {
  executionId: string;
  draftId: string;
  state: LoanExecutionStateV1;
  run: ReadyRunV1;
  attemptId: string | null;
  batchId: string | null;
  transactionHash: HashV1 | null;
  verification: Record<string, unknown> | null;
  errorCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface LoanExecutionStoreV1 {
  putReady(input: { owner: LoanOwnerV1; draftId: string; run: ReadyRunV1; now: Date }): Promise<LoanExecutionV1>;
  get(input: { owner: LoanOwnerV1; executionId: string }): Promise<LoanExecutionV1 | null>;
  getByDraft(input: { owner: LoanOwnerV1; draftId: string }): Promise<LoanExecutionV1 | null>;
  arm(input: { owner: LoanOwnerV1; executionId: string; callsHash: string; signingTermsHash: string; now: Date }): Promise<
    { ok: true; execution: LoanExecutionV1; attemptId: string } | { ok: false; refusal: 'execution_not_ready' | 'execution_active' }>;
  recordSubmission(input: { owner: LoanOwnerV1; executionId: string; attemptId: string; outcome: 'submitted' | 'unknown' | 'rejected'; batchId?: string | null; now: Date }): Promise<LoanExecutionV1 | null>;
  recordVerification(input: { owner: LoanOwnerV1; executionId: string; expectedVersion: number; state: 'confirmed' | 'failed' | 'unknown'; transactionHash: HashV1 | null;
    proof: Record<string, unknown> | null; errorCode: string | null; now: Date }): Promise<LoanExecutionV1 | null>;
}

type SqlV1 = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
const active = (state: LoanExecutionStateV1) => ['awaiting_wallet', 'submitted', 'unknown'].includes(state);
const validId = (value: string) => /^[A-Za-z0-9:_.-]{1,200}$/.test(value);
function assertOwner(owner: LoanOwnerV1): void {
  if (!/^0x[0-9a-f]{40}$/.test(owner.walletAddress) || owner.tenantId !== `eip155:8453:${owner.walletAddress}`) throw new Error('loan_execution_owner_invalid');
}
function assertReady(input: { owner: LoanOwnerV1; draftId: string; run: ReadyRunV1; now: Date }): void {
  assertOwner(input.owner);
  const { run } = input;
  if (!validId(input.draftId) || run.state !== 'ready' || run.atomicRequired !== true || !['morpho', 'aave-v4'].includes(run.facts.venue) ||
      !['borrow', 'repay'].includes(run.facts.operation) || !validId(run.facts.marketId) || run.calls.length === 0 || run.calls.length > 16 ||
      run.calls.some((call, index) => !ExecutionCallV1Schema.safeParse(call).success || call.index !== index) ||
      run.callsHash !== hashApprovedCallsV1(run.calls) || !Number.isFinite(Date.parse(run.expiresAt)) || Date.parse(run.expiresAt) <= input.now.getTime() ||
      !/^0x[0-9a-f]{64}$/.test(run.signingTermsHash) ||
      JSON.stringify(run).length > 512_000) throw new Error('loan_execution_ready_invalid');
}
const sameOwner = (row: LoanExecutionV1, owner: LoanOwnerV1) => row.tenantId === owner.tenantId && row.walletAddress === owner.walletAddress;
const sameQuestion = (row: LoanExecutionV1, run: ReadyRunV1) => {
  const a = row.run.facts, b = run.facts;
  return a.venue === b.venue && a.operation === b.operation && a.marketId === b.marketId &&
    a.collateralTokenAddress.toLowerCase() === b.collateralTokenAddress.toLowerCase() && a.amountMode === b.amountMode &&
    a.requestedAssets === b.requestedAssets && a.maximumDebitAssets === b.maximumDebitAssets && a.collateralSupplyAssets === b.collateralSupplyAssets &&
    (a.nativeFunding?.maximumNativeAssets ?? null) === (b.nativeFunding?.maximumNativeAssets ?? null);
};
const sameScope = (a: LoanExecutionV1, b: LoanExecutionV1) => a.tenantId === b.tenantId && a.walletAddress === b.walletAddress &&
  a.run.facts.venue === b.run.facts.venue && (a.run.facts.venue === 'aave-v4' || a.run.facts.marketId === b.run.facts.marketId);
const copy = <T>(value: T): T => structuredClone(value);

/** Atomic in one JS turn, used by isolated tests. Production uses PostgreSQL's
 * compare-and-set plus partial unique index, never this process-local store. */
export class MemoryLoanExecutionStoreV1 implements LoanExecutionStoreV1 {
  private rows = new Map<string, LoanExecutionV1>();
  async putReady(input: { owner: LoanOwnerV1; draftId: string; run: ReadyRunV1; now: Date }): Promise<LoanExecutionV1> {
    assertReady(input);
    const existing = [...this.rows.values()].find(row => sameOwner(row, input.owner) && row.draftId === input.draftId);
    if (existing) {
      if (!sameQuestion(existing, input.run)) throw new Error('loan_execution_question_changed');
      if (existing.state === 'ready') { existing.run = copy(input.run); existing.updatedAt = input.now.toISOString(); existing.version++; }
      return copy(existing);
    }
    const row: LoanExecutionV1 = { ...input.owner, executionId: crypto.randomUUID(), draftId: input.draftId, state: 'ready', run: copy(input.run),
      attemptId: null, batchId: null, transactionHash: null, verification: null, errorCode: null, version: 0,
      createdAt: input.now.toISOString(), updatedAt: input.now.toISOString() };
    this.rows.set(row.executionId, row); return copy(row);
  }
  async get(input: { owner: LoanOwnerV1; executionId: string }): Promise<LoanExecutionV1 | null> {
    assertOwner(input.owner); const row = this.rows.get(input.executionId);
    return row && sameOwner(row, input.owner) ? copy(row) : null;
  }
  async getByDraft(input: { owner: LoanOwnerV1; draftId: string }): Promise<LoanExecutionV1 | null> {
    assertOwner(input.owner);
    const row = [...this.rows.values()].find(row => sameOwner(row, input.owner) && row.draftId === input.draftId);
    return row ? copy(row) : null;
  }
  async arm(input: { owner: LoanOwnerV1; executionId: string; callsHash: string; signingTermsHash: string; now: Date }): ReturnType<LoanExecutionStoreV1['arm']> {
    assertOwner(input.owner); const row = this.rows.get(input.executionId);
    if (!row || !sameOwner(row, input.owner) || row.state !== 'ready' || row.run.callsHash !== input.callsHash || row.run.signingTermsHash !== input.signingTermsHash || Date.parse(row.run.expiresAt) <= input.now.getTime()) return { ok: false, refusal: 'execution_not_ready' };
    if ([...this.rows.values()].some(other => other.executionId !== row.executionId && sameScope(other, row) && active(other.state))) return { ok: false, refusal: 'execution_active' };
    row.state = 'awaiting_wallet'; row.attemptId = crypto.randomUUID(); row.updatedAt = input.now.toISOString(); row.version++;
    return { ok: true, execution: copy(row), attemptId: row.attemptId };
  }
  async recordSubmission(input: Parameters<LoanExecutionStoreV1['recordSubmission']>[0]): Promise<LoanExecutionV1 | null> {
    assertOwner(input.owner); validateSubmission(input); const row = this.rows.get(input.executionId);
    if (!row || !sameOwner(row, input.owner) || row.attemptId !== input.attemptId || !active(row.state)) return null;
    if (input.outcome === 'rejected') {
      if (row.state !== 'awaiting_wallet') return null;
      row.state = 'ready'; row.attemptId = null; row.errorCode = null;
    } else {
      // A late unknown cannot erase an already recorded batch. Conflicting
      // batch hints remain unknown rather than selecting a winner.
      if (row.errorCode === 'conflicting_batch_hints' || (row.batchId && input.batchId && row.batchId !== input.batchId)) { row.state = 'unknown'; row.errorCode = 'conflicting_batch_hints'; }
      else { row.batchId ??= input.batchId ?? null; row.state = row.batchId ? 'submitted' : 'unknown'; }
    }
    row.updatedAt = input.now.toISOString(); row.version++; return copy(row);
  }
  async recordVerification(input: Parameters<LoanExecutionStoreV1['recordVerification']>[0]): Promise<LoanExecutionV1 | null> {
    assertOwner(input.owner); validateVerification(input); const row = this.rows.get(input.executionId);
    if (!row || !sameOwner(row, input.owner) || row.version !== input.expectedVersion || row.state === 'ready') return null;
    // A final result may be downgraded if a fresh chain read contradicts it.
    // Retain the scope lock on unknown, including after a suspected reorg.
    if (input.state === 'unknown' && [...this.rows.values()].some(other => other.executionId !== row.executionId && sameScope(other, row) && active(other.state))) return null;
    row.state = input.state; row.transactionHash = input.transactionHash; row.verification = copy(input.proof); row.errorCode = input.errorCode;
    row.updatedAt = input.now.toISOString(); row.version++; return copy(row);
  }
}

function validateSubmission(input: Parameters<LoanExecutionStoreV1['recordSubmission']>[0]): void {
  if (!validId(input.attemptId) || !['submitted', 'unknown', 'rejected'].includes(input.outcome) ||
      (input.outcome === 'submitted' && !input.batchId) ||
      (input.batchId != null && (typeof input.batchId !== 'string' || input.batchId.length < 1 || input.batchId.length > 2000))) throw new Error('loan_execution_submission_invalid');
}
function validateVerification(input: Parameters<LoanExecutionStoreV1['recordVerification']>[0]): void {
  if (!['confirmed', 'failed', 'unknown'].includes(input.state) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
      (input.transactionHash !== null && !/^0x[0-9a-f]{64}$/.test(input.transactionHash)) ||
      (input.state !== 'unknown' && (input.transactionHash === null || input.proof === null))) throw new Error('loan_execution_verification_invalid');
}
function rowFromDb(row: Record<string, unknown>): LoanExecutionV1 {
  return { executionId: String(row.execution_id), tenantId: String(row.tenant_id), walletAddress: String(row.wallet_address), draftId: String(row.draft_id),
    state: row.state as LoanExecutionStateV1, run: (typeof row.run_json === 'string' ? JSON.parse(row.run_json) : row.run_json) as ReadyRunV1,
    attemptId: row.attempt_id == null ? null : String(row.attempt_id), batchId: row.batch_id == null ? null : String(row.batch_id),
    transactionHash: row.transaction_hash == null ? null : String(row.transaction_hash) as HashV1,
    verification: row.verification_json == null ? null : (typeof row.verification_json === 'string' ? JSON.parse(row.verification_json) : row.verification_json) as Record<string, unknown>,
    errorCode: row.error_code == null ? null : String(row.error_code), version: Number(row.version),
    createdAt: new Date(row.created_at as string | Date).toISOString(), updatedAt: new Date(row.updated_at as string | Date).toISOString() };
}
function uniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

export function createDatabaseLoanExecutionStoreV1(sql: SqlV1): LoanExecutionStoreV1 {
  return {
    async putReady(input) {
      assertReady(input); const { owner, run } = input; const at = input.now.toISOString();
      const rows = await sql`INSERT INTO lending_executions
        (execution_id, tenant_id, wallet_address, draft_id, venue, operation, market_id, calls_hash, run_json, state, created_at, updated_at, expires_at)
        VALUES (${crypto.randomUUID()}, ${owner.tenantId}, ${owner.walletAddress}, ${input.draftId}, ${run.facts.venue}, ${run.facts.operation},
          ${run.facts.marketId}, ${run.callsHash}, ${JSON.stringify(run)}::text::jsonb, 'ready', ${at}::timestamptz, ${at}::timestamptz, ${run.expiresAt}::timestamptz)
        ON CONFLICT (tenant_id, wallet_address, draft_id) DO UPDATE
          SET run_json = EXCLUDED.run_json, calls_hash = EXCLUDED.calls_hash, expires_at = EXCLUDED.expires_at,
              updated_at = EXCLUDED.updated_at, version = lending_executions.version + 1
          WHERE lending_executions.state = 'ready' AND lending_executions.venue = EXCLUDED.venue
            AND lending_executions.operation = EXCLUDED.operation AND lending_executions.market_id = EXCLUDED.market_id
            AND LOWER(lending_executions.run_json->'facts'->>'collateralTokenAddress') = LOWER(EXCLUDED.run_json->'facts'->>'collateralTokenAddress')
            AND lending_executions.run_json->'facts'->>'amountMode' = EXCLUDED.run_json->'facts'->>'amountMode'
            AND lending_executions.run_json->'facts'->'requestedAssets' = EXCLUDED.run_json->'facts'->'requestedAssets'
            AND lending_executions.run_json->'facts'->>'maximumDebitAssets' = EXCLUDED.run_json->'facts'->>'maximumDebitAssets'
            AND lending_executions.run_json->'facts'->>'collateralSupplyAssets' = EXCLUDED.run_json->'facts'->>'collateralSupplyAssets'
            AND COALESCE(lending_executions.run_json->'facts'->'nativeFunding'->>'maximumNativeAssets', '') = COALESCE(EXCLUDED.run_json->'facts'->'nativeFunding'->>'maximumNativeAssets', '')
        RETURNING *`;
      if (rows[0]) return rowFromDb(rows[0]);
      const prior = await sql`SELECT * FROM lending_executions WHERE tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress} AND draft_id = ${input.draftId}`;
      if (!prior[0] || !sameQuestion(rowFromDb(prior[0]), run)) throw new Error('loan_execution_question_changed');
      return rowFromDb(prior[0]);
    },
    async get({ owner, executionId }) {
      assertOwner(owner); const rows = await sql`SELECT * FROM lending_executions WHERE execution_id = ${executionId} AND tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}`;
      return rows[0] ? rowFromDb(rows[0]) : null;
    },
    async getByDraft({ owner, draftId }) {
      assertOwner(owner); const rows = await sql`SELECT * FROM lending_executions WHERE draft_id = ${draftId} AND tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}`;
      return rows[0] ? rowFromDb(rows[0]) : null;
    },
    async arm({ owner, executionId, callsHash, signingTermsHash, now }) {
      assertOwner(owner); const attemptId = crypto.randomUUID();
      try {
        const rows = await sql`UPDATE lending_executions SET state = 'awaiting_wallet', attempt_id = ${attemptId}, updated_at = ${now.toISOString()}::timestamptz, version = version + 1
          WHERE execution_id = ${executionId} AND tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}
            AND state = 'ready' AND calls_hash = ${callsHash} AND run_json->>'signingTermsHash' = ${signingTermsHash}
            AND expires_at > ${now.toISOString()}::timestamptz RETURNING *`;
        return rows[0] ? { ok: true, execution: rowFromDb(rows[0]), attemptId } : { ok: false, refusal: 'execution_not_ready' };
      } catch (error) { if (uniqueConflict(error)) return { ok: false, refusal: 'execution_active' }; throw error; }
    },
    async recordSubmission(input) {
      assertOwner(input.owner); validateSubmission(input); const { owner } = input; const at = input.now.toISOString();
      const rows = input.outcome === 'rejected'
        ? await sql`UPDATE lending_executions SET state = 'ready', attempt_id = NULL, error_code = NULL, updated_at = ${at}::timestamptz, version = version + 1
          WHERE execution_id = ${input.executionId} AND tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}
            AND attempt_id = ${input.attemptId} AND state = 'awaiting_wallet' RETURNING *`
        : await sql`UPDATE lending_executions SET
          state = CASE WHEN error_code = 'conflicting_batch_hints' OR (batch_id IS NOT NULL AND ${input.batchId ?? null}::text IS NOT NULL AND batch_id <> ${input.batchId ?? null}::text) THEN 'unknown'
            WHEN COALESCE(batch_id, ${input.batchId ?? null}::text) IS NULL THEN 'unknown' ELSE 'submitted' END,
          error_code = CASE WHEN batch_id IS NOT NULL AND ${input.batchId ?? null}::text IS NOT NULL AND batch_id <> ${input.batchId ?? null}::text
            THEN 'conflicting_batch_hints' ELSE error_code END,
          batch_id = COALESCE(batch_id, ${input.batchId ?? null}::text), updated_at = ${at}::timestamptz, version = version + 1
          WHERE execution_id = ${input.executionId} AND tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}
            AND attempt_id = ${input.attemptId} AND state IN ('awaiting_wallet', 'submitted', 'unknown') RETURNING *`;
      return rows[0] ? rowFromDb(rows[0]) : null;
    },
    async recordVerification(input) {
      assertOwner(input.owner); validateVerification(input); const { owner } = input;
      try {
        const rows = await sql`UPDATE lending_executions SET state = ${input.state}, transaction_hash = ${input.transactionHash},
          verification_json = ${input.proof === null ? null : JSON.stringify(input.proof)}::text::jsonb, error_code = ${input.errorCode},
          updated_at = ${input.now.toISOString()}::timestamptz, version = version + 1
          WHERE execution_id = ${input.executionId} AND tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}
            AND version = ${input.expectedVersion} AND state <> 'ready' RETURNING *`;
        return rows[0] ? rowFromDb(rows[0]) : null;
      } catch (error) { if (uniqueConflict(error)) return null; throw error; }
    },
  };
}

let runtimeStore: LoanExecutionStoreV1 | null = null;
export const loanExecutionRuntimeV1 = {
  async store(): Promise<LoanExecutionStoreV1> {
    if (!runtimeStore) { const { client } = await import('@mioagent/db'); runtimeStore = createDatabaseLoanExecutionStoreV1(client); }
    return runtimeStore;
  },
};
