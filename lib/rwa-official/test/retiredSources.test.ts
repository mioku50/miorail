import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OfficialAssetIdentityV1, OfficialAssetListingV1 } from '@mioagent/route-storage';
import {
  listedOnlyByRetiredSourcesV1,
  officialSourceRetiredV1,
  OFFICIAL_SOURCES_V1,
} from '../src/index.js';

const AAPL = '0x1111111111111111111111111111111111111111';
const NEW = '0x2222222222222222222222222222222222222222';

function listing(sourceKind: OfficialAssetListingV1['sourceKind'], currentlyListed = true): OfficialAssetListingV1 {
  return {
    sourceKind, sourceUrl: 'https://example.invalid/source', ticker: 'AAPLc', displayName: null,
    referenceFeedAddress: null, firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-10-07T18:52:30.918Z',
    currentlyListed, sourceCheckedAt: null, sourceStatus: 'ok',
  };
}
function asset(tokenAddress: string, listings: OfficialAssetListingV1[]): OfficialAssetIdentityV1 {
  return { chainId: 8453, tokenAddress, issuer: 'coinbase', listings };
}

test('the docs page Base emptied is retired, and nothing else is', () => {
  assert.equal(officialSourceRetiredV1('base_docs_technical'), true);
  for (const kind of ['base_product_list', 'coinbase_stocks_api', 'backed_assets_api']) {
    assert.equal(officialSourceRetiredV1(kind), false, kind);
  }
  // Retired, not deleted: the frozen rows still name where they came from.
  assert.ok(OFFICIAL_SOURCES_V1.base_docs_technical.url.startsWith('https://docs.base.org/'));
});

test('a retired source cannot keep an asset official on its own', () => {
  const flagged = listedOnlyByRetiredSourcesV1([
    asset(AAPL, [listing('base_docs_technical'), listing('coinbase_stocks_api')]),
    asset(NEW, [listing('base_docs_technical'), listing('coinbase_stocks_api', false)]),
  ]);
  assert.deepEqual(flagged.map((row) => row.tokenAddress), [NEW]);
  assert.deepEqual(listedOnlyByRetiredSourcesV1([asset(AAPL, [listing('base_docs_technical', false)])]), []);
});
