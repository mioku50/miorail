import {
  assertRepresentationSupplyChangeV1,
  assertRepresentationSupplyObservationV1,
  assertRepresentationSupplyV1,
  supplyStateForAmountV1,
  type RepresentationSupplyChangeV1,
  type RepresentationSupplyObservationV1,
  type RepresentationSupplyRepositoryV1,
  type RepresentationSupplyRowV1,
} from './representationSupply.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToSupplyV1(row: Record<string, unknown>): RepresentationSupplyRowV1 {
  return assertRepresentationSupplyV1({
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    state: String(row.supply_state),
    totalSupplyAtomic: row.total_supply_atomic === null ? null : String(row.total_supply_atomic),
    decimals: row.decimals === null ? null : Number(row.decimals),
    normalization: String(row.normalization),
    blockNumber: String(row.block_number),
    blockHash: String(row.block_hash),
    source: String(row.source),
    evidenceHash: String(row.evidence_hash),
    readOutcome: String(row.read_outcome),
    failureCode: row.failure_code === null ? null : String(row.failure_code),
    observedAt: new Date(row.observed_at as string).toISOString(),
    lastCheckedAt: new Date(row.last_checked_at as string).toISOString(),
    lastChangedAt: row.last_changed_at
      ? new Date(row.last_changed_at as string).toISOString()
      : null,
    reads: Number(row.reads),
    changes: Number(row.changes),
    createdAt: new Date(row.created_at as string).toISOString(),
  });
}

function rowToObservationV1(row: Record<string, unknown>): RepresentationSupplyObservationV1 {
  return assertRepresentationSupplyObservationV1({
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    state: String(row.supply_state),
    totalSupplyAtomic: row.total_supply_atomic === null ? null : String(row.total_supply_atomic),
    decimals: row.decimals === null ? null : Number(row.decimals),
    normalization: String(row.normalization),
    blockNumber: String(row.block_number),
    blockHash: String(row.block_hash),
    source: String(row.source),
    evidenceHash: String(row.evidence_hash),
    readOutcome: String(row.read_outcome),
    failureCode: row.failure_code === null ? null : String(row.failure_code),
    observedAt: new Date(row.observed_at as string).toISOString(),
    recordedAt: new Date(row.recorded_at as string).toISOString(),
  });
}

function rowToChangeV1(row: Record<string, unknown>): RepresentationSupplyChangeV1 {
  return assertRepresentationSupplyChangeV1({
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    fromTotalSupplyAtomic: String(row.from_total_supply_atomic),
    toTotalSupplyAtomic: String(row.to_total_supply_atomic),
    decimals: Number(row.decimals),
    blockNumber: String(row.block_number),
    blockHash: String(row.block_hash),
    evidenceHash: String(row.evidence_hash),
    observedAt: new Date(row.observed_at as string).toISOString(),
    recordedAt: new Date(row.recorded_at as string).toISOString(),
  });
}

export function createDatabaseRepresentationSupplyRepository(
  sql: SqlTemplateExecutor,
): RepresentationSupplyRepositoryV1 {
  return {
    async recordObservation(input) {
      const address = input.tokenAddress.toLowerCase();
      const state = supplyStateForAmountV1(input.totalSupplyAtomic);
      const previous =
        input.readOutcome === 'success'
          ? ((await sql`
            SELECT total_supply_atomic
              FROM representation_supply_observation
             WHERE chain_id = ${input.chainId}
               AND token_address = ${address}
               AND read_outcome = 'success'
             ORDER BY recorded_at DESC, id DESC
             LIMIT 1
          `) as Record<string, unknown>[])
          : [];
      const before = previous[0] ? String(previous[0].total_supply_atomic) : null;

      const inserted = (await sql`
        INSERT INTO representation_supply_observation (
          chain_id, token_address, supply_state, total_supply_atomic, decimals,
          normalization, block_number, block_hash, source, evidence_hash,
          read_outcome, failure_code, observed_at, recorded_at
        ) VALUES (
          ${input.chainId}, ${address}, ${state}, ${input.totalSupplyAtomic}, ${input.decimals},
          'raw_erc20_total_supply', ${input.blockNumber}, ${input.blockHash},
          'erc20_total_supply', ${input.evidenceHash}, ${input.readOutcome},
          ${input.failureCode}, ${input.observedAt}, ${input.now}
        )
        ON CONFLICT (chain_id, token_address, block_number, evidence_hash) DO NOTHING
        RETURNING id
      `) as Record<string, unknown>[];

      if (inserted.length === 0) {
        const current = (await sql`
          SELECT * FROM representation_supply
           WHERE chain_id = ${input.chainId} AND token_address = ${address}
        `) as Record<string, unknown>[];
        return {
          outcome: input.readOutcome === 'success' ? 'unchanged' : 'unresolved',
          row: rowToSupplyV1(current[0]!),
        };
      }

      const moved = before !== null && before !== input.totalSupplyAtomic;
      let transitionRecorded = false;
      if (input.readOutcome === 'success' && moved) {
        const transition = (await sql`
          INSERT INTO representation_supply_change (
            chain_id, token_address, from_total_supply_atomic, to_total_supply_atomic,
            decimals, block_number, block_hash, evidence_hash, observed_at, recorded_at
          ) VALUES (
            ${input.chainId}, ${address}, ${before}, ${input.totalSupplyAtomic}, ${input.decimals},
            ${input.blockNumber}, ${input.blockHash}, ${input.evidenceHash},
            ${input.observedAt}, ${input.now}
          )
          ON CONFLICT (chain_id, token_address, block_number) DO NOTHING
          RETURNING id
        `) as Record<string, unknown>[];
        transitionRecorded = transition.length > 0;
      }

      const current = (await sql`
        INSERT INTO representation_supply (
          chain_id, token_address, supply_state, total_supply_atomic, decimals,
          normalization, block_number, block_hash, source, evidence_hash,
          read_outcome, failure_code, observed_at, last_checked_at,
          last_changed_at, reads, changes, created_at
        ) VALUES (
          ${input.chainId}, ${address}, ${state}, ${input.totalSupplyAtomic}, ${input.decimals},
          'raw_erc20_total_supply', ${input.blockNumber}, ${input.blockHash},
          'erc20_total_supply', ${input.evidenceHash}, ${input.readOutcome},
          ${input.failureCode}, ${input.observedAt}, ${input.now}, ${null}, 1, 0, ${input.now}
        )
        ON CONFLICT (chain_id, token_address) DO UPDATE SET
          supply_state       = EXCLUDED.supply_state,
          total_supply_atomic = EXCLUDED.total_supply_atomic,
          decimals          = EXCLUDED.decimals,
          block_number      = EXCLUDED.block_number,
          block_hash        = EXCLUDED.block_hash,
          evidence_hash     = EXCLUDED.evidence_hash,
          read_outcome      = EXCLUDED.read_outcome,
          failure_code      = EXCLUDED.failure_code,
          observed_at       = EXCLUDED.observed_at,
          last_checked_at   = EXCLUDED.last_checked_at,
          last_changed_at   = CASE WHEN ${transitionRecorded} THEN EXCLUDED.last_checked_at
                                   ELSE representation_supply.last_changed_at END,
          reads             = representation_supply.reads + 1,
          changes           = representation_supply.changes + CASE WHEN ${transitionRecorded} THEN 1 ELSE 0 END
        RETURNING *
      `) as Record<string, unknown>[];

      return {
        outcome:
          input.readOutcome !== 'success'
            ? 'unresolved'
            : before === null
              ? 'first_observation'
              : moved
                ? 'changed'
                : 'unchanged',
        row: rowToSupplyV1(current[0]!),
      };
    },

    async readSupplies(input) {
      const addresses = input.tokenAddresses.map((value) => value.toLowerCase());
      if (addresses.length === 0) return [];
      const rows = (await sql`
        SELECT * FROM representation_supply
         WHERE chain_id = ${input.chainId} AND token_address = ANY(${addresses})
         ORDER BY token_address
      `) as Record<string, unknown>[];
      return rows.map(rowToSupplyV1);
    },

    async recentChanges(input) {
      const rows = (await sql`
        SELECT * FROM representation_supply_change
         WHERE chain_id = ${input.chainId}
         ORDER BY recorded_at DESC, id DESC
         LIMIT ${input.limit}
      `) as Record<string, unknown>[];
      return rows.map(rowToChangeV1);
    },

    async recentObservations(input) {
      const rows = (await sql`
        SELECT * FROM representation_supply_observation
         WHERE chain_id = ${input.chainId}
           AND token_address = ${input.tokenAddress.toLowerCase()}
         ORDER BY recorded_at DESC, id DESC
         LIMIT ${input.limit}
      `) as Record<string, unknown>[];
      return rows.map(rowToObservationV1);
    },
  };
}
