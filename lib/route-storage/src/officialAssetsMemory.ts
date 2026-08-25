import {
  OFFICIAL_SOURCE_KINDS_V1,
  assertOfficialAssetV1,
  assertOfficialSnapshotV1,
  assertSnapshotMayCarryAssetsV1,
  officialSourceDiscrepanciesV1,
  type OfficialAssetIdentityV1,
  type OfficialAssetInputV1,
  type OfficialAssetListingV1,
  type OfficialAssetRepositoryV1,
  type OfficialSnapshotOutcomeV1,
  type OfficialSourceKindV1,
  type OfficialSourceSnapshotRecordV1,
} from './officialAssets.js';

interface StoredAssetV1 extends OfficialAssetInputV1 {
  firstSeenAt: string;
  lastSeenAt: string;
  /** The snapshot that last named it. Identity, not a timestamp -- see the
   * database twin for why the comparison may not be a clock comparison. */
  sourceId: string;
}

/**
 * The in-memory twin.
 *
 * It refuses exactly what the database refuses -- assets under a failed check,
 * an ok check that named nothing, a row whose source disagrees with its
 * snapshot -- because a fake that is more permissive lets a test pass on a row
 * production cannot store. Three shipped bugs came from that gap.
 */
export function createMemoryOfficialAssetRepository(): OfficialAssetRepositoryV1 {
  const snapshots: OfficialSourceSnapshotRecordV1[] = [];
  const assets = new Map<string, StoredAssetV1>();
  const key = (chainId: number, sourceKind: string, tokenAddress: string) =>
    `${chainId}:${sourceKind}:${tokenAddress.toLowerCase()}`;

  /** Newest by INSERTION, which is the check we most recently performed. */
  const newestSnapshot = (
    sourceKind: OfficialSourceKindV1,
    successfulOnly: boolean,
  ): OfficialSourceSnapshotRecordV1 | null => {
    const matching = snapshots.filter(
      (row) => row.sourceKind === sourceKind && (!successfulOnly || row.status === 'ok'),
    );
    return matching.length === 0 ? null : matching[matching.length - 1];
  };

  /** A source still lists an asset when its newest SUCCESSFUL check named it.
   * An unreachable check writes no membership, so it cannot move this. */
  const stillListed = (row: StoredAssetV1): boolean =>
    row.sourceId === newestSnapshot(row.sourceKind, true)?.snapshotId;

  const toListing = (row: StoredAssetV1): OfficialAssetListingV1 => {
    const checked = newestSnapshot(row.sourceKind, false);
    return {
      sourceKind: row.sourceKind,
      sourceUrl: checked?.sourceUrl ?? '',
      ticker: row.ticker,
      displayName: row.displayName,
      referenceFeedAddress: row.referenceFeedAddress,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      currentlyListed: stillListed(row),
      sourceCheckedAt: checked?.observedAt ?? null,
      sourceStatus: checked?.status ?? null,
    };
  };

  const identityFor = (chainId: number, tokenAddress: string): OfficialAssetIdentityV1 | null => {
    const rows = [...assets.values()]
      .filter((row) => row.chainId === chainId && row.tokenAddress === tokenAddress.toLowerCase())
      .sort((left, right) => left.sourceKind.localeCompare(right.sourceKind));
    if (rows.length === 0) return null;
    return {
      chainId,
      tokenAddress: rows[0].tokenAddress,
      issuer: rows[0].issuer,
      listings: rows.map(toListing),
    };
  };

  return {
    async recordSnapshot(input) {
      const snapshot = assertOfficialSnapshotV1(input.snapshot, 'write');
      const rows = input.assets.map((asset) => assertOfficialAssetV1(asset, 'write'));
      assertSnapshotMayCarryAssetsV1(snapshot, rows);

      // Read the state this check is a transition FROM, before the snapshot
      // that will redefine "current" is stored.
      const previous = new Set(
        [...assets.values()]
          .filter((row) => row.sourceKind === snapshot.sourceKind && stillListed(row))
          .map((row) => row.tokenAddress),
      );

      const record: OfficialSourceSnapshotRecordV1 = {
        ...snapshot,
        snapshotId: String(snapshots.length + 1),
        assetCount: rows.length,
      };
      snapshots.push(record);

      const outcome: OfficialSnapshotOutcomeV1 = {
        snapshotId: record.snapshotId,
        sourceKind: snapshot.sourceKind,
        status: snapshot.status,
        observedAt: snapshot.observedAt,
        added: [],
        stillListed: [],
        delisted: [],
      };
      // A failed check records itself and nothing else. Membership survives it
      // untouched, which is the whole point: an outage stops the clock, it
      // never withdraws an identity.
      if (snapshot.status !== 'ok') return outcome;

      const named = new Set<string>();
      for (const asset of rows) {
        named.add(asset.tokenAddress);
        const id = key(asset.chainId, asset.sourceKind, asset.tokenAddress);
        const existing = assets.get(id);
        assets.set(id, {
          ...asset,
          firstSeenAt: existing?.firstSeenAt ?? snapshot.observedAt,
          // The latest of the two, exactly as the database's GREATEST does:
          // "how long a source has listed this" may not move backwards
          // because one check carried an earlier clock.
          lastSeenAt:
            existing && Date.parse(existing.lastSeenAt) > Date.parse(snapshot.observedAt)
              ? existing.lastSeenAt
              : snapshot.observedAt,
          sourceId: record.snapshotId,
        });
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
      return newestSnapshot(input.sourceKind, input.successfulOnly === true);
    },

    async officialIdentity(input) {
      return identityFor(input.chainId, input.tokenAddress);
    },

    async officialAssets(input) {
      const currentOnly = input.currentlyListedOnly !== false;
      const addresses = new Set<string>();
      for (const row of assets.values()) {
        if (row.chainId !== input.chainId) continue;
        if (input.sourceKind && row.sourceKind !== input.sourceKind) continue;
        if (currentOnly && !stillListed(row)) continue;
        addresses.add(row.tokenAddress);
      }
      const identities: OfficialAssetIdentityV1[] = [];
      for (const address of addresses) {
        const identity = identityFor(input.chainId, address);
        if (!identity) continue;
        if (input.sourceKind) {
          identity.listings = identity.listings.filter((listing) => listing.sourceKind === input.sourceKind);
        }
        identities.push(identity);
      }
      return identities
        .sort((left, right) => {
          const byTicker = left.listings[0].ticker.localeCompare(right.listings[0].ticker);
          return byTicker !== 0 ? byTicker : left.tokenAddress.localeCompare(right.tokenAddress);
        })
        .slice(0, Math.max(1, Math.min(500, input.limit)));
    },

    async sourceDiscrepancies(input) {
      const reviewed = OFFICIAL_SOURCE_KINDS_V1.filter((kind) => newestSnapshot(kind, true) !== null);
      return officialSourceDiscrepanciesV1({
        reviewedKinds: reviewed,
        rows: [...assets.values()]
          .filter((row) => row.chainId === input.chainId)
          .map((row) => ({
            tokenAddress: row.tokenAddress,
            sourceKind: row.sourceKind,
            ticker: row.ticker,
            lastSeenAt: row.lastSeenAt,
            currentlyListed: stillListed(row),
          })),
      });
    },
  };
}
