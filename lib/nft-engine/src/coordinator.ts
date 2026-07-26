import type {
  NftAssetRefV1,
  NftEvidenceRecordV1,
  NftListingCandidateV1,
  NftPurchaseIntentV1,
  NftRouteCardV1,
} from '@mioagent/route-domain';
import type { NftGatewayReasonV1, NftObservedAssetV1, NftObservedListingV1, OpenSeaGatewayV1 } from './opensea-gateway.js';
import { buildNftAssetRefV1, buildNftCandidateV1, buildNftEvidenceV1, buildNftRouteCardV1 } from './routeCard.js';
import { verifyNftIdentityV1, type NftVerificationReasonV1 } from './verification.js';

// ---------------------------------------------------------------------------
// T65.1 §2 — the end-to-end NFT comparison:
//   intent → NFT read → listing read → identity check → candidate + evidence
//   → NFT Route Card.
//
// No I/O of its own; the gateway is injected, so unit tests never open a
// socket. Every failure still produces a CARD carrying the reason — an NFT
// that vanished from the screen would leave the user guessing what happened
// to the listing they asked about.
// ---------------------------------------------------------------------------

export type NftComparisonReasonV1 = NftVerificationReasonV1 | NftGatewayReasonV1 | 'no_active_listing';

export interface NftComparisonOkV1 {
  ok: true;
  card: NftRouteCardV1;
  asset: NftAssetRefV1;
  candidate: NftListingCandidateV1;
  evidence: NftEvidenceRecordV1[];
}

export interface NftComparisonFailedV1 {
  ok: false;
  reason: NftComparisonReasonV1;
  /** Present whenever the NFT itself could be read. A card with no candidate
   * still names the token and states why there is nothing to buy. */
  card: NftRouteCardV1 | null;
  asset: NftAssetRefV1 | null;
  evidence: NftEvidenceRecordV1[];
}

export type NftComparisonResultV1 = NftComparisonOkV1 | NftComparisonFailedV1;

export interface CompareNftRoutesInputV1 {
  intent: NftPurchaseIntentV1;
  now: Date;
  ttlMs?: number;
  /** This deployment's media policy. Off means no image reaches a surface at
   * all, not a placeholder chosen later. */
  imageAllowed?: boolean;
  /** Gas is an ESTIMATE supplied by the caller from a chain read. Absent, the
   * card shows no total rather than the listing price wearing the word. */
  estimatedGasWei?: string | null;
}

const FAILURE_COPY_V1: Record<NftComparisonReasonV1, string> = {
  chain_mismatch: 'This NFT is not on Base. Miorail buys Base NFTs only.',
  asset_mismatch: 'OpenSea returned a different token than the one you asked for.',
  standard_unsupported: 'This is not an ERC-721. Miorail buys single ERC-721 tokens only.',
  listing_not_active: 'There is no active listing for this NFT right now.',
  listing_private: 'This listing is reserved for a specific buyer and cannot be filled here.',
  listing_expired: 'This listing has expired.',
  order_incomplete: 'OpenSea did not return a complete order for this listing.',
  protocol_not_allowlisted: 'This listing uses a marketplace contract Miorail does not fulfil.',
  currency_unsupported: 'This listing is not priced in ETH. Miorail pays in native ETH only.',
  price_not_positive: 'OpenSea returned a price Miorail will not act on.',
  price_above_ceiling: 'The only active listing costs more than your limit.',
  quantity_unsupported: 'This listing is not for a single token.',
  recipient_mismatch: 'The fulfilment would not deliver the NFT to your wallet.',
  provider_invalid_response: 'OpenSea returned a response Miorail could not read.',
  no_active_listing: 'This NFT is not listed for sale right now.',
  not_found: 'OpenSea does not know this NFT.',
  unauthorized: 'Miorail cannot reach OpenSea with the credentials it has.',
  rate_limited: 'OpenSea is rate limiting Miorail. Try again shortly.',
  provider_unavailable: 'OpenSea did not answer.',
  listing_unreadable: 'OpenSea returned a listing Miorail could not read safely.',
  quote_disagrees_with_order: 'The quoted price does not match the order. Miorail will not act on that.',
};

/** The one sentence a surface shows for a failed comparison. Fixed strings, so
 * a provider outage is never phrased as "this NFT does not exist". */
export function nftComparisonCopyV1(reason: NftComparisonReasonV1): string {
  return FAILURE_COPY_V1[reason] ?? 'Miorail could not verify this listing.';
}

export async function compareNftRoutesV1(
  deps: { gateway: OpenSeaGatewayV1 },
  input: CompareNftRoutesInputV1,
): Promise<NftComparisonResultV1> {
  const { intent, now } = input;
  const imageAllowed = input.imageAllowed ?? false;

  // A goal may name the collection by slug instead of by address. The slug is
  // resolved to a CONTRACT here, through the listing read, and everything
  // afterwards is bound to that address — identity in this family is
  // chain + contract + tokenId, and a name is never allowed to stand in for it.
  let contractAddress = intent.contractAddress;
  let resolvedListing: NftObservedListingV1 | null = null;
  if (contractAddress === null) {
    if (intent.collectionSlug === null) {
      return { ok: false, reason: 'asset_mismatch', card: null, asset: null, evidence: [] };
    }
    const bySlug = await deps.gateway.readBestListing({
      collectionSlug: intent.collectionSlug,
      tokenId: intent.tokenId,
      now,
    });
    if (!bySlug.ok) {
      const reason: NftComparisonReasonV1 = bySlug.reason === 'not_found' ? 'no_active_listing' : bySlug.reason;
      return { ok: false, reason, card: null, asset: null, evidence: [] };
    }
    contractAddress = bySlug.value.contractAddress as `0x${string}`;
    resolvedListing = bySlug.value;
  }

  const nft = await deps.gateway.readNft({ contractAddress, tokenId: intent.tokenId, now });
  if (!nft.ok) return { ok: false, reason: nft.reason, card: null, asset: null, evidence: [] };

  const observedAsset: NftObservedAssetV1 = nft.value;
  const asset = buildNftAssetRefV1({ observed: observedAsset, imageAllowed });

  const identity = verifyNftIdentityV1({ intent, asset });
  if (!identity.ok) {
    return failedCard({ intent, asset, observedAsset, listing: null, reason: identity.reason, now, ttlMs: input.ttlMs });
  }

  const slug = observedAsset.collectionSlug;
  if (resolvedListing === null && slug === null) {
    // Without a collection slug there is no listing endpoint to ask. Stated as
    // an incomplete order rather than "not listed" — nobody looked.
    return failedCard({ intent, asset, observedAsset, listing: null, reason: 'order_incomplete', now, ttlMs: input.ttlMs });
  }

  // The slug path already read the listing; re-reading it could return a
  // different one than the contract was resolved from.
  const listing = resolvedListing
    ? ({ ok: true, value: resolvedListing } as const)
    : await deps.gateway.readBestListing({ collectionSlug: slug as string, tokenId: intent.tokenId, now });
  if (!listing.ok) {
    const reason: NftComparisonReasonV1 =
      listing.reason === 'not_found' ? 'no_active_listing' : listing.reason;
    return failedCard({ intent, asset, observedAsset, listing: null, reason, now, ttlMs: input.ttlMs });
  }

  const candidate = buildNftCandidateV1({
    intent,
    asset,
    listing: listing.value,
    estimatedGasWei: input.estimatedGasWei ?? null,
    now,
  });
  const evidence = buildNftEvidenceV1({
    intent,
    asset,
    candidateHash: candidate.candidateHash,
    observedAsset,
    observedListing: listing.value,
    now,
  });
  const built = buildNftRouteCardV1({
    intent,
    asset,
    candidate,
    evidence,
    failureReason: null,
    ttlMs: input.ttlMs,
    now,
  });
  if (!built.ok) return { ok: false, reason: built.reason, card: built.card, asset, evidence };
  return { ok: true, card: built.card, asset, candidate, evidence };
}

function failedCard(input: {
  intent: NftPurchaseIntentV1;
  asset: NftAssetRefV1;
  observedAsset: NftObservedAssetV1;
  listing: NftObservedListingV1 | null;
  reason: NftComparisonReasonV1;
  now: Date;
  ttlMs?: number;
}): NftComparisonFailedV1 {
  const evidence = buildNftEvidenceV1({
    intent: input.intent,
    asset: input.asset,
    candidateHash: null,
    observedAsset: input.observedAsset,
    observedListing: input.listing,
    now: input.now,
  });
  const built = buildNftRouteCardV1({
    intent: input.intent,
    asset: input.asset,
    candidate: null,
    evidence,
    failureReason: nftComparisonCopyV1(input.reason),
    ttlMs: input.ttlMs,
    now: input.now,
  });
  return { ok: false, reason: input.reason, card: built.card, asset: input.asset, evidence };
}
