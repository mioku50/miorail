import {
  NftPurchaseProofV1Schema,
  ZERO_HASH_V1,
  deriveNftProofFinalStatusV1,
  hashNftPurchaseProofV1,
  stableHashV1,
  type NftAssetRefV1,
  type NftOwnershipReadV1,
  type NftProofFinalStatusV1,
  type NftPurchaseBlueprintV1,
  type NftPurchaseProofV1,
  type NftReceiptLegV1,
  type NftTransferLegV1,
} from '@mioagent/route-domain';
import { ERC721_TRANSFER_TOPIC_V1 } from './pinned-config.js';

// ---------------------------------------------------------------------------
// T65 §5 / §9 — the ownership proof.
//
// The rule this whole family exists to enforce: a successful receipt is not a
// purchase. Three independent legs have to agree before anything is called
// completed —
//
//   1. the transaction succeeded on Base,
//   2. an ERC-721 Transfer of THIS token reached the buyer,
//   3. ownerOf(tokenId) returns the buyer.
//
// Each is read from the chain. None is inferred from another. A success that
// cannot show ownership stays open as `reconciliation_required`, because
// money left the wallet and nobody can yet say what it bought.
// ---------------------------------------------------------------------------

/** A receipt log, structurally typed so this package stays free of a viem
 * dependency in its own signatures. */
export interface NftReceiptLogV1 {
  address: string;
  topics: readonly string[];
  data?: string;
}

export interface NftReceiptV1 {
  status: 'success' | 'reverted';
  transactionHash: string;
  blockNumber: bigint | string | number;
  gasUsed: bigint | string | number;
  logs: readonly NftReceiptLogV1[];
}

function toDecimalString(value: bigint | string | number): string {
  return typeof value === 'bigint' ? value.toString() : String(BigInt(value));
}

/** A 32-byte topic → an address. Topics are left-padded, so the address is the
 * last 20 bytes. */
function addressFromTopic(topic: string): string | null {
  if (typeof topic !== 'string' || topic.length !== 66) return null;
  return `0x${topic.slice(26).toLowerCase()}`;
}

function tokenIdFromTopic(topic: string): string | null {
  if (typeof topic !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return BigInt(topic).toString();
}

/**
 * Finds the ERC-721 Transfer of the purchased token.
 *
 * The critical discriminator is TOPIC COUNT. ERC-20 and ERC-721 share the
 * `Transfer(address,address,uint256)` signature, so they share topic[0]. In
 * ERC-721 the tokenId is INDEXED, giving four topics; in ERC-20 the amount
 * lives in `data`, giving three. Without this check, a token transfer of
 * 12345 units of some ERC-20 would read as a transfer of token id 12345.
 */
export function findNftTransferV1(input: {
  logs: readonly NftReceiptLogV1[];
  contractAddress: string;
  tokenId: string;
  buyer: string;
}): NftTransferLegV1 {
  const contract = input.contractAddress.toLowerCase();
  const buyer = input.buyer.toLowerCase();

  let sawTokenElsewhere: NftTransferLegV1 | null = null;

  for (const [index, log] of input.logs.entries()) {
    if (log.address.toLowerCase() !== contract) continue;
    if (log.topics.length !== 4) continue; // ERC-20 has three. This matters.
    if (log.topics[0].toLowerCase() !== ERC721_TRANSFER_TOPIC_V1) continue;
    if (tokenIdFromTopic(log.topics[3]) !== input.tokenId) continue;

    const from = addressFromTopic(log.topics[1]);
    const to = addressFromTopic(log.topics[2]);
    if (to === buyer) {
      return { status: 'observed', fromAddress: from as `0x${string}` | null, toAddress: to as `0x${string}`, logIndex: index };
    }
    // The token moved, but not to us. Recorded rather than discarded — this is
    // the difference between "nothing happened" and "it went somewhere else".
    sawTokenElsewhere = {
      status: 'wrong_recipient',
      fromAddress: from as `0x${string}` | null,
      toAddress: to as `0x${string}` | null,
      logIndex: index,
    };
  }

  return sawTokenElsewhere ?? { status: 'absent', fromAddress: null, toAddress: null, logIndex: null };
}

/** The receipt leg. `actualNativeValueWei` is what the transaction really
 * carried, supplied by the caller from the transaction — never the quoted
 * price copied forward. */
export function buildNftReceiptLegV1(input: {
  receipt: NftReceiptV1 | null;
  actualNativeValueWei: string | null;
  unavailable?: boolean;
}): NftReceiptLegV1 {
  if (input.receipt === null) {
    return {
      // No receipt yet is `pending`; a receipt we could not read is `unknown`.
      // Both keep the proof open, and neither is a failure.
      status: input.unavailable ? 'unknown' : 'pending',
      transactionHash: null,
      blockNumber: null,
      gasUsed: null,
      actualNativeValueWei: null,
    };
  }
  return {
    status: input.receipt.status === 'success' ? 'success' : 'reverted',
    transactionHash: input.receipt.transactionHash as `0x${string}`,
    blockNumber: toDecimalString(input.receipt.blockNumber),
    gasUsed: toDecimalString(input.receipt.gasUsed),
    actualNativeValueWei: input.actualNativeValueWei,
  };
}

/**
 * The ownership read.
 *
 * `mismatch` — someone else demonstrably owns it — is a different fact from
 * `unverified` — nobody could read it. The first is a finding; the second is a
 * gap, and they must never collapse into each other.
 */
export function buildNftOwnershipReadV1(input: {
  owner: string | null;
  buyer: string;
  blockNumber: bigint | string | number | null;
  observedAt: Date | null;
  unavailableReason?: string | null;
}): NftOwnershipReadV1 {
  if (input.owner === null) {
    return {
      status: 'unverified',
      owner: null,
      blockNumber: null,
      observedAt: null,
      unavailableReason: input.unavailableReason ?? 'The ownership read did not answer.',
    };
  }
  const owner = input.owner.toLowerCase() as `0x${string}`;
  const matches = owner === input.buyer.toLowerCase();
  return {
    status: matches ? 'verified' : 'mismatch',
    owner,
    blockNumber: input.blockNumber === null ? null : toDecimalString(input.blockNumber),
    observedAt: input.observedAt ? input.observedAt.toISOString() : null,
    unavailableReason: null,
  };
}

export interface NftProofBuildInputV1 {
  blueprint: NftPurchaseBlueprintV1;
  asset: NftAssetRefV1;
  seller: string;
  receipt: NftReceiptLegV1;
  transfer: NftTransferLegV1;
  ownership: NftOwnershipReadV1;
  now: Date;
}

/**
 * Assembles the proof.
 *
 * `finalStatus` is DERIVED, never passed in, and the schema re-derives it on
 * parse. There is no argument to this function that can make it say
 * `completed` when the three legs do not agree.
 */
export function buildNftPurchaseProofV1(input: NftProofBuildInputV1): NftPurchaseProofV1 {
  const finalStatus = deriveNftProofFinalStatusV1({
    receipt: input.receipt,
    transfer: input.transfer,
    ownership: input.ownership,
    buyer: input.blueprint.buyer,
  });
  // Only a terminal, fully-agreed outcome is finalized. `reconciliation_required`
  // stays open by construction — it is the state that keeps looking.
  const finalized = finalStatus === 'completed' || finalStatus === 'failed' || finalStatus === 'transaction_failed';
  const base = {
    schemaVersion: 'nft-purchase-proof/v1' as const,
    id: `nft-proof:${stableHashV1('nft-proof', {
      blueprintHash: input.blueprint.blueprintHash,
      orderHash: input.blueprint.orderHash,
    }).slice(2, 26)}`,
    tenantId: input.blueprint.tenantId,
    walletAddress: input.blueprint.walletAddress,
    chainId: 8453 as const,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    status: (finalized ? 'finalized' : 'open') as 'open' | 'finalized',
    proofHash: ZERO_HASH_V1,
    intentHash: input.blueprint.intentHash,
    blueprintHash: input.blueprint.blueprintHash,
    approvedCallsHash: input.blueprint.approvedCallsHash ?? input.blueprint.callsHash,
    orderHash: input.blueprint.orderHash,
    asset: input.asset,
    buyer: input.blueprint.buyer,
    seller: input.seller as `0x${string}`,
    listingPriceWei: input.blueprint.listingPriceWei,
    receipt: input.receipt,
    transfer: input.transfer,
    ownership: input.ownership,
    finalStatus,
    finalizedAt: finalized ? input.now.toISOString() : null,
  };
  return NftPurchaseProofV1Schema.parse({
    ...base,
    proofHash: hashNftPurchaseProofV1(base as unknown as NftPurchaseProofV1),
  });
}

/** What a surface may say about a proof. Fixed strings so a pending
 * reconciliation is never phrased as a completed purchase. */
export const NFT_PROOF_COPY_V1: Record<NftProofFinalStatusV1, string> = {
  pending: 'Waiting for the transaction to be mined. Nothing is confirmed yet.',
  completed: 'Confirmed onchain: the transaction succeeded, the token transferred, and you own it.',
  reconciliation_required:
    'The transaction succeeded but ownership is not confirmed yet. Miorail keeps checking — this is not a completed purchase.',
  transaction_failed: 'The transaction reverted. The NFT was not bought and the ETH was not spent.',
  failed: 'The transaction succeeded but the token did not reach your wallet. This needs to be looked at.',
};

/**
 * Whether reconciliation should run again.
 *
 * Only the open states are retried, and retrying is what `reconciliation_required`
 * IS — the alternative is filing an unexplained spend as done.
 */
export function nftProofNeedsReconciliationV1(finalStatus: NftProofFinalStatusV1): boolean {
  return finalStatus === 'pending' || finalStatus === 'reconciliation_required';
}
