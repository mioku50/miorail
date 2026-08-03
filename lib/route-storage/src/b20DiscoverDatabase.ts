import {
  assertDiscoverCursorV1,
  assertDiscoverRunV1,
  assertStoredLaunchV1,
  discoverCommitRefusalV1,
  discoverConflictV1,
  discoverCursorIdV1,
  type B20DiscoverCommitResultV1,
  type B20DiscoverCursorV1,
  type B20DiscoverRepositoryV1,
  type B20DiscoverRewindResultV1,
  type B20DiscoverRunV1,
  type B20StoredLaunchV1,
} from './b20Discover.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed B20DiscoverRepositoryV1.
//
// THE ATOMICITY RULE, and how it is met here:
//
//   The launches from a range and the cursor that claims to have finished that
//   range must become durable together or not at all. This codebase runs on
//   Neon over HTTP, which has no interactive transactions — so `commitRange`
//   and `rewindForReorg` are each ONE statement. A single statement is one
//   transaction, and the writes inside it are gated on each other with CTEs:
//   the cursor UPDATE comes first, and the launch INSERT is cross-joined to its
//   result, so a cursor that did not move inserts nothing.
//
//   This is the same shape as `reserveIntelligenceBudget` in database.ts, and
//   for the same reason: the alternative is two round trips with a window
//   between them where a crash leaves the cursor past launches nobody stored.
//
// Rows are re-parsed on read. A row that stopped satisfying its own schema is
// refused rather than used to advance a cursor.
// ---------------------------------------------------------------------------

/** Postgres hands timestamps back as Date and numerics back as string. Neither
 * shape is what the schema declares, so both are normalised here rather than
 * in five call sites. */
function isoV1(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function isoOrNullV1(value: unknown): string | null {
  return value === null || value === undefined ? null : isoV1(value);
}

function digitsV1(value: unknown): string {
  return String(value);
}

function rowToCursorV1(row: Record<string, unknown>): B20DiscoverCursorV1 {
  return assertDiscoverCursorV1({
    id: row.id,
    chainId: Number(row.chain_id),
    factoryAddress: row.factory_address,
    decoderVersion: row.decoder_version,
    lastProcessedBlock: digitsV1(row.last_processed_block),
    lastProcessedBlockHash: row.last_processed_block_hash ?? null,
    operatorState: row.operator_state ?? null,
    lastRunId: row.last_run_id ?? null,
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: isoOrNullV1(row.lease_expires_at),
    createdAt: isoV1(row.created_at),
    updatedAt: isoV1(row.updated_at),
  });
}

function rowToRunV1(row: Record<string, unknown>): B20DiscoverRunV1 {
  return assertDiscoverRunV1({
    id: row.id,
    chainId: Number(row.chain_id),
    factoryAddress: row.factory_address,
    decoderVersion: row.decoder_version,
    startedAt: isoV1(row.started_at),
    finishedAt: isoV1(row.finished_at),
    startCursorBlock: digitsV1(row.start_cursor_block),
    endCursorBlock: digitsV1(row.end_cursor_block),
    confirmedHead: row.confirmed_head === null ? null : digitsV1(row.confirmed_head),
    scannedFromBlock: row.scanned_from_block === null ? null : digitsV1(row.scanned_from_block),
    scannedToBlock: row.scanned_to_block === null ? null : digitsV1(row.scanned_to_block),
    launchesRead: Number(row.launches_read),
    launchesInserted: Number(row.launches_inserted),
    duplicates: Number(row.duplicates),
    budgetExhausted: Boolean(row.budget_exhausted),
    operatorState: row.operator_state ?? null,
    errorCategory: row.error_category ?? null,
    result: row.result,
  });
}

function rowToLaunchV1(row: Record<string, unknown>): B20StoredLaunchV1 {
  return assertStoredLaunchV1({
    id: row.id,
    chainId: Number(row.chain_id),
    factoryAddress: row.factory_address,
    tokenAddress: row.token_address,
    variant: row.variant,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals === null ? null : Number(row.decimals),
    blockNumber: digitsV1(row.block_number),
    blockHash: row.block_hash,
    transactionHash: row.transaction_hash,
    transactionIndex: row.transaction_index === null ? null : Number(row.transaction_index),
    logIndex: Number(row.log_index),
    detectedAt: isoV1(row.detected_at),
    confirmationCount: Number(row.confirmation_count),
    decoderVersion: row.decoder_version,
    canonical: Boolean(row.canonical),
    nonCanonicalAt: isoOrNullV1(row.non_canonical_at),
    createdAt: isoV1(row.created_at),
  });
}

/**
 * Launches as ONE jsonb parameter.
 *
 * Building a VALUES list by interpolation would be both unsafe and unbounded in
 * parameter count; `jsonb_to_recordset` is a single parameter whatever the
 * batch size.
 *
 * The `::text::jsonb` double cast at the call site is not decorative:
 * postgres-js infers a json parameter type from the surrounding cast and sends
 * the string as a JSON *string scalar*, which `jsonb_to_recordset` refuses
 * outright. Going through text forces the server to parse it as an array. Neon
 * sends every parameter as text already, so it is unaffected either way.
 */
function launchesPayloadV1(launches: readonly B20StoredLaunchV1[]): string {
  return JSON.stringify(
    launches.map((launch) => ({
      id: launch.id,
      chain_id: launch.chainId,
      factory_address: launch.factoryAddress,
      token_address: launch.tokenAddress,
      variant: launch.variant,
      name: launch.name,
      symbol: launch.symbol,
      decimals: launch.decimals,
      block_number: launch.blockNumber,
      block_hash: launch.blockHash,
      transaction_hash: launch.transactionHash,
      transaction_index: launch.transactionIndex,
      log_index: launch.logIndex,
      detected_at: launch.detectedAt,
      confirmation_count: launch.confirmationCount,
      decoder_version: launch.decoderVersion,
      created_at: launch.createdAt,
    })),
  );
}

export function createDatabaseB20DiscoverRepository(sql: SqlTemplateExecutor): B20DiscoverRepositoryV1 {
  const readCursor = async (id: string): Promise<B20DiscoverCursorV1 | null> => {
    const rows = await sql`SELECT * FROM b20_discover_cursors WHERE id = ${id} LIMIT 1`;
    return rows[0] ? rowToCursorV1(rows[0] as Record<string, unknown>) : null;
  };

  return {
    async getCursor(key) {
      return readCursor(discoverCursorIdV1(key));
    },

    async initialiseCursor(input) {
      const id = discoverCursorIdV1(input.key);
      // DO NOTHING, not DO UPDATE. An existing cursor always wins over
      // configuration: a start block that moved a live cursor would re-read or,
      // far worse, skip everything between.
      await sql`
        INSERT INTO b20_discover_cursors (
          id, chain_id, factory_address, decoder_version,
          last_processed_block, last_processed_block_hash, created_at, updated_at
        ) VALUES (
          ${id}, ${input.key.chainId}, ${input.key.factoryAddress}, ${input.key.decoderVersion},
          ${input.startBlock}::numeric(78,0), NULL, ${input.now}::timestamptz, ${input.now}::timestamptz
        )
        ON CONFLICT (id) DO NOTHING`;
      const cursor = await readCursor(id);
      if (!cursor) throw discoverConflictV1('The discover cursor vanished immediately after initialisation');
      return cursor;
    },

    async acquireWorkerLease(input) {
      const id = discoverCursorIdV1(input.key);
      const expiresAt = new Date(Date.parse(input.now) + input.ttlMs).toISOString();
      // A held, unexpired lease owned by somebody else simply does not match.
      // The caller exits `run_already_active` rather than waiting — a queued
      // second worker is a slower double read, not a safer one.
      const rows = await sql`
        UPDATE b20_discover_cursors
        SET lease_owner = ${input.owner},
            lease_expires_at = ${expiresAt}::timestamptz,
            updated_at = ${input.now}::timestamptz
        WHERE id = ${id}
          AND (lease_owner IS NULL OR lease_owner = ${input.owner} OR lease_expires_at <= ${input.now}::timestamptz)
        RETURNING *`;
      return rows[0] ? rowToCursorV1(rows[0] as Record<string, unknown>) : null;
    },

    async releaseWorkerLease(input) {
      await sql`
        UPDATE b20_discover_cursors
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ${input.now}::timestamptz
        WHERE id = ${discoverCursorIdV1(input.key)} AND lease_owner = ${input.owner}`;
    },

    async commitRange(input): Promise<B20DiscoverCommitResultV1> {
      const id = discoverCursorIdV1(input.key);
      const run = assertDiscoverRunV1(input.run, 'write');
      const launches = input.launches.map((launch) => assertStoredLaunchV1(launch, 'write'));
      const cursor = await readCursor(id);
      if (!cursor) throw discoverConflictV1('No discover cursor exists for this lane');
      const refusal = discoverCommitRefusalV1({
        cursor,
        launches,
        nextBlock: input.nextBlock,
        nextBlockHash: input.nextBlockHash,
      });
      if (refusal) throw discoverConflictV1(refusal);

      // ONE statement. The cursor moves first and everything else is gated on
      // it having moved, so a lost lease or a cursor another worker already
      // advanced writes nothing at all — not a launch, not a run row.
      const rows = await sql`
        WITH moved AS (
          UPDATE b20_discover_cursors
          SET last_processed_block = ${input.nextBlock}::numeric(78,0),
              last_processed_block_hash = ${input.nextBlockHash},
              operator_state = NULL,
              last_run_id = ${run.id},
              updated_at = ${input.now}::timestamptz
          WHERE id = ${id}
            AND lease_owner = ${input.owner}
            AND lease_expires_at > ${input.now}::timestamptz
            AND last_processed_block < ${input.nextBlock}::numeric(78,0)
          RETURNING id
        ), stored AS (
          INSERT INTO b20_launches (
            id, chain_id, factory_address, token_address, variant, name, symbol, decimals,
            block_number, block_hash, transaction_hash, transaction_index, log_index,
            detected_at, confirmation_count, decoder_version, canonical, non_canonical_at, created_at
          )
          SELECT j.id, j.chain_id, j.factory_address, j.token_address, j.variant, j.name, j.symbol,
                 j.decimals, j.block_number::numeric(78,0), j.block_hash, j.transaction_hash,
                 j.transaction_index, j.log_index, j.detected_at::timestamptz, j.confirmation_count,
                 j.decoder_version, true, NULL::timestamptz, j.created_at::timestamptz
          FROM jsonb_to_recordset(${launchesPayloadV1(launches)}::text::jsonb) AS j(
            id text, chain_id integer, factory_address text, token_address text, variant text,
            name text, symbol text, decimals integer, block_number text, block_hash text,
            transaction_hash text, transaction_index integer, log_index integer,
            detected_at text, confirmation_count integer, decoder_version text, created_at text
          )
          CROSS JOIN moved
          ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING
          RETURNING id
        ), recorded AS (
          INSERT INTO b20_discover_runs (
            id, chain_id, factory_address, decoder_version, started_at, finished_at,
            start_cursor_block, end_cursor_block, confirmed_head, scanned_from_block, scanned_to_block,
            launches_read, launches_inserted, duplicates, budget_exhausted,
            operator_state, error_category, result
          )
          SELECT ${run.id}, ${run.chainId}, ${run.factoryAddress}, ${run.decoderVersion},
                 ${run.startedAt}::timestamptz, ${run.finishedAt}::timestamptz,
                 ${run.startCursorBlock}::numeric(78,0), ${run.endCursorBlock}::numeric(78,0),
                 ${run.confirmedHead}::numeric(78,0), ${run.scannedFromBlock}::numeric(78,0),
                 ${run.scannedToBlock}::numeric(78,0), ${run.launchesRead},
                 -- Counted inside the same statement, because the caller cannot
                 -- know how many of its launches were already stored.
                 (SELECT count(*) FROM stored)::int,
                 ${launches.length} - (SELECT count(*) FROM stored)::int,
                 ${run.budgetExhausted}, ${run.operatorState}, ${run.errorCategory}, ${run.result}
          FROM moved
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        )
        SELECT (SELECT count(*) FROM moved)::int AS moved,
               (SELECT count(*) FROM stored)::int AS stored`;

      const moved = Number(rows[0]?.moved ?? 0) > 0;
      const inserted = Number(rows[0]?.stored ?? 0);
      if (!moved) {
        // The lease was lost or another worker got there first. Nothing was
        // written — reported rather than thrown, because losing a race is an
        // ordinary outcome for a job that may run from a timer.
        return { committed: false, inserted: 0, duplicates: 0, cursor };
      }
      return {
        committed: true,
        inserted,
        duplicates: launches.length - inserted,
        cursor: await readCursor(id),
      };
    },

    async recordFailedRun(input) {
      const run = assertDiscoverRunV1(input.run, 'write');
      await sql`
        INSERT INTO b20_discover_runs (
          id, chain_id, factory_address, decoder_version, started_at, finished_at,
          start_cursor_block, end_cursor_block, confirmed_head, scanned_from_block, scanned_to_block,
          launches_read, launches_inserted, duplicates, budget_exhausted,
          operator_state, error_category, result
        ) VALUES (
          ${run.id}, ${run.chainId}, ${run.factoryAddress}, ${run.decoderVersion},
          ${run.startedAt}::timestamptz, ${run.finishedAt}::timestamptz,
          ${run.startCursorBlock}::numeric(78,0), ${run.endCursorBlock}::numeric(78,0),
          ${run.confirmedHead}::numeric(78,0), ${run.scannedFromBlock}::numeric(78,0),
          ${run.scannedToBlock}::numeric(78,0), ${run.launchesRead}, ${run.launchesInserted},
          ${run.duplicates}, ${run.budgetExhausted}, ${run.operatorState}, ${run.errorCategory}, ${run.result}
        )
        ON CONFLICT (id) DO NOTHING`;
      if (input.operatorState) {
        // Stamped so an operator opening the cursor sees why ingestion stopped.
        // The block is deliberately untouched: a failed run read nothing.
        await sql`
          UPDATE b20_discover_cursors
          SET operator_state = ${input.operatorState}, last_run_id = ${run.id}, updated_at = ${run.finishedAt}::timestamptz
          WHERE id = ${discoverCursorIdV1(input.key)}`;
      }
    },

    async rewindForReorg(input): Promise<B20DiscoverRewindResultV1> {
      const id = discoverCursorIdV1(input.key);
      const run = assertDiscoverRunV1(input.run, 'write');
      if (!(await readCursor(id))) throw discoverConflictV1('No discover cursor exists for this lane');
      // Same shape as commitRange and for the same reason: marking launches
      // non-canonical without rewinding the cursor would leave the feed
      // claiming to have read blocks that no longer exist.
      const rows = await sql`
        WITH moved AS (
          UPDATE b20_discover_cursors
          SET last_processed_block = ${input.rewindToBlock}::numeric(78,0),
              last_processed_block_hash = ${input.rewindToBlockHash},
              operator_state = 'reorg_rewound',
              last_run_id = ${run.id},
              updated_at = ${input.now}::timestamptz
          WHERE id = ${id}
            AND lease_owner = ${input.owner}
            AND lease_expires_at > ${input.now}::timestamptz
            AND last_processed_block > ${input.rewindToBlock}::numeric(78,0)
          RETURNING id
        ), marked AS (
          UPDATE b20_launches
          SET canonical = false, non_canonical_at = ${input.now}::timestamptz
          WHERE chain_id = ${input.key.chainId}
            AND factory_address = ${input.key.factoryAddress}
            AND decoder_version = ${input.key.decoderVersion}
            AND block_number > ${input.rewindToBlock}::numeric(78,0)
            AND canonical
            AND EXISTS (SELECT 1 FROM moved)
          RETURNING id
        ), recorded AS (
          INSERT INTO b20_discover_runs (
            id, chain_id, factory_address, decoder_version, started_at, finished_at,
            start_cursor_block, end_cursor_block, confirmed_head, scanned_from_block, scanned_to_block,
            launches_read, launches_inserted, duplicates, budget_exhausted,
            operator_state, error_category, result
          )
          SELECT ${run.id}, ${run.chainId}, ${run.factoryAddress}, ${run.decoderVersion},
                 ${run.startedAt}::timestamptz, ${run.finishedAt}::timestamptz,
                 ${run.startCursorBlock}::numeric(78,0), ${run.endCursorBlock}::numeric(78,0),
                 ${run.confirmedHead}::numeric(78,0), ${run.scannedFromBlock}::numeric(78,0),
                 ${run.scannedToBlock}::numeric(78,0), ${run.launchesRead}, ${run.launchesInserted},
                 ${run.duplicates}, ${run.budgetExhausted}, ${run.operatorState},
                 ${run.errorCategory}, ${run.result}
          FROM moved
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        )
        SELECT (SELECT count(*) FROM moved)::int AS moved,
               (SELECT count(*) FROM marked)::int AS marked`;

      const rewound = Number(rows[0]?.moved ?? 0) > 0;
      return {
        rewound,
        markedNonCanonical: Number(rows[0]?.marked ?? 0),
        cursor: await readCursor(id),
      };
    },

    async listRecentRuns(input) {
      const rows = await sql`
        SELECT * FROM b20_discover_runs
        WHERE chain_id = ${input.key.chainId}
          AND factory_address = ${input.key.factoryAddress}
          AND decoder_version = ${input.key.decoderVersion}
        ORDER BY started_at DESC, id DESC
        LIMIT ${Math.max(1, Math.min(200, input.limit))}`;
      return rows.map((row) => rowToRunV1(row as Record<string, unknown>));
    },

    async listLaunches(input) {
      const rows = input.includeNonCanonical
        ? await sql`
            SELECT * FROM b20_launches
            WHERE chain_id = ${input.key.chainId}
              AND factory_address = ${input.key.factoryAddress}
              AND decoder_version = ${input.key.decoderVersion}
            ORDER BY block_number DESC, log_index DESC
            LIMIT ${Math.max(1, Math.min(500, input.limit))}`
        : await sql`
            SELECT * FROM b20_launches
            WHERE chain_id = ${input.key.chainId}
              AND factory_address = ${input.key.factoryAddress}
              AND decoder_version = ${input.key.decoderVersion}
              AND canonical
            ORDER BY block_number DESC, log_index DESC
            LIMIT ${Math.max(1, Math.min(500, input.limit))}`;
      return rows.map((row) => rowToLaunchV1(row as Record<string, unknown>));
    },
  };
}
