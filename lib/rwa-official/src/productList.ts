import { isAddressV1, TICKER_SHAPE_V1, type OfficialParseResultV1, type OfficialSourceAssetV1 } from './sources.js';

// ---------------------------------------------------------------------------
// What the product surface is currently offering.
//
// This page is rendered markup, not a published contract, so the parser takes
// the narrowest thing on it that carries BOTH facts we need in one element:
// the explorer link. Its accessible label names the token and its href is the
// address, so symbol and address are read from the same node and cannot be
// paired by proximity -- which is how a scraper ends up attaching one asset's
// address to another asset's name.
//
// If the markup changes, this finds nothing and says so. An empty answer here
// is our failure, never a claim that Base stopped offering tokenized stocks.
// ---------------------------------------------------------------------------

/** Anchors, one per element, so attribute order inside the tag does not matter. */
function anchorTagsV1(html: string): string[] {
  const tags: string[] = [];
  const pattern = /<a\b[^>]*>/gi;
  for (const match of html.matchAll(pattern)) tags.push(match[0]);
  return tags;
}

const LABEL_V1 = /aria-label\s*=\s*"View\s+([^"]+?)\s+on\s+BaseScan"/i;
const TOKEN_HREF_V1 = /href\s*=\s*"https:\/\/basescan\.org\/token\/(0x[0-9a-fA-F]{40})"/i;

export function parseBaseProductListV1(html: string): OfficialParseResultV1 {
  const assets: OfficialSourceAssetV1[] = [];
  const seen = new Set<string>();

  for (const tag of anchorTagsV1(html)) {
    const label = LABEL_V1.exec(tag);
    const href = TOKEN_HREF_V1.exec(tag);
    if (!label || !href) continue;
    const ticker = label[1].trim();
    const tokenAddress = href[1].toLowerCase();
    if (!TICKER_SHAPE_V1.test(ticker) || !isAddressV1(tokenAddress)) continue;
    const pair = `${ticker}:${tokenAddress}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    assets.push({ tokenAddress, ticker, displayName: null, referenceFeedAddress: null });
  }

  // The page repeats each asset in several layouts. The same ticker on two
  // ADDRESSES is a different matter entirely, and not something to average.
  const byTicker = new Map<string, Set<string>>();
  for (const asset of assets) {
    const addresses = byTicker.get(asset.ticker) ?? new Set<string>();
    addresses.add(asset.tokenAddress);
    byTicker.set(asset.ticker, addresses);
  }
  for (const [ticker, addresses] of byTicker) {
    if (addresses.size > 1) {
      return {
        ok: false,
        refusal: 'ticker_maps_to_multiple_addresses',
        detail: `the page shows ${ticker} at ${addresses.size} different addresses`,
      };
    }
  }

  const unique = [...byTicker].map(([ticker, addresses]) => ({
    tokenAddress: [...addresses][0],
    ticker,
    displayName: null,
    referenceFeedAddress: null,
  }));

  if (unique.length === 0) {
    return {
      ok: false,
      refusal: 'no_asset_rows',
      detail: 'no explorer link on the page named a token and an address together',
    };
  }
  return { ok: true, assets: unique, otherEntries: [] };
}
