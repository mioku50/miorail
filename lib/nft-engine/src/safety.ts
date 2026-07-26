import type {
  ExecutionCallV1,
  NftListingCandidateV1,
  NftPurchaseIntentV1,
} from '@mioagent/route-domain';
import { isPinnedSeaportTargetV1 } from './pinned-config.js';
import { verifyNftIdentityV1, type NftVerificationReasonV1 } from './verification.js';

// ---------------------------------------------------------------------------
// T65 §7 — the NFT Safety Kernel.
//
// The last thing between a reviewed listing and a wallet prompt. It answers
// one question: does this call batch do exactly what the Route Card said, and
// nothing else?
//
// It reads the CALLS, not the summary fields around them. An object can claim
// a price of 0.02 ETH while carrying a call that sends 2 ETH to a different
// contract; only the call is executed, so only the call is checked.
//
// `api.opensea.io` is not a safety score. A Seaport order's offer and
// consideration decide what is exchanged, and a well-known brand serving the
// response changes none of that.
// ---------------------------------------------------------------------------

export type NftSafetyViolationV1 =
  | NftVerificationReasonV1
  | 'wrong_call_count'
  | 'target_not_seaport'
  | 'target_not_order_protocol'
  | 'value_exceeds_ceiling'
  | 'value_not_positive'
  | 'value_exceeds_listing_price'
  | 'erc20_approval_present'
  | 'empty_calldata'
  | 'calldata_not_from_fulfillment'
  | 'creator_fee_policy_changed'
  | 'buyer_mismatch';

export interface NftSafetyResultV1 {
  ok: boolean;
  violations: NftSafetyViolationV1[];
}

export interface NftSafetyInputV1 {
  intent: NftPurchaseIntentV1;
  candidate: NftListingCandidateV1;
  calls: readonly ExecutionCallV1[];
  buyer: string;
  /** Hash of the fulfillment response the calldata was encoded from, and the
   * hash recorded on the Blueprint. Equal or the bytes were swapped. */
  fulfillmentResponseHash: string;
  blueprintFulfillmentResponseHash: string;
  /** The creator-fee policy the Route Card showed the user. */
  reviewedCreatorFeePolicy: NftListingCandidateV1['creatorFeePolicy'];
  now: Date;
}

/** ERC-20 `approve(address,uint256)` and `increaseAllowance(address,uint256)`.
 * Neither has any place in a native-ETH purchase, and both are how a batch
 * quietly takes more than it showed. */
const ERC20_APPROVAL_SELECTORS_V1 = ['0x095ea7b3', '0x39509351'] as const;

function selectorOf(data: string): string {
  return data.slice(0, 10).toLowerCase();
}

/**
 * Runs every §7 check and returns EVERY violation rather than the first.
 *
 * A caller that only ever sees one reason at a time fixes them one at a time;
 * a reviewer reading a refusal deserves the whole picture.
 */
export function nftPurchaseSafetyKernelV1(input: NftSafetyInputV1): NftSafetyResultV1 {
  const violations: NftSafetyViolationV1[] = [];
  const { intent, candidate, calls } = input;
  const buyer = input.buyer.toLowerCase();

  // Chain, standard and token identity, through the same function the Route
  // Card used — so the kernel cannot disagree with the card by construction.
  const identity = verifyNftIdentityV1({ intent, asset: candidate.asset });
  if (!identity.ok) violations.push(identity.reason);

  if (intent.walletAddress.toLowerCase() !== buyer) violations.push('buyer_mismatch');

  // Exactly one call. A native-ETH Seaport fulfillment needs no approval and
  // no second leg; anything extra is something the user did not review.
  if (calls.length !== 1) {
    violations.push('wrong_call_count');
    return { ok: false, violations };
  }
  const call = calls[0];

  if (!isPinnedSeaportTargetV1(call.to)) violations.push('target_not_seaport');
  if (call.to.toLowerCase() !== candidate.order.protocolAddress.toLowerCase()) {
    violations.push('target_not_order_protocol');
  }

  if (!call.data || call.data === '0x') violations.push('empty_calldata');
  if (ERC20_APPROVAL_SELECTORS_V1.includes(selectorOf(call.data) as (typeof ERC20_APPROVAL_SELECTORS_V1)[number])) {
    violations.push('erc20_approval_present');
  }

  let value: bigint;
  try {
    value = BigInt(call.valueWei);
  } catch {
    violations.push('provider_invalid_response');
    return { ok: false, violations };
  }
  if (value <= BigInt(0)) violations.push('value_not_positive');
  if (intent.maxSpendWei === null || value > BigInt(intent.maxSpendWei)) {
    violations.push('value_exceeds_ceiling');
  }
  // The call may not send more than the listing the user reviewed. A value
  // above the price is the difference between "buying this NFT" and "sending
  // extra ETH to Seaport", and they look identical in a wallet prompt.
  if (value > BigInt(candidate.listingPriceWei)) violations.push('value_exceeds_listing_price');

  // The listing must still be live at the moment of signing, not merely at the
  // moment it was quoted.
  const expiresAtMs = Date.parse(candidate.listingExpiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= input.now.getTime()) violations.push('listing_expired');
  if (candidate.listingStatus !== 'active') violations.push('listing_not_active');
  if (candidate.order.restrictedTaker !== null) violations.push('listing_private');

  // The calldata must be the bytes the recorded fulfillment response produced.
  // Without this the whole chain of checks describes one response while the
  // wallet executes another.
  if (input.fulfillmentResponseHash !== input.blueprintFulfillmentResponseHash) {
    violations.push('calldata_not_from_fulfillment');
  }

  // Fees are part of what the user agreed to. A policy that changed between
  // the card and the signature is a different deal.
  if (input.reviewedCreatorFeePolicy !== candidate.creatorFeePolicy) {
    violations.push('creator_fee_policy_changed');
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Whether a wallet payload may be handed out at all.
 *
 * Simulation is a PRECONDITION, not a display field: an unsimulated or
 * reverting purchase produces no payload, so there is nothing for a surface to
 * accidentally sign.
 */
export function nftPurchaseSignableV1(input: {
  safety: NftSafetyResultV1;
  simulationStatus: 'passed' | 'failed' | 'unavailable';
  executionEnabled: boolean;
}): { signable: boolean; reason: string | null } {
  if (!input.executionEnabled) {
    return { signable: false, reason: 'NFT execution is off on this server.' };
  }
  if (!input.safety.ok) {
    return { signable: false, reason: `This purchase failed safety checks: ${input.safety.violations.join(', ')}.` };
  }
  if (input.simulationStatus === 'failed') {
    return { signable: false, reason: 'This purchase reverts in simulation, so it cannot be signed.' };
  }
  if (input.simulationStatus !== 'passed') {
    return { signable: false, reason: 'Simulation has not run yet, so nothing is signed from a guess.' };
  }
  return { signable: true, reason: null };
}
