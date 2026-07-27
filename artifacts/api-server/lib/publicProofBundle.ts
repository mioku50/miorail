import {
  sealPublicProofBundleV1,
  type PublicNftProofBundleV1,
  type PublicProofBundleV1,
  type PublicProofProviderV1,
  type PublicProofShareV1,
  type PublicRouteProofBundleV1,
} from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T67C.2 — assembling a public proof bundle.
//
// The bundle carries the CANONICAL proof document, not the projection the
// console renders. That distinction is the whole feature: a verifier that
// receives a prettified summary cannot recompute `proofHash`, and a hash it
// cannot recompute is a hash it has to take Miorail's word for.
//
// `issuedAt` is the SHARE's creation time and never the time of the request.
// Two fetches of one link must be byte-identical, or "download it and check the
// hash yourself" stops being a thing anyone can do.
//
// What deliberately never enters a bundle: session identifiers, cookies, SIWE
// tokens, API keys, request headers, email addresses, raw provider error text,
// prompts. A wallet address and transaction hashes DO appear — they are part of
// the canonical proof and are what makes it checkable on a block explorer — and
// the UI warns about exactly that before anything is published.
// ---------------------------------------------------------------------------

export interface BuildPublicBundleInputV1 {
  share: PublicProofShareV1;
  provider: PublicProofProviderV1 | null;
}

export function buildPublicRouteProofBundleV1(
  input: BuildPublicBundleInputV1 & { proof: PublicRouteProofBundleV1['proof']; events: PublicRouteProofBundleV1['events'] },
): PublicRouteProofBundleV1 {
  return sealPublicProofBundleV1<PublicRouteProofBundleV1>({
    schemaVersion: 'public-proof-bundle/v1',
    publicProofId: input.share.publicId,
    proofFamily: 'route',
    issuedAt: input.share.createdAt,
    provider: input.provider,
    proof: input.proof,
    // Ordered by index: the chain is only checkable in the order it was built.
    events: [...input.events].sort((left, right) => left.eventIndex - right.eventIndex),
  });
}

export function buildPublicNftProofBundleV1(
  input: BuildPublicBundleInputV1 & { proof: PublicNftProofBundleV1['proof']; events: PublicNftProofBundleV1['events'] },
): PublicNftProofBundleV1 {
  return sealPublicProofBundleV1<PublicNftProofBundleV1>({
    schemaVersion: 'public-proof-bundle/v1',
    publicProofId: input.share.publicId,
    proofFamily: 'nft',
    issuedAt: input.share.createdAt,
    provider: input.provider,
    proof: input.proof,
    events: [...input.events].sort((left, right) => left.sequence - right.sequence),
  });
}

/** The download filename. Named after the PUBLIC id so a saved file cannot be
 * traced back to an internal identifier. */
export function publicProofFilenameV1(publicId: string): string {
  return `miorail-proof-${publicId}.json`;
}

/**
 * What the public page is allowed to say about a proof.
 *
 * A cancelled process record is not evidence of an onchain execution, and a
 * failed one is not a success with a caveat. Each terminal status gets its own
 * sentence so the page cannot render a green tick over any of them.
 */
export const PUBLIC_PROOF_HEADLINE_V1: Record<string, string> = {
  completed: 'Verified execution proof',
  partial_failure: 'Partial failure — some calls in this batch did not succeed',
  failed: 'Failed execution',
  cancelled: 'Cancelled — this process record describes a route that was never executed',
  reconciliation_required: 'Manual reconciliation record — the outcome has not been established',
  // NFT proof vocabulary.
  ownership_confirmed: 'Verified execution proof',
  ownership_not_confirmed: 'Ownership was not confirmed onchain',
};

export function publicProofHeadlineV1(finalStatus: string): string {
  return PUBLIC_PROOF_HEADLINE_V1[finalStatus] ?? `Recorded outcome: ${finalStatus}`;
}

/** Whether the page may present this as evidence that something executed. */
export function describesOnchainExecutionV1(finalStatus: string): boolean {
  return finalStatus !== 'cancelled' && finalStatus !== 'reconciliation_required';
}

export type { PublicProofBundleV1 };
