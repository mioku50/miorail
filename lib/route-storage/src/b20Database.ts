import type { B20ControlSnapshotV1 } from '@mioagent/b20-control';
import {
  assertB20SnapshotV1,
  b20ConflictV1,
  b20SnapshotWriteEffectV1,
  type B20SnapshotRecordV1,
  type B20StorageRepositoryV1,
  type InsertB20SnapshotInputV1,
} from './b20.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed B20StorageRepositoryV1.
//
// The immutability guarantee is the DATABASE'S. `INSERT … ON CONFLICT DO
// NOTHING` against `b20_snapshots_tenant_token_block_unique` means a second
// inspection at the same block cannot overwrite the first: it inserts nothing
// and the stored row is read back, so what a user already saw stays what the
// record says. Evidence attaches through a composite foreign key that carries
// the block number, so a record read at a different block is refused by the
// schema rather than by a comment.
// ---------------------------------------------------------------------------

function jsonb(value: unknown): string {
  return JSON.stringify(value);
}

function rowToRecordV1(row: Record<string, unknown>): B20SnapshotRecordV1 {
  const snapshot = assertB20SnapshotV1(row.payload, 'read');
  return {
    id: String(row.id),
    userId: String(row.user_id),
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    snapshotHash: String(row.snapshot_hash),
    identityHash: String(row.identity_hash),
    blockNumber: row.block_number === null ? null : String(row.block_number),
    blockHash: row.block_hash === null ? null : String(row.block_hash),
    observedAt: new Date(String(row.observed_at)).toISOString(),
    snapshot,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function createDatabaseB20StorageRepository(sql: SqlTemplateExecutor): B20StorageRepositoryV1 {
  async function findByUniqueKey(
    userId: string,
    snapshot: B20ControlSnapshotV1,
  ): Promise<B20SnapshotRecordV1 | null> {
    const rows = snapshot.blockNumber === null
      ? await sql`
          SELECT id, user_id, chain_id, token_address, snapshot_hash, identity_hash,
          block_number, block_hash, observed_at, payload, created_at FROM b20_control_snapshots
          WHERE user_id = ${userId} AND token_address = ${snapshot.tokenAddress}
            AND block_number IS NULL
          LIMIT 1`
      : await sql`
          SELECT id, user_id, chain_id, token_address, snapshot_hash, identity_hash,
          block_number, block_hash, observed_at, payload, created_at FROM b20_control_snapshots
          WHERE user_id = ${userId} AND token_address = ${snapshot.tokenAddress}
            AND block_number = ${snapshot.blockNumber}
          LIMIT 1`;
    const row = rows[0];
    return row ? rowToRecordV1(row as Record<string, unknown>) : null;
  }

  return {
    async insertSnapshot(input: InsertB20SnapshotInputV1): Promise<B20SnapshotRecordV1> {
      const snapshot = assertB20SnapshotV1(input.snapshot, 'write');
      const existing = await findByUniqueKey(input.userId, snapshot);
      const decision = b20SnapshotWriteEffectV1(existing, snapshot);
      if (decision.effect === 'conflict') throw b20ConflictV1(decision.reason);
      if (decision.effect === 'return_existing') return existing!;

      const inserted = await sql`
        INSERT INTO b20_control_snapshots (
          id, user_id, chain_id, token_address, schema_version, status,
          snapshot_hash, identity_hash, detection_outcome, variant,
          block_number, block_hash, observed_at, payload
        ) VALUES (
          ${snapshot.id}, ${input.userId}, ${snapshot.chainId}, ${snapshot.tokenAddress},
          ${snapshot.schemaVersion}, ${snapshot.status}, ${snapshot.snapshotHash},
          ${snapshot.identityHash}, ${snapshot.detection.outcome}, ${snapshot.detection.variant},
          ${snapshot.blockNumber}, ${snapshot.blockHash}, ${snapshot.observedAt},
          ${jsonb(snapshot)}::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING id, user_id, chain_id, token_address, snapshot_hash, identity_hash,
          block_number, block_hash, observed_at, payload, created_at`;

      // Losing the race is not an error: the winner wrote the same block, and
      // the stored row is the answer. A DIFFERENT snapshot for that block is
      // caught by the decision above on the re-read.
      if (inserted.length === 0) {
        const raced = await findByUniqueKey(input.userId, snapshot);
        if (!raced) throw b20ConflictV1('The snapshot could not be stored or re-read');
        const recheck = b20SnapshotWriteEffectV1(raced, snapshot);
        if (recheck.effect === 'conflict') throw b20ConflictV1(recheck.reason);
        return raced;
      }

      for (const record of snapshot.evidence) {
        await sql`
          INSERT INTO b20_control_evidence (
            id, snapshot_id, user_id, evidence_hash, chain_id, token_address, target,
            block_number, block_hash, method_signature, selector, raw_response_hash,
            decoded_value, revert_selector, observed_at, verification, source_version
          ) VALUES (
            ${`${snapshot.id}:${record.evidenceHash.slice(2, 18)}`}, ${snapshot.id}, ${input.userId},
            ${record.evidenceHash}, ${record.chainId}, ${record.tokenAddress}, ${record.target},
            ${record.blockNumber}, ${record.blockHash}, ${record.methodSignature}, ${record.selector},
            ${record.rawResponseHash}, ${record.decodedValue}, ${record.revertSelector},
            ${record.observedAt}, ${record.verification}, ${record.sourceVersion}
          )
          ON CONFLICT DO NOTHING`;
      }

      return rowToRecordV1(inserted[0] as Record<string, unknown>);
    },

    async getSnapshot(id: string, userId: string): Promise<B20SnapshotRecordV1 | null> {
      const rows = await sql`
        SELECT id, user_id, chain_id, token_address, snapshot_hash, identity_hash,
          block_number, block_hash, observed_at, payload, created_at FROM b20_control_snapshots
        WHERE id = ${id} AND user_id = ${userId}
        LIMIT 1`;
      const row = rows[0];
      return row ? rowToRecordV1(row as Record<string, unknown>) : null;
    },

    async latestSnapshot(userId: string, tokenAddress: string): Promise<B20SnapshotRecordV1 | null> {
      const rows = await sql`
        SELECT id, user_id, chain_id, token_address, snapshot_hash, identity_hash,
          block_number, block_hash, observed_at, payload, created_at FROM b20_control_snapshots
        WHERE user_id = ${userId} AND token_address = ${tokenAddress.toLowerCase()}
        ORDER BY observed_at DESC
        LIMIT 1`;
      const row = rows[0];
      return row ? rowToRecordV1(row as Record<string, unknown>) : null;
    },
  };
}
