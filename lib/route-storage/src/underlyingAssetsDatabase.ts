import {
  UnknownUnderlyingError,
  assertRepresentationUnderlyingV1,
  assertUnderlyingAssetV1,
  type RepresentationUnderlyingV1,
  type UnderlyingAssetRepositoryV1,
  type UnderlyingAssetV1,
} from './underlyingAssets.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToUnderlyingV1(row: Record<string, unknown>): UnderlyingAssetV1 {
  return assertUnderlyingAssetV1(
    {
      underlyingKey: String(row.underlying_key),
      assetClass: String(row.asset_class),
      canonicalName: String(row.canonical_name),
      sourceKind: String(row.source_kind),
      sourceRef: String(row.source_ref),
      observedAt: new Date(row.observed_at as string).toISOString(),
    },
    'read',
  );
}

function rowToBindingV1(row: Record<string, unknown>): RepresentationUnderlyingV1 {
  return assertRepresentationUnderlyingV1(
    {
      chainId: Number(row.chain_id),
      tokenAddress: String(row.token_address),
      underlyingKey: String(row.underlying_key),
      sourceKind: String(row.source_kind),
      sourceRef: String(row.source_ref),
      observedAt: new Date(row.observed_at as string).toISOString(),
    },
    'read',
  );
}

export function createDatabaseUnderlyingAssetRepository(
  sql: SqlTemplateExecutor,
): UnderlyingAssetRepositoryV1 {
  return {
    async declareUnderlying(input) {
      const parsed = assertUnderlyingAssetV1(input, 'write');
      const rows = (await sql`
        INSERT INTO underlying_asset (
          underlying_key, asset_class, canonical_name, source_kind, source_ref, observed_at
        ) VALUES (
          ${parsed.underlyingKey}, ${parsed.assetClass}, ${parsed.canonicalName},
          ${parsed.sourceKind}, ${parsed.sourceRef}, ${parsed.observedAt}::timestamptz
        )
        ON CONFLICT (underlying_key) DO UPDATE SET
          asset_class = EXCLUDED.asset_class,
          canonical_name = EXCLUDED.canonical_name,
          source_kind = EXCLUDED.source_kind,
          source_ref = EXCLUDED.source_ref,
          observed_at = GREATEST(underlying_asset.observed_at, EXCLUDED.observed_at)
        RETURNING *
      `) as Record<string, unknown>[];
      return rowToUnderlyingV1(rows[0]);
    },

    async bindRepresentation(input) {
      const parsed = assertRepresentationUnderlyingV1(input, 'write');
      const address = parsed.tokenAddress.toLowerCase();
      // Checked here as well as by the foreign key, so the caller gets the
      // refusal in our vocabulary instead of a constraint name.
      const declared = (await sql`
        SELECT 1 FROM underlying_asset WHERE underlying_key = ${parsed.underlyingKey}
      `) as unknown[];
      if (declared.length === 0) throw new UnknownUnderlyingError(parsed.underlyingKey);

      const rows = (await sql`
        INSERT INTO representation_underlying (
          chain_id, token_address, underlying_key, source_kind, source_ref, observed_at
        ) VALUES (
          ${parsed.chainId}, ${address}, ${parsed.underlyingKey}, ${parsed.sourceKind},
          ${parsed.sourceRef}, ${parsed.observedAt}::timestamptz
        )
        ON CONFLICT (chain_id, token_address) DO UPDATE SET
          underlying_key = EXCLUDED.underlying_key,
          source_kind = EXCLUDED.source_kind,
          source_ref = EXCLUDED.source_ref,
          observed_at = GREATEST(representation_underlying.observed_at, EXCLUDED.observed_at)
        RETURNING *
      `) as Record<string, unknown>[];
      return rowToBindingV1(rows[0]);
    },

    async underlyingOf(input) {
      const rows = (await sql`
        SELECT b.*, u.asset_class, u.canonical_name,
               u.source_kind AS underlying_source_kind,
               u.source_ref AS underlying_source_ref,
               u.observed_at AS underlying_observed_at
          FROM representation_underlying b
          JOIN underlying_asset u ON u.underlying_key = b.underlying_key
         WHERE b.chain_id = ${input.chainId}
           AND b.token_address = ${input.tokenAddress.toLowerCase()}
         LIMIT 1
      `) as Record<string, unknown>[];
      const row = rows[0];
      if (!row) return null;
      return {
        binding: rowToBindingV1(row),
        underlying: rowToUnderlyingV1({
          underlying_key: row.underlying_key,
          asset_class: row.asset_class,
          canonical_name: row.canonical_name,
          source_kind: row.underlying_source_kind,
          source_ref: row.underlying_source_ref,
          observed_at: row.underlying_observed_at,
        }),
      };
    },

    async representationsOf(input) {
      const rows = (await sql`
        SELECT * FROM representation_underlying
         WHERE chain_id = ${input.chainId} AND underlying_key = ${input.underlyingKey}
         ORDER BY token_address ASC
      `) as Record<string, unknown>[];
      return rows.map(rowToBindingV1);
    },

    async underlyingCounts(input) {
      const rows = (await sql`
        SELECT
          (SELECT count(*)::int FROM underlying_asset) AS underlyings,
          (SELECT count(*)::int FROM representation_underlying
            WHERE chain_id = ${input.chainId}) AS bound
      `) as Record<string, unknown>[];
      return {
        underlyings: Number(rows[0]?.underlyings ?? 0),
        boundRepresentations: Number(rows[0]?.bound ?? 0),
      };
    },
  };
}
