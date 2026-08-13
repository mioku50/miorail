import type { EarnProtocolV1, EarnVenueKindV1, WithdrawalModelV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// Pinned Base-mainnet earn venues (T61 §3 — curated, NO dynamic discovery).
// The Safety Kernel treats these as the single source of truth for the
// allowlist; the adapters never resolve a market/vault any other way.
// ---------------------------------------------------------------------------

/** Canonical USDC on Base mainnet. Mirrors @mioagent/security
 * `BASE_MAINNET_USDC_DEFAULT` (hardcoded here to avoid a security→earn dep). */
export const PINNED_BASE_USDC_V1: `0x${string}` = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

export interface PinnedEarnVenueV1 {
  protocol: EarnProtocolV1;
  venueKind: EarnVenueKindV1;
  identifier: string;
  /** mToken market / ERC-4626 vault the USDC is deposited into (lowercased). */
  target: `0x${string}`;
  /** Recipient of the EXACT USDC approval (== target for both venues). */
  approvalSpender: `0x${string}`;
  withdrawalModel: WithdrawalModelV1;
  estimatedGasUnits: string;
  callCount: number;
  approvalCount: number;
}

// ┌────────────────────────────────────────────────────────────────────────┐
// │  ⚠  VERIFY BEFORE THE MAINNET SMOKE TEST  ⚠                              │
// │  These are the ONLY pinned earn venues: the canonical Base-mainnet      │
// │  Moonwell USDC market and a pinned Morpho USDC MetaMorpho vault.        │
// │  T63A (2026-07-25) cross-checked both against the official provider     │
// │  APIs: Moonwell reports mTokenAddress 0xEdc817…6c22 with assetAddress   │
// │  == canonical USDC on eip155:8453, and Morpho reports vault             │
// │  0xc1256Ae5…A2Ca ("Moonwell Flagship USDC") on chain 8453 with asset    │
// │  == canonical USDC. That is an API-level confirmation, NOT a substitute │
// │  for the on-chain preflight (verifyPinnedEarnContractsV1), which still  │
// │  gates every earn route before the first real deposit.                  │
// └────────────────────────────────────────────────────────────────────────┘
export const PINNED_EARN_VENUES_V1: Record<EarnProtocolV1, PinnedEarnVenueV1> = {
  moonwell: {
    protocol: 'moonwell',
    venueKind: 'moonwell_market',
    identifier: 'Moonwell USDC',
    target: '0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22',
    approvalSpender: '0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22',
    withdrawalModel: 'direct',
    estimatedGasUnits: '250000',
    callCount: 2,
    approvalCount: 1,
  },
  morpho: {
    protocol: 'morpho',
    venueKind: 'morpho_vault',
    identifier: 'Moonwell Flagship USDC (Morpho)',
    target: '0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca',
    approvalSpender: '0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca',
    withdrawalModel: 'vault_redeem',
    estimatedGasUnits: '300000',
    callCount: 2,
    approvalCount: 1,
  },
  yo: {
    protocol: 'yo',
    venueKind: 'yo_vault',
    identifier: 'YO yoUSD',
    target: '0x0000000f2eb9f69274678c76222b35eec7588a65',
    approvalSpender: '0xf1eee0957267b1a474323ff9cff7719e964969fa',
    withdrawalModel: 'async_redeem',
    estimatedGasUnits: '350000',
    callCount: 2,
    approvalCount: 1,
  },
};

export const EARN_PROTOCOLS_V1: readonly EarnProtocolV1[] = ['moonwell', 'morpho', 'yo'];

export function pinnedEarnVenueV1(protocol: EarnProtocolV1): PinnedEarnVenueV1 {
  return PINNED_EARN_VENUES_V1[protocol];
}

const ALLOWLISTED_TARGETS_V1: ReadonlySet<string> = new Set(
  Object.values(PINNED_EARN_VENUES_V1).flatMap((venue) => [venue.target, venue.approvalSpender]),
);

/** True only for the pinned deposit targets / approval spenders. */
export function isPinnedEarnTargetV1(address: string): boolean {
  return ALLOWLISTED_TARGETS_V1.has(address.toLowerCase());
}

export function isCanonicalBaseUsdcV1(address: string): boolean {
  return address.toLowerCase() === PINNED_BASE_USDC_V1;
}
