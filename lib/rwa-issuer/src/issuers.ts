// ---------------------------------------------------------------------------
// The reviewed issuer, and what "reviewed" means for it.
//
// Miorail covers Coinbase's tokenized stocks on Base and no other issuer's
// (2026-11-18: Backed's and Dinari's tokens were removed, code and data, as
// having nothing to do with Coinbase's). An issuer is established the same way
// an asset is: by a root the issuer itself controls that names an exact
// address. Coinbase's root is a reviewed document and API at an https origin
// that lists the addresses. Freshness is when we last fetched it; a failed
// fetch stops the clock and demotes nothing.
// ---------------------------------------------------------------------------

export const REVIEWED_ISSUERS_V1 = ['coinbase'] as const;
export type ReviewedIssuerIdV1 = (typeof REVIEWED_ISSUERS_V1)[number];

export const IDENTITY_ROOT_KINDS_V1 = ['reviewed_document'] as const;
export type IdentityRootKindV1 = (typeof IDENTITY_ROOT_KINDS_V1)[number];

export interface ReviewedIssuerV1 {
  issuerId: ReviewedIssuerIdV1;
  displayName: string;
  identityRootKind: IdentityRootKindV1;
  /**
   * What a positive answer from this issuer's root does and does not establish.
   *
   * Carried as prose because it is the sentence a surface must be able to show
   * beside the claim: the root establishes the issuer, not WHICH security a
   * representation stands for.
   */
  rootEstablishes: string;
}

export const REVIEWED_ISSUERS_BY_ID_V1: Readonly<Record<ReviewedIssuerIdV1, ReviewedIssuerV1>> = {
  coinbase: {
    issuerId: 'coinbase',
    displayName: 'Coinbase',
    identityRootKind: 'reviewed_document',
    rootEstablishes:
      'Base publishes this address in its own issuance guide. That establishes the issuer, not the security: the guide keys assets by a mutable ticker.',
  },
};
