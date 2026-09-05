import { partnerFetch } from '@mioagent/security/httpAllowlist';

import type {
  DefiListingSourceV1,
  DefiVenueListingV1,
  UseAccessReaderV1,
} from './useAccess.js';

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
    curated: null,
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
    curated: null,
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
    // Moonwell's market list is governance-curated; there is no permissionless
    // market on this venue for an uncurated one to hide in.
    curated: true,
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
  // Anyone can deploy a Morpho market against any token. `listed` is Morpho's
  // own curation flag, it was queried from the very first version of this
  // parser, and it was never read — so a market a stranger deployed rendered
  // exactly like an asset Morpho accepted. Both tokenized-stock markets that
  // exist on Base come back false.
  const curated = [...asCollateral, ...asLoan].some((market) => market.listed === true);
  return {
    venueId: 'morpho',
    venueName: 'Morpho',
    state: 'listed',
    curated,
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

// ---------------------------------------------------------------------------
// The two venues that answer from the chain rather than from an API.
//
// Aave and Compound are the names a reader reaches for first, and neither
// needs a key, an allowlist entry or a third party staying up: the listed set
// IS onchain state, one `eth_call` each. That makes them strictly better
// evidence than an HTTP catalogue — and it makes the negative worth something,
// because "not accepted at Aave, Compound, Moonwell or Morpho" is a sentence a
// reader can act on, where "not at the two venues Miorail checked" is not.
//
// Measured 2026-09-03 across all 130 reviewed representations: Aave lists 15
// reserves and Compound's three Base markets hold 17 collaterals between them,
// and NOT ONE tokenized equity appears in either. USDC does, in both, which is
// the control that makes the miss mean something.
//
// Neither is a claim that a stock is absent from DeFi. It is four named places
// that were looked in.
// ---------------------------------------------------------------------------

/**
 * Venue listings are read at head, not at the page's pinned anchor.
 *
 * A listing is a question about the protocol's current configuration, and the
 * two HTTP venues beside these answer from their own live catalogue with no
 * block at all. Pinning these two to a block the others cannot honour would
 * make the four rows look like one measurement when they are four readings.
 */
const VENUE_BLOCK_TAG_V1 = 'latest';

/** Aave v3 `Pool` on Base. */
export const AAVE_V3_POOL_BASE_V1 = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
/** `getReservesList()`. */
export const AAVE_RESERVES_SELECTOR_V1 = '0xd1946dbc';

/**
 * Compound v3 markets on Base, each its own pool with its own collateral set.
 *
 * A borrowable base asset and an accepted collateral are different permissions
 * in this protocol, so the two axes are read from different places and never
 * merged: `baseToken()` is what a market lends, `getAssetInfo(i).asset` is what
 * it accepts against that loan.
 */
export const COMPOUND_V3_COMETS_BASE_V1: readonly { marketId: string; address: string }[] = [
  { marketId: 'cUSDCv3', address: '0xb125e6687d4313864e53df431d5425969c15eb2f' },
  { marketId: 'cWETHv3', address: '0x46e6b214b524310239732d51387075e0e70970bf' },
  { marketId: 'cUSDbCv3', address: '0x784efeb622244d2348d4f2522f8860b96fbece89' },
];
/** `numAssets()`, `getAssetInfo(uint8)`, `baseToken()`. */
export const COMET_NUM_ASSETS_SELECTOR_V1 = '0xa46fe83b';
export const COMET_ASSET_INFO_SELECTOR_V1 = '0xc8c7fe6b';
export const COMET_BASE_TOKEN_SELECTOR_V1 = '0xc55dae63';

/** The 20 low bytes of a 32-byte word, lowercased. Null on anything else. */
export function addressFromWordV1(raw: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  return `0x${raw.slice(26).toLowerCase()}`;
}

/** A dynamic `address[]` return. Null when the encoding is not that. */
export function addressArrayFromReturnV1(raw: string): string[] | null {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(raw) || raw.length < 130) return null;
  const body = raw.slice(2);
  const offset = Number.parseInt(body.slice(0, 64), 16) * 2;
  if (!Number.isInteger(offset) || offset + 64 > body.length) return null;
  const count = Number.parseInt(body.slice(offset, offset + 64), 16);
  if (!Number.isInteger(count) || count < 0) return null;
  const start = offset + 64;
  if (start + count * 64 > body.length) return null;
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const word = `0x${body.slice(start + index * 64, start + (index + 1) * 64)}`;
    const address = addressFromWordV1(word);
    if (address === null) return null;
    out.push(address);
  }
  return out;
}

/**
 * Aave v3, from the reserve list.
 *
 * Membership does not establish whether supply or borrowing is enabled. A
 * listed reserve may be paused, frozen or have borrowing disabled. Those
 * configuration flags, caps and liquidity are outside this listing read.
 */
export function aaveListingFromReservesV1(
  tokenAddress: string,
  reserves: readonly string[] | null,
): DefiVenueListingV1 {
  if (reserves === null) {
    return unreadV1('aave_v3', 'Aave v3', 'aave returned an unrecognised reserve list');
  }
  const listed = reserves.includes(tokenAddress.toLowerCase());
  return {
    venueId: 'aave_v3',
    venueName: 'Aave v3',
    state: listed ? 'listed' : 'not_listed',
    // A reserve exists only because Aave governance added it. There is no
    // permissionless market here to confuse it with.
    curated: listed ? true : null,
    uses: { lend: null, borrow: null, collateral: null },
    marketRef: listed ? AAVE_V3_POOL_BASE_V1 : null,
    reason: listed ? 'reserve listed; current operation settings and limits not measured' : null,
  };
}

export function aaveDefiSourceV1(reader: UseAccessReaderV1): DefiListingSourceV1 {
  return {
    venueId: 'aave_v3',
    venueName: 'Aave v3',
    async lookup(tokenAddress) {
      if (!ADDRESS_V1.test(tokenAddress)) return unreadV1('aave_v3', 'Aave v3', 'bad address');
      const answer = await reader.call({ to: AAVE_V3_POOL_BASE_V1, data: AAVE_RESERVES_SELECTOR_V1, blockTag: VENUE_BLOCK_TAG_V1 });
      if (!answer.ok) return unreadV1('aave_v3', 'Aave v3', `aave read ${answer.reason}`);
      return aaveListingFromReservesV1(tokenAddress, addressArrayFromReturnV1(answer.value));
    },
  };
}

/** One Compound market's answer: what it lends, and what it takes against it. */
export interface CometReadV1 {
  marketId: string;
  baseToken: string | null;
  collaterals: string[] | null;
}

export function compoundListingFromCometsV1(
  tokenAddress: string,
  comets: readonly CometReadV1[],
): DefiVenueListingV1 {
  const address = tokenAddress.toLowerCase();
  // An absent match is conclusive only when every reviewed market answered.
  if (comets.length === 0 || comets.every((row) => row.baseToken === null && row.collaterals === null)) {
    return unreadV1('compound_v3', 'Compound v3', 'no Compound market answered');
  }
  const lends = comets.filter((row) => row.baseToken === address);
  const takes = comets.filter((row) => (row.collaterals ?? []).includes(address));
  const listed = lends.length > 0 || takes.length > 0;
  if (!listed && comets.some((row) => row.baseToken === null || row.collaterals === null)) {
    return unreadV1('compound_v3', 'Compound v3', 'some reviewed Compound markets did not answer; absence is not established');
  }
  return {
    venueId: 'compound_v3',
    venueName: 'Compound v3',
    state: listed ? 'listed' : 'not_listed',
    // Same: a Comet's base asset and collateral set are governance decisions.
    curated: listed ? true : null,
    uses: listed
      ? {
          // A base asset is what the market lends out, so supplying it earns
          // and borrowing it is the market's whole purpose. A collateral is
          // neither — it is locked, and Compound pays nothing for it.
          lend: lends.length > 0 ? true : null,
          borrow: lends.length > 0 ? true : null,
          collateral: takes.length > 0 ? true : null,
        }
      : { lend: null, borrow: null, collateral: null },
    marketRef: listed ? [...lends, ...takes].map((row) => row.marketId).join(', ') : null,
    reason: null,
  };
}

export function compoundDefiSourceV1(reader: UseAccessReaderV1): DefiListingSourceV1 {
  return {
    venueId: 'compound_v3',
    venueName: 'Compound v3',
    async lookup(tokenAddress) {
      if (!ADDRESS_V1.test(tokenAddress)) {
        return unreadV1('compound_v3', 'Compound v3', 'bad address');
      }
      const comets: CometReadV1[] = [];
      for (const comet of COMPOUND_V3_COMETS_BASE_V1) {
        const [base, count] = await Promise.all([
          reader.call({ to: comet.address, data: COMET_BASE_TOKEN_SELECTOR_V1, blockTag: VENUE_BLOCK_TAG_V1 }),
          reader.call({ to: comet.address, data: COMET_NUM_ASSETS_SELECTOR_V1, blockTag: VENUE_BLOCK_TAG_V1 }),
        ]);
        const numAssets = count.ok && /^0x[0-9a-fA-F]{64}$/.test(count.value)
          ? Number(BigInt(count.value))
          : null;
        if (numAssets === null || numAssets < 0 || numAssets > 32) {
          comets.push({
            marketId: comet.marketId,
            baseToken: base.ok ? addressFromWordV1(base.value) : null,
            collaterals: null,
          });
          continue;
        }
        const infos = await Promise.all(
          Array.from({ length: numAssets }, (_unused, index) =>
            reader.call({
              to: comet.address,
              data: `${COMET_ASSET_INFO_SELECTOR_V1}${index.toString(16).padStart(64, '0')}`,
              blockTag: VENUE_BLOCK_TAG_V1,
            }),
          ),
        );
        // `getAssetInfo` returns a struct whose SECOND word is the asset.
        const collaterals: string[] = [];
        let complete = true;
        for (const info of infos) {
          const word = info.ok && info.value.length >= 2 + 128 ? `0x${info.value.slice(66, 130)}` : null;
          const address_ = word === null ? null : addressFromWordV1(word);
          if (address_ === null) complete = false;
          else collaterals.push(address_);
        }
        comets.push({
          marketId: comet.marketId,
          baseToken: base.ok ? addressFromWordV1(base.value) : null,
          collaterals: complete ? collaterals : null,
        });
      }
      return compoundListingFromCometsV1(tokenAddress, comets);
    },
  };
}

/**
 * The reviewed venue set, in the order the copy names them.
 *
 * A reader is optional so a caller with no chain access still gets the two HTTP
 * venues rather than nothing; passing one adds the two that answer from Base
 * itself.
 */
export function reviewedDefiSourcesV1(reader?: UseAccessReaderV1): DefiListingSourceV1[] {
  const sources = [moonwellDefiSourceV1(), morphoDefiSourceV1()];
  if (reader) sources.push(aaveDefiSourceV1(reader), compoundDefiSourceV1(reader));
  return sources;
}
