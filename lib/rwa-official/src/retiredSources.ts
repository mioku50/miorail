import {
  RETIRED_OFFICIAL_SOURCES_V1,
  officialSourceRetiredV1,
  type OfficialAssetIdentityV1,
} from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// Sources Miorail no longer reads.
//
// Which sources are retired, and why, is declared beside the source kinds in
// @mioagent/route-storage, so that the discrepancies every surface reads
// already leave a retired source out. This module keeps what the official
// worker needs on top: the guard that a frozen snapshot is never the only
// thing keeping an asset official.
// ---------------------------------------------------------------------------

export { RETIRED_OFFICIAL_SOURCES_V1, officialSourceRetiredV1 };

/** Assets whose only current listings come from retired sources. */
export function listedOnlyByRetiredSourcesV1(
  assets: readonly OfficialAssetIdentityV1[],
): OfficialAssetIdentityV1[] {
  return assets.filter((asset) => {
    const current = asset.listings.filter((listing) => listing.currentlyListed);
    return current.length > 0 && current.every((listing) => officialSourceRetiredV1(listing.sourceKind));
  });
}
