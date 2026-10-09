import type {
  OfficialAssetIdentityV1,
  OfficialSourceDiscrepancyV1,
  OfficialSourceKindV1,
} from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// Sources Miorail no longer reads.
//
// On 2026-10-07 Base removed the contract-address table from its "List
// Tokenized Stocks" page, the `base_docs_technical` source. The page now sends
// readers to base.org/assets and to the List Tokenized Stocks API, which is
// `coinbase_stocks_api`, and it will never parse back into a corpus: every
// hourly pass failed from then on, and the red unit went unnoticed for days.
//
// Retired is not deleted. The source's last complete snapshot stays exactly as
// it was recorded: it is the history of what Base published, and it still
// carries the Chainlink reference feeds Base goes on publishing for the same
// equities. What it may no longer do is keep an asset official on its own, so
// a pass that finds such an asset fails and a person decides.
// ---------------------------------------------------------------------------

export const RETIRED_OFFICIAL_SOURCES_V1: Readonly<
  Partial<Record<OfficialSourceKindV1, { retiredOn: string; reason: string }>>
> = {
  base_docs_technical: {
    retiredOn: '2026-10-10',
    reason:
      'Base removed the contract-address table on 2026-10-07 and points to the List Tokenized Stocks API instead',
  },
};

export function officialSourceRetiredV1(kind: string): boolean {
  return Object.hasOwn(RETIRED_OFFICIAL_SOURCES_V1, kind);
}

/** Assets whose only current listings come from retired sources. */
export function listedOnlyByRetiredSourcesV1(
  assets: readonly OfficialAssetIdentityV1[],
): OfficialAssetIdentityV1[] {
  return assets.filter((asset) => {
    const current = asset.listings.filter((listing) => listing.currentlyListed);
    return current.length > 0 && current.every((listing) => officialSourceRetiredV1(listing.sourceKind));
  });
}

/**
 * Disagreements between the sources still read.
 *
 * A retired source is not a place an asset can go missing from, and its frozen
 * rows do not drop anything: without this, every pass printed "not in
 * base_docs_technical" for each asset the API added after the page stopped.
 * An asset listed ONLY by a retired source is reported by
 * `listedOnlyByRetiredSourcesV1` instead, as a failure.
 */
export function activeSourceDiscrepanciesV1(
  discrepancies: readonly OfficialSourceDiscrepancyV1[],
): OfficialSourceDiscrepancyV1[] {
  const kept: OfficialSourceDiscrepancyV1[] = [];
  for (const row of discrepancies) {
    if (row.kind === 'delisted_by_source') {
      if (!officialSourceRetiredV1(row.sourceKind)) kept.push(row);
    } else if (row.kind === 'listed_in_one_source') {
      const listedIn = row.listedIn.filter((kind) => !officialSourceRetiredV1(kind));
      const missingFrom = row.missingFrom.filter((kind) => !officialSourceRetiredV1(kind));
      if (listedIn.length > 0 && missingFrom.length > 0) kept.push({ ...row, listedIn, missingFrom });
    } else {
      kept.push(row);
    }
  }
  return kept;
}
