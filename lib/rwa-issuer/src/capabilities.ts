import type { ReviewedIssuerIdV1 } from './issuers.js';

// ---------------------------------------------------------------------------
// What a representation can do, on TWO axes, because they disagree.
//
// Measured on Base 2026-08-26, the published artefacts and the deployed
// bytecode contradict each other in BOTH directions on the same issuer:
//
//   Dinari's release ABI (releases/v1.0.0/dshare.json) declares 53 functions
//   and none of them is `paused`, `endpoint`, `token`, `approvalRequired` or
//   `sharedDecimals`. The deployed Base dShare answers all five.
//
//   Dinari's release ABI declares `getDShares()` and `isTokenWrappedDShare()`.
//   Both factories on Base revert on both.
//
// So "the docs say so" and "this address answers" are independent facts, and a
// single tri-state would have to pick one of them to believe. It picks wrong
// in one direction or the other every time:
//
//   * believing the document alone reported dShare pause as unavailable, when
//     `paused()` answers `false` on every dShare measured;
//   * believing the deployment alone would have called bridging absent on the
//     evidence of one reverting selector, when the LayerZero V2 endpoint reads
//     back from the token itself.
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
 * so asking the contract about it would be asking the wrong question. Dinari
 * redemption and Dinari dividends are both that: they run through accounts and
 * KYC, and probing a selector for them would produce an `absent` that reads as
 * "this issuer does not do dividends".
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

/** Legacy Backed bTokens on Base. Current xStocks-only behavior is not copied
 * across the product-family boundary. */
const BACKED_PROFILE_V1: IssuerCapabilityProfileV1 = {
  structure: {
    documented: 'documented',
    callable: 'callable',
    probe: 'ERC-20 rebasing implementation; balanceOf(), sharesOf(), getCurrentMultiplier()',
    note: 'A Swiss-law tracker certificate represented by a legacy rebasing ERC-20. Optional ERC-4626 wrappers are separate exact addresses.',
  },
  reference_price: {
    documented: 'undocumented',
    callable: 'not_probed',
    probe: null,
    note: 'The reviewed identity API does not establish a fresh bToken reference-price observation.',
  },
  ratio: {
    documented: 'documented',
    callable: 'callable',
    probe: 'getCurrentMultiplier() / multiplier()',
    note: 'The EVM contract returns an already-adjusted balanceOf. Applying the multiplier again would double-count corporate actions.',
  },
  transfer_policy: {
    documented: 'documented',
    callable: 'not_probed',
    probe: null,
    note: 'Current issuer legal documentation states there are no technical transfer restrictions; exact deployment pause state is still an independent read.',
  },
  eligibility: {
    documented: 'documented',
    callable: 'off_chain',
    probe: null,
    note: 'Jurisdiction and issuer-redemption eligibility remain off chain and are not inferred from possession of a freely transferable token.',
  },
  pause_state: {
    documented: 'documented',
    callable: 'not_probed',
    probe: null,
    note: 'The published legacy contract has a pauser role; no current value is claimed until the exact Base deployment is called.',
  },
  redemption: {
    documented: 'documented',
    callable: 'off_chain',
    probe: null,
    note: 'New bToken issuance is closed and redemption remains supported for existing holders through the issuer process.',
  },
  distributions: {
    documented: 'documented',
    callable: 'callable',
    probe: 'getCurrentMultiplier() / balanceOf()',
    note: 'The published legacy implementation carries rebase effects through the multiplier and adjusted balance.',
  },
  corporate_actions: {
    documented: 'documented',
    callable: 'callable',
    probe: 'newMultiplierActivationTime(), multiplierUpdatesLength()',
    note: 'The published legacy implementation schedules and records multiplier changes; the exact deployment still needs fresh reads for current state.',
  },
  bridge: {
    documented: 'undocumented',
    callable: 'not_probed',
    probe: null,
    note: 'The current public xStocks bridge is not evidence that a legacy Base bToken has a supported bridge route.',
  },
};

/**
 * Dinari dShare on Base, as measured.
 *
 * Two entries here exist because the naive answer was wrong, and both were
 * corrected against the deployment rather than the documentation:
 *
 *   pause_state  the release ABI does not declare `paused()`. The deployed
 *                dShare answers it — `false` on Apple, Amazon and DIS.
 *   bridge       the release ABI does not declare an OFT surface. The deployed
 *                dShare returns the canonical LayerZero V2 EndpointV2 from
 *                `endpoint()`, itself from `token()`, `false` from
 *                `approvalRequired()` and `9` from `sharedDecimals()`.
 *
 * `bridge` is `supported` for the transport and still says nothing about
 * destinations: `peers(uint32)` reverts, so which chains this token is wired
 * to is not established from this deployment.
 */
const DINARI_PROFILE_V1: IssuerCapabilityProfileV1 = {
  structure: {
    documented: 'documented',
    callable: 'callable',
    probe: 'balancePerShare() 0xa781a3fd, decimals() 0x313ce567',
    note: 'A rebasing ERC-20 dShare, 18 decimals, paired with an ERC-4626 wrapped dShare that is NOT a member of the issuer root.',
  },
  reference_price: {
    documented: 'documented',
    callable: 'not_probed',
    probe: null,
    note: "Dinari publishes prices through its own API. No on-chain reference feed for a dShare has been established, and Coinbase's feed for the same ticker is a different issuer's instrument.",
  },
  ratio: {
    documented: 'documented',
    callable: 'callable',
    probe: 'balancePerShare() 0xa781a3fd',
    note: 'The token rebases: balanceOf has already applied this. Applying it again double-counts every corporate action.',
  },
  transfer_policy: {
    documented: 'documented',
    callable: 'callable',
    probe: 'transferRestrictor() 0xd4ec137a',
    note: 'Each dShare names its own restrictor contract, which holds a blacklist. There is no allowlist and no on-chain residency test.',
  },
  eligibility: {
    documented: 'documented',
    callable: 'off_chain',
    probe: null,
    note: 'Who may mint or redeem is decided by KYC and residency rules held off chain. A secondary-market transfer is stopped only by the blacklist, so holding is not the same permission as redeeming.',
  },
  pause_state: {
    documented: 'documented',
    callable: 'callable',
    probe: 'paused() 0x5c975abb',
    note: "Dinari's bridging guide says to check paused() before transferring and that tokens may be paused during splits. The deployed dShares answer it.",
  },
  redemption: {
    documented: 'documented',
    callable: 'off_chain',
    probe: null,
    note: 'Redemption runs through Dinari accounts and KYC, not through a permissionless on-chain call. It is a different exit family from a market sale, and never a measured cost.',
  },
  distributions: {
    documented: 'documented',
    callable: 'off_chain',
    probe: null,
    note: 'Dividends are paid in USD+ to a wallet registered to an account with valid KYC. A holder who bought on the secondary market and never registered does not receive them.',
  },
  corporate_actions: {
    documented: 'documented',
    callable: 'callable',
    probe: 'balancePerShare() 0xa781a3fd',
    note: 'Splits arrive as a rebase of balance-per-share; dividends are paid in USD+ to registered accounts, which a secondary-market holder does not have.',
  },
  bridge: {
    documented: 'documented',
    callable: 'callable',
    probe:
      'endpoint() 0x5e280f11, token() 0xfc0c546a, approvalRequired() 0x9f68b964, sharedDecimals() 0x857749b0',
    note: 'The token is itself a LayerZero V2 OFT and returns the canonical EndpointV2. Which destinations are wired is not established: peers(uint32) reverts on this deployment.',
  },
};

export const ISSUER_CAPABILITY_PROFILES_V1: Readonly<
  Record<ReviewedIssuerIdV1, IssuerCapabilityProfileV1>
> = {
  coinbase: COINBASE_PROFILE_V1,
  dinari: DINARI_PROFILE_V1,
  backed: BACKED_PROFILE_V1,
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
