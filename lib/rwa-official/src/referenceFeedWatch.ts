import { baseDocsFeedLabelsV1 } from './baseDocsCorpus.js';

// ---------------------------------------------------------------------------
// The Chainlink feeds Base still publishes, watched rather than bound.
//
// The page that was `base_docs_technical` lost its address table on
// 2026-10-07 and kept its feed table: one row per underlying ("Coinbase AAPL")
// with the feed's proxy address. Every feed Miorail reads comes from the last
// complete snapshot of that page, where ONE document bound a feed to a token
// through its own two tables. Nothing can bind a feed the page adds now: the
// token's address lives in another publication, and a reference value
// attached to the wrong asset is worse than none.
//
// So this only compares. A feed the page publishes for a token Miorail holds
// no feed for, or at a different address than the one it holds, fails the
// official pass, and a person reviews the binding. The issuer's API says
// which tokens have a Chainlink reference value at all (`nav_price`), which
// is the other half of the same question.
// ---------------------------------------------------------------------------

export interface ReferenceFeedWatchAssetV1 {
  tokenAddress: string;
  /** The issuer's ticker for the token, as its API lists it today. */
  ticker: string;
  /** The feed Miorail holds for the token from a reviewed binding, or null. */
  heldFeedAddress: string | null;
  /** The issuer publishes a Chainlink reference value for the token. */
  referenceValuePublished: boolean;
}

export interface ReferenceFeedFindingV1 {
  label: string;
  feedAddress: string;
  ticker: string;
  tokenAddress: string;
}

export interface ReferenceFeedWatchV1 {
  /** Feeds the page publishes at the address Miorail holds for the token. */
  matched: string[];
  /** Published for a token Miorail holds no feed for: a binding to review. */
  unbound: ReferenceFeedFindingV1[];
  /** Published at an address other than the one Miorail holds. */
  moved: (ReferenceFeedFindingV1 & { heldFeedAddress: string })[];
  /** No single token the issuer lists answers to the label. */
  unmatched: { label: string; feedAddress: string; candidates: number }[];
  /** Tokens with an issuer reference value and no feed Miorail holds. */
  referenceValueWithoutFeed: string[];
}

export function watchReferenceFeedsV1(input: {
  feeds: readonly { label: string; feedAddress: string }[];
  assets: readonly ReferenceFeedWatchAssetV1[];
}): ReferenceFeedWatchV1 {
  const watch: ReferenceFeedWatchV1 = { matched: [], unbound: [], moved: [], unmatched: [], referenceValueWithoutFeed: [] };
  for (const feed of input.feeds) {
    const candidates = input.assets.filter((asset) => baseDocsFeedLabelsV1(asset.ticker).includes(feed.label));
    if (candidates.length !== 1) {
      watch.unmatched.push({ label: feed.label, feedAddress: feed.feedAddress, candidates: candidates.length });
      continue;
    }
    const [asset] = candidates;
    const finding = { label: feed.label, feedAddress: feed.feedAddress, ticker: asset.ticker, tokenAddress: asset.tokenAddress };
    if (asset.heldFeedAddress === null) watch.unbound.push(finding);
    else if (asset.heldFeedAddress.toLowerCase() !== feed.feedAddress.toLowerCase()) {
      watch.moved.push({ ...finding, heldFeedAddress: asset.heldFeedAddress.toLowerCase() });
    } else watch.matched.push(asset.ticker);
  }
  watch.referenceValueWithoutFeed = input.assets
    .filter((asset) => asset.referenceValuePublished && asset.heldFeedAddress === null)
    .map((asset) => asset.ticker)
    .sort();
  watch.matched.sort();
  return watch;
}
