import { encodeFunctionData } from 'viem';
import {
  NftPurchaseBlueprintV1Schema,
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashNftPurchaseBlueprintV1,
  stableHashV1,
  type ExecutionCallV1,
  type NftListingCandidateV1,
  type NftPurchaseBlueprintV1,
  type NftPurchaseIntentV1,
  type NftRouteCardV1,
} from '@mioagent/route-domain';
import { NFT_CHAIN_ID_V1, isPinnedSeaportTargetV1 } from './pinned-config.js';
import { readSeaportListingV1 } from './seaport.js';

// ---------------------------------------------------------------------------
// T65 §6 — the purchase Blueprint.
//
// OpenSea returns a DECODED transaction: a function signature, a target, a
// value, and a structured `input_data`. It does not return calldata, and this
// module does not ask it to. The bytes are encoded HERE, from an ABI pinned in
// this file, so the only thing that decides what the wallet executes is code
// that lives in this repository.
//
// The signature string in the response is checked against the pinned one and
// otherwise ignored. A provider that can name the function it wants encoded
// can name any function.
//
// `calldata_suffix` — OpenSea's attribution tag — is deliberately NOT
// appended. Trailing bytes on a call we ask someone to sign are bytes nobody
// in this repository verified, and the safety kernel would have to be taught
// to tolerate them.
//
// Grounded against a real Base fulfillment response observed 2026-07-26:
//   function      fulfillAdvancedOrder(((address,address,…)),…)
//   chain         8453
//   to            0x0000000000000068f116a894984e2db1123eb395
//   value         "3580000000000000"  ← equals the consideration total
//   input_data    { advancedOrder, criteriaResolvers, fulfillerConduitKey, recipient }
// ---------------------------------------------------------------------------

/** The ONE function this family encodes. Pinned here, not read from a
 * response. Anything else is refused rather than encoded. */
export const SEAPORT_FULFILL_ADVANCED_ORDER_SIGNATURE_V1 =
  'fulfillAdvancedOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes),(uint256,uint8,uint256,uint256,bytes32[])[],bytes32,address)';

export const SEAPORT_FULFILL_ADVANCED_ORDER_ABI_V1 = [
  {
    type: 'function',
    name: 'fulfillAdvancedOrder',
    stateMutability: 'payable',
    outputs: [{ name: 'fulfilled', type: 'bool' }],
    inputs: [
      {
        name: 'advancedOrder',
        type: 'tuple',
        components: [
          {
            name: 'parameters',
            type: 'tuple',
            components: [
              { name: 'offerer', type: 'address' },
              { name: 'zone', type: 'address' },
              {
                name: 'offer',
                type: 'tuple[]',
                components: [
                  { name: 'itemType', type: 'uint8' },
                  { name: 'token', type: 'address' },
                  { name: 'identifierOrCriteria', type: 'uint256' },
                  { name: 'startAmount', type: 'uint256' },
                  { name: 'endAmount', type: 'uint256' },
                ],
              },
              {
                name: 'consideration',
                type: 'tuple[]',
                components: [
                  { name: 'itemType', type: 'uint8' },
                  { name: 'token', type: 'address' },
                  { name: 'identifierOrCriteria', type: 'uint256' },
                  { name: 'startAmount', type: 'uint256' },
                  { name: 'endAmount', type: 'uint256' },
                  { name: 'recipient', type: 'address' },
                ],
              },
              { name: 'orderType', type: 'uint8' },
              { name: 'startTime', type: 'uint256' },
              { name: 'endTime', type: 'uint256' },
              { name: 'zoneHash', type: 'bytes32' },
              { name: 'salt', type: 'uint256' },
              { name: 'conduitKey', type: 'bytes32' },
              { name: 'totalOriginalConsiderationItems', type: 'uint256' },
            ],
          },
          { name: 'numerator', type: 'uint120' },
          { name: 'denominator', type: 'uint120' },
          { name: 'signature', type: 'bytes' },
          { name: 'extraData', type: 'bytes' },
        ],
      },
      {
        name: 'criteriaResolvers',
        type: 'tuple[]',
        components: [
          { name: 'orderIndex', type: 'uint256' },
          { name: 'side', type: 'uint8' },
          { name: 'index', type: 'uint256' },
          { name: 'identifier', type: 'uint256' },
          { name: 'criteriaProof', type: 'bytes32[]' },
        ],
      },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
    ],
  },
] as const;

/**
 * The exact signature OpenSea returns for an ordinary listing, verified live
 * on Base 2026-07-26. Seaport's gas-optimised path: the NFT always goes to
 * `msg.sender`, so there is no recipient field to get wrong.
 */
export const SEAPORT_FULFILL_BASIC_ORDER_SIGNATURE_V1 =
  'fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))';

export const SEAPORT_FULFILL_BASIC_ORDER_ABI_V1 = [
  {
    type: 'function',
    name: 'fulfillBasicOrder_efficient_6GL6yc',
    stateMutability: 'payable',
    outputs: [{ name: 'fulfilled', type: 'bool' }],
    inputs: [
      {
        name: 'parameters',
        type: 'tuple',
        components: [
          { name: 'considerationToken', type: 'address' },
          { name: 'considerationIdentifier', type: 'uint256' },
          { name: 'considerationAmount', type: 'uint256' },
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          { name: 'offerToken', type: 'address' },
          { name: 'offerIdentifier', type: 'uint256' },
          { name: 'offerAmount', type: 'uint256' },
          { name: 'basicOrderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'offererConduitKey', type: 'bytes32' },
          { name: 'fulfillerConduitKey', type: 'bytes32' },
          { name: 'totalOriginalAdditionalRecipients', type: 'uint256' },
          {
            name: 'additionalRecipients',
            type: 'tuple[]',
            components: [
              { name: 'amount', type: 'uint256' },
              { name: 'recipient', type: 'address' },
            ],
          },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/**
 * BasicOrderType 0 — ETH_TO_ERC721_FULL_OPEN.
 *
 * The ONLY value V1 encodes. 1..7 cover partial fills and zone-restricted
 * variants; 8+ move to ERC-1155 or ERC-20 payment. Every one of them is a
 * different purchase than the one this family verified.
 */
export const SEAPORT_BASIC_ORDER_TYPE_ETH_TO_ERC721_FULL_OPEN_V1 = 0;

/** Which encoder this order must use — decided HERE, from the order Miorail
 * itself read and validated. The provider is then held to it. */
export type NftFulfillmentFormV1 = 'basic' | 'advanced';

export function expectedFulfillmentFormV1(order: { restrictedByZone: boolean }): NftFulfillmentFormV1 {
  // A zone-restricted order cannot go through the basic path at all; an
  // ordinary one must not be routed through the advanced path just because a
  // response offered it.
  return order.restrictedByZone ? 'advanced' : 'basic';
}

export type NftFulfillmentReasonV1 =
  | 'malformed_fulfillment'
  | 'function_not_pinned'
  | 'chain_mismatch'
  | 'target_not_seaport'
  | 'target_not_order_protocol'
  | 'value_mismatch'
  | 'recipient_mismatch'
  | 'order_mismatch'
  | 'criteria_resolvers_present'
  | 'partial_fill_requested'
  | 'wrong_fulfillment_form'
  | 'basic_order_type_unsupported'
  | 'offerer_mismatch'
  | 'offer_amount_not_one'
  | 'payment_not_native_eth'
  | 'consideration_total_mismatch'
  | 'additional_recipients_mismatch'
  | 'zone_present'
  | 'order_expired'
  | 'signature_missing'
  | 'encode_failed';

export interface NftFulfillmentReadV1 {
  to: string;
  valueWei: string;
  data: `0x${string}`;
  recipient: string;
  /** Hash of the exact response the bytes came from, carried onto the
   * Blueprint so the kernel can prove they were not swapped later. */
  responseHash: `0x${string}`;
}

export type NftFulfillmentResultV1 =
  | { ok: true; fulfillment: NftFulfillmentReadV1 }
  | { ok: false; reason: NftFulfillmentReasonV1; detail?: string };

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
}

/**
 * Reads a fulfillment response and encodes the ONE call it may become.
 *
 * Everything is checked against the candidate the user reviewed — the same
 * token, the same order, the same price, the same buyer. The response supplies
 * the order struct and nothing else; it does not get to choose the function,
 * the chain, the target, or who receives the NFT.
 */
export function readOpenSeaFulfillmentV1(input: {
  payload: unknown;
  candidate: NftListingCandidateV1;
  buyer: string;
  /**
   * Which encoder this order must use, decided by Miorail from the order it
   * read. Defaults to `advanced` only so existing callers keep their old
   * behaviour; every new caller passes the value it derived.
   */
  expectedForm?: NftFulfillmentFormV1;
  now?: Date;
}): NftFulfillmentResultV1 {
  const body = input.payload as { fulfillment_data?: { transaction?: Record<string, unknown> } } | null;
  const tx = body?.fulfillment_data?.transaction;
  if (!tx || typeof tx !== 'object') return { ok: false, reason: 'malformed_fulfillment' };

  const expectedForm = input.expectedForm ?? 'advanced';
  const expectedSignature =
    expectedForm === 'basic'
      ? SEAPORT_FULFILL_BASIC_ORDER_SIGNATURE_V1
      : SEAPORT_FULFILL_ADVANCED_ORDER_SIGNATURE_V1;
  const named = asString(tx.function);

  // The function is pinned AND the choice is ours. A response offering the
  // other pinned function is refused too: which encoder an order needs follows
  // from the order, so a provider proposing the other one is proposing a
  // different order than the one that was verified.
  if (named !== expectedSignature) {
    const otherPinned =
      named === SEAPORT_FULFILL_BASIC_ORDER_SIGNATURE_V1 || named === SEAPORT_FULFILL_ADVANCED_ORDER_SIGNATURE_V1;
    return {
      ok: false,
      reason: otherPinned ? 'wrong_fulfillment_form' : 'function_not_pinned',
      detail: named ?? 'missing',
    };
  }
  if (Number(tx.chain) !== NFT_CHAIN_ID_V1) return { ok: false, reason: 'chain_mismatch' };

  const to = asString(tx.to);
  if (!to || !isPinnedSeaportTargetV1(to)) return { ok: false, reason: 'target_not_seaport' };
  if (to.toLowerCase() !== input.candidate.order.protocolAddress.toLowerCase()) {
    return { ok: false, reason: 'target_not_order_protocol' };
  }

  const value = asString(tx.value);
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return { ok: false, reason: 'malformed_fulfillment' };
  // The value must be exactly the price on the card. Not "at most" — a
  // different number is a different purchase than the one that was reviewed.
  if (value !== input.candidate.listingPriceWei) return { ok: false, reason: 'value_mismatch' };

  const inputData = tx.input_data as Record<string, unknown> | undefined;
  if (!inputData || typeof inputData !== 'object') return { ok: false, reason: 'malformed_fulfillment' };

  if (expectedForm === 'basic') {
    return readBasicOrderFulfillmentV1({
      tx,
      parameters: inputData.parameters,
      candidate: input.candidate,
      buyer: input.buyer,
      to,
      value,
      now: input.now ?? new Date(),
    });
  }

  const recipient = asString(inputData.recipient);
  if (!recipient || recipient.toLowerCase() !== input.buyer.toLowerCase()) {
    return { ok: false, reason: 'recipient_mismatch' };
  }

  // Criteria resolvers name a token from a SET. V1 buys one identified token,
  // so a resolver here means the response is fulfilling something else.
  const resolvers = inputData.criteriaResolvers;
  if (Array.isArray(resolvers) && resolvers.length > 0) {
    return { ok: false, reason: 'criteria_resolvers_present' };
  }

  const advanced = inputData.advancedOrder as Record<string, unknown> | undefined;
  if (!advanced || typeof advanced !== 'object') return { ok: false, reason: 'malformed_fulfillment' };
  // numerator/denominator express a partial fill. One ERC-721 is indivisible;
  // anything other than 1/1 is not this purchase.
  if (String(advanced.numerator ?? '1') !== '1' || String(advanced.denominator ?? '1') !== '1') {
    return { ok: false, reason: 'partial_fill_requested' };
  }

  // The order inside the fulfillment must be the order that was reviewed: same
  // token, same seller, same total.
  const read = readSeaportListingV1(advanced.parameters);
  if (!read.ok) return { ok: false, reason: 'order_mismatch', detail: read.reason };
  if (
    read.listing.nftContract !== input.candidate.asset.contractAddress.toLowerCase() ||
    read.listing.tokenId !== input.candidate.asset.tokenId ||
    read.listing.seller !== input.candidate.order.seller.toLowerCase() ||
    read.listing.totalWei !== input.candidate.listingPriceWei
  ) {
    return { ok: false, reason: 'order_mismatch' };
  }

  let data: `0x${string}`;
  try {
    data = encodeFunctionData({
      abi: SEAPORT_FULFILL_ADVANCED_ORDER_ABI_V1,
      functionName: 'fulfillAdvancedOrder',
      args: [
        advanced as never,
        (Array.isArray(resolvers) ? resolvers : []) as never,
        asString(inputData.fulfillerConduitKey) as never,
        recipient as never,
      ],
    });
  } catch (error) {
    return { ok: false, reason: 'encode_failed', detail: error instanceof Error ? error.message : 'unknown' };
  }

  return {
    ok: true,
    fulfillment: {
      to: to.toLowerCase(),
      valueWei: value,
      data,
      recipient: recipient.toLowerCase(),
      responseHash: stableHashV1('nft-fulfillment-response/v1', tx),
    },
  };
}

/**
 * The Blueprint: exactly one call, and the hash of the response its bytes came
 * from.
 *
 * The contract enforces the shape (one call, positive value, within the
 * ceiling, targeting the order's own protocol address); this function supplies
 * it. A blueprint that cannot be parsed is never returned half-built.
 */
export function buildNftPurchaseBlueprintV1(input: {
  intent: NftPurchaseIntentV1;
  card: NftRouteCardV1;
  candidate: NftListingCandidateV1;
  fulfillment: NftFulfillmentReadV1;
  ttlMs?: number;
  now: Date;
}): NftPurchaseBlueprintV1 {
  const call: ExecutionCallV1 = {
    index: 0,
    callType: 'other',
    to: input.fulfillment.to as `0x${string}`,
    valueWei: input.fulfillment.valueWei,
    data: input.fulfillment.data,
    asset: null,
    amountAtomic: null,
    recipient: input.fulfillment.recipient as `0x${string}`,
    spender: null,
  };
  const calls = [call];
  const base = {
    schemaVersion: 'nft-purchase-blueprint/v1' as const,
    id: `nft-blueprint:${stableHashV1('nft-blueprint', {
      intentHash: input.intent.intentHash,
      candidateHash: input.candidate.candidateHash,
    }).slice(2, 26)}`,
    tenantId: input.intent.tenantId,
    walletAddress: input.intent.walletAddress,
    chainId: 8453 as const,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    status: 'draft' as const,
    blueprintHash: ZERO_HASH_V1,
    intentHash: input.intent.intentHash,
    candidateHash: input.candidate.candidateHash,
    routeCardHash: input.card.routeCardHash,
    orderHash: input.candidate.order.orderHash,
    protocolAddress: input.candidate.order.protocolAddress,
    asset: input.candidate.asset,
    buyer: input.intent.walletAddress,
    paymentAsset: 'native_eth' as const,
    listingPriceWei: input.candidate.listingPriceWei,
    maxSpendWei: input.intent.maxSpendWei ?? '0',
    calls,
    callsHash: hashApprovedCallsV1(calls),
    approvedCallsHash: null,
    fulfillmentResponseHash: input.fulfillment.responseHash,
    // Bounded by the listing's own expiry: a blueprint may never outlive the
    // order it fulfils.
    expiresAt: new Date(
      Math.min(input.now.getTime() + (input.ttlMs ?? 60_000), Date.parse(input.candidate.listingExpiresAt)),
    ).toISOString(),
  };
  return NftPurchaseBlueprintV1Schema.parse({
    ...base,
    blueprintHash: hashNftPurchaseBlueprintV1(base as unknown as NftPurchaseBlueprintV1),
  });
}

/**
 * Reads and encodes a BasicOrder fulfillment.
 *
 * Every field is checked against the candidate the user reviewed, and the
 * provider's own summary is never believed over the order parameters: the
 * price this validates is the SUM of considerationAmount and every additional
 * recipient, not the number the response put in `value`.
 *
 * One structural difference from the advanced path matters and is a
 * strengthening, not a gap: `fulfillBasicOrder_efficient_6GL6yc` has no
 * recipient field. Seaport sends the NFT to `msg.sender`. The buyer is
 * therefore whoever signs, and no calldata can send the token elsewhere.
 */
function readBasicOrderFulfillmentV1(input: {
  tx: Record<string, unknown>;
  parameters: unknown;
  candidate: NftListingCandidateV1;
  buyer: string;
  to: string;
  value: string;
  now: Date;
}): NftFulfillmentResultV1 {
  const p = input.parameters as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'malformed_fulfillment' };
  const { candidate } = input;

  // Only ETH_TO_ERC721_FULL_OPEN. Every other BasicOrderType is a partial
  // fill, a zone-restricted variant, an ERC-1155, or ERC-20 payment.
  if (Number(p.basicOrderType) !== SEAPORT_BASIC_ORDER_TYPE_ETH_TO_ERC721_FULL_OPEN_V1) {
    return { ok: false, reason: 'basic_order_type_unsupported', detail: String(p.basicOrderType) };
  }
  // A basic FULL_OPEN order has no zone. A non-zero one contradicts the type.
  const zone = asString(p.zone)?.toLowerCase();
  if (zone && !/^0x0{40}$/.test(zone)) return { ok: false, reason: 'zone_present' };

  const offerer = asString(p.offerer)?.toLowerCase();
  if (!offerer || offerer !== candidate.order.seller.toLowerCase()) {
    return { ok: false, reason: 'offerer_mismatch' };
  }
  const offerToken = asString(p.offerToken)?.toLowerCase();
  if (!offerToken || offerToken !== candidate.asset.contractAddress.toLowerCase()) {
    return { ok: false, reason: 'order_mismatch', detail: 'offerToken' };
  }
  if (String(p.offerIdentifier ?? '') !== candidate.asset.tokenId) {
    return { ok: false, reason: 'order_mismatch', detail: 'offerIdentifier' };
  }
  // One ERC-721. A quantity other than 1 is not this purchase.
  if (String(p.offerAmount ?? '') !== '1') return { ok: false, reason: 'offer_amount_not_one' };

  // Native ETH is the zero consideration token with a zero identifier.
  const considerationToken = asString(p.considerationToken)?.toLowerCase();
  if (!considerationToken || !/^0x0{40}$/.test(considerationToken)) {
    return { ok: false, reason: 'payment_not_native_eth' };
  }
  if (String(p.considerationIdentifier ?? '0') !== '0') return { ok: false, reason: 'payment_not_native_eth' };

  const sellerAmount = asString(p.considerationAmount);
  if (sellerAmount === null || !/^(0|[1-9][0-9]*)$/.test(sellerAmount)) {
    return { ok: false, reason: 'malformed_fulfillment' };
  }

  const extras = Array.isArray(p.additionalRecipients) ? p.additionalRecipients : [];
  if (String(p.totalOriginalAdditionalRecipients ?? extras.length) !== String(extras.length)) {
    // A truncated recipient list changes what the transaction pays out while
    // leaving the struct looking well-formed.
    return { ok: false, reason: 'additional_recipients_mismatch' };
  }
  let total = BigInt(sellerAmount);
  for (const entry of extras) {
    const item = entry as Record<string, unknown>;
    const amount = asString(item.amount);
    const recipient = asString(item.recipient);
    if (amount === null || !/^(0|[1-9][0-9]*)$/.test(amount) || !recipient) {
      return { ok: false, reason: 'additional_recipients_mismatch' };
    }
    total += BigInt(amount);
  }

  // THE check the provider summary must not win: the price is the sum of the
  // order's own payouts. `value` agreeing with it is necessary, not sufficient.
  if (total.toString() !== candidate.listingPriceWei) {
    return { ok: false, reason: 'consideration_total_mismatch', detail: total.toString() };
  }
  if (input.value !== total.toString()) return { ok: false, reason: 'value_mismatch' };

  const endTime = asString(p.endTime);
  if (endTime !== null && /^[0-9]+$/.test(endTime)) {
    if (BigInt(endTime) * 1000n <= BigInt(input.now.getTime())) return { ok: false, reason: 'order_expired' };
  }
  const signature = asString(p.signature);
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature) || signature === '0x') {
    return { ok: false, reason: 'signature_missing' };
  }

  let data: `0x${string}`;
  try {
    data = encodeFunctionData({
      abi: SEAPORT_FULFILL_BASIC_ORDER_ABI_V1,
      functionName: 'fulfillBasicOrder_efficient_6GL6yc',
      args: [p as never],
    });
  } catch (error) {
    return { ok: false, reason: 'encode_failed', detail: error instanceof Error ? error.message : 'unknown' };
  }

  return {
    ok: true,
    fulfillment: {
      to: input.to.toLowerCase(),
      valueWei: input.value,
      data,
      // Seaport delivers a basic order to msg.sender. Recording the buyer here
      // states who that must be; it is not read out of the calldata, because
      // the calldata cannot name anyone else.
      recipient: input.buyer.toLowerCase(),
      responseHash: stableHashV1('nft-fulfillment-response/v1', input.tx),
    },
  };
}
