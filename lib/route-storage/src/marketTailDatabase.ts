import {
  MarketVenueUnidentifiedError,
  assertMarketVenueTransferV1,
  assertMarketVenueV1,
  venueMayCarryTradesV1,
  type MarketTailCursorV1,
  type MarketTailRepositoryV1,
  type MarketVenueActivityV1,
  type MarketVenueTransferRowV1,
  type MarketVenueKindV1,
  type MarketVenueRowV1,
} from './marketTail.js';
import { RouteStorageIntegrityError } from './types.js';
import type { SqlTemplateExecutor } from './types.js';

function venueFromRowV1(row: Record<string, unknown>): MarketVenueRowV1 {
  return assertMarketVenueV1(
    {
      chainId: Number(row.chain_id),
      address: row.address,
      kind: row.kind,
      token0: (row.token0 as string | null) ?? null,
      token1: (row.token1 as string | null) ?? null,
      firstSeenAt: new Date(row.first_seen_at as string).toISOString(),
      identifiedAt: row.identified_at ? new Date(row.identified_at as string).toISOString() : null,
    },
    'read',
  );
}

function eventFromRowV1(row: Record<string, unknown>): MarketVenueTransferRowV1 {
  return assertMarketVenueTransferV1(
    {
      chainId: Number(row.chain_id),
      tokenAddress: row.token_address,
      venueAddress: row.venue_address,
      direction: row.direction,
      counterparty: row.counterparty,
      amountAtomic: String(row.amount_atomic),
      blockNumber: Number(row.block_number),
      transactionHash: row.transaction_hash,
      logIndex: Number(row.log_index),
      observedAt: new Date(row.observed_at as string).toISOString(),
    },
    'read',
  );
}

function cursorFromRowV1(row: Record<string, unknown>): MarketTailCursorV1 {
  return {
    tailKey: String(row.tail_key),
    chainId: Number(row.chain_id),
    lastBlock: Number(row.last_block),
    lastRunAt: new Date(row.last_run_at as string).toISOString(),
    passes: Number(row.passes),
    logCalls: Number(row.log_calls),
    identityCalls: Number(row.identity_calls),
    eventsWritten: Number(row.events_written),
  };
}

export function createDatabaseMarketTailRepository(sql: SqlTemplateExecutor): MarketTailRepositoryV1 {
  return {
    async readCursor(input) {
      const rows = (await sql`
        SELECT * FROM market_tail_cursors WHERE tail_key = ${input.tailKey} LIMIT 1`) as Record<
        string,
        unknown
      >[];
      return rows[0] ? cursorFromRowV1(rows[0]) : null;
    },

    async recordPass(input) {
      const existingRows = (await sql`
        SELECT * FROM market_tail_cursors WHERE tail_key = ${input.tailKey} LIMIT 1`) as Record<
        string,
        unknown
      >[];
      const existing = existingRows[0] ? cursorFromRowV1(existingRows[0]) : null;
      if (existing && input.toBlock < existing.lastBlock) {
        throw new RouteStorageIntegrityError(
          `refusing to move the ${input.tailKey} cursor back from ${existing.lastBlock} to ${input.toBlock}: a tail that rewinds re-scans history while appearing to work`,
        );
      }

      const venueRows = input.venues.map((row) => assertMarketVenueV1(row, 'write'));
      // What the store knew BEFORE this pass. Read up front rather than
      // inferred from the upsert: an ON CONFLICT clause sees only the row it is
      // about to leave behind, so "was this a candidate a moment ago" is not a
      // question it can answer.
      const priorKind = new Map<string, MarketVenueKindV1>();
      if (venueRows.length > 0) {
        const addresses = venueRows.map((row) => row.address);
        const known = (await sql`
          SELECT address, kind FROM market_venues
           WHERE chain_id = ${input.chainId} AND address = ANY(${addresses})`) as Record<
          string,
          unknown
        >[];
        for (const row of known) {
          priorKind.set(String(row.address), row.kind as MarketVenueKindV1);
        }
      }

      let venuesAdded = 0;
      let venuesIdentified = 0;
      for (const row of venueRows) {
        const before = priorKind.get(row.address);
        if (before === undefined) venuesAdded += 1;
        else if (before === 'candidate' && row.kind !== 'candidate') venuesIdentified += 1;
        // first_seen_at is never overwritten: how long we have watched an
        // address is a fact the next pass must not reset.
        await sql`
          INSERT INTO market_venues (
            chain_id, address, kind, token0, token1, first_seen_at, identified_at
          ) VALUES (
            ${row.chainId}, ${row.address}, ${row.kind}, ${row.token0}, ${row.token1},
            ${row.firstSeenAt}::timestamptz, ${row.identifiedAt}
          )
          ON CONFLICT (chain_id, address) DO UPDATE SET
            kind = EXCLUDED.kind,
            token0 = EXCLUDED.token0,
            token1 = EXCLUDED.token1,
            identified_at = COALESCE(EXCLUDED.identified_at, market_venues.identified_at)`;
      }

      const eventRows = input.events.map((row) => assertMarketVenueTransferV1(row, 'write'));
      let inserted = 0;
      let duplicates = 0;
      for (const row of eventRows) {
        const venueRow = (await sql`
          SELECT kind FROM market_venues
           WHERE chain_id = ${row.chainId} AND address = ${row.venueAddress} LIMIT 1`) as Record<
          string,
          unknown
        >[];
        const kind = venueRow[0]?.kind as MarketVenueKindV1 | undefined;
        if (!kind) {
          throw new MarketVenueUnidentifiedError(row.venueAddress, 'the store has no such address');
        }
        if (!venueMayCarryTradesV1(kind)) {
          throw new MarketVenueUnidentifiedError(
            row.venueAddress,
            `it is recorded as ${kind}, so nothing that passed through it is evidence of anything`,
          );
        }
        const written = (await sql`
          INSERT INTO market_venue_transfers (
            chain_id, token_address, venue_address, direction, counterparty,
            amount_atomic, block_number, transaction_hash, log_index, observed_at
          ) VALUES (
            ${row.chainId}, ${row.tokenAddress}, ${row.venueAddress}, ${row.direction},
            ${row.counterparty}, ${row.amountAtomic}, ${row.blockNumber}::bigint,
            ${row.transactionHash}, ${row.logIndex}, ${row.observedAt}::timestamptz
          )
          ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING
          RETURNING id`) as Record<string, unknown>[];
        if (written.length > 0) inserted += 1;
        else duplicates += 1;
      }

      const [cursorRow] = (await sql`
        INSERT INTO market_tail_cursors (
          tail_key, chain_id, last_block, last_run_at, passes, log_calls, identity_calls, events_written
        ) VALUES (
          ${input.tailKey}, ${input.chainId}, ${input.toBlock}::bigint, ${input.observedAt}::timestamptz,
          1, ${input.logCalls}::bigint, ${input.identityCalls}::bigint, ${inserted}::bigint
        )
        ON CONFLICT (tail_key) DO UPDATE SET
          chain_id = EXCLUDED.chain_id,
          last_block = GREATEST(market_tail_cursors.last_block, EXCLUDED.last_block),
          last_run_at = EXCLUDED.last_run_at,
          passes = market_tail_cursors.passes + 1,
          log_calls = market_tail_cursors.log_calls + EXCLUDED.log_calls,
          identity_calls = market_tail_cursors.identity_calls + EXCLUDED.identity_calls,
          events_written = market_tail_cursors.events_written + EXCLUDED.events_written
        RETURNING *`) as Record<string, unknown>[];

      return {
        cursor: cursorFromRowV1(cursorRow),
        inserted,
        duplicates,
        venuesAdded,
        venuesIdentified,
      };
    },

    async venues(input) {
      const kinds = input.kinds ? [...input.kinds] : null;
      const rows = (await sql`
        SELECT * FROM market_venues
         WHERE chain_id = ${input.chainId}
           AND (${kinds}::text[] IS NULL OR kind = ANY(${kinds}))
         ORDER BY address
         LIMIT ${Math.max(1, Math.min(1_000, input.limit))}`) as Record<string, unknown>[];
      return rows.map(venueFromRowV1);
    },

    async venueActivity(input) {
      const tokens = [...new Set(input.tokenAddresses.map((address) => address.toLowerCase()))];
      if (tokens.length === 0) return [];
      const rows = (await sql`
        SELECT token_address,
               count(*)::int AS transfers,
               count(*) FILTER (WHERE direction = 'out_of_venue')::int AS acquired,
               count(*) FILTER (WHERE direction = 'into_venue')::int AS disposed,
               min(block_number)::bigint AS first_block,
               max(block_number)::bigint AS last_block
          FROM market_venue_transfers
         WHERE chain_id = ${input.chainId}
           AND token_address = ANY(${tokens})
           AND block_number >= ${input.sinceBlock}::bigint
         GROUP BY token_address
         ORDER BY token_address`) as Record<string, unknown>[];
      return rows.map(
        (row): MarketVenueActivityV1 => ({
          tokenAddress: String(row.token_address),
          transfers: Number(row.transfers),
          acquired: Number(row.acquired),
          disposed: Number(row.disposed),
          firstBlock: Number(row.first_block),
          lastBlock: Number(row.last_block),
        }),
      );
    },

    async recentTransfers(input) {
      const rows = (await sql`
        SELECT * FROM market_venue_transfers
         WHERE chain_id = ${input.chainId} AND token_address = ${input.tokenAddress.toLowerCase()}
         ORDER BY block_number DESC, log_index DESC, transaction_hash DESC
         LIMIT ${Math.max(1, Math.min(500, input.limit))}`) as Record<string, unknown>[];
      return rows.map(eventFromRowV1);
    },
  };
}
