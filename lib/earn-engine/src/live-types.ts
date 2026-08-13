import type { EarnProtocolV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T63A — live earn data seams. The two live sources (Moonwell, Morpho) read
// ONLY official provider APIs plus, optionally, direct on-chain reads. There is
// no scraping and no dynamic discovery: every request is bound to the PINNED
// venue for the protocol, and any response that does not match Base 8453 +
// canonical USDC + the pinned market/vault is a TYPED FAILURE that produces no
// candidate at all (never a silently corrected or partially trusted one).
// ---------------------------------------------------------------------------

export const BASE_MAINNET_CHAIN_ID_V1 = 8453;

/** The closed failure taxonomy a live source may report. It flows into
 * `EarnObservationResultV1.reason` verbatim, so the coordinator's `failures`
 * (and any operator log) always carries a stable, non-leaking code. */
export type EarnLiveFailureReasonV1 =
  | 'unsupported_protocol'
  /** The host was refused by the partner allowlist before any socket opened. */
  | 'provider_host_not_allowlisted'
  | 'provider_timeout'
  | 'provider_unreachable'
  | 'provider_rate_limited'
  | 'provider_http_error'
  | 'provider_invalid_response'
  /** The provider answered, but the pinned venue was absent from the payload. */
  | 'provider_venue_missing'
  | 'pinned_venue_deprecated'
  | 'pinned_chain_mismatch'
  | 'pinned_contract_mismatch'
  | 'pinned_asset_mismatch'
  | 'apy_out_of_range';

/** A direct on-chain read of a pinned Moonwell market. Moonwell's HTTP API
 * reports APY and USD liquidity but neither an atomic balance nor a block, so
 * the exact `availableLiquidityAtomic` + `blockNumber` in the evidence come
 * from this read. Injected (never constructed here) so the engine package never
 * opens a socket of its own and tests never touch a live RPC. */
export interface EarnMoonwellMarketSnapshotV1 {
  /** Block the reads were answered at, as an unsigned decimal string. */
  blockNumber: string;
  /** The market's `underlying()` — cross-checked against canonical USDC. */
  underlyingAsset: `0x${string}`;
  /** `getCash()` — underlying held by the market, i.e. what is withdrawable now. */
  availableLiquidityAtomic: string;
}

export interface EarnYoVaultSnapshotV1 {
  blockNumber: string;
  underlyingAsset: `0x${string}`;
  totalAssetsAtomic: string;
  totalSupplyAtomic: string;
  expectedSharesAtomic: string;
}

export interface EarnChainReaderV1 {
  readMoonwellMarketSnapshot(input: { market: `0x${string}` }): Promise<EarnMoonwellMarketSnapshotV1>;
  readYoVaultSnapshot?(input: {
    vault: `0x${string}`;
    amountAtomic: string;
  }): Promise<EarnYoVaultSnapshotV1>;
}

/** Shared knobs for both live sources. Every duration is explicit so the
 * operator (not the code) decides how long a reading stays rankable. */
export interface EarnLiveSourceOptionsV1 {
  fetchImpl?: typeof fetch;
  /** Bounded per-request timeout; the provider is reported unavailable past it. */
  timeoutMs?: number;
  /** How long an observation counts as FRESH (drives `expiresAt`). Past it the
   * reading is still shown but is excluded from every ranking dimension. */
  freshnessTtlMs?: number;
  endpoint?: string;
  providerId?: string;
  providerDisplayName?: string;
}

export const DEFAULT_EARN_LIVE_TIMEOUT_MS = 6_000;
export const DEFAULT_EARN_LIVE_FRESHNESS_TTL_MS = 5 * 60_000;

/** Clamp so `expiresAt` is always strictly after `observedAt` (contract rule)
 * and a misconfigured TTL can never disable freshness entirely. */
export function resolveFreshnessTtlMsV1(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_EARN_LIVE_FRESHNESS_TTL_MS;
  return Math.max(1_000, Math.floor(value));
}

export function resolveTimeoutMsV1(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_EARN_LIVE_TIMEOUT_MS;
  return Math.min(60_000, Math.max(250, Math.floor(value)));
}

export interface EarnLiveProviderRefV1 {
  id: string;
  displayName: string;
  operator: string;
}

export const MOONWELL_LIVE_PROVIDER_V1: EarnLiveProviderRefV1 = {
  id: 'moonwell-api-v1',
  displayName: 'Moonwell API',
  operator: 'Moonwell',
};

export const MORPHO_LIVE_PROVIDER_V1: EarnLiveProviderRefV1 = {
  id: 'morpho-api-v1',
  displayName: 'Morpho API',
  operator: 'Morpho Labs',
};
export const YO_LIVE_PROVIDER_V1: EarnLiveProviderRefV1 = {
  id: 'yo-onchain-v1',
  displayName: 'YO onchain vault',
  operator: 'YO',
};

export const EARN_LIVE_PROVIDERS_V1: Record<EarnProtocolV1, EarnLiveProviderRefV1> = {
  moonwell: MOONWELL_LIVE_PROVIDER_V1,
  morpho: MORPHO_LIVE_PROVIDER_V1,
  yo: YO_LIVE_PROVIDER_V1,
};
