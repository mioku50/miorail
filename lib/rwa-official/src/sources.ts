// ---------------------------------------------------------------------------
// The reviewed sources of the OFFICIAL trust root.
//
// Two of them, deliberately, and they are not interchangeable:
//
//   base_docs_technical  the complete issuance corpus, published for
//                        integrators. Thirteen tokenized equities on
//                        2026-08-25, plus the oracle registry; ten on
//                        2026-09-10, when Base dropped COINc, CRCLc and INTCc
//                        -- three addresses that have never held supply.
//   base_product_list    what the product surface is currently offering.
//                        Four of the same thirteen on 2026-08-25, and ten from
//                        2026-09-04, when AMZNc, MSFTc, MSTRc, SNDKc, SPCXc and
//                        TSLAc went on offer.
//
// Neither is wrong and neither supersedes the other. "Officially issued" and
// "currently offered" are different claims, and an asset can be the first
// without being the second -- which is exactly the fact a reader needs before
// deciding what a thin market means.
//
// The technical source is read as markdown rather than as the rendered page.
// It is the same document a human reads; the difference is that a markdown
// table is a contract and a rendered DOM is a layout, and only one of those
// stays stable when the site is restyled.
//
// The path below is not the one Miorail first read. Base moved the document
// from `base-chain/asset-issuance/tokenized-stocks-on-base` to
// `build-on-base/integrate-defi/list-tokenized-stocks` on 2026-09-10; the old
// path still redirects here, and the redirect is followed, but a stored
// `source_url` should name the document that exists rather than the one that
// used to.
// ---------------------------------------------------------------------------

export const OFFICIAL_SOURCES_V1 = {
  base_docs_technical: {
    url: 'https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks.md',
    /** Where a human reads the same document. Shown, never fetched. */
    humanUrl: 'https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks',
    issuer: 'coinbase',
  },
  base_product_list: {
    url: 'https://brand.base.org/stocks',
    humanUrl: 'https://brand.base.org/stocks',
    issuer: 'coinbase',
  },
} as const;

export type OfficialSourceKeyV1 = keyof typeof OFFICIAL_SOURCES_V1;

/** One asset as a reviewed source names it. Addresses are already normalized;
 * the store refuses anything else, so normalization cannot be forgotten later. */
export interface OfficialSourceAssetV1 {
  tokenAddress: string;
  ticker: string;
  displayName: string | null;
  /** The reference feed the SAME document binds to this asset, if any. */
  referenceFeedAddress: string | null;
}

export type OfficialParseResultV1 =
  | {
      ok: true;
      assets: OfficialSourceAssetV1[];
      /** Rows in the document that are not assets, kept so a change in the
       * document's shape is visible instead of silently dropped. */
      otherEntries: { label: string; address: string }[];
    }
  | { ok: false; refusal: string; detail: string };

/** A bare ticker. Anything with a space or punctuation beyond a dot or dash is
 * a label, not a ticker -- which is how the oracle registry row stays out of
 * the asset set without the parser needing to know its name. */
export const TICKER_SHAPE_V1 = /^[A-Za-z0-9.-]{1,16}$/;

export function isAddressV1(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
