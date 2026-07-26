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
}): NftFulfillmentResultV1 {
  const body = input.payload as { fulfillment_data?: { transaction?: Record<string, unknown> } } | null;
  const tx = body?.fulfillment_data?.transaction;
  if (!tx || typeof tx !== 'object') return { ok: false, reason: 'malformed_fulfillment' };

  // The function is pinned. A response naming another one is refused, not
  // encoded — a provider that picks the function picks the behaviour.
  if (asString(tx.function) !== SEAPORT_FULFILL_ADVANCED_ORDER_SIGNATURE_V1) {
    return { ok: false, reason: 'function_not_pinned', detail: asString(tx.function) ?? 'missing' };
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
