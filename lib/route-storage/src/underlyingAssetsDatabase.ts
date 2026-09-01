import {
  UnknownUnderlyingError,
  assertBindRepresentationInputV1,
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
      displaySymbol:
        row.display_symbol === null || row.display_symbol === undefined
          ? null
          : String(row.display_symbol),
      identifierScheme:
        row.identifier_scheme === null || row.identifier_scheme === undefined
          ? null
          : String(row.identifier_scheme),
      identifierValue:
        row.identifier_value === null || row.identifier_value === undefined
          ? null
          : String(row.identifier_value),
      sourceKind: String(row.source_kind),
      sourceRef: String(row.source_ref),
      sourceHash:
        row.source_hash === null || row.source_hash === undefined ? null : String(row.source_hash),
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
      sourceHash:
        row.source_hash === null || row.source_hash === undefined ? null : String(row.source_hash),
      issuerId:
        row.issuer_id === null || row.issuer_id === undefined ? null : String(row.issuer_id),
      issuerInstrumentKey:
        row.issuer_instrument_key === null || row.issuer_instrument_key === undefined
          ? null
          : String(row.issuer_instrument_key),
      caip10: row.caip10 === null || row.caip10 === undefined ? null : String(row.caip10),
      representationKind:
        row.representation_kind === null || row.representation_kind === undefined
          ? null
          : String(row.representation_kind),
      evidenceStrength:
        row.evidence_strength === null || row.evidence_strength === undefined
          ? null
          : String(row.evidence_strength),
      observedBlockNumber:
        row.observed_block_number === null || row.observed_block_number === undefined
          ? null
          : String(row.observed_block_number),
      observedBlockHash:
        row.observed_block_hash === null || row.observed_block_hash === undefined
          ? null
          : String(row.observed_block_hash),
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
          underlying_key, asset_class, canonical_name, display_symbol,
          identifier_scheme, identifier_value, source_kind, source_ref, source_hash, observed_at
        ) VALUES (
          ${parsed.underlyingKey}, ${parsed.assetClass}, ${parsed.canonicalName},
          ${parsed.displaySymbol ?? null}, ${parsed.identifierScheme ?? null},
          ${parsed.identifierValue ?? null}, ${parsed.sourceKind}, ${parsed.sourceRef},
          ${parsed.sourceHash ?? null}, ${parsed.observedAt}::timestamptz
        )
        ON CONFLICT (underlying_key) DO UPDATE SET
          asset_class = CASE WHEN EXCLUDED.observed_at >= underlying_asset.observed_at
            THEN EXCLUDED.asset_class ELSE underlying_asset.asset_class END,
          canonical_name = CASE WHEN EXCLUDED.observed_at >= underlying_asset.observed_at
            THEN EXCLUDED.canonical_name ELSE underlying_asset.canonical_name END,
          display_symbol = CASE WHEN EXCLUDED.observed_at >= underlying_asset.observed_at
            THEN EXCLUDED.display_symbol ELSE underlying_asset.display_symbol END,
          identifier_scheme = CASE WHEN EXCLUDED.observed_at >= underlying_asset.observed_at
            THEN EXCLUDED.identifier_scheme ELSE underlying_asset.identifier_scheme END,
          identifier_value = CASE WHEN EXCLUDED.observed_at >= underlying_asset.observed_at
            THEN EXCLUDED.identifier_value ELSE underlying_asset.identifier_value END,
          source_kind = CASE WHEN EXCLUDED.observed_at >= underlying_asset.observed_at
            THEN EXCLUDED.source_kind ELSE underlying_asset.source_kind END,
          source_ref = CASE WHEN EXCLUDED.observed_at >= underlying_asset.observed_at
            THEN EXCLUDED.source_ref ELSE underlying_asset.source_ref END,
          source_hash = CASE WHEN EXCLUDED.observed_at >= underlying_asset.observed_at
            THEN EXCLUDED.source_hash ELSE underlying_asset.source_hash END,
          observed_at = GREATEST(underlying_asset.observed_at, EXCLUDED.observed_at)
        RETURNING *
      `) as Record<string, unknown>[];
      return rowToUnderlyingV1(rows[0]);
    },

    async bindRepresentation(input) {
      // The write gate, not the read one: a new binding must carry complete
      // typed identity. The read schema tolerates a pre-0059 row so history
      // stays legible; nothing may add to that history.
      const parsed = assertBindRepresentationInputV1(input);
      const address = parsed.tokenAddress.toLowerCase();
      // Checked here as well as by the foreign key, so the caller gets the
      // refusal in our vocabulary instead of a constraint name.
      const declared = (await sql`
        SELECT 1 FROM underlying_asset WHERE underlying_key = ${parsed.underlyingKey}
      `) as unknown[];
      if (declared.length === 0) throw new UnknownUnderlyingError(parsed.underlyingKey);

      const rows = (await sql`
        INSERT INTO representation_underlying (
          chain_id, token_address, underlying_key, source_kind, source_ref, source_hash,
          issuer_id, issuer_instrument_key, caip10, representation_kind, evidence_strength,
          observed_block_number, observed_block_hash, observed_at
        ) VALUES (
          ${parsed.chainId}, ${address}, ${parsed.underlyingKey}, ${parsed.sourceKind},
          ${parsed.sourceRef}, ${parsed.sourceHash ?? null}, ${parsed.issuerId ?? null},
          ${parsed.issuerInstrumentKey ?? null}, ${parsed.caip10 ?? null},
          ${parsed.representationKind ?? null}, ${parsed.evidenceStrength ?? null},
          ${parsed.observedBlockNumber ?? null}, ${parsed.observedBlockHash ?? null},
          ${parsed.observedAt}::timestamptz
        )
        ON CONFLICT (chain_id, token_address) DO UPDATE SET
          underlying_key = CASE
            WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.underlying_key ELSE representation_underlying.underlying_key END,
          source_kind = CASE WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.source_kind ELSE representation_underlying.source_kind END,
          source_ref = CASE WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.source_ref ELSE representation_underlying.source_ref END,
          source_hash = CASE WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.source_hash ELSE representation_underlying.source_hash END,
          issuer_id = CASE WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.issuer_id ELSE representation_underlying.issuer_id END,
          issuer_instrument_key = CASE
            WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.issuer_instrument_key
            ELSE representation_underlying.issuer_instrument_key END,
          caip10 = CASE WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.caip10 ELSE representation_underlying.caip10 END,
          representation_kind = CASE
            WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.representation_kind ELSE representation_underlying.representation_kind END,
          evidence_strength = CASE
            WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.evidence_strength ELSE representation_underlying.evidence_strength END,
          observed_block_number = CASE
            WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.observed_block_number
            ELSE representation_underlying.observed_block_number END,
          observed_block_hash = CASE
            WHEN EXCLUDED.observed_at >= representation_underlying.observed_at
            THEN EXCLUDED.observed_block_hash ELSE representation_underlying.observed_block_hash END,
          observed_at = GREATEST(representation_underlying.observed_at, EXCLUDED.observed_at)
        RETURNING *
      `) as Record<string, unknown>[];
      const stored = rowToBindingV1(rows[0]);
      if (
        parsed.sourceHash &&
        parsed.issuerId &&
        parsed.issuerInstrumentKey &&
        parsed.caip10 &&
        parsed.representationKind &&
        parsed.evidenceStrength
      ) {
        await sql`
          INSERT INTO underlying_identity_observation (
            chain_id, token_address, underlying_key, source_kind, source_ref, source_hash,
            issuer_id, issuer_instrument_key, caip10, representation_kind, evidence_strength,
            observed_block_number, observed_block_hash, observed_at
          ) VALUES (
            ${parsed.chainId}, ${address}, ${parsed.underlyingKey},
            ${parsed.sourceKind}, ${parsed.sourceRef}, ${parsed.sourceHash}, ${parsed.issuerId},
            ${parsed.issuerInstrumentKey}, ${parsed.caip10}, ${parsed.representationKind},
            ${parsed.evidenceStrength}, ${parsed.observedBlockNumber ?? null},
            ${parsed.observedBlockHash ?? null}, ${parsed.observedAt}::timestamptz
          ) ON CONFLICT DO NOTHING
        `;
      }
      return stored;
    },

    async underlyingOf(input) {
      const rows = (await sql`
        SELECT b.*, u.asset_class, u.canonical_name, u.display_symbol,
               u.identifier_scheme, u.identifier_value,
               u.source_kind AS underlying_source_kind,
               u.source_ref AS underlying_source_ref,
               u.source_hash AS underlying_source_hash,
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
          display_symbol: row.display_symbol,
          identifier_scheme: row.identifier_scheme,
          identifier_value: row.identifier_value,
          source_kind: row.underlying_source_kind,
          source_ref: row.underlying_source_ref,
          source_hash: row.underlying_source_hash,
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

    async listUnderlyings(input) {
      // One query rather than one per underlying: the corpus is small today and
      // the join is what keeps the count and the issuer list describing the
      // same rows. `array_agg` over a filtered join yields `{NULL}` for an
      // underlying nothing is bound to, which is why the null is stripped here
      // rather than trusted to be absent.
      // A security with a live representation sorts above one with more
      // contracts and no tokens outstanding: `representation_count` counts
      // CONTRACTS, and nine of the thirteen Coinbase stocks hold zero. The
      // supply join is LEFT so an unread representation lowers nothing — it
      // simply is not counted as live.
      const rows = (await sql`
        SELECT u.*,
               count(r.token_address)::int AS representation_count,
               count(*) FILTER (WHERE s.supply_state = 'positive_supply')::int AS live_count,
               array_remove(array_agg(DISTINCT r.issuer_id), NULL) AS issuer_ids
          FROM underlying_asset u
          LEFT JOIN representation_underlying r
            ON r.underlying_key = u.underlying_key AND r.chain_id = ${input.chainId}
          LEFT JOIN representation_supply s
            ON s.token_address = r.token_address AND s.chain_id = r.chain_id
         GROUP BY u.underlying_key
         ORDER BY live_count DESC,
                  representation_count DESC,
                  u.canonical_name ASC,
                  u.underlying_key ASC
         LIMIT ${Math.max(1, Math.min(500, input.limit))}
      `) as Record<string, unknown>[];
      return rows.map((row) => ({
        underlying: rowToUnderlyingV1(row),
        representationCount: Number(row.representation_count ?? 0),
        liveRepresentationCount: Number(row.live_count ?? 0),
        issuerIds: [...new Set((row.issuer_ids as string[] | null) ?? [])].sort(),
      }));
    },

    async underlyingCounts(input) {
      const rows = (await sql`
        SELECT
          (SELECT count(*)::int FROM underlying_asset) AS underlyings,
          (SELECT count(*)::int FROM representation_underlying
            WHERE chain_id = ${input.chainId}) AS bound,
          -- Distinct ISSUERS per underlying, never binding count: a rebasing
          -- token and its own wrapper are one issuer's structure choice, and
          -- counting them as two would promise a comparison with nothing on
          -- the other side of it.
          (SELECT count(*)::int FROM (
             SELECT underlying_key
               FROM representation_underlying
              WHERE chain_id = ${input.chainId} AND issuer_id IS NOT NULL
              GROUP BY underlying_key
             HAVING count(DISTINCT issuer_id) > 1) AS multi) AS multi_issuer
      `) as Record<string, unknown>[];
      return {
        underlyings: Number(rows[0]?.underlyings ?? 0),
        boundRepresentations: Number(rows[0]?.bound ?? 0),
        multiIssuerUnderlyings: Number(rows[0]?.multi_issuer ?? 0),
      };
    },
  };
}
