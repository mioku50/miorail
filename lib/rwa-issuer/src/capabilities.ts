import type { ReviewedIssuerIdV1 } from './issuers.js';

// ---------------------------------------------------------------------------
// What a representation can do, on TWO axes, because they disagree.
//
// A published document and the deployed bytecode can contradict each other in
// BOTH directions on the same contract: an ABI can leave out a function the
// deployment answers, and declare one the deployment reverts on. So "the docs
// say so" and "this address answers" are independent facts, and a single
// tri-state would have to pick one of them to believe. It picks wrong in one
// direction or the other every time.
//
// Hence two axes and a verdict computed from them. `not_applicable` is a
// reviewed decision that the capability cannot exist here; `unknown` is the
// absence of evidence. They are never the same sentence and never the same
// column.
// ---------------------------------------------------------------------------

export const REPRESENTATION_CAPABILITIES_V1 = [
  'structure',
  'reference_price',
  'ratio',
  'transfer_policy',
  'eligibility',
  'pause_state',
  'redemption',
  'distributions',
  'corporate_actions',
  'bridge',
] as const;
export type RepresentationCapabilityV1 = (typeof REPRESENTATION_CAPABILITIES_V1)[number];

/** What a reviewed source says. `not_applicable` is a review decision, not an
 * observation: it says the capability cannot exist for this family at all. */
export const CAPABILITY_DOCUMENTED_V1 = ['documented', 'undocumented', 'not_applicable'] as const;
export type CapabilityDocumentedV1 = (typeof CAPABILITY_DOCUMENTED_V1)[number];

/**
 * What the exact deployment did when asked.
 *
 * `not_probed` is ours: we did not look. `off_chain` is different and is a
 * review decision — the capability is real and does not live in the contract,
 * so asking the contract about it would be asking the wrong question. Coinbase's
 * primary redemption is that: it runs through authorized participants and KYC,
 * and probing a selector for it would produce an `absent` that reads as "this
 * issuer has no redemption".
 */
export const CAPABILITY_CALLABLE_V1 = ['callable', 'absent', 'off_chain', 'not_probed'] as const;
export type CapabilityCallableV1 = (typeof CAPABILITY_CALLABLE_V1)[number];

export const CAPABILITY_VERDICTS_V1 = [
  /** A reviewed source describes it AND this exact address answers. */
  'supported',
  /** A reviewed source describes it; this address does not answer. Not false —
   * the capability may live off-chain, behind an account, or on a newer
   * deployment. It is a gap between the document and this contract. */
  'documented_not_callable',
  /** This address answers; no reviewed source we hold describes it. Usable as
   * a read, never as a promise about what the issuer will do. */
  'callable_not_documented',
  /** A reviewed source describes it and it deliberately does not live in the
   * contract. Real, and never measurable by this product. */
  'documented_off_chain',
  /** A reviewed decision that this capability cannot exist here. */
  'not_applicable',
  /** Not established either way. */
  'unknown',
] as const;
export type CapabilityVerdictV1 = (typeof CAPABILITY_VERDICTS_V1)[number];

/**
 * The verdict, from the two axes. Pure, total, and the only place the mapping
 * exists so a surface cannot invent a sixth word.
 */
export function capabilityVerdictV1(input: {
  documented: CapabilityDocumentedV1;
  callable: CapabilityCallableV1;
}): CapabilityVerdictV1 {
  if (input.documented === 'not_applicable') return 'not_applicable';
  // Not probed is not a finding. A documented capability nobody called and an
  // undocumented one nobody called are both unestablished; which of the two it
  // is stays readable in `documented`, so the verdict does not have to guess.
  if (input.callable === 'not_probed') return 'unknown';
  if (input.documented === 'documented') {
    if (input.callable === 'off_chain') return 'documented_off_chain';
    return input.callable === 'callable' ? 'supported' : 'documented_not_callable';
  }
  // An off-chain process nobody documented is not something this product may
  // assert on its own; there is nothing on chain to point at.
  return input.callable === 'callable' ? 'callable_not_documented' : 'unknown';
}

export interface CapabilityStateV1 {
  capability: RepresentationCapabilityV1;
  documented: CapabilityDocumentedV1;
  callable: CapabilityCallableV1;
  /** What was called, when the deployment was probed at all. Stored so a
   * verdict can be re-checked rather than believed. */
  probe: string | null;
  /** One sentence a surface may show. Never a promise, never a rating. */
  note: string;
}

export type IssuerCapabilityProfileV1 = Readonly<
  Record<RepresentationCapabilityV1, Omit<CapabilityStateV1, 'capability'>>
>;

/**
 * Coinbase B20, as of the Phase 9A/9A.5 measurements.
 *
 * `redemption` is `unknown` rather than absent: Base Docs describe the asset
 * without publishing an on-chain redemption path we have called.
 */
const COINBASE_PROFILE_V1: IssuerCapabilityProfileV1 = {
  structure: {
    documented: 'documented',
    callable: 'callable',
    probe: 'multiplier() 0x1b3ed722, scaledBalanceOf() 0x1da24f3e',
    note: 'A B20 asset holding a raw balance plus a disclosed multiplier. Base Docs open with the warning that one token does not permanently equal one share.',
  },
  reference_price: {
    documented: 'documented',
    callable: 'callable',
    probe: 'Chainlink total-return proxy, latestRoundData()',
    note: 'Base Docs bind a Chainlink proxy to each asset; the feed publishes a total-return value, so the multiplier is already inside it.',
  },
  ratio: {
    documented: 'documented',
    callable: 'callable',
    probe: 'multiplier() 0x1b3ed722 + WAD_PRECISION() 0x664808a8',
    note: 'Balances are stored raw. The caller applies raw * multiplier / scale; the scale is read, never assumed.',
  },
  transfer_policy: {
    documented: 'documented',
    callable: 'callable',
    probe: 'senderPolicy(), receiverPolicy(), executorPolicy(), isAuthorized()',
    note: 'Base Docs and the B20 interface define policy checks and blocked-address controls. Secondary holding is not the same permission as primary mint or redemption.',
  },
  eligibility: {
    documented: 'documented',
    callable: 'off_chain',
    probe: null,
    note: 'Primary access is KYC/authorized-participant controlled and the product is limited to eligible non-US users; secondary token policy is a separate onchain fact.',
  },
  pause_state: {
    documented: 'documented',
    callable: 'callable',
    probe: 'pausedFeatures() / B20 feature-pause state',
    note: 'B20 exposes feature-specific pause state. The separate corporate-action feed pause is off chain and must not be inferred from this call.',
  },
  redemption: {
    documented: 'documented',
    callable: 'off_chain',
    probe: null,
    note: 'Primary redemption is an authenticated authorized-participant process; no permissionless consumer redemption route is claimed.',
  },
  distributions: {
    documented: 'documented',
    callable: 'callable',
    probe: 'multiplier() 0x1b3ed722',
    note: 'A distribution reaches every holder as a change in the multiplier, so it is visible on chain to anybody holding the token — no registration and no account.',
  },
  corporate_actions: {
    documented: 'documented',
    callable: 'callable',
    probe: 'multiplier() 0x1b3ed722; advance state is the separate issuer registry/feed',
    note: 'The active economic ratio is callable. Base Docs place advance corporate-action state in a separate offchain registry, so invented token selectors are not evidence of its absence.',
  },
  bridge: {
    documented: 'undocumented',
    callable: 'not_probed',
    probe: null,
    note: 'No reviewed cross-chain surface has been established for these contracts.',
  },
};

export const ISSUER_CAPABILITY_PROFILES_V1: Readonly<
  Record<ReviewedIssuerIdV1, IssuerCapabilityProfileV1>
> = {
  coinbase: COINBASE_PROFILE_V1,
};

/** Every capability for one issuer, with its verdict. Ordered, so two cards
 * never list the same facts in a different order. */
export function issuerCapabilitiesV1(
  issuerId: ReviewedIssuerIdV1,
): (CapabilityStateV1 & { verdict: CapabilityVerdictV1 })[] {
  const profile = ISSUER_CAPABILITY_PROFILES_V1[issuerId];
  return REPRESENTATION_CAPABILITIES_V1.map((capability) => {
    const state = profile[capability];
    return { capability, ...state, verdict: capabilityVerdictV1(state) };
  });
}
