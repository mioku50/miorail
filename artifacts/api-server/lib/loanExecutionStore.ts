import crypto from 'node:crypto';
import { ExecutionCallV1Schema, hashApprovedCallsV1, type HashV1 } from '@mioagent/route-domain';
import type { LendingRunV1 } from './lendingReview.js';
import { LOAN_STEPS_STOPPED_V1, sequentialBatchIdV1, sequentialHashesV1 } from './lendingSteps.js';

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
  /** Every loan of this owner that pays one Bitrefill invoice (Still Spend). */
  listByPaymentOrder(input: { owner: LoanOwnerV1; orderId: string }): Promise<LoanExecutionV1[]>;
  /** The other attempts holding this execution's market (Aave: its whole spoke). */
  listActiveInScope(input: { owner: LoanOwnerV1; executionId: string }): Promise<LoanExecutionV1[]>;
  arm(input: { owner: LoanOwnerV1; executionId: string; callsHash: string; signingTermsHash: string; now: Date }): Promise<
    { ok: true; execution: LoanExecutionV1; attemptId: string } | { ok: false; refusal: 'execution_not_ready' | 'execution_active' | 'invoice_has_attempt' }>;
  /** `stopped`: the steps in `batchId` landed and the rest was never sent (declined in the wallet, or refused
   * before it was asked), so what landed decides the result. */
  recordSubmission(input: { owner: LoanOwnerV1; executionId: string; attemptId: string; outcome: 'submitted' | 'unknown' | 'rejected' | 'stopped'; batchId?: string | null; now: Date }): Promise<LoanExecutionV1 | null>;
  recordVerification(input: { owner: LoanOwnerV1; executionId: string; expectedVersion: number; state: 'confirmed' | 'failed' | 'unknown'; transactionHash: HashV1 | null;
    proof: Record<string, unknown> | null; errorCode: string | null; now: Date }): Promise<LoanExecutionV1 | null>;
  /** A loan in steps: step `index` landed as `transactionHash`. The hashes so
   * far are kept as one viem fallback batch id; the last step submits it, and
   * `stop` submits what landed when the rest will not be sent. */
  recordStep(input: { owner: LoanOwnerV1; executionId: string; attemptId: string; index: number; transactionHash: HashV1; stop?: boolean; now: Date }): Promise<LoanExecutionV1 | null>;
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
  // One batch, or steps only where they were granted: an Aave V4 action without
  // native ETH; a Spend payment goes as its last step.
  const delivery = run.atomicRequired === true ? run.delivery === undefined
    : run.atomicRequired === false && run.delivery === 'sequential' && run.facts.venue === 'aave-v4' && !run.facts.nativeFunding &&
      (!run.facts.payment || run.calls.at(-1)?.callType === 'transfer');
  if (!validId(input.draftId) || run.state !== 'ready' || !delivery || !['morpho', 'aave-v4'].includes(run.facts.venue) ||
      !['borrow', 'repay'].includes(run.facts.operation) || !validId(run.facts.marketId) || run.calls.length === 0 || run.calls.length > 16 ||
      run.calls.some((call, index) => !ExecutionCallV1Schema.safeParse(call).success || call.index !== index) ||
      run.callsHash !== hashApprovedCallsV1(run.calls) || !Number.isFinite(Date.parse(run.expiresAt)) || Date.parse(run.expiresAt) <= input.now.getTime() ||
      !/^0x[0-9a-f]{64}$/.test(run.signingTermsHash) ||
      JSON.stringify(run).length > 512_000) throw new Error('loan_execution_ready_invalid');
}
const sameOwner = (row: LoanExecutionV1, owner: LoanOwnerV1) => row.tenantId === owner.tenantId && row.walletAddress === owner.walletAddress;
const invoiceOf = (row: LoanExecutionV1) => row.run.facts.payment?.orderId ?? null;
const sameQuestion = (row: LoanExecutionV1, run: ReadyRunV1) => {
  const a = row.run.facts, b = run.facts;
  return a.venue === b.venue && a.operation === b.operation && a.marketId === b.marketId &&
    a.collateralTokenAddress.toLowerCase() === b.collateralTokenAddress.toLowerCase() && a.amountMode === b.amountMode &&
    a.requestedAssets === b.requestedAssets && a.maximumDebitAssets === b.maximumDebitAssets && a.collateralSupplyAssets === b.collateralSupplyAssets &&
    (a.nativeFunding?.maximumNativeAssets ?? null) === (b.nativeFunding?.maximumNativeAssets ?? null) &&
    (a.payment?.orderId ?? null) === (b.payment?.orderId ?? null) && (a.payment?.payTo ?? null) === (b.payment?.payTo ?? null) &&
    (a.payment?.assets ?? null) === (b.payment?.assets ?? null);
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
  async listByPaymentOrder(input: { owner: LoanOwnerV1; orderId: string }): Promise<LoanExecutionV1[]> {
    assertOwner(input.owner);
    return [...this.rows.values()].filter(row => sameOwner(row, input.owner) && row.run.facts.payment?.orderId === input.orderId).map(copy);
  }
  async listActiveInScope(input: { owner: LoanOwnerV1; executionId: string }): Promise<LoanExecutionV1[]> {
    assertOwner(input.owner); const row = this.rows.get(input.executionId);
    if (!row || !sameOwner(row, input.owner)) return [];
    return [...this.rows.values()].filter(other => other.executionId !== row.executionId && sameScope(other, row) && active(other.state)).map(copy);
  }
  async arm(input: { owner: LoanOwnerV1; executionId: string; callsHash: string; signingTermsHash: string; now: Date }): ReturnType<LoanExecutionStoreV1['arm']> {
    assertOwner(input.owner); const row = this.rows.get(input.executionId);
    if (!row || !sameOwner(row, input.owner) || row.state !== 'ready' || row.run.callsHash !== input.callsHash || row.run.signingTermsHash !== input.signingTermsHash || Date.parse(row.run.expiresAt) <= input.now.getTime()) return { ok: false, refusal: 'execution_not_ready' };
    // One invoice is paid once, whichever market a review of it chose (index lending_execution_one_invoice).
    const invoice = invoiceOf(row);
    if (invoice && [...this.rows.values()].some(other => other.executionId !== row.executionId && sameOwner(other, input.owner) && invoiceOf(other) === invoice && other.state !== 'ready')) return { ok: false, refusal: 'invoice_has_attempt' };
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
      if (input.outcome === 'stopped' && row.state === 'submitted') row.errorCode = LOAN_STEPS_STOPPED_V1;
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
  async recordStep(input: Parameters<LoanExecutionStoreV1['recordStep']>[0]): Promise<LoanExecutionV1 | null> {
    assertOwner(input.owner); const row = this.rows.get(input.executionId);
    if (!row || !sameOwner(row, input.owner) || row.attemptId !== input.attemptId || row.state !== 'awaiting_wallet') return null;
    const next = nextStepV1(row, input);
    if (!next) return null;
    row.batchId = next.batchId; if (next.submitted) row.state = 'submitted';
    if (next.submitted && input.stop === true) row.errorCode = LOAN_STEPS_STOPPED_V1;
    row.updatedAt = input.now.toISOString(); row.version++; return copy(row);
  }
}

/** The batch id after one more step, or null when this step is not the next one. */
function nextStepV1(row: LoanExecutionV1, input: Parameters<LoanExecutionStoreV1['recordStep']>[0]): { batchId: string; submitted: boolean } | null {
  if (row.run.delivery !== 'sequential' || !/^0x[0-9a-f]{64}$/.test(input.transactionHash)) return null;
  const landed = row.batchId === null ? [] : sequentialHashesV1(row.batchId);
  if (!landed || input.index !== landed.length || input.index >= row.run.calls.length || landed.includes(input.transactionHash)) return null;
  const hashes = [...landed, input.transactionHash];
  return { batchId: sequentialBatchIdV1(hashes), submitted: hashes.length === row.run.calls.length || input.stop === true };
}

function validateSubmission(input: Parameters<LoanExecutionStoreV1['recordSubmission']>[0]): void {
  if (!validId(input.attemptId) || !['submitted', 'unknown', 'rejected', 'stopped'].includes(input.outcome) ||
      ((input.outcome === 'submitted' || input.outcome === 'stopped') && !input.batchId) ||
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
function conflictingIndexV1(error: unknown): string | null {
  return error && typeof error === 'object' && 'constraint_name' in error ? String(error.constraint_name) : null;
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
            AND COALESCE(lending_executions.run_json->'facts'->'payment'->>'orderId', '') = COALESCE(EXCLUDED.run_json->'facts'->'payment'->>'orderId', '')
            AND COALESCE(lending_executions.run_json->'facts'->'payment'->>'payTo', '') = COALESCE(EXCLUDED.run_json->'facts'->'payment'->>'payTo', '')
            AND COALESCE(lending_executions.run_json->'facts'->'payment'->>'assets', '') = COALESCE(EXCLUDED.run_json->'facts'->'payment'->>'assets', '')
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
    async listByPaymentOrder({ owner, orderId }) {
      assertOwner(owner);
      const rows = await sql`SELECT * FROM lending_executions WHERE tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}
        AND run_json->'facts'->'payment'->>'orderId' = ${orderId}`;
      return rows.map(rowFromDb);
    },
    async listActiveInScope({ owner, executionId }) {
      assertOwner(owner);
      const rows = await sql`SELECT other.* FROM lending_executions AS self JOIN lending_executions AS other
          ON other.tenant_id = self.tenant_id AND other.wallet_address = self.wallet_address AND other.venue = self.venue
          AND (self.venue = 'aave-v4' OR other.market_id = self.market_id)
        WHERE self.execution_id = ${executionId} AND self.tenant_id = ${owner.tenantId} AND self.wallet_address = ${owner.walletAddress}
          AND other.execution_id <> self.execution_id AND other.state IN ('awaiting_wallet', 'submitted', 'unknown')`;
      return rows.map(rowFromDb);
    },
    async arm({ owner, executionId, callsHash, signingTermsHash, now }) {
      assertOwner(owner); const attemptId = crypto.randomUUID();
      try {
        const rows = await sql`UPDATE lending_executions SET state = 'awaiting_wallet', attempt_id = ${attemptId}, updated_at = ${now.toISOString()}::timestamptz, version = version + 1
          WHERE execution_id = ${executionId} AND tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}
            AND state = 'ready' AND calls_hash = ${callsHash} AND run_json->>'signingTermsHash' = ${signingTermsHash}
            AND expires_at > ${now.toISOString()}::timestamptz RETURNING *`;
        return rows[0] ? { ok: true, execution: rowFromDb(rows[0]), attemptId } : { ok: false, refusal: 'execution_not_ready' };
      } catch (error) {
        if (uniqueConflict(error)) return { ok: false, refusal: conflictingIndexV1(error) === 'lending_execution_one_invoice' ? 'invoice_has_attempt' : 'execution_active' };
        throw error;
      }
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
            THEN 'conflicting_batch_hints'
            WHEN ${input.outcome === 'stopped'}::boolean AND error_code IS DISTINCT FROM 'conflicting_batch_hints' AND COALESCE(batch_id, ${input.batchId ?? null}::text) IS NOT NULL
            THEN ${LOAN_STEPS_STOPPED_V1}::text ELSE error_code END,
          batch_id = COALESCE(batch_id, ${input.batchId ?? null}::text), updated_at = ${at}::timestamptz, version = version + 1
          WHERE execution_id = ${input.executionId} AND tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}
            AND attempt_id = ${input.attemptId} AND state IN ('awaiting_wallet', 'submitted', 'unknown') RETURNING *`;
      return rows[0] ? rowFromDb(rows[0]) : null;
    },
    async recordStep(input) {
      assertOwner(input.owner); const { owner } = input;
      const rows = await sql`SELECT * FROM lending_executions WHERE execution_id = ${input.executionId} AND tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}`;
      const row = rows[0] ? rowFromDb(rows[0]) : null;
      if (!row || row.attemptId !== input.attemptId || row.state !== 'awaiting_wallet') return null;
      const next = nextStepV1(row, input);
      if (!next) return null;
      // Compare-and-set on the version read, so two step reports cannot both land.
      const updated = await sql`UPDATE lending_executions SET batch_id = ${next.batchId}, state = ${next.submitted ? 'submitted' : 'awaiting_wallet'},
          error_code = CASE WHEN ${next.submitted && input.stop === true}::boolean THEN ${LOAN_STEPS_STOPPED_V1}::text ELSE error_code END,
          updated_at = ${input.now.toISOString()}::timestamptz, version = version + 1
        WHERE execution_id = ${input.executionId} AND tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress}
          AND attempt_id = ${input.attemptId} AND state = 'awaiting_wallet' AND version = ${row.version} RETURNING *`;
      return updated[0] ? rowFromDb(updated[0]) : null;
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
