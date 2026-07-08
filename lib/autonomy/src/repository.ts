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
    _proof: ConfirmedSettlementProof,
  ): Promise<SpendPermission | undefined> {
    const permission = this.permissions.get(id);
    if (!permission || !permission.isActive) return undefined;
    if (permission.spent + amount > permission.limit) return undefined;
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

export function createDatabaseSpendPermissionRepository(sql: SqlTemplateExecutor): SpendPermissionRepository {
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

    async getById(id: string): Promise<SpendPermission | undefined> {
      const rows = await sql`
        SELECT id, user_id, chain_id, asset, "limit", spent, whitelist, expires_at, is_active
        FROM spend_permissions
        WHERE id = ${id}
        LIMIT 1
      `;
      return rows[0] ? rowToPermission(rows[0]) : undefined;
    },

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
      _proof: ConfirmedSettlementProof,
    ): Promise<SpendPermission | undefined> {
      const rows = await sql`
        UPDATE spend_permissions
        SET spent = spent + ${amount}, updated_at = now()
        WHERE id = ${id}
          AND is_active = true
          AND spent + ${amount} <= "limit"
        RETURNING id, user_id, chain_id, asset, "limit", spent, whitelist, expires_at, is_active
      `;
      return rows[0] ? rowToPermission(rows[0]) : undefined;
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
