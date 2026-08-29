import type {
  RepresentationRatioRowV1,
  RepresentationUnderlyingV1,
  UnderlyingSourceKindV1,
} from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// A binding written before migration 0059 carries no issuer typing.
//
// 0058 created `representation_underlying` with `source_kind`, `source_ref` and
// the address; 0059 ADDED `issuer_id`, `issuer_instrument_key` and
// `representation_kind` to a table that already existed, so they are nullable
// and a legacy row holds NULL. Both live writers fill all three, so the hole is
// history rather than an ongoing state -- but `market-reality/v2` asserted them
// non-null, which turned one legacy row into a Zod throw that took down the
// whole canonical assembler, and with it a valid agent request.
//
// The answer is NOT to weaken v2. `issuerId: null` and `issuerId: "unknown"`
// both put an absence where a reader expects a proven identity, which is the
// one thing this vertical exists to refuse. The identity is recovered instead,
// deterministically, from the exact chain and token address:
//
//   issuerId            <- source_kind. Each value IS one issuer's own reviewed
//                          source, so a binding created from it is that
//                          issuer's representation. Total, 3 -> 3, no read.
//   issuerInstrumentKey <- the exact address. Miorail already treats the
//                          address as the identity; the recovered key SAYS it
//                          is address-derived rather than borrowing the shape
//                          of a key the issuer published.
//   representationKind  <- the ratio the reader already stored for that exact
//                          address. A stored ratio is positive evidence that
//                          the token rebases; its kind names which structure.
//
// The last one is deliberately partial. A non-rebasing ERC-4626 wrapper has no
// ratio row, and "no row" is the absence of evidence, never proof of a wrapper
// -- so a binding whose structure cannot be established is REFUSED rather than
// guessed. A refused binding leaves the strict v2 array instead of entering it
// with an invented structure, and the caller is told through the coverage
// reason that already exists for exactly this: an incomplete denominator.
// ---------------------------------------------------------------------------

/** Each reviewed underlying source belongs to exactly one reviewed issuer. */
export const ISSUER_BY_REVIEWED_SOURCE_KIND_V1 = {
  coinbase_b20_metadata: 'coinbase',
  dinari_stock_api: 'dinari',
  backed_assets_api: 'backed',
} as const satisfies Record<UnderlyingSourceKindV1, 'coinbase' | 'dinari' | 'backed'>;

/** What a stored ratio proves about the structure of the token that has it. */
export const REPRESENTATION_KIND_BY_RATIO_KIND_V1 = {
  b20_multiplier: 'b20_asset',
  dinari_balance_per_share: 'rebasing_erc20',
  backed_evm_multiplier: 'rebasing_erc20',
} as const;

export type CanonicalReviewedBindingV1 = RepresentationUnderlyingV1 & {
  issuerId: 'coinbase' | 'dinari' | 'backed';
  issuerInstrumentKey: string;
  representationKind: 'b20_asset' | 'rebasing_erc20' | 'non_rebasing_erc4626_wrapper';
};

export type CanonicalBindingResultV1 =
  | { status: 'canonical'; binding: CanonicalReviewedBindingV1; recovered: boolean }
  | { status: 'refused'; tokenAddress: string; reason: 'representation_kind_not_established' };

/**
 * Complete a reviewed binding from the evidence attached to its exact address.
 *
 * A binding that already carries its issuer typing is returned untouched, and
 * `recovered` says which of the two happened, so a surface can never present a
 * recovered structure as one the issuer published.
 */
export function canonicalReviewedBindingV1(
  binding: RepresentationUnderlyingV1,
  ratio: RepresentationRatioRowV1 | null,
): CanonicalBindingResultV1 {
  const issuerId = binding.issuerId ?? ISSUER_BY_REVIEWED_SOURCE_KIND_V1[binding.sourceKind];
  const representationKind =
    binding.representationKind ??
    (ratio ? REPRESENTATION_KIND_BY_RATIO_KIND_V1[ratio.ratioKind] : null);
  if (representationKind === null) {
    return {
      status: 'refused',
      tokenAddress: binding.tokenAddress,
      reason: 'representation_kind_not_established',
    };
  }
  const issuerInstrumentKey =
    binding.issuerInstrumentKey ?? `${issuerId}:base_address:${binding.tokenAddress}`;
  return {
    status: 'canonical',
    recovered:
      binding.issuerId == null ||
      binding.issuerInstrumentKey == null ||
      binding.representationKind == null,
    binding: { ...binding, issuerId, issuerInstrumentKey, representationKind },
  };
}
