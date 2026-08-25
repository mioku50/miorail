import { createHash } from 'node:crypto';

import type { OfficialSourceAssetV1 } from './sources.js';

// ---------------------------------------------------------------------------
// Two hashes, because they answer two different questions.
//
// The DOCUMENT hash moves whenever the site is rebuilt -- a reworded warning,
// a new nav entry, a changed footer. On its own it would report a change every
// week and mean nothing.
//
// The CORPUS hash moves only when the reviewed membership actually moved: an
// address added, an address dropped, a ticker or a reference feed rebound.
// That is the one worth waking somebody for.
//
// Neither is a signature. They prove that what we stored is what we read, not
// that the source is authentic; authenticity here is the https origin.
// ---------------------------------------------------------------------------

export function officialDocumentHashV1(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function officialCorpusHashV1(assets: readonly OfficialSourceAssetV1[]): string {
  // Sorted by address, so the same membership in a different document order
  // hashes the same. Address first, because address is the identity.
  const canonical = [...assets]
    .sort((left, right) => left.tokenAddress.localeCompare(right.tokenAddress))
    .map((asset) => [asset.tokenAddress, asset.ticker, asset.referenceFeedAddress ?? '']);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
