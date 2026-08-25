import {
  OFFICIAL_SOURCE_KINDS_V1,
  assertOfficialAssetV1,
  assertOfficialSnapshotV1,
  assertSnapshotMayCarryAssetsV1,
  officialSourceDiscrepanciesV1,
  type OfficialAssetIdentityV1,
  type OfficialAssetListingV1,
  type OfficialAssetRepositoryV1,
  type OfficialMembershipRowV1,
  type OfficialSnapshotOutcomeV1,
  type OfficialSourceKindV1,
  type OfficialSourceSnapshotRecordV1,
  type OfficialSourceStatusV1,
} from './officialAssets.js';
import type { SqlTemplateExecutor } from './types.js';

function snapshotFromRowV1(row: Record<string, unknown>): OfficialSourceSnapshotRecordV1 {
  const snapshot = assertOfficialSnapshotV1(
    {
      sourceKind: row.source_kind,
      sourceUrl: row.source_url,
      observedAt: new Date(row.observed_at as string).toISOString(),
      status: row.status,
      documentHash: (row.document_hash as string | null) ?? null,
      corpusHash: (row.corpus_hash as string | null) ?? null,
      detail: (row.detail as string | null) ?? null,
    },
    'read',
  );
  return { ...snapshot, snapshotId: String(row.id), assetCount: Number(row.asset_count) };
}

function listingFromRowV1(row: Record<string, unknown>): OfficialAssetListingV1 {
  return {
    sourceKind: row.source_kind as OfficialSourceKindV1,
    sourceUrl: String(row.source_url ?? ''),
    ticker: String(row.ticker),
    displayName: (row.display_name as string | null) ?? null,
    referenceFeedAddress: (row.reference_feed_address as string | null) ?? null,
    firstSeenAt: new Date(row.first_seen_at as string).toISOString(),
    lastSeenAt: new Date(row.last_seen_at as string).toISOString(),
    currentlyListed: row.currently_listed === true,
    sourceCheckedAt: row.source_checked_at ? new Date(row.source_checked_at as string).toISOString() : null,
    sourceStatus: (row.source_status as OfficialSourceStatusV1 | null) ?? null,
  };
}

function identitiesFromRowsV1(chainId: number, rows: Record<string, unknown>[]): OfficialAssetIdentityV1[] {
  const byAddress = new Map<string, OfficialAssetIdentityV1>();
  for (const row of rows) {
    const address = String(row.token_address);
    const identity = byAddress.get(address) ?? {
      chainId,
      tokenAddress: address,
      issuer: String(row.issuer),
      listings: [],
    };
    identity.listings.push(listingFromRowV1(row));
    byAddress.set(address, identity);
  }
  return [...byAddress.values()];
}

export function createDatabaseOfficialAssetRepository(sql: SqlTemplateExecutor): OfficialAssetRepositoryV1 {
  /**
   * Every asset row joined to two facts about its source: the newest check of
   * any outcome (what freshness to show) and the newest check that COMPLETED
   * (what "still listed" is measured against). Keeping those separate is what
   * makes an outage stop the clock instead of withdrawing an identity.
   *
   * "Newest" is INSERTION order, and "still listed" is an id match against the
   * snapshot that wrote the row -- not a timestamp comparison. A caller's clock
   * is an input, and one snapshot recorded with a wrong one would otherwise sit
   * permanently ahead of every real check and delist the entire corpus.
   */
  const listingRows = (where: {
    chainId: number;
    tokenAddress?: string;
    tokenAddresses?: readonly string[];
    sourceKind?: OfficialSourceKindV1;
  }) => sql`
    WITH latest AS (
      SELECT DISTINCT ON (source_kind) source_kind, source_url, observed_at, status
        FROM official_asset_sources
       ORDER BY source_kind, id DESC
    ), latest_ok AS (
      SELECT DISTINCT ON (source_kind) source_kind, id
        FROM official_asset_sources
       WHERE status = 'ok'
       ORDER BY source_kind, id DESC
    )
    SELECT a.token_address, a.source_kind, a.ticker, a.display_name, a.issuer,
           a.reference_feed_address, a.first_seen_at, a.last_seen_at,
           l.source_url, l.observed_at AS source_checked_at, l.status AS source_status,
           (a.source_id = ok.id) AS currently_listed
      FROM official_assets a
      LEFT JOIN latest l ON l.source_kind = a.source_kind
      LEFT JOIN latest_ok ok ON ok.source_kind = a.source_kind
     WHERE a.chain_id = ${where.chainId}
       AND (${where.tokenAddress ?? null}::text IS NULL OR a.token_address = ${where.tokenAddress ?? null})
       AND (${(where.tokenAddresses ?? null) as string[] | null}::text[] IS NULL
            OR a.token_address = ANY(${(where.tokenAddresses ?? null) as string[] | null}))
       AND (${where.sourceKind ?? null}::text IS NULL OR a.source_kind = ${where.sourceKind ?? null})
     ORDER BY a.token_address, a.source_kind`;

  return {
    async recordSnapshot(input) {
      const snapshot = assertOfficialSnapshotV1(input.snapshot, 'write');
      const rows = input.assets.map((asset) => assertOfficialAssetV1(asset, 'write'));
      assertSnapshotMayCarryAssetsV1(snapshot, rows);

      // The state this check is a transition FROM, read before the snapshot
      // that will redefine "current" is stored.
      const previousRows = snapshot.status === 'ok'
        ? ((await sql`
            WITH latest_ok AS (
              SELECT DISTINCT ON (source_kind) source_kind, id
                FROM official_asset_sources
               WHERE status = 'ok'
               ORDER BY source_kind, id DESC
            )
            SELECT a.token_address
              FROM official_assets a
              JOIN latest_ok ok ON ok.source_kind = a.source_kind
             WHERE a.source_kind = ${snapshot.sourceKind}
               AND a.source_id = ok.id`) as Record<string, unknown>[])
        : [];
      const previous = new Set(previousRows.map((row) => String(row.token_address)));

      const [inserted] = (await sql`
        INSERT INTO official_asset_sources (
          source_kind, source_url, observed_at, status, document_hash, corpus_hash, asset_count, detail
        ) VALUES (
          ${snapshot.sourceKind}, ${snapshot.sourceUrl}, ${snapshot.observedAt}::timestamptz,
          ${snapshot.status}, ${snapshot.documentHash}, ${snapshot.corpusHash},
          ${rows.length}, ${snapshot.detail}
        )
        RETURNING id`) as Record<string, unknown>[];
      const snapshotId = String(inserted.id);

      const outcome: OfficialSnapshotOutcomeV1 = {
        snapshotId,
        sourceKind: snapshot.sourceKind,
        status: snapshot.status,
        observedAt: snapshot.observedAt,
        added: [],
        stillListed: [],
        delisted: [],
      };
      if (snapshot.status !== 'ok') return outcome;

      const named = new Set<string>();
      for (const asset of rows) {
        named.add(asset.tokenAddress);
        // first_seen_at is never overwritten: how long a source has listed an
        // asset is a fact the next check must not reset.
        await sql`
          INSERT INTO official_assets (
            chain_id, token_address, source_kind, ticker, display_name, issuer,
            reference_feed_address, first_seen_at, last_seen_at, source_id
          ) VALUES (
            ${asset.chainId}, ${asset.tokenAddress}, ${asset.sourceKind}, ${asset.ticker},
            ${asset.displayName}, ${asset.issuer}, ${asset.referenceFeedAddress},
            ${snapshot.observedAt}::timestamptz, ${snapshot.observedAt}::timestamptz, ${snapshotId}::bigint
          )
          ON CONFLICT (chain_id, source_kind, token_address) DO UPDATE SET
            ticker = EXCLUDED.ticker,
            display_name = EXCLUDED.display_name,
            issuer = EXCLUDED.issuer,
            reference_feed_address = EXCLUDED.reference_feed_address,
            last_seen_at = GREATEST(official_assets.last_seen_at, EXCLUDED.last_seen_at),
            source_id = EXCLUDED.source_id`;
        (previous.has(asset.tokenAddress) ? outcome.stillListed : outcome.added).push(asset.tokenAddress);
      }
      for (const address of previous) {
        if (!named.has(address)) outcome.delisted.push(address);
      }
      outcome.added.sort();
      outcome.stillListed.sort();
      outcome.delisted.sort();
      return outcome;
    },

    async latestSnapshot(input) {
      const rows = (await sql`
        SELECT * FROM official_asset_sources
         WHERE source_kind = ${input.sourceKind}
           AND (${input.successfulOnly === true} IS FALSE OR status = 'ok')
         ORDER BY id DESC
         LIMIT 1`) as Record<string, unknown>[];
      return rows[0] ? snapshotFromRowV1(rows[0]) : null;
    },

    async officialIdentity(input) {
      const rows = (await listingRows({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress.toLowerCase(),
      })) as Record<string, unknown>[];
      return identitiesFromRowsV1(input.chainId, rows)[0] ?? null;
    },

    async officialAssets(input) {
      const currentOnly = input.currentlyListedOnly !== false;
      const limit = Math.max(1, Math.min(500, input.limit));
      // Two reads, because the limit counts ASSETS and a single query would
      // cut a token's second source off the end of the page.
      const addressRows = (await sql`
        WITH latest_ok AS (
          SELECT DISTINCT ON (source_kind) source_kind, id
            FROM official_asset_sources
           WHERE status = 'ok'
           ORDER BY source_kind, id DESC
        )
        SELECT a.token_address,
               (array_agg(a.ticker ORDER BY a.source_kind))[1] AS ticker
          FROM official_assets a
          LEFT JOIN latest_ok ok ON ok.source_kind = a.source_kind
         WHERE a.chain_id = ${input.chainId}
           AND (${input.sourceKind ?? null}::text IS NULL OR a.source_kind = ${input.sourceKind ?? null})
           AND (${currentOnly} IS FALSE OR a.source_id = ok.id)
         GROUP BY a.token_address
         ORDER BY (array_agg(a.ticker ORDER BY a.source_kind))[1], a.token_address
         LIMIT ${limit}`) as Record<string, unknown>[];
      const addresses = addressRows.map((row) => String(row.token_address));
      if (addresses.length === 0) return [];

      const rows = (await listingRows({
        chainId: input.chainId,
        tokenAddresses: addresses,
        sourceKind: input.sourceKind,
      })) as Record<string, unknown>[];
      const identities = identitiesFromRowsV1(input.chainId, rows);
      const order = new Map(addresses.map((address, index) => [address, index]));
      return identities.sort(
        (left, right) => (order.get(left.tokenAddress) ?? 0) - (order.get(right.tokenAddress) ?? 0),
      );
    },

    async sourceDiscrepancies(input) {
      const rows = (await listingRows({ chainId: input.chainId })) as Record<string, unknown>[];
      const reviewedRows = (await sql`
        SELECT DISTINCT source_kind FROM official_asset_sources WHERE status = 'ok'`) as Record<
        string,
        unknown
      >[];
      const reviewed = OFFICIAL_SOURCE_KINDS_V1.filter((kind) =>
        reviewedRows.some((row) => row.source_kind === kind),
      );
      const membership: OfficialMembershipRowV1[] = rows.map((row) => ({
        tokenAddress: String(row.token_address),
        sourceKind: row.source_kind as OfficialSourceKindV1,
        ticker: String(row.ticker),
        lastSeenAt: new Date(row.last_seen_at as string).toISOString(),
        currentlyListed: row.currently_listed === true,
      }));
      return officialSourceDiscrepanciesV1({ reviewedKinds: reviewed, rows: membership });
    },
  };
}
