// ---------------------------------------------------------------------------
// The reviewed issuers, and what "reviewed" means for each of them.
//
// Phase 9A measured that Base carries representations from three issuers, not
// six, and that the issuer chip in Base App proves nothing about them — Tesla
// is chipped `Backed Assets` although Coinbase also has a Base representation,
// and Circle is chipped `Backed Assets` although Backed has no CRCL on Base at
// all. So an issuer is established the same way an asset is: by a root that
// the issuer itself controls and that names an exact address.
//
// The two roots on file are not the same kind of thing, and pretending they
// were is how one issuer's conventions leak into another's card:
//
//   reviewed_document   Coinbase. A document at an https origin lists the
//                       addresses. Freshness is when we last fetched it; a
//                       failed fetch stops the clock and demotes nothing.
//   onchain_predicate   Dinari. A contract the issuer deployed answers a
//                       membership question about ONE address at a time.
//                       Freshness is a block; there is no list to fetch and
//                       nothing to parse.
//
// A predicate root cannot be enumerated and a document root cannot be asked
// about an address it does not mention. Neither is better. They are different
// evidence, and the registry stores which one answered.
// ---------------------------------------------------------------------------

export const REVIEWED_ISSUERS_V1 = ['coinbase', 'dinari'] as const;
export type ReviewedIssuerIdV1 = (typeof REVIEWED_ISSUERS_V1)[number];

export const IDENTITY_ROOT_KINDS_V1 = ['reviewed_document', 'onchain_predicate'] as const;
export type IdentityRootKindV1 = (typeof IDENTITY_ROOT_KINDS_V1)[number];

export interface ReviewedIssuerV1 {
  issuerId: ReviewedIssuerIdV1;
  displayName: string;
  identityRootKind: IdentityRootKindV1;
  /**
   * What a positive answer from this issuer's root does and does not establish.
   *
   * Carried as prose because it is the sentence a surface must be able to show
   * beside the claim. Both entries say the same second half on purpose: no
   * root on file establishes WHICH security a representation stands for.
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
  dinari: {
    issuerId: 'dinari',
    displayName: 'Dinari',
    identityRootKind: 'onchain_predicate',
    rootEstablishes:
      "Dinari's own factory answers isTokenDShare(address) for this exact address. That establishes the issuer, not the security: the token's symbol is admin-settable and Dinari's own guide says to key off stock_id instead.",
  },
};
