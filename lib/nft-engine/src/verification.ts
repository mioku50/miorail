import {
  hashNftAssetRefV1,
  sameNftAssetV1,
  type NftAssetRefV1,
  type NftListingCandidateV1,
  type NftPurchaseIntentV1,
} from '@mioagent/route-domain';
import {
  NFT_CHAIN_CAIP2_V1,
  NFT_PAYMENT_ASSET_V1,
  NFT_TOKEN_STANDARD_V1,
  isPinnedSeaportTargetV1,
} from './pinned-config.js';

// ---------------------------------------------------------------------------
// T65 §3 — the fail-closed listing checks.
//
// Every one of these runs BEFORE a Route Card is built and again before a
// signature is offered. There is no "close enough" branch: a listing that
// fails any check produces no card and no signing prompt, with a reason.
//
// The check this file exists for: IDENTITY IS NEVER METADATA. A listing whose
// name and image match what the user asked for, on a different contract or a
// different token id, is a different token — and the most profitable lie an
// NFT marketplace response can tell.
// ---------------------------------------------------------------------------

export type NftVerificationReasonV1 =
  | 'chain_mismatch'
  | 'asset_mismatch'
  | 'standard_unsupported'
  | 'listing_not_active'
  | 'listing_private'
  | 'listing_expired'
  | 'order_incomplete'
  | 'protocol_not_allowlisted'
  | 'currency_unsupported'
  | 'price_not_positive'
  | 'price_above_ceiling'
  | 'quantity_unsupported'
  | 'recipient_mismatch'
  | 'provider_invalid_response';

export type NftVerificationResultV1 = { ok: true } | { ok: false; reason: NftVerificationReasonV1 };

const OK: NftVerificationResultV1 = { ok: true };

function fail(reason: NftVerificationReasonV1): NftVerificationResultV1 {
  return { ok: false, reason };
}

/**
 * The asset the provider described must be the asset the user asked for.
 *
 * Compares chain + contract + tokenId only. `name`, `image` and
 * `collectionName` are not consulted, because they are the parts an attacker
 * controls: a worthless token can carry a famous one's name and picture, and
 * that must change nothing.
 */
export function verifyNftIdentityV1(input: {
  intent: NftPurchaseIntentV1;
  asset: NftAssetRefV1;
}): NftVerificationResultV1 {
  const { intent, asset } = input;
  if (asset.chain !== NFT_CHAIN_CAIP2_V1) return fail('chain_mismatch');
  if (asset.tokenStandard !== NFT_TOKEN_STANDARD_V1) return fail('standard_unsupported');
  if (asset.tokenId !== intent.tokenId) return fail('asset_mismatch');
  // A contract in the intent is identity and must match exactly. When the user
  // only gave a slug there is nothing to compare — the resolved contract IS
  // the answer, and it is what every later check is bound to.
  if (intent.contractAddress !== null && asset.contractAddress.toLowerCase() !== intent.contractAddress.toLowerCase()) {
    return fail('asset_mismatch');
  }
  return OK;
}

/**
 * The listing itself: active, public, unexpired, priced in native ETH, within
 * the ceiling, and carrying the order fields a fulfillment needs.
 */
export function verifyNftListingV1(input: {
  intent: NftPurchaseIntentV1;
  candidate: NftListingCandidateV1;
  now: Date;
}): NftVerificationResultV1 {
  const { intent, candidate } = input;

  const identity = verifyNftIdentityV1({ intent, asset: candidate.asset });
  if (!identity.ok) return identity;

  if (candidate.listingStatus !== 'active') return fail('listing_not_active');
  // A private listing names a single permitted taker. Buying into one either
  // reverts or fills on terms the buyer never saw.
  if (candidate.order.restrictedTaker !== null) return fail('listing_private');

  const expiresAtMs = Date.parse(candidate.listingExpiresAt);
  if (Number.isNaN(expiresAtMs)) return fail('provider_invalid_response');
  if (expiresAtMs <= input.now.getTime()) return fail('listing_expired');

  if (!candidate.order.orderHash || !candidate.order.protocolAddress) return fail('order_incomplete');
  if (!isPinnedSeaportTargetV1(candidate.order.protocolAddress)) return fail('protocol_not_allowlisted');

  if (candidate.paymentAsset !== NFT_PAYMENT_ASSET_V1) return fail('currency_unsupported');

  let price: bigint;
  try {
    price = BigInt(candidate.listingPriceWei);
  } catch {
    return fail('provider_invalid_response');
  }
  if (price <= BigInt(0)) return fail('price_not_positive');

  // The ceiling is what the user authorized. It is compared against the
  // LISTING PRICE here and against the CALL VALUE in the safety kernel; both,
  // because a price under the ceiling can still be sent with a larger value.
  if (intent.maxSpendWei === null) return fail('price_above_ceiling');
  if (price > BigInt(intent.maxSpendWei)) return fail('price_above_ceiling');

  return OK;
}

/**
 * Re-verification immediately before a signature.
 *
 * A listing observed a minute ago may have been cancelled or filled. This
 * compares a FRESH order read against the candidate the user reviewed: the
 * same order, the same token, the same price. Anything else stops, and no new
 * listing is silently substituted — the user reviewed one listing, and a
 * different one is a different decision.
 */
export function verifyNftListingUnchangedV1(input: {
  candidate: NftListingCandidateV1;
  fresh: {
    orderHash: string;
    protocolAddress: string;
    listingStatus: NftListingCandidateV1['listingStatus'];
    listingPriceWei: string;
    asset: NftAssetRefV1;
    restrictedTaker: string | null;
    listingExpiresAt: string;
  };
  now: Date;
}): NftVerificationResultV1 {
  const { candidate, fresh } = input;
  if (fresh.orderHash.toLowerCase() !== candidate.order.orderHash.toLowerCase()) return fail('order_incomplete');
  if (fresh.protocolAddress.toLowerCase() !== candidate.order.protocolAddress.toLowerCase()) {
    return fail('protocol_not_allowlisted');
  }
  if (!sameNftAssetV1(fresh.asset, candidate.asset)) return fail('asset_mismatch');
  if (fresh.listingStatus !== 'active') return fail('listing_not_active');
  if (fresh.restrictedTaker !== null) return fail('listing_private');
  // A price that MOVED is not this listing any more, in either direction. A
  // cheaper one still means the reviewed terms were not the executed terms.
  if (fresh.listingPriceWei !== candidate.listingPriceWei) return fail('price_above_ceiling');
  const expiresAtMs = Date.parse(fresh.listingExpiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= input.now.getTime()) return fail('listing_expired');
  return OK;
}

/** Refunds, receipts and the NFT itself go to the authenticated wallet or
 * nowhere. A recipient the caller supplied is never trusted. */
export function verifyNftRecipientV1(input: {
  authenticatedWallet: string;
  fulfiller: string | null;
  recipient: string | null;
}): NftVerificationResultV1 {
  const wallet = input.authenticatedWallet.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return fail('provider_invalid_response');
  if (input.fulfiller !== null && input.fulfiller.toLowerCase() !== wallet) return fail('recipient_mismatch');
  if (input.recipient !== null && input.recipient.toLowerCase() !== wallet) return fail('recipient_mismatch');
  return OK;
}

/** True when a token reference is the one this intent is about. Exposed so
 * callers compare identity through one function rather than by hand. */
export function nftAssetMatchesIntentV1(intent: NftPurchaseIntentV1, asset: NftAssetRefV1): boolean {
  return verifyNftIdentityV1({ intent, asset }).ok;
}

export { hashNftAssetRefV1 };
