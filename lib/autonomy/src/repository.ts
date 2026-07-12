import { SpendPermission } from './types';

export interface ConfirmedSettlementProof {
  txHash?: string;
  batchId?: string;
  receiptId?: string;
  x402ReceiptId?: string;
  confirmedAt?: string;
}

export interface SpendPermissionRepository {
  create(permission: SpendPermission): Promise<void>;
  getById(id: string): Promise<SpendPermission | undefined>;
  setActive(id: string, isActive: boolean): Promise<void>;
  incrementSpent(
    id: string,
    amount: number,
    proof: ConfirmedSettlementProof,
  ): Promise<SpendPermission | undefined>;
  reconcileSpent?(id: string, spent: number): Promise<SpendPermission | undefined>;
}

export class InMemorySpendPermissionRepository implements SpendPermissionRepository {
  private readonly permissions = new Map<string, SpendPermission>();
  // Idempotency ledger mirroring the `spend_permission_proofs` table: once a
  // proof has been applied, a repeated call with the same proof must not
  // double-increment `spent` again — it should report the already-applied result.
  private readonly appliedProofs = new Set<string>();

  async create(permission: SpendPermission): Promise<void> {
    this.permissions.set(permission.id, clonePermission(permission));
  }

  async getById(id: string): Promise<SpendPermission | undefined> {
    const permission = this.permissions.get(id);
    return permission ? clonePermission(permission) : undefined;
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    const permission = this.permissions.get(id);
    if (!permission) return;
    this.permissions.set(id, { ...permission, isActive });
  }

  async incrementSpent(
    id: string,
    amount: number,
    proof: ConfirmedSettlementProof,
  ): Promise<SpendPermission | undefined> {
    const permission = this.permissions.get(id);
    if (!permission) return undefined;
    const key = proofKey(proof);
    if (this.appliedProofs.has(key)) {
      // Same proof as a previous, successfully APPLIED call: idempotent
      // success, return current state without incrementing again.
      return clonePermission(permission);
    }
    if (!permission.isActive) return undefined;
    if (permission.spent + amount > permission.limit) return undefined;
    // Mirror of the DB CTE contract: the proof is recorded ONLY when the
    // increment actually applies. A rejected (over-limit/inactive) attempt
    // leaves no ledger entry, so retrying it is rejected again rather than
    // being misread as "already applied".
    this.appliedProofs.add(key);
    const updated = { ...permission, spent: permission.spent + amount };
    this.permissions.set(id, updated);
    return clonePermission(updated);
  }

  async reconcileSpent(id: string, spent: number): Promise<SpendPermission | undefined> {
    const permission = this.permissions.get(id);
    if (!permission) return undefined;
    if (spent < 0 || spent > permission.limit) return undefined;
    const updated = { ...permission, spent };
    this.permissions.set(id, updated);
    return clonePermission(updated);
  }
}

export type SqlTemplateExecutor = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

// Derives a stable idempotency-ledger key from a confirmed settlement proof.
// Callers only reach incrementSpent after hasDurableProof(proof) is true, so at
// least one of these fields is always present here.
function proofKey(proof: ConfirmedSettlementProof): string {
  if (proof.txHash) return `tx:${proof.txHash}`;
  if (proof.batchId) return `batch:${proof.batchId}`;
  if (proof.receiptId) return `receipt:${proof.receiptId}`;
  if (proof.x402ReceiptId) return `x402:${proof.x402ReceiptId}`;
  throw new Error('Durable settlement proof required for idempotent spend accounting');
}

export function createDatabaseSpendPermissionRepository(sql: SqlTemplateExecutor): SpendPermissionRepository {
  async function getById(id: string): Promise<SpendPermission | undefined> {
    const rows = await sql`
      SELECT id, user_id, chain_id, asset, "limit", spent, whitelist, expires_at, is_active
      FROM spend_permissions
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ? rowToPermission(rows[0]) : undefined;
  }

  return {
    async create(permission: SpendPermission): Promise<void> {
      await sql`
        INSERT INTO spend_permissions (
          id,
          user_id,
          chain_id,
          asset,
          "limit",
          spent,
          whitelist,
          expires_at,
          is_active,
          created_at,
          updated_at
        )
        VALUES (
          ${permission.id},
          ${permission.userId},
          ${permission.chainId},
          ${permission.asset ?? null},
          ${permission.limit},
          ${permission.spent},
          CAST(${JSON.stringify(permission.whitelist)} AS jsonb),
          ${new Date(permission.expiresAt)},
          ${permission.isActive},
          now(),
          now()
        )
        ON CONFLICT (id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          chain_id = EXCLUDED.chain_id,
          asset = EXCLUDED.asset,
          "limit" = EXCLUDED."limit",
          spent = EXCLUDED.spent,
          whitelist = EXCLUDED.whitelist,
          expires_at = EXCLUDED.expires_at,
          is_active = EXCLUDED.is_active,
          updated_at = now()
      `;
    },

    getById,

    async setActive(id: string, isActive: boolean): Promise<void> {
      await sql`
        UPDATE spend_permissions
        SET is_active = ${isActive}, updated_at = now()
        WHERE id = ${id}
      `;
    },

    async incrementSpent(
      id: string,
      amount: number,
      proof: ConfirmedSettlementProof,
    ): Promise<SpendPermission | undefined> {
      // Idempotent by proof: the Neon HTTP driver's customFetch retries any
      // fetch failure (including AbortController timeouts) up to
      // DATABASE_FETCH_ATTEMPTS times. Since neon-http has no multi-statement
      // transactions, a single CTE statement applies the spend UPDATE (gated
      // on limit/active AND the proof being unseen) and records the proof in
      // spend_permission_proofs ONLY from a successful UPDATE. A proof
      // therefore only ever exists in the ledger for an increment that was
      // actually applied: a retried successful charge is a no-op success,
      // while a retried limit-rejected attempt is rejected again — it can
      // never be misread as "already applied".
      const key = proofKey(proof);
      const rows = await sql`
        WITH upd AS (
          UPDATE spend_permissions
          SET spent = spent + ${amount}, updated_at = now()
          WHERE id = ${id}
            AND is_active = true
            AND spent + ${amount} <= "limit"
            AND NOT EXISTS (SELECT 1 FROM spend_permission_proofs WHERE proof = ${key})
          RETURNING id, user_id, chain_id, asset, "limit", spent, whitelist, expires_at, is_active
        ), ins AS (
          INSERT INTO spend_permission_proofs (proof, permission_id, amount)
          SELECT ${key}, upd.id, ${amount} FROM upd
          ON CONFLICT (proof) DO NOTHING
          RETURNING 1
        )
        SELECT
          (SELECT count(*) FROM upd)::int AS applied,
          EXISTS (SELECT 1 FROM spend_permission_proofs WHERE proof = ${key}) AS previously_applied,
          upd.id, upd.user_id, upd.chain_id, upd.asset, upd."limit", upd.spent, upd.whitelist, upd.expires_at, upd.is_active
        FROM (SELECT 1 AS one) AS placeholder
        LEFT JOIN upd ON true
      `;
      const row = rows[0];
      if (row?.id) {
        // applied = 1: the increment ran in this statement and the proof was
        // recorded from it.
        return rowToPermission(row);
      }
      // Snapshot semantics: this EXISTS reads the pre-statement state of
      // spend_permission_proofs (it cannot see the ins CTE of this same
      // statement), so true here means the proof was recorded by a PREVIOUS,
      // successfully applied call — idempotent success.
      const previouslyApplied = row?.previously_applied === true || row?.previously_applied === 'true' || row?.previously_applied === 't';
      if (row && previouslyApplied) {
        return getById(id);
      }
      // applied = 0 and the proof was never recorded: the update was rejected
      // (limit exceeded or permission inactive). Genuine failure, matching
      // prior behavior — and a retry with the same proof fails the same way.
      return undefined;
    },

    async reconcileSpent(id: string, spent: number): Promise<SpendPermission | undefined> {
      const rows = await sql`
        UPDATE spend_permissions
        SET spent = ${spent}, updated_at = now()
        WHERE id = ${id}
          AND ${spent} >= 0
          AND ${spent} <= "limit"
        RETURNING id, user_id, chain_id, asset, "limit", spent, whitelist, expires_at, is_active
      `;
      return rows[0] ? rowToPermission(rows[0]) : undefined;
    },
  };
}

function clonePermission(permission: SpendPermission): SpendPermission {
  return {
    ...permission,
    whitelist: [...permission.whitelist],
  };
}

function numberFromRow(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

function rowToPermission(row: Record<string, unknown>): SpendPermission {
  const rawWhitelist = row.whitelist;
  const whitelist = Array.isArray(rawWhitelist)
    ? rawWhitelist.map(String)
    : typeof rawWhitelist === 'string'
      ? JSON.parse(rawWhitelist)
      : [];
  const expiresAt = row.expires_at instanceof Date
    ? row.expires_at.getTime()
    : new Date(String(row.expires_at)).getTime();

  return {
    id: String(row.id),
    userId: String(row.user_id),
    chainId: numberFromRow(row.chain_id),
    asset: row.asset ? String(row.asset) : undefined,
    limit: numberFromRow(row.limit),
    spent: numberFromRow(row.spent),
    whitelist,
    expiresAt,
    isActive: Boolean(row.is_active),
  };
}
