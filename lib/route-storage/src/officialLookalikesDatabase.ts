import {
  assertLookalikeIdentityV1,
  assertOfficialLookalikeV1,
  emptyLookalikeCountsV1,
  LOOKALIKE_ALIAS_KINDS_V1,
  type LookalikeAliasKindV1,
  type OfficialLookalikeOutcomeV1,
  type OfficialLookalikeRepositoryV1,
  type OfficialLookalikeRowV1,
} from './officialLookalikes.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToLookalikeV1(row: Record<string, unknown>): OfficialLookalikeRowV1 {
  return assertOfficialLookalikeV1(
    {
      chainId: Number(row.chain_id),
      tokenAddress: row.token_address,
      officialAddress: row.official_address,
      matchKind: row.match_kind,
      matchedAlias: row.matched_alias,
      matchedValue: row.matched_value,
      launchSymbol: String(row.launch_symbol ?? ''),
      launchName: String(row.launch_name ?? ''),
      launchedAt: row.launched_at ? new Date(row.launched_at as string).toISOString() : null,
      firstFlaggedAt: new Date(row.first_flagged_at as string).toISOString(),
      lastSeenAt: new Date(row.last_seen_at as string).toISOString(),
    },
    'read',
  );
}

export function createDatabaseOfficialLookalikeRepository(
  sql: SqlTemplateExecutor,
): OfficialLookalikeRepositoryV1 {
  return {
    async recordLookalikes(input) {
      const corpus = new Set(input.officialAddresses.map((address) => address.toLowerCase()));
      const parsed = input.rows.map((row) => assertOfficialLookalikeV1(row, 'write'));
      for (const row of parsed) assertLookalikeIdentityV1(row, corpus);

      const outcome: OfficialLookalikeOutcomeV1 = { flagged: [], refreshed: [] };
      if (parsed.length === 0) return outcome;

      // What the store knew before this scan. Read up front rather than
      // inferred from the upsert: an ON CONFLICT clause sees only the row it is
      // about to leave behind.
      const addresses = parsed.map((row) => row.tokenAddress);
      const known = (await sql`
        SELECT token_address FROM official_asset_lookalikes
         WHERE chain_id = ${input.chainId} AND token_address = ANY(${addresses})`) as Record<
        string,
        unknown
      >[];
      const seen = new Set(known.map((row) => String(row.token_address)));

      for (const row of parsed) {
        (seen.has(row.tokenAddress) ? outcome.refreshed : outcome.flagged).push(row.tokenAddress);
        // first_flagged_at is never overwritten: when a contract started
        // wearing the name is a fact a later scan must not reset.
        await sql`
          INSERT INTO official_asset_lookalikes (
            chain_id, token_address, official_address, match_kind, matched_alias, matched_value,
            launch_symbol, launch_name, launched_at, first_flagged_at, last_seen_at
          ) VALUES (
            ${row.chainId}, ${row.tokenAddress}, ${row.officialAddress}, ${row.matchKind},
            ${row.matchedAlias}, ${row.matchedValue}, ${row.launchSymbol}, ${row.launchName},
            ${row.launchedAt}, ${row.firstFlaggedAt}::timestamptz, ${row.lastSeenAt}::timestamptz
          )
          ON CONFLICT (chain_id, token_address) DO UPDATE SET
            official_address = EXCLUDED.official_address,
            match_kind = EXCLUDED.match_kind,
            matched_alias = EXCLUDED.matched_alias,
            matched_value = EXCLUDED.matched_value,
            launch_symbol = EXCLUDED.launch_symbol,
            launch_name = EXCLUDED.launch_name,
            launched_at = EXCLUDED.launched_at,
            last_seen_at = GREATEST(official_asset_lookalikes.last_seen_at, EXCLUDED.last_seen_at)`;
      }
      outcome.flagged.sort();
      outcome.refreshed.sort();
      return outcome;
    },

    async lookalikesOf(input) {
      const rows = (await sql`
        SELECT * FROM official_asset_lookalikes
         WHERE chain_id = ${input.chainId}
           AND official_address = ${input.officialAddress.toLowerCase()}
         ORDER BY first_flagged_at DESC, token_address DESC
         LIMIT ${Math.max(1, Math.min(200, input.limit))}`) as Record<string, unknown>[];
      return rows.map(rowToLookalikeV1);
    },

    async lookalikeFor(input) {
      const rows = (await sql`
        SELECT * FROM official_asset_lookalikes
         WHERE chain_id = ${input.chainId} AND token_address = ${input.tokenAddress.toLowerCase()}
         LIMIT 1`) as Record<string, unknown>[];
      return rows[0] ? rowToLookalikeV1(rows[0]) : null;
    },

    async recentLookalikes(input) {
      const alias = input.matchedAlias ?? null;
      const rows = (await sql`
        SELECT * FROM official_asset_lookalikes
         WHERE chain_id = ${input.chainId}
           AND (${alias}::text IS NULL OR matched_alias = ${alias}::text)
         ORDER BY first_flagged_at DESC, token_address DESC
         LIMIT ${Math.max(1, Math.min(200, input.limit))}`) as Record<string, unknown>[];
      return rows.map(rowToLookalikeV1);
    },

    async lookalikeCountsByOfficial(input) {
      const rows = (await sql`
        SELECT official_address, count(*)::int AS total
          FROM official_asset_lookalikes
         WHERE chain_id = ${input.chainId}
         GROUP BY official_address`) as Record<string, unknown>[];
      const counts: Record<string, number> = {};
      for (const row of rows) counts[String(row.official_address)] = Number(row.total);
      return counts;
    },

    async lookalikeCounts(input) {
      const rows = (await sql`
        SELECT matched_alias, count(*)::int AS total, max(last_seen_at) AS last_seen_at
          FROM official_asset_lookalikes
         WHERE chain_id = ${input.chainId}
         GROUP BY matched_alias`) as Record<string, unknown>[];
      // Seeded with every kind at zero, so a spelling nobody currently wears
      // still appears as a filter rather than disappearing from the surface.
      const byAlias = emptyLookalikeCountsV1();
      let total = 0;
      let lastSeenAt: string | null = null;
      for (const row of rows) {
        const alias = String(row.matched_alias) as LookalikeAliasKindV1;
        if (!LOOKALIKE_ALIAS_KINDS_V1.includes(alias)) continue;
        byAlias[alias] = Number(row.total);
        total += Number(row.total);
        const seen = row.last_seen_at ? new Date(row.last_seen_at as string).toISOString() : null;
        if (seen !== null && (lastSeenAt === null || seen > lastSeenAt)) lastSeenAt = seen;
      }
      return { total, byAlias, lastSeenAt };
    },
  };
}
