import { RouteStorageIntegrityError, type SqlTemplateExecutor } from './types.js';

export interface StockActionDraftOwnerV1 {
  tenantId: string;
  walletAddress: string;
  actionDraftId: string;
}

export interface StockActionReleaseV1 extends StockActionDraftOwnerV1 {
  clearanceId: string;
  blueprintId: string;
  routeRunId: string;
}

export type StockActionExecutionV1 = StockActionDraftOwnerV1 & {
  release: StockActionReleaseV1 | null;
  createdAt: string;
};

/** Only ownership and references. Signed drafts, clearances and executable
 * payloads never enter this store or the status response built from it. */
export interface StockActionExecutionRepositoryV1 {
  recordDraft(input: StockActionDraftOwnerV1 & { at: Date }): Promise<void>;
  recordRelease(input: StockActionReleaseV1 & { at: Date }): Promise<void>;
  latest(input: StockActionDraftOwnerV1): Promise<StockActionExecutionV1 | null>;
}

const ID = /^[A-Za-z0-9:_.-]{1,200}$/;

function assertOwner(input: StockActionDraftOwnerV1): void {
  if (!/^0x[0-9a-f]{40}$/.test(input.walletAddress)
    || input.tenantId !== `eip155:8453:${input.walletAddress}` || !ID.test(input.actionDraftId)) {
    throw new RouteStorageIntegrityError('a stock action belongs to one authenticated wallet');
  }
}

function assertRelease(input: StockActionReleaseV1): void {
  assertOwner(input);
  if (![input.clearanceId, input.blueprintId, input.routeRunId].every(id => ID.test(id))) {
    throw new RouteStorageIntegrityError('a stock action release needs all three references');
  }
}

function sameOwner(a: StockActionDraftOwnerV1, b: StockActionDraftOwnerV1): boolean {
  return a.tenantId === b.tenantId && a.walletAddress === b.walletAddress && a.actionDraftId === b.actionDraftId;
}

function sameRelease(a: StockActionReleaseV1, b: StockActionReleaseV1): boolean {
  return sameOwner(a, b) && a.clearanceId === b.clearanceId && a.blueprintId === b.blueprintId && a.routeRunId === b.routeRunId;
}

export class InMemoryStockActionExecutionRepositoryV1 implements StockActionExecutionRepositoryV1 {
  private rows: Array<StockActionExecutionV1 & { sequence: number }> = [];

  async recordDraft(input: StockActionDraftOwnerV1 & { at: Date }): Promise<void> {
    assertOwner(input);
    const createdAt = input.at.toISOString();
    const prior = this.rows.find(row => row.actionDraftId === input.actionDraftId && !row.release);
    if (prior) {
      if (!sameOwner(prior, input)) throw new RouteStorageIntegrityError('stock draft ownership is immutable');
      return;
    }
    this.rows.push({ tenantId: input.tenantId, walletAddress: input.walletAddress, actionDraftId: input.actionDraftId,
      release: null, createdAt, sequence: this.rows.length });
  }

  async recordRelease(input: StockActionReleaseV1 & { at: Date }): Promise<void> {
    assertRelease(input);
    const createdAt = input.at.toISOString();
    await this.recordDraft(input);
    const prior = this.rows.find(row => row.release?.blueprintId === input.blueprintId);
    if (prior) {
      if (!sameRelease(prior.release!, input)) throw new RouteStorageIntegrityError('stock release references are immutable');
      return;
    }
    const release = { tenantId: input.tenantId, walletAddress: input.walletAddress, actionDraftId: input.actionDraftId,
      clearanceId: input.clearanceId, blueprintId: input.blueprintId, routeRunId: input.routeRunId };
    this.rows.push({ tenantId: input.tenantId, walletAddress: input.walletAddress, actionDraftId: input.actionDraftId,
      release, createdAt, sequence: this.rows.length });
  }

  async latest(input: StockActionDraftOwnerV1): Promise<StockActionExecutionV1 | null> {
    assertOwner(input);
    const rows = this.rows.filter(row => sameOwner(row, input)).sort((a, b) =>
      Number(Boolean(b.release)) - Number(Boolean(a.release))
      || Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.sequence - a.sequence);
    if (!rows[0]) return null;
    const { sequence: _sequence, ...row } = rows[0];
    return structuredClone(row);
  }
}

function rowV1(row: Record<string, unknown>): StockActionExecutionV1 {
  const owner = { tenantId: String(row.tenant_id), walletAddress: String(row.wallet_address),
    actionDraftId: String(row.action_draft_id) };
  return { ...owner, createdAt: new Date(row.created_at as string | Date).toISOString(),
    release: row.blueprint_id == null ? null : { ...owner, clearanceId: String(row.clearance_id),
      blueprintId: String(row.blueprint_id), routeRunId: String(row.route_run_id) } };
}

export function createDatabaseStockActionExecutionRepositoryV1(sql: SqlTemplateExecutor): StockActionExecutionRepositoryV1 {
  const repository: StockActionExecutionRepositoryV1 = {
    async recordDraft(input) {
      assertOwner(input);
      const at = input.at.toISOString();
      await sql`INSERT INTO stock_action_executions (tenant_id, wallet_address, action_draft_id, created_at)
        VALUES (${input.tenantId}, ${input.walletAddress}, ${input.actionDraftId}, ${at}::timestamptz)
        ON CONFLICT (action_draft_id) WHERE blueprint_id IS NULL DO NOTHING`;
      const rows = await sql`SELECT action_draft_id FROM stock_action_executions
        WHERE action_draft_id = ${input.actionDraftId} AND tenant_id = ${input.tenantId}
          AND wallet_address = ${input.walletAddress} AND blueprint_id IS NULL`;
      if (!rows[0]) throw new RouteStorageIntegrityError('stock draft ownership is immutable');
    },
    async recordRelease(input) {
      assertRelease(input);
      const at = input.at.toISOString();
      // Also covers a browser-created draft that was never prepared over MCP.
      // If the release write fails, no executable payload leaves the service.
      await repository.recordDraft(input);
      await sql`INSERT INTO stock_action_executions
        (tenant_id, wallet_address, action_draft_id, clearance_id, blueprint_id, route_run_id, created_at)
        VALUES (${input.tenantId}, ${input.walletAddress}, ${input.actionDraftId}, ${input.clearanceId},
          ${input.blueprintId}, ${input.routeRunId}, ${at}::timestamptz)
        ON CONFLICT (blueprint_id) DO NOTHING`;
      const rows = await sql`SELECT * FROM stock_action_executions WHERE blueprint_id = ${input.blueprintId}
        AND tenant_id = ${input.tenantId} AND wallet_address = ${input.walletAddress}`;
      if (!rows[0] || !sameRelease(rowV1(rows[0]).release!, input)) {
        throw new RouteStorageIntegrityError('stock release references are immutable');
      }
    },
    async latest(input) {
      assertOwner(input);
      const rows = await sql`SELECT * FROM stock_action_executions
        WHERE tenant_id = ${input.tenantId} AND wallet_address = ${input.walletAddress}
          AND action_draft_id = ${input.actionDraftId}
        ORDER BY (blueprint_id IS NOT NULL) DESC, created_at DESC, id DESC LIMIT 1`;
      return rows[0] ? rowV1(rows[0]) : null;
    },
  };
  return repository;
}
