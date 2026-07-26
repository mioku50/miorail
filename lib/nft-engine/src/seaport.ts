// ---------------------------------------------------------------------------
// T65 §7 — reading a Seaport order.
//
// OpenSea hands back a summary (`price`, `status`, `type`) AND the order
// itself (`protocol_data.parameters`). Only the order is signed, and only the
// order decides what is exchanged. Everything here is derived from `offer` and
// `consideration`; the summary is used solely as a cross-check that must
// agree, never as the source.
//
// Grounded against a real Base listing observed 2026-07-26:
//   offer:         [{ itemType 2, token <collection>, identifierOrCriteria <id> }]
//   consideration: [{ itemType 0, token 0x0, 3544200000000000, → seller },
//                   { itemType 0, token 0x0,   35800000000000, → fee recipient }]
//   price.current: { currency ETH, value 3580000000000000 }
// The two consideration amounts sum EXACTLY to the quoted price, which is why
// the sum is what gets trusted and the quote is what gets checked.
// ---------------------------------------------------------------------------

/** Seaport ItemType. 0 native, 1 ERC-20, 2 ERC-721, 3 ERC-1155, 4/5 criteria. */
export const SEAPORT_ITEM_TYPE_V1 = {
  NATIVE: 0,
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
  ERC721_WITH_CRITERIA: 4,
  ERC1155_WITH_CRITERIA: 5,
} as const;

const ZERO_ADDRESS_V1 = '0x0000000000000000000000000000000000000000';

export interface SeaportItemV1 {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
  recipient?: string;
}

export interface SeaportParametersV1 {
  offerer: string;
  offer: SeaportItemV1[];
  consideration: SeaportItemV1[];
  startTime: string;
  endTime: string;
  orderType: number;
  zone: string;
  totalOriginalConsiderationItems: number;
}

export type SeaportReadReasonV1 =
  | 'offer_not_single_item'
  | 'offer_not_erc721'
  | 'offer_is_erc1155'
  | 'offer_uses_criteria'
  | 'offer_quantity_not_one'
  | 'consideration_empty'
  | 'consideration_not_native'
  | 'consideration_contains_nft'
  | 'amount_not_fixed'
  | 'malformed_order';

export interface SeaportListingReadV1 {
  /** The token being sold, straight from `offer`. */
  nftContract: string;
  tokenId: string;
  seller: string;
  /** Sum of every consideration item — what the buyer actually pays. */
  totalWei: string;
  /** Amounts going to someone other than the seller: marketplace and creator
   * fees. Stated so the Route Card can show a fee policy rather than imply
   * there is none. */
  feeWei: string;
  /** Non-null when this listing is reserved for one taker.
   *
   * Seaport expresses a private listing by putting the NFT ITSELF into the
   * consideration, directed at the intended buyer. There is no
   * `restrictedTaker` field on the wire — this is derived, and it is why the
   * consideration is read item by item instead of summed blindly. */
  reservedForTaker: string | null;
  /** Unix seconds. The authoritative expiry: `endTime` is what the contract
   * enforces, not any `expiration` string in the summary. */
  endTimeUnix: number;
  startTimeUnix: number;
  /** `orderType` 2 and 3 are the restricted kinds, which require the zone to
   * approve the fill. Recorded rather than refused — OpenSea's standard Base
   * listings are restricted, and calling that private would reject everything. */
  restrictedByZone: boolean;
}

export type SeaportReadResultV1 =
  | { ok: true; listing: SeaportListingReadV1 }
  | { ok: false; reason: SeaportReadReasonV1 };

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isUintString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

/**
 * Turns Seaport order parameters into what the buyer gets and what they pay.
 *
 * Fails closed on anything V1 does not buy: more than one offered item, an
 * ERC-1155, a criteria-based offer (which names a SET of tokens, not one), an
 * ERC-20 or NFT consideration item, or an amount that moves between start and
 * end (a Dutch auction, where the price at signing is not the price quoted).
 */
export function readSeaportListingV1(parameters: unknown): SeaportReadResultV1 {
  const params = parameters as SeaportParametersV1 | null;
  if (!params || typeof params !== 'object' || !Array.isArray(params.offer) || !Array.isArray(params.consideration)) {
    return { ok: false, reason: 'malformed_order' };
  }
  if (!isAddress(params.offerer)) return { ok: false, reason: 'malformed_order' };

  if (params.offer.length !== 1) return { ok: false, reason: 'offer_not_single_item' };
  const offered = params.offer[0];
  if (offered.itemType === SEAPORT_ITEM_TYPE_V1.ERC1155) return { ok: false, reason: 'offer_is_erc1155' };
  if (
    offered.itemType === SEAPORT_ITEM_TYPE_V1.ERC721_WITH_CRITERIA ||
    offered.itemType === SEAPORT_ITEM_TYPE_V1.ERC1155_WITH_CRITERIA
  ) {
    // A criteria offer names a set of tokens. Buying one would be buying
    // whichever the seller chooses, not the one the user asked for.
    return { ok: false, reason: 'offer_uses_criteria' };
  }
  if (offered.itemType !== SEAPORT_ITEM_TYPE_V1.ERC721) return { ok: false, reason: 'offer_not_erc721' };
  if (!isAddress(offered.token) || !isUintString(offered.identifierOrCriteria)) {
    return { ok: false, reason: 'malformed_order' };
  }
  if (offered.startAmount !== '1' || offered.endAmount !== '1') {
    return { ok: false, reason: 'offer_quantity_not_one' };
  }

  if (params.consideration.length === 0) return { ok: false, reason: 'consideration_empty' };

  const seller = params.offerer.toLowerCase();
  let total = BigInt(0);
  let fees = BigInt(0);
  let reservedForTaker: string | null = null;

  for (const item of params.consideration) {
    if (item.itemType === SEAPORT_ITEM_TYPE_V1.ERC721 || item.itemType === SEAPORT_ITEM_TYPE_V1.ERC1155) {
      // The NFT appears on the PAYING side: this listing is reserved for the
      // named recipient, and anyone else filling it pays without receiving.
      reservedForTaker = isAddress(item.recipient) ? item.recipient.toLowerCase() : ZERO_ADDRESS_V1;
      return { ok: false, reason: 'consideration_contains_nft' };
    }
    if (item.itemType !== SEAPORT_ITEM_TYPE_V1.NATIVE) return { ok: false, reason: 'consideration_not_native' };
    if (item.token.toLowerCase() !== ZERO_ADDRESS_V1) return { ok: false, reason: 'consideration_not_native' };
    if (!isUintString(item.startAmount) || !isUintString(item.endAmount)) {
      return { ok: false, reason: 'malformed_order' };
    }
    // A moving amount is a Dutch auction. The price shown at review would not
    // be the price paid at signing.
    if (item.startAmount !== item.endAmount) return { ok: false, reason: 'amount_not_fixed' };

    const amount = BigInt(item.startAmount);
    total += amount;
    if (!isAddress(item.recipient) || item.recipient.toLowerCase() !== seller) fees += amount;
  }

  const endTimeUnix = Number(params.endTime);
  const startTimeUnix = Number(params.startTime);
  if (!Number.isFinite(endTimeUnix) || !Number.isFinite(startTimeUnix)) {
    return { ok: false, reason: 'malformed_order' };
  }

  return {
    ok: true,
    listing: {
      nftContract: offered.token.toLowerCase(),
      tokenId: offered.identifierOrCriteria,
      seller,
      totalWei: total.toString(),
      feeWei: fees.toString(),
      reservedForTaker,
      endTimeUnix,
      startTimeUnix,
      restrictedByZone: params.orderType === 2 || params.orderType === 3,
    },
  };
}

/**
 * The quoted price must equal what the order actually charges.
 *
 * OpenSea's `price.current.value` and the sum of the consideration agreed
 * exactly on the live listing this was built against. When they disagree, the
 * summary is the thing that is wrong — but the disagreement itself means the
 * response cannot be reconciled, so it is refused rather than silently
 * preferred one way.
 */
export function seaportQuoteAgreesV1(input: { quotedWei: string; listing: SeaportListingReadV1 }): boolean {
  try {
    return BigInt(input.quotedWei) === BigInt(input.listing.totalWei);
  } catch {
    return false;
  }
}

/** OpenSea reports listing status in upper case (`ACTIVE`). Mapped through a
 * closed set so an unrecognised word becomes `unknown` — never `active`. */
export function mapOpenSeaListingStatusV1(value: unknown): 'active' | 'expired' | 'cancelled' | 'filled' | 'unknown' {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'active':
      return 'active';
    case 'expired':
      return 'expired';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'filled':
    case 'fulfilled':
      return 'filled';
    default:
      return 'unknown';
  }
}
