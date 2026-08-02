import {
  b20WatchlistAddEffectV1,
  b20WatchlistFullV1,
  b20WatchlistIdV1,
  type B20WatchSweepOutcomeV1,
  type B20WatchlistEntryV1,
  type B20WatchlistRepositoryV1,
} from './b20Watchlist.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed B20WatchlistRepositoryV1.
//
// The interesting query is `dueForSweep`, which crosses tenants. It is the one
// read in this file that is NOT scoped to a user, because a background sweep
// has no user — it runs on a timer. Everything it returns is fed straight back
// into per-tenant writes, so the tenant travels with the row rather than being
// re-derived later from something ambient.
// ---------------------------------------------------------------------------

function rowToEntryV1(row: Record<string, unknown>): B20WatchlistEntryV1 {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastSweptAt: row.last_swept_at === null ? null : new Date(String(row.last_swept_at)).toISOString(),
    lastOutcome: row.last_outcome === null ? null : (String(row.last_outcome) as B20WatchSweepOutcomeV1),
  };
}

export function createDatabaseB20WatchlistRepository(
  sql: SqlTemplateExecutor,
): B20WatchlistRepositoryV1 {
  return {
    async addToken(input) {
      const address = input.tokenAddress.toLowerCase();
      const existingRows = await sql`
        SELECT id, user_id, chain_id, token_address, created_at, last_swept_at, last_outcome FROM b20_watchlist
        WHERE user_id = ${input.userId} AND token_address = ${address}
        LIMIT 1`;
      const existing = existingRows[0] ? rowToEntryV1(existingRows[0] as Record<string, unknown>) : null;
      const countRows = await sql`
        SELECT COUNT(*)::int AS count FROM b20_watchlist WHERE user_id = ${input.userId}`;
      const decision = b20WatchlistAddEffectV1({
        existing,
        currentCount: Number((countRows[0] as { count?: unknown } | undefined)?.count ?? 0),
      });
      if (decision.effect === 'at_capacity') throw b20WatchlistFullV1(decision.reason);
      if (decision.effect === 'return_existing') return existing!;

      const inserted = await sql`
        INSERT INTO b20_watchlist (id, user_id, chain_id, token_address, created_at)
        VALUES (${b20WatchlistIdV1(input.userId, address)}, ${input.userId}, 8453, ${address}, ${input.now.toISOString()})
        ON CONFLICT DO NOTHING
        RETURNING id, user_id, chain_id, token_address, created_at, last_swept_at, last_outcome`;
      if (inserted.length > 0) return rowToEntryV1(inserted[0] as Record<string, unknown>);

      // Lost a race with a concurrent add of the same token. The winner wrote
      // the row this call wanted, so the row is the answer.
      const raced = await sql`
        SELECT id, user_id, chain_id, token_address, created_at, last_swept_at, last_outcome FROM b20_watchlist
        WHERE user_id = ${input.userId} AND token_address = ${address}
        LIMIT 1`;
      if (!raced[0]) throw b20WatchlistFullV1('The token could not be added or re-read');
      return rowToEntryV1(raced[0] as Record<string, unknown>);
    },

    async removeToken(userId, tokenAddress) {
      const rows = await sql`
        DELETE FROM b20_watchlist
        WHERE user_id = ${userId} AND token_address = ${tokenAddress.toLowerCase()}
        RETURNING id`;
      return rows.length > 0;
    },

    async listForUser(userId) {
      const rows = await sql`
        SELECT id, user_id, chain_id, token_address, created_at, last_swept_at, last_outcome FROM b20_watchlist
        WHERE user_id = ${userId}
        ORDER BY created_at ASC, id ASC`;
      return rows.map((row) => rowToEntryV1(row as Record<string, unknown>));
    },

    async dueForSweep(input) {
      // Never-swept first, then longest-unread. `NULLS FIRST` is the whole
      // ordering: a token somebody just added has no reading at all, and a page
      // that shows nothing for it is the worst thing this table can produce.
      const capped = Math.max(1, Math.min(500, Math.trunc(input.limit)));
      const rows = await sql`
        SELECT id, user_id, chain_id, token_address, created_at, last_swept_at, last_outcome FROM b20_watchlist
        WHERE last_swept_at IS NULL OR last_swept_at < ${input.sweptBefore.toISOString()}
        ORDER BY last_swept_at ASC NULLS FIRST, created_at ASC, id ASC
        LIMIT ${capped}`;
      return rows.map((row) => rowToEntryV1(row as Record<string, unknown>));
    },

    async recordSweep(input) {
      await sql`
        UPDATE b20_watchlist
        SET last_swept_at = ${input.at.toISOString()}, last_outcome = ${input.outcome}
        WHERE id = ${input.id}`;
    },
  };
}
