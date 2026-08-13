import { client } from '@mioagent/db';
import type { ConfirmedSettlementProofV1 } from '@mioagent/intelligence-budget';

export type SpendPermissionChargeAttemptStatusV1 = 'claimed' | 'settled' | 'outcome_unknown';

export interface SpendPermissionChargeAttemptV1 {
  idempotencyKey: string;
  chargeId: string;
  userId: string;
  spendPermissionId: string;
  expectedPayer: `0x${string}`;
  amountAtomic: string;
  status: SpendPermissionChargeAttemptStatusV1;
  proof: ConfirmedSettlementProofV1 | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

export type ClaimSpendPermissionChargeAttemptResultV1 =
  | { outcome: 'claimed'; attempt: SpendPermissionChargeAttemptV1 }
  | { outcome: 'existing'; attempt: SpendPermissionChargeAttemptV1 }
  | { outcome: 'conflict'; attempt: SpendPermissionChargeAttemptV1 };

export interface SpendPermissionChargeAttemptStoreV1 {
  claim(input: {
    idempotencyKey: string;
    chargeId: string;
    userId: string;
    spendPermissionId: string;
    expectedPayer: `0x${string}`;
    amountAtomic: string;
    now: string;
  }): Promise<ClaimSpendPermissionChargeAttemptResultV1>;
  settle(input: {
    idempotencyKey: string;
    proof: ConfirmedSettlementProofV1;
    now: string;
  }): Promise<SpendPermissionChargeAttemptV1 | null>;
  markOutcomeUnknown(input: {
    idempotencyKey: string;
    now: string;
  }): Promise<SpendPermissionChargeAttemptV1 | null>;
}

function rowToAttempt(row: Record<string, unknown>): SpendPermissionChargeAttemptV1 {
  const proof = row.proof == null
    ? null
    : (typeof row.proof === 'string' ? JSON.parse(row.proof) : row.proof) as ConfirmedSettlementProofV1;
  return {
    idempotencyKey: String(row.idempotency_key),
    chargeId: String(row.charge_id),
    userId: String(row.user_id),
    spendPermissionId: String(row.spend_permission_id),
    expectedPayer: String(row.expected_payer).toLowerCase() as `0x${string}`,
    amountAtomic: String(row.amount_atomic),
    status: String(row.status) as SpendPermissionChargeAttemptStatusV1,
    proof,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    settledAt: row.settled_at == null ? null : new Date(String(row.settled_at)).toISOString(),
  };
}

function factsMatch(
  attempt: SpendPermissionChargeAttemptV1,
  input: {
    chargeId: string;
    userId: string;
    spendPermissionId: string;
    expectedPayer: `0x${string}`;
    amountAtomic: string;
  },
): boolean {
  return attempt.chargeId === input.chargeId
    && attempt.userId === input.userId
    && attempt.spendPermissionId === input.spendPermissionId
    && attempt.expectedPayer === input.expectedPayer.toLowerCase()
    && attempt.amountAtomic === input.amountAtomic;
}

export class PostgresSpendPermissionChargeAttemptStoreV1 implements SpendPermissionChargeAttemptStoreV1 {
  async claim(input: {
    idempotencyKey: string;
    chargeId: string;
    userId: string;
    spendPermissionId: string;
    expectedPayer: `0x${string}`;
    amountAtomic: string;
    now: string;
  }): Promise<ClaimSpendPermissionChargeAttemptResultV1> {
    const rows = await client`
      WITH inserted AS (
        INSERT INTO intelligence_charge_attempts (
          idempotency_key, charge_id, user_id, spend_permission_id,
          expected_payer, amount_atomic, status, proof,
          created_at, updated_at, settled_at
        ) VALUES (
          ${input.idempotencyKey}, ${input.chargeId}, ${input.userId},
          ${input.spendPermissionId}, ${input.expectedPayer.toLowerCase()},
          ${input.amountAtomic}::numeric(78,0), 'claimed', NULL,
          ${input.now}::timestamptz, ${input.now}::timestamptz, NULL
        )
        ON CONFLICT DO NOTHING
        RETURNING *, true AS acquired
      )
      SELECT * FROM inserted
      UNION ALL
      SELECT existing.*, false AS acquired
      FROM intelligence_charge_attempts AS existing
      WHERE existing.idempotency_key = ${input.idempotencyKey}
        AND NOT EXISTS (SELECT 1 FROM inserted)
      LIMIT 1
    `;
    if (!rows[0]) throw new Error('spend_permission_charge_attempt_claim_failed');
    const attempt = rowToAttempt(rows[0]);
    if (!factsMatch(attempt, input)) return { outcome: 'conflict', attempt };
    return rows[0].acquired === true
      ? { outcome: 'claimed', attempt }
      : { outcome: 'existing', attempt };
  }

  async settle(input: {
    idempotencyKey: string;
    proof: ConfirmedSettlementProofV1;
    now: string;
  }): Promise<SpendPermissionChargeAttemptV1 | null> {
    const rows = await client`
      UPDATE intelligence_charge_attempts
      SET status = 'settled',
          proof = ${JSON.stringify(input.proof)}::jsonb,
          updated_at = ${input.now}::timestamptz,
          settled_at = ${input.now}::timestamptz
      WHERE idempotency_key = ${input.idempotencyKey}
        AND status IN ('claimed', 'outcome_unknown')
      RETURNING *
    `;
    if (rows[0]) return rowToAttempt(rows[0]);
    const existing = await client`
      SELECT * FROM intelligence_charge_attempts
      WHERE idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    return existing[0] ? rowToAttempt(existing[0]) : null;
  }

  async markOutcomeUnknown(input: {
    idempotencyKey: string;
    now: string;
  }): Promise<SpendPermissionChargeAttemptV1 | null> {
    const rows = await client`
      UPDATE intelligence_charge_attempts
      SET status = 'outcome_unknown', updated_at = ${input.now}::timestamptz
      WHERE idempotency_key = ${input.idempotencyKey} AND status = 'claimed'
      RETURNING *
    `;
    if (rows[0]) return rowToAttempt(rows[0]);
    const existing = await client`
      SELECT * FROM intelligence_charge_attempts
      WHERE idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    return existing[0] ? rowToAttempt(existing[0]) : null;
  }
}

export class InMemorySpendPermissionChargeAttemptStoreV1 implements SpendPermissionChargeAttemptStoreV1 {
  private readonly attempts = new Map<string, SpendPermissionChargeAttemptV1>();

  async claim(input: {
    idempotencyKey: string;
    chargeId: string;
    userId: string;
    spendPermissionId: string;
    expectedPayer: `0x${string}`;
    amountAtomic: string;
    now: string;
  }): Promise<ClaimSpendPermissionChargeAttemptResultV1> {
    const existing = this.attempts.get(input.idempotencyKey);
    if (existing) {
      const attempt = structuredClone(existing);
      return factsMatch(attempt, input)
        ? { outcome: 'existing', attempt }
        : { outcome: 'conflict', attempt };
    }
    const attempt: SpendPermissionChargeAttemptV1 = {
      idempotencyKey: input.idempotencyKey,
      chargeId: input.chargeId,
      userId: input.userId,
      spendPermissionId: input.spendPermissionId,
      expectedPayer: input.expectedPayer.toLowerCase() as `0x${string}`,
      amountAtomic: input.amountAtomic,
      status: 'claimed',
      proof: null,
      createdAt: input.now,
      updatedAt: input.now,
      settledAt: null,
    };
    this.attempts.set(input.idempotencyKey, attempt);
    return { outcome: 'claimed', attempt: structuredClone(attempt) };
  }

  async settle(input: {
    idempotencyKey: string;
    proof: ConfirmedSettlementProofV1;
    now: string;
  }): Promise<SpendPermissionChargeAttemptV1 | null> {
    const attempt = this.attempts.get(input.idempotencyKey);
    if (!attempt) return null;
    if (attempt.status !== 'settled') {
      attempt.status = 'settled';
      attempt.proof = structuredClone(input.proof);
      attempt.updatedAt = input.now;
      attempt.settledAt = input.now;
    }
    return structuredClone(attempt);
  }

  async markOutcomeUnknown(input: {
    idempotencyKey: string;
    now: string;
  }): Promise<SpendPermissionChargeAttemptV1 | null> {
    const attempt = this.attempts.get(input.idempotencyKey);
    if (!attempt) return null;
    if (attempt.status === 'claimed') {
      attempt.status = 'outcome_unknown';
      attempt.updatedAt = input.now;
    }
    return structuredClone(attempt);
  }
}
