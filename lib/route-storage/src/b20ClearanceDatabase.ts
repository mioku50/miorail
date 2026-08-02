import {
  assertClearanceV1,
  clearanceConflictV1,
  type B20ClearanceRepositoryV1,
  type B20OpportunityClearanceV1,
} from './b20Clearance.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed B20ClearanceRepositoryV1.
//
// The whole document lives in `payload` and is re-parsed on read: a row that
// stopped satisfying its own schema is refused rather than used to authorise a
// preparation. The scalar columns exist only to be queried and indexed.
// ---------------------------------------------------------------------------

function rowToClearanceV1(row: Record<string, unknown>): B20OpportunityClearanceV1 {
  return assertClearanceV1(row.payload, 'read');
}

export function createDatabaseB20ClearanceRepository(
  sql: SqlTemplateExecutor,
): B20ClearanceRepositoryV1 {
  return {
    async insertClearance(clearance) {
      const parsed = assertClearanceV1(clearance, 'write');
      const inserted = await sql`
        INSERT INTO b20_opportunity_clearances (
          id, tenant_id, wallet_address, chain_id, token_address,
          profile_identity, control_snapshot_hash, entry_route_hash,
          simulation_evidence_hash, expires_at, payload
        ) VALUES (
          ${parsed.id}, ${parsed.tenantId}, ${parsed.walletAddress}, ${parsed.chainId},
          ${parsed.tokenAddress}, ${parsed.profileIdentity}, ${parsed.controlSnapshotHash},
          ${parsed.entryRouteHash}, ${parsed.simulationEvidenceHash}, ${parsed.expiresAt},
          ${JSON.stringify(parsed)}::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING id, tenant_id, payload, expires_at, created_at`;
      if (inserted.length > 0) return rowToClearanceV1(inserted[0] as Record<string, unknown>);

      // The id already exists. Byte-identical is an ordinary retry; anything
      // else is two records claiming one id, and neither silently wins.
      const existing = await sql`
        SELECT id, tenant_id, payload, expires_at, created_at FROM b20_opportunity_clearances
        WHERE id = ${parsed.id} LIMIT 1`;
      if (!existing[0]) throw clearanceConflictV1('The clearance could not be stored or re-read');
      const stored = rowToClearanceV1(existing[0] as Record<string, unknown>);
      if (JSON.stringify(stored) !== JSON.stringify(parsed)) {
        throw clearanceConflictV1('A different clearance already exists with this id');
      }
      return stored;
    },

    async getClearance(id, tenantId) {
      const rows = await sql`
        SELECT id, tenant_id, payload, expires_at, created_at FROM b20_opportunity_clearances
        WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1`;
      return rows[0] ? rowToClearanceV1(rows[0] as Record<string, unknown>) : null;
    },

    async latestClearance(input) {
      const rows = await sql`
        SELECT id, tenant_id, payload, expires_at, created_at FROM b20_opportunity_clearances
        WHERE tenant_id = ${input.tenantId}
          AND wallet_address = ${input.walletAddress.toLowerCase()}
          AND token_address = ${input.tokenAddress.toLowerCase()}
          AND profile_identity = ${input.profileIdentity}
          AND expires_at > ${input.now.toISOString()}
        ORDER BY created_at DESC, id DESC
        LIMIT 1`;
      return rows[0] ? rowToClearanceV1(rows[0] as Record<string, unknown>) : null;
    },
  };
}
