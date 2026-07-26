// ---------------------------------------------------------------------------
// T65 §1 / §3 — everything this family refuses to take from a response.
//
// Chain, payment asset, standard, quantity, host and Seaport targets are
// CONSTANTS here. A provider can tell us a price, a seller and an order hash;
// it cannot tell us which chain we are on or which contract may receive a
// transaction. Nothing in this file is read from a response body.
// ---------------------------------------------------------------------------

export const NFT_CHAIN_ID_V1 = 8453 as const;
export const NFT_CHAIN_CAIP2_V1 = 'eip155:8453' as const;
/** OpenSea's own path segment for Base. Used to BUILD requests and to CHECK
 * responses — a body claiming another chain is refused, never translated. */
export const NFT_OPENSEA_CHAIN_SLUG_V1 = 'base' as const;
export const NFT_OPENSEA_HOST_V1 = 'api.opensea.io' as const;
export const NFT_OPENSEA_BASE_URL_V1 = 'https://api.opensea.io' as const;

export const NFT_PAYMENT_ASSET_V1 = 'native_eth' as const;
export const NFT_TOKEN_STANDARD_V1 = 'erc721' as const;
export const NFT_QUANTITY_V1 = 1 as const;

/**
 * Seaport deployments a fulfillment call may target.
 *
 * The kernel checks the call's `to` against BOTH this list and the protocol
 * address the order itself names — an address that is one but not the other is
 * refused. Getting an entry wrong here fails purchases closed rather than
 * sending value somewhere unintended, which is the direction this list is
 * allowed to be wrong in.
 *
 * These must be confirmed against a live `fulfillment_data` response before
 * MIORAIL_NFT_EXECUTION_V1 is ever turned on; `pnpm smoke:opensea-nft` prints
 * the protocol address the API actually returns.
 */
export const NFT_SEAPORT_TARGETS_V1: readonly `0x${string}`[] = [
  // Seaport 1.6
  '0x0000000000000068f116a894984e2db1123eb395',
  // Seaport 1.5
  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc',
];

/** ERC-721 `Transfer(address,address,uint256)`. Indexed tokenId is what makes
 * an ERC-721 log distinguishable from an ERC-20 one with the same signature:
 * ERC-721 carries three indexed topics, ERC-20 two. */
export const ERC721_TRANSFER_TOPIC_V1 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

/** `ownerOf(uint256)`. The only read that can say a purchase happened. */
export const ERC721_OWNER_OF_SELECTOR_V1 = '0x6352211e' as const;

export const NFT_OPENSEA_TIMEOUT_MS_DEFAULT_V1 = 8_000;
export const NFT_LISTING_TTL_MS_DEFAULT_V1 = 30_000;

/** The pinned OpenSea v2 paths. Built here so no caller can compose a path,
 * and so the current per-NFT best-listing route is the only one in the tree. */
export const NFT_OPENSEA_PATHS_V1 = {
  search: () => '/api/v2/search',
  contract: (address: string) => `/api/v2/chain/${NFT_OPENSEA_CHAIN_SLUG_V1}/contract/${address}`,
  nft: (address: string, tokenId: string) =>
    `/api/v2/chain/${NFT_OPENSEA_CHAIN_SLUG_V1}/contract/${address}/nfts/${tokenId}`,
  bestListing: (slug: string, tokenId: string) =>
    `/api/v2/listings/collection/${slug}/nfts/${tokenId}/best`,
  order: (protocolAddress: string, orderHash: string) =>
    `/api/v2/orders/chain/${NFT_OPENSEA_CHAIN_SLUG_V1}/protocol/${protocolAddress}/${orderHash}`,
  fulfillmentData: () => '/api/v2/listings/fulfillment_data',
} as const;

export function isPinnedSeaportTargetV1(address: string | null | undefined): boolean {
  if (!address) return false;
  return NFT_SEAPORT_TARGETS_V1.includes(address.toLowerCase() as `0x${string}`);
}
