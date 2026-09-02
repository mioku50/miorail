import { partnerFetch } from '@mioagent/security/httpAllowlist';

import type { DefiListingSourceV1, DefiVenueListingV1 } from './useAccess.js';

// ---------------------------------------------------------------------------
// Is this EXACT address listed at a reviewed lending venue, and for what.
//
// The Use & access tab used to publish six DeFi rows all reading "Not
// established", which is true and useless: nothing had ever looked. These look,
// at the two venues this project already reviews and already allowlists, and
// they answer the three axes separately — a token accepted as collateral is not
// one anybody can borrow, and merging them would invent a use.
//
// WHAT A MISS MEANS, EXACTLY
//
// `not_listed` is bounded by the venue it came from. The copy above it names
// the venues that were checked, so the page can never say "not in DeFi" — a
// sentence Miorail has no standing to write. A venue that could not be read is
// `unread` for that venue only; a transport failure of ours must never become a
// finding about the token.
//
// The control that makes this worth anything: USDC returns twenty Morpho
// markets in both roles and a Moonwell market with a collateral factor, while
// the tokenized stocks return nothing anywhere. A check that cannot come back
// positive has not been shown to discriminate.
// ---------------------------------------------------------------------------

export const MOONWELL_MARKETS_URL_V1 = 'https://api.moonwell.fi/v1/markets?chain=base';
export const MORPHO_GRAPHQL_URL_V1 = 'https://api.morpho.org/graphql';

/**
 * Both roles in one document, by exact address.
 *
 * A fixed query with the address as a bound variable: no market is discovered
 * by symbol, and paging the whole Base universe to search it locally would make
 * a miss depend on where the page happened to stop.
 */
export const MORPHO_MARKETS_BY_ASSET_QUERY_V1 = `query MiorailMarketsByAsset($chainId: [Int!], $address: [String!]) {
  asCollateral: markets(first: 20, where: { chainId_in: $chainId, collateralAssetAddress_in: $address }) {
    items { marketId listed state { supplyAssetsUsd borrowAssetsUsd } }
  }
  asLoan: markets(first: 20, where: { chainId_in: $chainId, loanAssetAddress_in: $address }) {
    items { marketId listed state { supplyAssetsUsd borrowAssetsUsd } }
  }
}`;

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

function notListedV1(venueId: string, venueName: string): DefiVenueListingV1 {
  return {
    venueId,
    venueName,
    state: 'not_listed',
    uses: { lend: null, borrow: null, collateral: null },
    marketRef: null,
    reason: null,
  };
}

function unreadV1(venueId: string, venueName: string, reason: string): DefiVenueListingV1 {
  return {
    venueId,
    venueName,
    state: 'unread',
    uses: { lend: null, borrow: null, collateral: null },
    marketRef: null,
    reason: reason.slice(0, 200),
  };
}

function positiveNumberV1(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Moonwell, from its own markets list.
 *
 * `lend` is the listing itself: a live, non-deprecated market accepts supply.
 * `collateral` is a positive collateral factor, which is the venue's own
 * statement. `borrow` is only claimed when there are OUTSTANDING borrows —
 * borrowing that has demonstrably happened is a measurement, whereas "a market
 * exists so borrowing is presumably enabled" is an inference, and this file
 * does not make those.
 */
export function moonwellListingFromMarketsV1(
  tokenAddress: string,
  markets: readonly Record<string, unknown>[],
): DefiVenueListingV1 {
  const target = tokenAddress.toLowerCase();
  const market = markets.find(
    (row) => String(row.assetAddress ?? '').toLowerCase() === target,
  );
  if (!market) return notListedV1('moonwell', 'Moonwell');
  const deprecated = market.deprecated === true;
  const collateralFactor = positiveNumberV1(market.collateralFactor);
  const borrowsUsd = positiveNumberV1(market.totalBorrowsUsd);
  return {
    venueId: 'moonwell',
    venueName: 'Moonwell',
    state: 'listed',
    uses: {
      lend: !deprecated,
      borrow: borrowsUsd !== null && borrowsUsd > 0 ? true : null,
      collateral: collateralFactor === null ? null : collateralFactor > 0,
    },
    marketRef: typeof market.mTokenAddress === 'string' ? market.mTokenAddress.toLowerCase() : null,
    reason: deprecated ? 'the venue marks this market deprecated' : null,
  };
}

/**
 * Morpho Blue, from a market query on the exact address.
 *
 * The roles are the market's own: an address used as the COLLATERAL asset of a
 * market is collateral, and one used as the LOAN asset is what that market
 * lends and borrows. Neither is derived from the other.
 */
export function morphoListingFromMarketsV1(
  asCollateral: readonly Record<string, unknown>[],
  asLoan: readonly Record<string, unknown>[],
): DefiVenueListingV1 {
  if (asCollateral.length === 0 && asLoan.length === 0) {
    return notListedV1('morpho', 'Morpho');
  }
  const borrowed = asLoan.some((market) => {
    const state = market.state as { borrowAssetsUsd?: unknown } | undefined;
    const value = positiveNumberV1(state?.borrowAssetsUsd);
    return value !== null && value > 0;
  });
  const first = [...asCollateral, ...asLoan][0];
  return {
    venueId: 'morpho',
    venueName: 'Morpho',
    state: 'listed',
    uses: {
      lend: asLoan.length > 0 ? true : null,
      borrow: asLoan.length > 0 ? (borrowed ? true : null) : null,
      collateral: asCollateral.length > 0 ? true : null,
    },
    marketRef: typeof first?.marketId === 'string' ? first.marketId : null,
    reason: null,
  };
}

export function moonwellDefiSourceV1(options?: { endpoint?: string }): DefiListingSourceV1 {
  return {
    venueId: 'moonwell',
    venueName: 'Moonwell',
    async lookup(tokenAddress) {
      if (!ADDRESS_V1.test(tokenAddress)) return unreadV1('moonwell', 'Moonwell', 'bad address');
      const response = await partnerFetch(options?.endpoint ?? MOONWELL_MARKETS_URL_V1, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        return unreadV1('moonwell', 'Moonwell', `moonwell answered HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      const markets = Array.isArray(body)
        ? body
        : Array.isArray((body as { data?: unknown })?.data)
          ? ((body as { data: unknown[] }).data)
          : null;
      if (!markets) return unreadV1('moonwell', 'Moonwell', 'moonwell returned no market list');
      return moonwellListingFromMarketsV1(
        tokenAddress,
        markets.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null),
      );
    },
  };
}

export function morphoDefiSourceV1(options?: { endpoint?: string }): DefiListingSourceV1 {
  return {
    venueId: 'morpho',
    venueName: 'Morpho',
    async lookup(tokenAddress) {
      if (!ADDRESS_V1.test(tokenAddress)) return unreadV1('morpho', 'Morpho', 'bad address');
      const response = await partnerFetch(options?.endpoint ?? MORPHO_GRAPHQL_URL_V1, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query: MORPHO_MARKETS_BY_ASSET_QUERY_V1,
          variables: { chainId: [8453], address: [tokenAddress] },
        }),
      });
      if (!response.ok) {
        return unreadV1('morpho', 'Morpho', `morpho answered HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        errors?: unknown[];
        data?: {
          asCollateral?: { items?: unknown[] };
          asLoan?: { items?: unknown[] };
        };
      };
      if (body.errors && body.errors.length > 0) {
        return unreadV1('morpho', 'Morpho', 'morpho returned a GraphQL error');
      }
      const asCollateral = body.data?.asCollateral?.items;
      const asLoan = body.data?.asLoan?.items;
      if (!Array.isArray(asCollateral) || !Array.isArray(asLoan)) {
        // Not "no markets": an envelope this parser does not recognise says
        // nothing about the token, and reading it as zero is how a shape change
        // becomes a finding.
        return unreadV1('morpho', 'Morpho', 'morpho returned an unrecognised envelope');
      }
      const rows = (items: unknown[]) =>
        items.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
      return morphoListingFromMarketsV1(rows(asCollateral), rows(asLoan));
    },
  };
}

/** The reviewed venue set, in the order the copy names them. */
export function reviewedDefiSourcesV1(): DefiListingSourceV1[] {
  return [moonwellDefiSourceV1(), morphoDefiSourceV1()];
}
