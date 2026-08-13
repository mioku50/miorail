import type { EarnProtocolV1 } from '@mioagent/route-domain';
import {
  PINNED_BASE_USDC_V1,
  PINNED_EARN_VENUES_V1,
  isCanonicalBaseUsdcV1,
  type PinnedEarnVenueV1,
} from './pinned-config.js';

// ---------------------------------------------------------------------------
// T62 §6 — Mainnet pinned-contract verification. Before MIORAIL_EARN_ROUTE_V1 is
// enabled against real funds, the pinned Base venues MUST be re-confirmed
// on-chain: every pinned address is a real contract, each venue actually accepts
// canonical Base USDC, and the Morpho vault implements the ERC-4626 reads the
// deposit path relies on. This module is PURE verification logic over an
// INJECTED chain reader — it never opens a socket itself, so it is fully
// testable with a fake reader and NEVER makes a live call in tests. The receiver
// == authenticated wallet invariant is enforced at prepare/approve (the Safety
// Kernel), not here; this module verifies the venue contracts only.
// ---------------------------------------------------------------------------

/** The minimal on-chain reads the verification needs, injected so the earn
 * package never depends on a concrete RPC client. An implementation (e.g. a
 * viem public client over the env-configured Base RPC) lives in the app layer. */
export interface EarnPinnedContractReaderV1 {
  /** Deployed code size at `address` on Base 8453 (0 => not a contract). */
  getCodeSize(address: `0x${string}`): Promise<number>;
  /** The ERC-20 the venue accepts: a Moonwell market's `underlying()`, a Morpho
   * vault's `asset()`. Returns null when the call reverts or is unimplemented. */
  getVenueUnderlyingAsset(input: { protocol: EarnProtocolV1; target: `0x${string}` }): Promise<`0x${string}` | null>;
  /** True iff `vault` answers the ERC-4626 reads the deposit path relies on
   * (asset / totalAssets / convertToShares / previewDeposit / maxDeposit).
   * Meaningful only for a Morpho ERC-4626 vault; a Moonwell market is not
   * ERC-4626 and is never probed for this. */
  supportsErc4626Reads(vault: `0x${string}`): Promise<boolean>;
}

export interface PinnedEarnVenueVerificationV1 {
  protocol: EarnProtocolV1;
  target: `0x${string}`;
  codePresent: boolean;
  /** The venue's accepted asset matches canonical Base USDC. */
  underlyingMatchesUsdc: boolean;
  /** ERC-4626 reads present (Morpho only); null for a Moonwell market. */
  erc4626Ok: boolean | null;
  ok: boolean;
  failures: string[];
}

export interface PinnedEarnVerificationV1 {
  ok: boolean;
  usdc: { address: `0x${string}`; codePresent: boolean };
  venues: PinnedEarnVenueVerificationV1[];
  failures: string[];
}

async function verifyVenueV1(
  reader: EarnPinnedContractReaderV1,
  venue: PinnedEarnVenueV1,
): Promise<PinnedEarnVenueVerificationV1> {
  const failures: string[] = [];

  const codeSize = await reader.getCodeSize(venue.target);
  const codePresent = codeSize > 0;
  if (!codePresent) failures.push(`${venue.protocol}_target_not_a_contract`);
  const spenderCodePresent =
    venue.approvalSpender === venue.target || (await reader.getCodeSize(venue.approvalSpender)) > 0;
  if (!spenderCodePresent) failures.push(`${venue.protocol}_approval_spender_not_a_contract`);

  let underlyingMatchesUsdc = false;
  if (codePresent) {
    const underlying = await reader.getVenueUnderlyingAsset({ protocol: venue.protocol, target: venue.target });
    underlyingMatchesUsdc = underlying !== null && isCanonicalBaseUsdcV1(underlying);
    if (underlying === null) failures.push(`${venue.protocol}_underlying_unreadable`);
    else if (!underlyingMatchesUsdc) failures.push(`${venue.protocol}_underlying_not_canonical_usdc`);
  }

  // ERC-4626 reads are only meaningful for the Morpho vault; a Moonwell market
  // is a distinct mToken interface (its underlying() check above is enough).
  let erc4626Ok: boolean | null = null;
  if (venue.venueKind === 'morpho_vault' || venue.venueKind === 'yo_vault') {
    erc4626Ok = codePresent ? await reader.supportsErc4626Reads(venue.target) : false;
    if (!erc4626Ok) failures.push(`${venue.protocol}_missing_erc4626_reads`);
  }

  const ok = codePresent && spenderCodePresent && underlyingMatchesUsdc && (erc4626Ok === null || erc4626Ok === true);
  return { protocol: venue.protocol, target: venue.target, codePresent, underlyingMatchesUsdc, erc4626Ok, ok, failures };
}

/**
 * Re-confirms every pinned earn venue on-chain through the injected reader.
 * `ok` is true only when canonical USDC is a live contract AND every pinned
 * venue is a live contract that accepts canonical USDC (and, for the Morpho
 * vault, implements the required ERC-4626 reads). Fail-closed: any unreadable
 * call counts as a failure, never a pass.
 */
export async function verifyPinnedEarnContractsV1(
  reader: EarnPinnedContractReaderV1,
): Promise<PinnedEarnVerificationV1> {
  const usdcCodeSize = await reader.getCodeSize(PINNED_BASE_USDC_V1);
  const usdcCodePresent = usdcCodeSize > 0;

  const venues: PinnedEarnVenueVerificationV1[] = [];
  for (const venue of Object.values(PINNED_EARN_VENUES_V1)) {
    venues.push(await verifyVenueV1(reader, venue));
  }

  const failures: string[] = [];
  if (!usdcCodePresent) failures.push('canonical_usdc_not_a_contract');
  for (const venue of venues) failures.push(...venue.failures);

  const ok = usdcCodePresent && venues.every((venue) => venue.ok);
  return { ok, usdc: { address: PINNED_BASE_USDC_V1, codePresent: usdcCodePresent }, venues, failures };
}

export interface EarnRouteEnablementV1 {
  enabled: boolean;
  reason: string | null;
}

/**
 * The flag gate (§6): the earn route surface is enabled ONLY when the operator
 * flag is on AND the pinned contracts have been verified on-chain. A pure
 * function so the enablement decision is trivially testable and auditable —
 * MIORAIL_EARN_ROUTE_V1 being true is necessary but never sufficient.
 */
export function resolveEarnRouteEnablementV1(input: {
  flagEnabled: boolean;
  verification: PinnedEarnVerificationV1 | null;
}): EarnRouteEnablementV1 {
  if (!input.flagEnabled) return { enabled: false, reason: 'flag_disabled' };
  if (!input.verification) return { enabled: false, reason: 'pinned_contracts_unverified' };
  if (!input.verification.ok) return { enabled: false, reason: input.verification.failures[0] ?? 'pinned_verification_failed' };
  return { enabled: true, reason: null };
}
