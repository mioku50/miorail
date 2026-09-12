import {
  B20_CORPORATE_ACTION_TAIL_KEY_V1,
  assertB20CorporateActionV1,
  type B20CorporateActionRepositoryV1,
  type B20CorporateActionRowV1,
} from './b20CorporateActions.js';
import { RouteStorageIntegrityError } from './types.js';
import type { SqlTemplateExecutor } from './types.js';

function rowFromDatabaseV1(row: Record<string, unknown>): B20CorporateActionRowV1 {
  return assertB20CorporateActionV1(
    {
      chainId: Number(row.chain_id),
      tokenAddress: row.token_address,
      event: row.event,
      payloadState: row.payload_state,
      announcementId: (row.announcement_id as string | null) ?? null,
      caller: (row.caller as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      uri: (row.uri as string | null) ?? null,
      multiplierWad: row.multiplier_wad === null ? null : String(row.multiplier_wad),
      topics: (row.topics ?? []) as string[],
      data: String(row.data),
      blockNumber: Number(row.block_number),
      blockTime: new Date(row.block_time as string).toISOString(),
      transactionHash: row.transaction_hash,
      logIndex: Number(row.log_index),
      observedAt: new Date(row.observed_at as string).toISOString(),
    },
    'read',
  );
}

export function createDatabaseB20CorporateActionRepository(
  sql: SqlTemplateExecutor,
): B20CorporateActionRepositoryV1 {
  return {
    async recordPass(input) {
      const existing = (await sql`
        SELECT last_block FROM market_tail_cursors
         WHERE tail_key = ${B20_CORPORATE_ACTION_TAIL_KEY_V1} LIMIT 1`) as Record<
        string,
        unknown
      >[];
      const lastBlock = existing[0] ? Number(existing[0].last_block) : null;
      if (lastBlock !== null && input.toBlock < lastBlock) {
        throw new RouteStorageIntegrityError(
          `refusing to move the ${B20_CORPORATE_ACTION_TAIL_KEY_V1} cursor back from ${lastBlock} to ${input.toBlock}: a tail that rewinds re-scans history while appearing to work`,
        );
      }

      let inserted = 0;
      let duplicates = 0;
      for (const candidate of input.rows) {
        const row = assertB20CorporateActionV1(candidate, 'write');
        const written = (await sql`
          INSERT INTO b20_corporate_actions (
            chain_id, token_address, event, announcement_id, caller, description, uri,
            multiplier_wad, payload_state, topics, data, block_number, block_time,
            transaction_hash, log_index, observed_at
          ) VALUES (
            ${row.chainId}, ${row.tokenAddress}, ${row.event}, ${row.announcementId},
            ${row.caller}, ${row.description}, ${row.uri}, ${row.multiplierWad},
            ${row.payloadState}, ${JSON.stringify(row.topics)}::text::jsonb, ${row.data},
            ${row.blockNumber}::bigint, ${row.blockTime}::timestamptz,
            ${row.transactionHash}, ${row.logIndex}, ${row.observedAt}::timestamptz
          )
          ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING
          RETURNING id`) as Record<string, unknown>[];
        if (written.length > 0) inserted += 1;
        else duplicates += 1;
      }

      const [cursorRow] = (await sql`
        INSERT INTO market_tail_cursors (
          tail_key, chain_id, last_block, last_run_at, passes, log_calls, identity_calls,
          events_written, first_block
        ) VALUES (
          ${B20_CORPORATE_ACTION_TAIL_KEY_V1}, ${input.chainId}, ${input.toBlock}::bigint,
          ${input.observedAt}::timestamptz, 1, ${input.logCalls}::bigint, 0, ${inserted}::bigint,
          ${input.fromBlock}::bigint
        )
        ON CONFLICT (tail_key) DO UPDATE SET
          chain_id = EXCLUDED.chain_id,
          last_block = GREATEST(market_tail_cursors.last_block, EXCLUDED.last_block),
          last_run_at = EXCLUDED.last_run_at,
          passes = market_tail_cursors.passes + 1,
          log_calls = market_tail_cursors.log_calls + EXCLUDED.log_calls,
          events_written = market_tail_cursors.events_written + EXCLUDED.events_written
          -- first_block is deliberately absent: where a record STARTED is
          -- written once and never moved, or the range it claims to cover
          -- shrinks every hour while looking like it grew.
        RETURNING last_block`) as Record<string, unknown>[];

      return { inserted, duplicates, lastBlock: Number(cursorRow!.last_block) };
    },

    async coverage(input) {
      const [cursor] = (await sql`
        SELECT first_block, last_block FROM market_tail_cursors
         WHERE tail_key = ${B20_CORPORATE_ACTION_TAIL_KEY_V1} LIMIT 1`) as Record<
        string,
        unknown
      >[];
      const [counted] = (await sql`
        SELECT count(*)::int AS actions FROM b20_corporate_actions
         WHERE chain_id = ${input.chainId}`) as Record<string, unknown>[];
      return {
        firstBlock: cursor?.first_block == null ? null : Number(cursor.first_block),
        lastBlock: cursor?.last_block == null ? null : Number(cursor.last_block),
        actions: Number(counted?.actions ?? 0),
      };
    },

    async actionsFor(input) {
      const limit = Math.max(1, Math.min(200, input.limit));
      const rows = (await sql`
        SELECT * FROM b20_corporate_actions
         WHERE chain_id = ${input.chainId}
           AND token_address = ${input.tokenAddress.toLowerCase()}
         ORDER BY block_time DESC, id DESC
         LIMIT ${limit}`) as Record<string, unknown>[];
      return rows.map(rowFromDatabaseV1);
    },

    async recentActions(input) {
      const limit = Math.max(1, Math.min(200, input.limit));
      const since = input.since ?? null;
      const rows = (await sql`
        SELECT * FROM b20_corporate_actions
         WHERE chain_id = ${input.chainId}
           -- Inclusive, and on block_time rather than observed_at: the caller
           -- is asking when the action executed, not when a pass noticed it.
           AND (${since}::timestamptz IS NULL OR block_time >= ${since}::timestamptz)
         ORDER BY block_time DESC, id DESC
         LIMIT ${limit}`) as Record<string, unknown>[];
      return rows.map(rowFromDatabaseV1);
    },
  };
}
