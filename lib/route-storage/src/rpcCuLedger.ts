import { rpcBudgetMonthV1 } from '@mioagent/b20-control';

// ---------------------------------------------------------------------------
// The month's metered spend, kept where a restart cannot lose it.
//
// A budget held in memory is not a budget: the process forgets on every deploy
// and every crash, and "under budget" then means "has not been running long",
// which is indistinguishable from the truth right up until it is not.
// ---------------------------------------------------------------------------

export type RpcProviderV1 = 'alchemy' | 'fallback';

export interface RpcCuLedgerRowV1 {
  month: string;
  provider: RpcProviderV1;
  spentCu: number;
  callCount: number;
  updatedAt: string;
}

export interface RpcCuLedgerRepositoryV1 {
  /** Add a batch's cost. Never subtracts: a decrement is a correction nobody
   * can audit, and the fallback exists so none is needed. */
  recordSpend(input: {
    provider: RpcProviderV1;
    cu: number;
    calls: number;
    now: Date;
  }): Promise<void>;
  /** This month's rows, or an empty list before anything was spent. */
  readMonth(now: Date): Promise<RpcCuLedgerRowV1[]>;
}

type SqlV1 = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

export function createDatabaseRpcCuLedgerRepository(sql: unknown): RpcCuLedgerRepositoryV1 {
  const query = sql as SqlV1;
  return {
    async recordSpend({ provider, cu, calls, now }) {
      if (cu <= 0 && calls <= 0) return;
      const month = rpcBudgetMonthV1(now);
      await query`
        INSERT INTO rpc_cu_ledger (month, provider, spent_cu, call_count, first_spend_at, updated_at)
        VALUES (${month}, ${provider}, ${Math.max(0, Math.round(cu))}, ${Math.max(0, Math.round(calls))}, ${now}, ${now})
        ON CONFLICT (month, provider) DO UPDATE
          SET spent_cu = rpc_cu_ledger.spent_cu + EXCLUDED.spent_cu,
              call_count = rpc_cu_ledger.call_count + EXCLUDED.call_count,
              updated_at = EXCLUDED.updated_at`;
    },
    async readMonth(now) {
      const month = rpcBudgetMonthV1(now);
      const rows = await query`
        SELECT month, provider, spent_cu, call_count, updated_at
          FROM rpc_cu_ledger
         WHERE month = ${month}
         ORDER BY provider`;
      return rows.map((row) => ({
        month: String(row.month),
        provider: String(row.provider) as RpcProviderV1,
        spentCu: Number(row.spent_cu ?? 0),
        callCount: Number(row.call_count ?? 0),
        updatedAt: new Date(String(row.updated_at)).toISOString(),
      }));
    },
  };
}

/** The in-memory twin, which must refuse and count exactly as Postgres does. */
export function createInMemoryRpcCuLedgerRepository(): RpcCuLedgerRepositoryV1 {
  const rows = new Map<string, RpcCuLedgerRowV1>();
  return {
    async recordSpend({ provider, cu, calls, now }) {
      if (cu <= 0 && calls <= 0) return;
      const month = rpcBudgetMonthV1(now);
      const key = `${month}:${provider}`;
      const existing = rows.get(key);
      rows.set(key, {
        month,
        provider,
        spentCu: (existing?.spentCu ?? 0) + Math.max(0, Math.round(cu)),
        callCount: (existing?.callCount ?? 0) + Math.max(0, Math.round(calls)),
        updatedAt: now.toISOString(),
      });
    },
    async readMonth(now) {
      const month = rpcBudgetMonthV1(now);
      return [...rows.values()].filter((row) => row.month === month).sort((a, b) => a.provider.localeCompare(b.provider));
    },
  };
}
