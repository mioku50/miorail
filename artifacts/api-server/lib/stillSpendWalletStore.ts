import crypto from 'node:crypto';
import { ExecutionCallV1Schema, hashApprovedCallsV1, type HashV1 } from '@mioagent/route-domain';
import type { LoanOwnerV1 } from './loanExecutionStore.js';
import type { SpendWalletReadyV1 } from './stillSpendWallet.js';

// ---------------------------------------------------------------------------
// Still Spend: a Bitrefill invoice paid from the USDC already in the wallet,
// one exact transfer and no loan (the operator, 2026-11-03).
//
// One row per invoice and wallet, keyed by the invoice: a review is prepared
// again in place while it is `ready`, and once it leaves `ready` it is never
// prepared or armed again. A loan's review of the same invoice is in
// lending_executions; the two are checked against each other under one lock
// (withSpendInvoiceLockV1), so one invoice is paid once, by either.
// ---------------------------------------------------------------------------

export type SpendWalletStateV1 = 'ready' | 'awaiting_wallet' | 'submitted' | 'unknown' | 'confirmed' | 'failed';
export interface SpendWalletPaymentV1 extends LoanOwnerV1 {
  paymentId: string;
  orderId: string;
  state: SpendWalletStateV1;
  run: SpendWalletReadyV1;
  attemptId: string | null;
  batchId: string | null;
  transactionHash: HashV1 | null;
  verification: Record<string, unknown> | null;
  errorCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface SpendWalletStoreV1 {
  /** A review for this invoice, or the same one prepared again while still `ready`. A row past `ready` comes back as it is. */
  putReady(input: { owner: LoanOwnerV1; run: SpendWalletReadyV1; now: Date }): Promise<SpendWalletPaymentV1>;
  get(input: { owner: LoanOwnerV1; orderId: string }): Promise<SpendWalletPaymentV1 | null>;
  arm(input: { owner: LoanOwnerV1; orderId: string; callsHash: string; signingTermsHash: string; now: Date }): Promise<
    { ok: true; payment: SpendWalletPaymentV1; attemptId: string } | { ok: false; refusal: 'payment_not_ready' }>;
  /** What the wallet answered: a batch id (wallet_sendCalls) or a transaction hash (one transaction). */
  recordSubmission(input: { owner: LoanOwnerV1; orderId: string; attemptId: string; outcome: 'submitted' | 'unknown' | 'rejected';
    batchId?: string | null; transactionHash?: HashV1 | null; now: Date }): Promise<SpendWalletPaymentV1 | null>;
  recordVerification(input: { owner: LoanOwnerV1; orderId: string; expectedVersion: number; state: 'confirmed' | 'failed' | 'unknown';
    transactionHash: HashV1 | null; proof: Record<string, unknown> | null; errorCode: string | null; now: Date }): Promise<SpendWalletPaymentV1 | null>;
}

type SqlV1 = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
const ORDER_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_V1 = /^0x[0-9a-f]{64}$/;
const active = (state: SpendWalletStateV1) => ['awaiting_wallet', 'submitted', 'unknown'].includes(state);
function assertOwner(owner: LoanOwnerV1): void {
  if (!/^0x[0-9a-f]{40}$/.test(owner.walletAddress) || owner.tenantId !== `eip155:8453:${owner.walletAddress}`) throw new Error('spend_wallet_owner_invalid');
}
function assertReady(input: { owner: LoanOwnerV1; run: SpendWalletReadyV1; now: Date }): void {
  assertOwner(input.owner);
  const { run } = input;
  if (run.state !== 'ready' || !ORDER_V1.test(run.facts.payment.orderId) || run.calls.length !== 1 ||
      run.calls.some((call, index) => !ExecutionCallV1Schema.safeParse(call).success || call.index !== index || call.callType !== 'transfer') ||
      run.callsHash !== hashApprovedCallsV1(run.calls) || !HASH_V1.test(run.signingTermsHash) ||
      !Number.isFinite(Date.parse(run.expiresAt)) || Date.parse(run.expiresAt) <= input.now.getTime() ||
      JSON.stringify(run).length > 64_000) throw new Error('spend_wallet_ready_invalid');
}
function validateSubmission(input: Parameters<SpendWalletStoreV1['recordSubmission']>[0]): void {
  const batch = input.batchId ?? null, hash = input.transactionHash ?? null;
  if (!/^[A-Za-z0-9:_.-]{1,200}$/.test(input.attemptId) || !['submitted', 'unknown', 'rejected'].includes(input.outcome) ||
      (batch !== null && (typeof batch !== 'string' || batch.length < 1 || batch.length > 2000)) || (hash !== null && !HASH_V1.test(hash)) ||
      (input.outcome === 'submitted' && batch === null && hash === null) || (input.outcome === 'rejected' && (batch !== null || hash !== null))) {
    throw new Error('spend_wallet_submission_invalid');
  }
}
function validateVerification(input: Parameters<SpendWalletStoreV1['recordVerification']>[0]): void {
  if (!['confirmed', 'failed', 'unknown'].includes(input.state) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
      (input.transactionHash !== null && !HASH_V1.test(input.transactionHash)) ||
      (input.state !== 'unknown' && (input.transactionHash === null || input.proof === null))) throw new Error('spend_wallet_verification_invalid');
}
const sameOwner = (row: SpendWalletPaymentV1, owner: LoanOwnerV1) => row.tenantId === owner.tenantId && row.walletAddress === owner.walletAddress;
// A review prepared again pays the same invoice, the same amount, to the same address.
const sameQuestion = (row: SpendWalletPaymentV1, run: SpendWalletReadyV1) => {
  const a = row.run.facts.payment, b = run.facts.payment;
  return a.orderId === b.orderId && a.payTo === b.payTo && a.assets === b.assets;
};
const copy = <T>(value: T): T => structuredClone(value);

/** Atomic in one JS turn, for tests. Production uses PostgreSQL's compare-and-set. */
export class MemorySpendWalletStoreV1 implements SpendWalletStoreV1 {
  private rows = new Map<string, SpendWalletPaymentV1>();
  private find(owner: LoanOwnerV1, orderId: string) {
    return [...this.rows.values()].find(row => sameOwner(row, owner) && row.orderId === orderId) ?? null;
  }
  async putReady(input: { owner: LoanOwnerV1; run: SpendWalletReadyV1; now: Date }): Promise<SpendWalletPaymentV1> {
    assertReady(input);
    const existing = this.find(input.owner, input.run.facts.payment.orderId);
    if (existing) {
      if (!sameQuestion(existing, input.run)) throw new Error('spend_wallet_question_changed');
      if (existing.state === 'ready') { existing.run = copy(input.run); existing.updatedAt = input.now.toISOString(); existing.version++; }
      return copy(existing);
    }
    const row: SpendWalletPaymentV1 = { ...input.owner, paymentId: crypto.randomUUID(), orderId: input.run.facts.payment.orderId, state: 'ready', run: copy(input.run),
      attemptId: null, batchId: null, transactionHash: null, verification: null, errorCode: null, version: 0,
      createdAt: input.now.toISOString(), updatedAt: input.now.toISOString() };
    this.rows.set(row.paymentId, row); return copy(row);
  }
  async get(input: { owner: LoanOwnerV1; orderId: string }): Promise<SpendWalletPaymentV1 | null> {
    assertOwner(input.owner); const row = this.find(input.owner, input.orderId);
    return row ? copy(row) : null;
  }
  async arm(input: Parameters<SpendWalletStoreV1['arm']>[0]): ReturnType<SpendWalletStoreV1['arm']> {
    assertOwner(input.owner); const row = this.find(input.owner, input.orderId);
    if (!row || row.state !== 'ready' || row.run.callsHash !== input.callsHash || row.run.signingTermsHash !== input.signingTermsHash ||
        Date.parse(row.run.expiresAt) <= input.now.getTime()) return { ok: false, refusal: 'payment_not_ready' };
    row.state = 'awaiting_wallet'; row.attemptId = crypto.randomUUID(); row.updatedAt = input.now.toISOString(); row.version++;
    return { ok: true, payment: copy(row), attemptId: row.attemptId };
  }
  async recordSubmission(input: Parameters<SpendWalletStoreV1['recordSubmission']>[0]): Promise<SpendWalletPaymentV1 | null> {
    assertOwner(input.owner); validateSubmission(input); const row = this.find(input.owner, input.orderId);
    if (!row || row.attemptId !== input.attemptId || !active(row.state)) return null;
    if (input.outcome === 'rejected') {
      if (row.state !== 'awaiting_wallet') return null;
      row.state = 'ready'; row.attemptId = null; row.errorCode = null;
    } else {
      // A late unknown cannot erase a recorded answer, and two different answers stay unknown.
      const batch = input.batchId ?? null, hash = input.transactionHash ?? null;
      if (row.errorCode === 'conflicting_wallet_answers' || (row.batchId && batch && row.batchId !== batch) || (row.transactionHash && hash && row.transactionHash !== hash)) {
        row.state = 'unknown'; row.errorCode = 'conflicting_wallet_answers';
      } else {
        row.batchId ??= batch; row.transactionHash ??= hash;
        row.state = row.batchId || row.transactionHash ? 'submitted' : 'unknown';
      }
    }
    row.updatedAt = input.now.toISOString(); row.version++; return copy(row);
  }
  async recordVerification(input: Parameters<SpendWalletStoreV1['recordVerification']>[0]): Promise<SpendWalletPaymentV1 | null> {
    assertOwner(input.owner); validateVerification(input); const row = this.find(input.owner, input.orderId);
    if (!row || row.version !== input.expectedVersion || row.state === 'ready') return null;
    row.state = input.state; row.transactionHash = input.transactionHash; row.verification = copy(input.proof); row.errorCode = input.errorCode;
    row.updatedAt = input.now.toISOString(); row.version++; return copy(row);
  }
}

function rowFromDb(row: Record<string, unknown>): SpendWalletPaymentV1 {
  const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
  return { paymentId: String(row.payment_id), tenantId: String(row.tenant_id), walletAddress: String(row.wallet_address), orderId: String(row.order_id),
    state: row.state as SpendWalletStateV1, run: json(row.run_json) as SpendWalletReadyV1,
    attemptId: row.attempt_id == null ? null : String(row.attempt_id), batchId: row.batch_id == null ? null : String(row.batch_id),
    transactionHash: row.transaction_hash == null ? null : String(row.transaction_hash) as HashV1,
    verification: row.verification_json == null ? null : json(row.verification_json) as Record<string, unknown>,
    errorCode: row.error_code == null ? null : String(row.error_code), version: Number(row.version),
    createdAt: new Date(row.created_at as string | Date).toISOString(), updatedAt: new Date(row.updated_at as string | Date).toISOString() };
}

export function createDatabaseSpendWalletStoreV1(sql: SqlV1): SpendWalletStoreV1 {
  return {
    async putReady(input) {
      assertReady(input); const { owner, run } = input; const at = input.now.toISOString(), payment = run.facts.payment;
      const rows = await sql`INSERT INTO spend_wallet_payments
        (payment_id, tenant_id, wallet_address, order_id, calls_hash, run_json, state, created_at, updated_at, expires_at)
        VALUES (${crypto.randomUUID()}, ${owner.tenantId}, ${owner.walletAddress}, ${payment.orderId}, ${run.callsHash},
          ${JSON.stringify(run)}::text::jsonb, 'ready', ${at}::timestamptz, ${at}::timestamptz, ${run.expiresAt}::timestamptz)
        ON CONFLICT (tenant_id, wallet_address, order_id) DO UPDATE
          SET run_json = EXCLUDED.run_json, calls_hash = EXCLUDED.calls_hash, expires_at = EXCLUDED.expires_at,
              updated_at = EXCLUDED.updated_at, version = spend_wallet_payments.version + 1
          WHERE spend_wallet_payments.state = 'ready'
            AND spend_wallet_payments.run_json->'facts'->'payment'->>'payTo' = EXCLUDED.run_json->'facts'->'payment'->>'payTo'
            AND spend_wallet_payments.run_json->'facts'->'payment'->>'assets' = EXCLUDED.run_json->'facts'->'payment'->>'assets'
        RETURNING *`;
      if (rows[0]) return rowFromDb(rows[0]);
      const prior = await sql`SELECT * FROM spend_wallet_payments WHERE tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress} AND order_id = ${payment.orderId}`;
      if (!prior[0] || !sameQuestion(rowFromDb(prior[0]), run)) throw new Error('spend_wallet_question_changed');
      return rowFromDb(prior[0]);
    },
    async get({ owner, orderId }) {
      assertOwner(owner);
      const rows = await sql`SELECT * FROM spend_wallet_payments WHERE tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress} AND order_id = ${orderId}`;
      return rows[0] ? rowFromDb(rows[0]) : null;
    },
    async arm({ owner, orderId, callsHash, signingTermsHash, now }) {
      assertOwner(owner); const attemptId = crypto.randomUUID();
      const rows = await sql`UPDATE spend_wallet_payments SET state = 'awaiting_wallet', attempt_id = ${attemptId}, updated_at = ${now.toISOString()}::timestamptz, version = version + 1
        WHERE tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress} AND order_id = ${orderId}
          AND state = 'ready' AND calls_hash = ${callsHash} AND run_json->>'signingTermsHash' = ${signingTermsHash}
          AND expires_at > ${now.toISOString()}::timestamptz RETURNING *`;
      return rows[0] ? { ok: true, payment: rowFromDb(rows[0]), attemptId } : { ok: false, refusal: 'payment_not_ready' };
    },
    async recordSubmission(input) {
      assertOwner(input.owner); validateSubmission(input); const { owner } = input; const at = input.now.toISOString();
      const batch = input.batchId ?? null, hash = input.transactionHash ?? null;
      const rows = input.outcome === 'rejected'
        ? await sql`UPDATE spend_wallet_payments SET state = 'ready', attempt_id = NULL, error_code = NULL, updated_at = ${at}::timestamptz, version = version + 1
          WHERE tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress} AND order_id = ${input.orderId}
            AND attempt_id = ${input.attemptId} AND state = 'awaiting_wallet' RETURNING *`
        : await sql`UPDATE spend_wallet_payments SET
          state = CASE WHEN error_code = 'conflicting_wallet_answers'
              OR (batch_id IS NOT NULL AND ${batch}::text IS NOT NULL AND batch_id <> ${batch}::text)
              OR (transaction_hash IS NOT NULL AND ${hash}::text IS NOT NULL AND transaction_hash <> ${hash}::text) THEN 'unknown'
            WHEN COALESCE(batch_id, ${batch}::text) IS NULL AND COALESCE(transaction_hash, ${hash}::text) IS NULL THEN 'unknown' ELSE 'submitted' END,
          error_code = CASE WHEN (batch_id IS NOT NULL AND ${batch}::text IS NOT NULL AND batch_id <> ${batch}::text)
              OR (transaction_hash IS NOT NULL AND ${hash}::text IS NOT NULL AND transaction_hash <> ${hash}::text) THEN 'conflicting_wallet_answers' ELSE error_code END,
          batch_id = COALESCE(batch_id, ${batch}::text), transaction_hash = COALESCE(transaction_hash, ${hash}::text),
          updated_at = ${at}::timestamptz, version = version + 1
          WHERE tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress} AND order_id = ${input.orderId}
            AND attempt_id = ${input.attemptId} AND state IN ('awaiting_wallet', 'submitted', 'unknown') RETURNING *`;
      return rows[0] ? rowFromDb(rows[0]) : null;
    },
    async recordVerification(input) {
      assertOwner(input.owner); validateVerification(input); const { owner } = input;
      const rows = await sql`UPDATE spend_wallet_payments SET state = ${input.state}, transaction_hash = ${input.transactionHash},
        verification_json = ${input.proof === null ? null : JSON.stringify(input.proof)}::text::jsonb, error_code = ${input.errorCode},
        updated_at = ${input.now.toISOString()}::timestamptz, version = version + 1
        WHERE tenant_id = ${owner.tenantId} AND wallet_address = ${owner.walletAddress} AND order_id = ${input.orderId}
          AND version = ${input.expectedVersion} AND state <> 'ready' RETURNING *`;
      return rows[0] ? rowFromDb(rows[0]) : null;
    },
  };
}

let runtimeStore: SpendWalletStoreV1 | null = null;
export const spendWalletStoreRuntimeV1 = {
  async store(): Promise<SpendWalletStoreV1> {
    if (!runtimeStore) { const { client } = await import('@mioagent/db'); runtimeStore = createDatabaseSpendWalletStoreV1(client); }
    return runtimeStore;
  },
};
