import {
  McpAuditWriteError,
  assertMcpAuditV1,
  type McpExecutionAuditRepositoryV1,
  type McpExecutionAuditV1,
  type McpHandoffRevocationRepositoryV1,
  type McpHandoffRevocationV1,
} from './mcpExecutionAudit.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed MCP execution audit.
//
// Columns, not a payload document. Every other table in this schema stores the
// document in `payload` and re-parses it on read; this one deliberately does
// not, because a jsonb column is a place an arbitrary object can be written,
// and the entire point of this table is that there is nowhere to put a token
// or a piece of calldata. Reading rebuilds the row from the typed columns and
// validates it, so a hand-edited row fails on the way out as well as in.
// ---------------------------------------------------------------------------

function rowToAuditV1(row: Record<string, unknown>): McpExecutionAuditV1 {
  return assertMcpAuditV1(
    {
      schemaVersion: 'mcp-execution-audit/v1',
      id: String(row.id),
      tokenId: String(row.token_id),
      tenantId: String(row.tenant_id),
      walletAddress: String(row.wallet_address),
      toolName: String(row.tool_name),
      planId: row.plan_id === null || row.plan_id === undefined ? null : String(row.plan_id),
      callsHash: row.calls_hash === null || row.calls_hash === undefined ? null : String(row.calls_hash),
      batchId: row.batch_id === null || row.batch_id === undefined ? null : String(row.batch_id),
      outcome: row.outcome,
      clientKind:
        row.client_kind === null || row.client_kind === undefined ? null : row.client_kind,
      createdAt: new Date(String(row.created_at)).toISOString(),
    },
    'read',
  );
}

export function createDatabaseMcpExecutionAuditRepository(
  sql: SqlTemplateExecutor,
): McpExecutionAuditRepositoryV1 {
  return {
    async record(entry) {
      const row = assertMcpAuditV1(entry, 'write');
      // One statement. `ON CONFLICT DO NOTHING` plus the RETURNING-or-select
      // below makes a retried tool call idempotent without a transaction —
      // Neon over HTTP has no interactive ones.
      const inserted = await sql`
        INSERT INTO mcp_execution_audit (
          id, token_id, tenant_id, wallet_address, tool_name,
          plan_id, calls_hash, batch_id, outcome, client_kind, created_at
        ) VALUES (
          ${row.id}, ${row.tokenId}, ${row.tenantId}, ${row.walletAddress}, ${row.toolName},
          ${row.planId}, ${row.callsHash}, ${row.batchId}, ${row.outcome}, ${row.clientKind},
          ${row.createdAt}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id, token_id, tenant_id, wallet_address, tool_name,
                  plan_id, calls_hash, batch_id, outcome, client_kind, created_at`;
      if (inserted.length > 0) return rowToAuditV1(inserted[0] as Record<string, unknown>);

      const existing = await sql`
        SELECT id, token_id, tenant_id, wallet_address, tool_name,
               plan_id, calls_hash, batch_id, outcome, client_kind, created_at
        FROM mcp_execution_audit WHERE id = ${row.id}`;
      if (existing.length === 0) {
        // Neither inserted nor found: the write did not happen, and for a
        // mandatory outcome the caller must refuse rather than proceed.
        throw new McpAuditWriteError('The MCP audit row was neither written nor found');
      }
      return rowToAuditV1(existing[0] as Record<string, unknown>);
    },

    async listForTenant(query) {
      const limit = Math.max(1, Math.min(200, query.limit ?? 50));
      const rows = await sql`
        SELECT id, token_id, tenant_id, wallet_address, tool_name,
               plan_id, calls_hash, batch_id, outcome, client_kind, created_at
        FROM mcp_execution_audit
        WHERE tenant_id = ${query.tenantId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}`;
      return rows.map((row) => rowToAuditV1(row as Record<string, unknown>));
    },

    async listForPlan(input) {
      const rows = await sql`
        SELECT id, token_id, tenant_id, wallet_address, tool_name,
               plan_id, calls_hash, batch_id, outcome, client_kind, created_at
        FROM mcp_execution_audit
        WHERE tenant_id = ${input.tenantId} AND plan_id = ${input.planId}
        ORDER BY created_at ASC, id ASC`;
      return rows.map((row) => rowToAuditV1(row as Record<string, unknown>));
    },
  };
}

export function createDatabaseMcpHandoffRevocationRepository(
  sql: SqlTemplateExecutor,
): McpHandoffRevocationRepositoryV1 {
  return {
    async revoke(input: McpHandoffRevocationV1) {
      // The first revocation wins: the time something was revoked is not a
      // thing a retry should move forward.
      await sql`
        INSERT INTO mcp_handoff_revocations (token_id, tenant_id, revoked_at, expires_at)
        VALUES (${input.tokenId}, ${input.tenantId}, ${input.revokedAt}, ${input.expiresAt})
        ON CONFLICT (token_id, tenant_id) DO NOTHING`;
    },

    async isRevoked(input) {
      // Tenant is part of the key, so one wallet cannot revoke — or observe —
      // another's session.
      const rows = await sql`
        SELECT 1 FROM mcp_handoff_revocations
        WHERE token_id = ${input.tokenId} AND tenant_id = ${input.tenantId}
        LIMIT 1`;
      return rows.length > 0;
    },

    async listForTenant(tenantId) {
      const rows = await sql`
        SELECT token_id, tenant_id, revoked_at, expires_at
        FROM mcp_handoff_revocations
        WHERE tenant_id = ${tenantId}
        ORDER BY revoked_at DESC`;
      return rows.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          tokenId: String(record.token_id),
          tenantId: String(record.tenant_id),
          revokedAt: new Date(String(record.revoked_at)).toISOString(),
          expiresAt: new Date(String(record.expires_at)).toISOString(),
        };
      });
    },
  };
}
