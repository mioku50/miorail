import { partnerFetch } from '@mioagent/security/httpAllowlist';
import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import {
  NFT_OPENSEA_BASE_URL_V1,
  NFT_OPENSEA_CHAIN_SLUG_V1,
  NFT_OPENSEA_PATHS_V1,
  NFT_OPENSEA_TIMEOUT_MS_DEFAULT_V1,
  NFT_TOKEN_STANDARD_V1,
  isPinnedSeaportTargetV1,
} from './pinned-config.js';
import { mapOpenSeaListingStatusV1, readSeaportListingV1, seaportQuoteAgreesV1 } from './seaport.js';

// ---------------------------------------------------------------------------
// T65 §3 — the OpenSea v2 adapter.
//
// Every request goes through `partnerFetch`, so the host allowlist and a
// bounded timeout apply to all of them, and every path comes from
// NFT_OPENSEA_PATHS_V1 — no caller composes a URL.
//
// What this module refuses to do: interpret. It reads the response, checks it
// against the pinned constants, records what it saw, and hands back either a
// typed observation or a reason. It never repairs a field, never substitutes a
// default for a missing one, and never prefers the summary over the order.
// ---------------------------------------------------------------------------

export type NftGatewayReasonV1 =
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'provider_invalid_response'
  | 'chain_mismatch'
  | 'standard_unsupported'
  | 'no_active_listing'
  | 'listing_unreadable'
  | 'quote_disagrees_with_order'
  | 'protocol_not_allowlisted';

export interface OpenSeaGatewayConfigV1 {
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface NftObservedAssetV1 {
  contractAddress: string;
  tokenId: string;
  tokenStandard: 'erc721' | 'erc1155';
  collectionSlug: string | null;
  name: string | null;
  imageUrl: string | null;
  /** OpenSea's own moderation flags. Carried so a surface can decline to
   * render media rather than discovering the problem by rendering it. */
  isDisabled: boolean;
  isNsfw: boolean;
  requestHash: HashV1;
  responseHash: HashV1;
  observedAt: string;
}

export interface NftObservedListingV1 {
  orderHash: string;
  protocolAddress: string;
  seller: string;
  contractAddress: string;
  tokenId: string;
  /** From the ORDER's consideration, not from `price`. */
  totalWei: string;
  feeWei: string;
  listingStatus: 'active' | 'expired' | 'cancelled' | 'filled' | 'unknown';
  listingExpiresAt: string;
  restrictedByZone: boolean;
  requestHash: HashV1;
  responseHash: HashV1;
  observedAt: string;
}

export type NftGatewayResultV1<T> = { ok: true; value: T } | { ok: false; reason: NftGatewayReasonV1; detail?: string };

export interface OpenSeaGatewayV1 {
  /** The NFT itself: standard, collection, metadata. */
  readNft(input: { contractAddress: string; tokenId: string; now: Date }): Promise<NftGatewayResultV1<NftObservedAssetV1>>;
  /** The contract, used to resolve a slug-only intent to a real address. */
  readContract(input: { contractAddress: string; now: Date }): Promise<NftGatewayResultV1<{ address: string; collectionSlug: string | null; standard: string }>>;
  /** The best ACTIVE listing for one NFT. */
  readBestListing(input: { collectionSlug: string; tokenId: string; now: Date }): Promise<NftGatewayResultV1<NftObservedListingV1>>;
  /** A fresh order read, for the re-check immediately before a signature. */
  readOrder(input: { protocolAddress: string; orderHash: string; now: Date }): Promise<NftGatewayResultV1<NftObservedListingV1>>;
}

function hashPayloadV1(domain: string, payload: unknown): HashV1 {
  return stableHashV1(domain, payload);
}

function reasonForStatusV1(status: number): NftGatewayReasonV1 {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'provider_unavailable';
}

/**
 * Turns one listing-shaped OpenSea payload into an observation, or a reason.
 *
 * Shared by `readBestListing` and `readOrder` so the two can never disagree:
 * the pre-signature re-check reads its answer through exactly the same code
 * that produced the candidate the user reviewed.
 */
function observeListingV1(input: {
  payload: unknown;
  requestHash: HashV1;
  now: Date;
}): NftGatewayResultV1<NftObservedListingV1> {
  const listing = input.payload as Record<string, unknown> | null;
  if (!listing || typeof listing !== 'object') return { ok: false, reason: 'provider_invalid_response' };

  // The chain is checked by value. A payload naming another chain is refused,
  // never translated into the one we asked for.
  if (typeof listing.chain === 'string' && listing.chain.toLowerCase() !== NFT_OPENSEA_CHAIN_SLUG_V1) {
    return { ok: false, reason: 'chain_mismatch' };
  }

  const orderHash = listing.order_hash;
  const protocolAddress = listing.protocol_address;
  if (typeof orderHash !== 'string' || typeof protocolAddress !== 'string') {
    return { ok: false, reason: 'provider_invalid_response' };
  }
  if (!isPinnedSeaportTargetV1(protocolAddress)) return { ok: false, reason: 'protocol_not_allowlisted' };

  const parameters = (listing.protocol_data as { parameters?: unknown } | undefined)?.parameters;
  const read = readSeaportListingV1(parameters);
  if (!read.ok) return { ok: false, reason: 'listing_unreadable', detail: read.reason };

  // The summary must agree with the order. When it does not, the response
  // cannot be reconciled — it is refused rather than one side being preferred.
  const quoted = (listing.price as { current?: { value?: unknown; currency?: unknown } } | undefined)?.current;
  if (quoted && typeof quoted.value === 'string') {
    if (!seaportQuoteAgreesV1({ quotedWei: quoted.value, listing: read.listing })) {
      return { ok: false, reason: 'quote_disagrees_with_order' };
    }
  }

  return {
    ok: true,
    value: {
      orderHash: orderHash.toLowerCase(),
      protocolAddress: protocolAddress.toLowerCase(),
      seller: read.listing.seller,
      contractAddress: read.listing.nftContract,
      tokenId: read.listing.tokenId,
      totalWei: read.listing.totalWei,
      feeWei: read.listing.feeWei,
      listingStatus: mapOpenSeaListingStatusV1(listing.status),
      // `endTime` from the order is what the contract enforces.
      listingExpiresAt: new Date(read.listing.endTimeUnix * 1000).toISOString(),
      restrictedByZone: read.listing.restrictedByZone,
      requestHash: input.requestHash,
      responseHash: hashPayloadV1('nft-opensea-response/v1', listing),
      observedAt: input.now.toISOString(),
    },
  };
}

export function createOpenSeaGatewayV1(config: OpenSeaGatewayConfigV1): OpenSeaGatewayV1 {
  const timeoutMs = config.timeoutMs ?? NFT_OPENSEA_TIMEOUT_MS_DEFAULT_V1;

  async function call(path: string): Promise<NftGatewayResultV1<{ body: unknown; requestHash: HashV1 }>> {
    // The key never enters the request hash — the hash is evidence, and
    // evidence must be safe to store and show.
    const requestHash = hashPayloadV1('nft-opensea-request/v1', { host: 'api.opensea.io', path });
    let response: Response;
    try {
      response = await partnerFetch(
        `${NFT_OPENSEA_BASE_URL_V1}${path}`,
        { method: 'GET', headers: { 'x-api-key': config.apiKey, accept: 'application/json' } },
        { timeoutMs, fetchImpl: config.fetchImpl },
      );
    } catch {
      return { ok: false, reason: 'provider_unavailable' };
    }
    if (!response.ok) return { ok: false, reason: reasonForStatusV1(response.status) };
    try {
      return { ok: true, value: { body: await response.json(), requestHash } };
    } catch {
      return { ok: false, reason: 'provider_invalid_response' };
    }
  }

  return {
    async readNft(input) {
      const result = await call(NFT_OPENSEA_PATHS_V1.nft(input.contractAddress.toLowerCase(), input.tokenId));
      if (!result.ok) return result;
      const nft = (result.value.body as { nft?: Record<string, unknown> }).nft;
      if (!nft || typeof nft !== 'object') return { ok: false, reason: 'provider_invalid_response' };

      const standard = String(nft.token_standard ?? '').toLowerCase();
      if (standard !== NFT_TOKEN_STANDARD_V1) {
        // Named rather than misread: the caller can say "this is an ERC-1155"
        // instead of "something went wrong".
        return { ok: false, reason: 'standard_unsupported', detail: standard || 'unknown' };
      }
      // Identity comes from what we ASKED for, cross-checked against what came
      // back. A response describing another token is refused.
      const contract = String(nft.contract ?? '').toLowerCase();
      const identifier = String(nft.identifier ?? '');
      if (contract !== input.contractAddress.toLowerCase() || identifier !== input.tokenId) {
        return { ok: false, reason: 'provider_invalid_response' };
      }

      return {
        ok: true,
        value: {
          contractAddress: contract,
          tokenId: identifier,
          tokenStandard: 'erc721',
          collectionSlug: typeof nft.collection === 'string' ? nft.collection : null,
          name: typeof nft.name === 'string' ? nft.name : null,
          imageUrl: typeof nft.image_url === 'string' && nft.image_url.length > 0 ? nft.image_url : null,
          isDisabled: nft.is_disabled === true,
          isNsfw: nft.is_nsfw === true,
          requestHash: result.value.requestHash,
          responseHash: hashPayloadV1('nft-opensea-response/v1', nft),
          observedAt: input.now.toISOString(),
        },
      };
    },

    async readContract(input) {
      const result = await call(NFT_OPENSEA_PATHS_V1.contract(input.contractAddress.toLowerCase()));
      if (!result.ok) return result;
      const body = result.value.body as Record<string, unknown>;
      if (typeof body.chain === 'string' && body.chain.toLowerCase() !== NFT_OPENSEA_CHAIN_SLUG_V1) {
        return { ok: false, reason: 'chain_mismatch' };
      }
      const standard = String(body.contract_standard ?? '').toLowerCase();
      if (standard !== NFT_TOKEN_STANDARD_V1) return { ok: false, reason: 'standard_unsupported', detail: standard };
      return {
        ok: true,
        value: {
          address: String(body.address ?? '').toLowerCase(),
          collectionSlug: typeof body.collection === 'string' ? body.collection : null,
          standard,
        },
      };
    },

    async readBestListing(input) {
      const result = await call(NFT_OPENSEA_PATHS_V1.bestListing(input.collectionSlug, input.tokenId));
      if (!result.ok) {
        // No listing is a normal, expected answer — not a provider failure.
        return result.reason === 'not_found' ? { ok: false, reason: 'no_active_listing' } : result;
      }
      const body = result.value.body as Record<string, unknown>;
      // The endpoint answers with the listing directly; an empty object means
      // this NFT is not listed.
      if (!body || Object.keys(body).length === 0) return { ok: false, reason: 'no_active_listing' };
      const observed = observeListingV1({ payload: body, requestHash: result.value.requestHash, now: input.now });
      if (!observed.ok) return observed;
      // A listing for a different token than the one asked about is refused,
      // however the metadata reads.
      if (observed.value.tokenId !== input.tokenId) return { ok: false, reason: 'provider_invalid_response' };
      return observed;
    },

    async readOrder(input) {
      if (!isPinnedSeaportTargetV1(input.protocolAddress)) {
        return { ok: false, reason: 'protocol_not_allowlisted' };
      }
      const result = await call(
        NFT_OPENSEA_PATHS_V1.order(input.protocolAddress.toLowerCase(), input.orderHash.toLowerCase()),
      );
      if (!result.ok) return result;
      const order = (result.value.body as { order?: unknown }).order ?? result.value.body;
      const observed = observeListingV1({ payload: order, requestHash: result.value.requestHash, now: input.now });
      if (!observed.ok) return observed;
      if (observed.value.orderHash !== input.orderHash.toLowerCase()) {
        return { ok: false, reason: 'provider_invalid_response' };
      }
      return observed;
    },
  };
}
