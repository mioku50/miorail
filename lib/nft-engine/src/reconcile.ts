import type { NftPurchaseBlueprintV1, NftPurchaseProofV1, NftProofEventV1 } from '@mioagent/route-domain';
import {
  buildNftOwnershipReadV1,
  buildNftProofEventV1,
  buildNftPurchaseProofV1,
  buildNftReceiptLegV1,
  findNftTransferV1,
  nftProofNeedsReconciliationV1,
  type NftReceiptV1,
} from './proof.js';

// ---------------------------------------------------------------------------
// T65.1 §5 — reconciliation.
//
// Three INDEPENDENT chain reads, none inferred from another:
//
//   1. the transaction receipt,
//   2. the ERC-721 Transfer log inside it,
//   3. `ownerOf(tokenId)` asked of the contract afterwards.
//
// The third is the one that matters and the one that costs an extra call.
// Skipping it because the first two looked fine is exactly how "the receipt
// succeeded, therefore they own it" gets written, which is the sentence this
// whole family exists to refuse.
//
// Pure: the chain reader is injected, so unit tests never open a socket.
// ---------------------------------------------------------------------------

export interface NftObservedTransactionV1 {
  receipt: NftReceiptV1;
  /** What the transaction ACTUALLY carried, read from the transaction itself —
   * never the quoted price copied forward from the Route Card. */
  actualNativeValueWei: string;
}

export interface NftObservedOwnerV1 {
  owner: string;
  blockNumber: string;
}

export interface NftChainReaderV1 {
  /** Null while the transaction is unknown to the node — pending, not failed. */
  readTransaction(input: { hash: string }): Promise<NftObservedTransactionV1 | null>;
  /** Null when the read did not answer. An unanswered read is a GAP, and the
   * proof records it as one rather than as "someone else owns it". */
  readOwnerOf(input: { contractAddress: string; tokenId: string }): Promise<NftObservedOwnerV1 | null>;
}

export interface NftReconcileInputV1 {
  blueprint: NftPurchaseBlueprintV1;
  /** The proof as stored. Its event count is where the next sequence starts. */
  current: NftPurchaseProofV1;
  seller: string;
  /** The hash to watch, as reported at submission. Null means the client never
   * came back with one, and there is nothing to look up. */
  transactionHash: string | null;
  existingEventCount: number;
  now: Date;
}

export interface NftReconcileResultV1 {
  proof: NftPurchaseProofV1;
  /** Ready to append, in order. Each records what a read SAID, including the
   * reads that answered nothing — that record is how an unexplained spend is
   * eventually explained. */
  events: NftProofEventV1[];
  /** Whether another pass should run. */
  stillOpen: boolean;
  /** True when this pass changed the recorded answer. */
  changed: boolean;
}

export async function reconcileNftProofV1(
  deps: { chainReader: NftChainReaderV1 },
  input: NftReconcileInputV1,
): Promise<NftReconcileResultV1> {
  const { blueprint, current, now } = input;
  const asset = blueprint.asset;
  const buyer = blueprint.buyer;

  // A finalized proof holds the answer. Reconciliation reads it, it does not
  // re-open it.
  if (!nftProofNeedsReconciliationV1(current.finalStatus)) {
    return { proof: current, events: [], stillOpen: false, changed: false };
  }

  const observations: { kind: NftProofEventV1['eventKind']; detail: string | null }[] = [];

  const hash = input.transactionHash ?? current.receipt.transactionHash;
  const observed = hash === null ? null : await deps.chainReader.readTransaction({ hash });

  const receipt = buildNftReceiptLegV1({
    receipt: observed?.receipt ?? null,
    actualNativeValueWei: observed?.actualNativeValueWei ?? null,
    submittedTransactionHash: hash,
  });
  observations.push({
    kind: 'receipt_observed',
    detail: observed === null ? 'No receipt yet.' : `Receipt ${observed.receipt.status}.`,
  });

  const transfer = findNftTransferV1({
    logs: observed?.receipt.logs ?? [],
    contractAddress: asset.contractAddress,
    tokenId: asset.tokenId,
    buyer,
  });
  observations.push({ kind: 'transfer_observed', detail: `Transfer ${transfer.status}.` });

  // The ownership read is only worth making once the transaction is mined, and
  // it is made EVEN WHEN the transfer log already looks right. The log says
  // what the transaction emitted; `ownerOf` says what the contract believes
  // now, and only the second one is ownership.
  let ownership = buildNftOwnershipReadV1({
    owner: null,
    buyer,
    blockNumber: null,
    observedAt: null,
    unavailableReason: 'The transaction has not been confirmed yet.',
  });
  if (observed !== null && observed.receipt.status === 'success') {
    const owner = await deps.chainReader.readOwnerOf({
      contractAddress: asset.contractAddress,
      tokenId: asset.tokenId,
    });
    ownership = buildNftOwnershipReadV1({
      owner: owner?.owner ?? null,
      buyer,
      blockNumber: owner?.blockNumber ?? null,
      observedAt: owner ? now : null,
      unavailableReason: owner ? null : 'The ownership read did not answer.',
    });
    observations.push({
      kind: 'ownership_read',
      detail: owner === null ? 'ownerOf did not answer.' : `ownerOf → ${ownership.status}.`,
    });
  }

  const proof = buildNftPurchaseProofV1({
    blueprint,
    asset,
    seller: input.seller,
    receipt,
    transfer,
    ownership,
    now,
  });

  const changed = proof.proofHash !== current.proofHash;
  if (!changed) {
    // Nothing moved. An identical answer appended again would grow the log
    // without adding a fact, and an audit trail of noise is harder to read
    // than a short one.
    return { proof: current, events: [], stillOpen: nftProofNeedsReconciliationV1(proof.finalStatus), changed: false };
  }
  observations.push({ kind: 'reconciliation_attempted', detail: `Status ${proof.finalStatus}.` });
  if (proof.status === 'finalized') observations.push({ kind: 'finalized', detail: proof.finalStatus });

  // Events describe THIS proof, so they are built against the proof this pass
  // produced — never against the one it replaced.
  const events = observations.map((observation, index) =>
    buildNftProofEventV1({
      proof,
      sequence: input.existingEventCount + index,
      eventKind: observation.kind,
      detail: observation.detail,
      now,
    }),
  );

  return { proof, events, stillOpen: nftProofNeedsReconciliationV1(proof.finalStatus), changed };
}
