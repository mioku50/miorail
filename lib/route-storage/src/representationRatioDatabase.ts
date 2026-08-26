import {
  RATIO_APPLICATION_BY_KIND_V1,
  RATIO_SCALE_SOURCE_BY_KIND_V1,
  assertRepresentationRatioChangeV1,
  assertRepresentationRatioV1,
  type RatioReadOutcomeV1,
  type RepresentationRatioChangeV1,
  type RepresentationRatioRepositoryV1,
  type RepresentationRatioRowV1,
} from './representationRatio.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToRatioV1(row: Record<string, unknown>): RepresentationRatioRowV1 {
  return assertRepresentationRatioV1(
    {
      chainId: Number(row.chain_id),
      tokenAddress: String(row.token_address),
      ratioKind: String(row.ratio_kind),
      application: String(row.application),
      rawValue: String(row.raw_value),
      scale: String(row.scale),
      scaleSource: String(row.scale_source),
      blockNumber: String(row.block_number),
      blockHash: String(row.block_hash),
      evidenceHash: String(row.evidence_hash),
      observedAt: new Date(row.observed_at as string).toISOString(),
      lastCheckedAt: new Date(row.last_checked_at as string).toISOString(),
      lastChangedAt: row.last_changed_at
        ? new Date(row.last_changed_at as string).toISOString()
        : null,
      reads: Number(row.reads),
      changes: Number(row.changes),
      createdAt: new Date(row.created_at as string).toISOString(),
    },
    'read',
  );
}

function rowToChangeV1(row: Record<string, unknown>): RepresentationRatioChangeV1 {
  return assertRepresentationRatioChangeV1(
    {
      chainId: Number(row.chain_id),
      tokenAddress: String(row.token_address),
      ratioKind: String(row.ratio_kind),
      fromRawValue: String(row.from_raw_value),
      toRawValue: String(row.to_raw_value),
      scale: String(row.scale),
      blockNumber: String(row.block_number),
      blockHash: String(row.block_hash),
      evidenceHash: String(row.evidence_hash),
      observedAt: new Date(row.observed_at as string).toISOString(),
      recordedAt: new Date(row.recorded_at as string).toISOString(),
    },
    'read',
  );
}

export function createDatabaseRepresentationRatioRepository(
  sql: SqlTemplateExecutor,
): RepresentationRatioRepositoryV1 {
  return {
    async recordRead(input) {
      const address = input.tokenAddress.toLowerCase();
      const application = RATIO_APPLICATION_BY_KIND_V1[input.ratioKind];
      // Derived from the kind, never taken from the caller. See the contract.
      const scaleSource = RATIO_SCALE_SOURCE_BY_KIND_V1[input.ratioKind];

      const previous = (await sql`
        SELECT raw_value FROM representation_ratio
         WHERE chain_id = ${input.chainId}
           AND token_address = ${address}
           AND ratio_kind = ${input.ratioKind}
      `) as Record<string, unknown>[];
      const before = previous[0] ? String(previous[0].raw_value) : null;
      const moved = before !== null && before !== input.rawValue;

      // Written first: the transition is the fact, and the state row is a
      // summary of it. `ON CONFLICT DO NOTHING` on (representation, block) is
      // what makes a re-read of the same block idempotent — a caller cannot
      // forget it, because it is not the caller's job.
      let changeRecorded = false;
      if (moved) {
        const inserted = (await sql`
          INSERT INTO representation_ratio_change (
            chain_id, token_address, ratio_kind, from_raw_value, to_raw_value, scale,
            block_number, block_hash, evidence_hash, observed_at, recorded_at
          ) VALUES (
            ${input.chainId}, ${address}, ${input.ratioKind}, ${before}, ${input.rawValue},
            ${input.scale}, ${input.blockNumber}, ${input.blockHash}, ${input.evidenceHash},
            ${input.observedAt}, ${input.now}
          )
          ON CONFLICT (chain_id, token_address, ratio_kind, block_number) DO NOTHING
          RETURNING id
        `) as Record<string, unknown>[];
        changeRecorded = inserted.length > 0;
      }

      const rows = (await sql`
        INSERT INTO representation_ratio (
          chain_id, token_address, ratio_kind, application, raw_value, scale, scale_source,
          block_number, block_hash, evidence_hash, observed_at,
          last_checked_at, last_changed_at, reads, changes, created_at
        ) VALUES (
          ${input.chainId}, ${address}, ${input.ratioKind}, ${application}, ${input.rawValue},
          ${input.scale}, ${scaleSource}, ${input.blockNumber}, ${input.blockHash},
          ${input.evidenceHash}, ${input.observedAt}, ${input.now}, ${null}, 1, 0, ${input.now}
        )
        ON CONFLICT (chain_id, token_address, ratio_kind) DO UPDATE SET
          raw_value       = EXCLUDED.raw_value,
          scale           = EXCLUDED.scale,
          scale_source    = EXCLUDED.scale_source,
          block_number    = EXCLUDED.block_number,
          block_hash      = EXCLUDED.block_hash,
          evidence_hash   = EXCLUDED.evidence_hash,
          observed_at     = EXCLUDED.observed_at,
          last_checked_at = EXCLUDED.last_checked_at,
          last_changed_at = CASE WHEN ${changeRecorded} THEN EXCLUDED.last_checked_at
                                 ELSE representation_ratio.last_changed_at END,
          reads           = representation_ratio.reads + 1,
          changes         = representation_ratio.changes + CASE WHEN ${changeRecorded} THEN 1 ELSE 0 END
        RETURNING *
      `) as Record<string, unknown>[];

      const outcome: RatioReadOutcomeV1 =
        before === null ? 'first_observation' : moved ? 'changed' : 'unchanged';
      return { outcome, row: rowToRatioV1(rows[0]!) };
    },

    async readRatios(input) {
      const addresses = input.tokenAddresses.map((value) => value.toLowerCase());
      if (addresses.length === 0) return [];
      const rows = (await sql`
        SELECT * FROM representation_ratio
         WHERE chain_id = ${input.chainId}
           AND token_address = ANY(${addresses})
         ORDER BY token_address
      `) as Record<string, unknown>[];
      return rows.map(rowToRatioV1);
    },

    async recentChanges(input) {
      const rows = (await sql`
        SELECT * FROM representation_ratio_change
         WHERE chain_id = ${input.chainId}
         ORDER BY recorded_at DESC, id DESC
         LIMIT ${input.limit}
      `) as Record<string, unknown>[];
      return rows.map(rowToChangeV1);
    },
  };
}
