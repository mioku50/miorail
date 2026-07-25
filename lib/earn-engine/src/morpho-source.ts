import { z } from 'zod';
import { partnerFetch } from '@mioagent/security/httpAllowlist';
import { PINNED_BASE_USDC_V1 } from './pinned-config.js';
import {
  BASE_MAINNET_CHAIN_ID_V1,
  MORPHO_LIVE_PROVIDER_V1,
  resolveFreshnessTtlMsV1,
  resolveTimeoutMsV1,
  type EarnLiveSourceOptionsV1,
} from './live-types.js';
import {
  MAX_APY_BPS_V1,
  classifyLiveHttpStatusV1,
  classifyLiveTransportErrorV1,
  clampNetApyBpsV1,
  fractionToApyBpsV1,
  liveRequestHashV1,
  liveResponseHashV1,
  normalizeLiveAddressV1,
  parseAtomicIntegerV1,
  resolveObservedAtV1,
} from './live-normalization.js';
import type { EarnDataSourceObserveInput, EarnDataSourceV1, EarnObservationResultV1 } from './types.js';

// ---------------------------------------------------------------------------
// MorphoEarnDataSourceV1 (T63A §1) — the official Morpho API (GraphQL), read
// only. The query is a FIXED document with the pinned vault address and chain
// 8453 as variables: no vault listing, no ranking, no discovery — the API is
// asked about exactly one vault and must answer about exactly that vault.
//
// Morpho publishes everything the evidence needs first-party: net APY, the
// reward legs separately, the vault fee, total assets, withdrawable liquidity,
// the block AND the timestamp — so this source needs no on-chain read.
// ---------------------------------------------------------------------------

export const MORPHO_GRAPHQL_ENDPOINT_V1 = 'https://api.morpho.org/graphql';

/** Fixed document. `netApyExcludingRewards` is the vault's own yield NET of the
 * performance fee; `allRewards[].supplyApr` are the incentive legs; `netApy`
 * is their sum as Morpho computes it. */
export const MORPHO_VAULT_QUERY_V1 = `query MiorailPinnedVault($address: String!, $chainId: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) {
    address
    name
    symbol
    chain { id }
    asset { address symbol decimals }
    state {
      timestamp
      blockNumber
      netApy
      netApyExcludingRewards
      fee
      totalAssets
      allRewards { supplyApr }
    }
    liquidity { underlying }
  }
}`;

const MorphoVaultSchemaV1 = z
  .object({
    address: z.string().min(1).max(100),
    name: z.string().max(200).nullable().optional(),
    symbol: z.string().max(64).nullable().optional(),
    chain: z.object({ id: z.number() }).passthrough(),
    asset: z.object({ address: z.string().min(1).max(100) }).passthrough(),
    state: z
      .object({
        timestamp: z.number().nullable().optional(),
        blockNumber: z.union([z.number(), z.string()]).nullable().optional(),
        netApy: z.number().nullable().optional(),
        netApyExcludingRewards: z.number().nullable().optional(),
        fee: z.number().nullable().optional(),
        totalAssets: z.union([z.number(), z.string()]).nullable().optional(),
        allRewards: z
          .array(z.object({ supplyApr: z.number().nullable().optional() }).passthrough())
          .nullable()
          .optional(),
      })
      .passthrough(),
    liquidity: z
      .object({ underlying: z.union([z.number(), z.string()]).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const MorphoResponseSchemaV1 = z
  .object({
    data: z.object({ vaultByAddress: MorphoVaultSchemaV1.nullable() }).passthrough().optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type MorphoEarnDataSourceOptionsV1 = EarnLiveSourceOptionsV1;

export function createMorphoEarnDataSourceV1(options: MorphoEarnDataSourceOptionsV1 = {}): EarnDataSourceV1 {
  const endpoint = options.endpoint ?? MORPHO_GRAPHQL_ENDPOINT_V1;
  const timeoutMs = resolveTimeoutMsV1(options.timeoutMs);
  const freshnessTtlMs = resolveFreshnessTtlMsV1(options.freshnessTtlMs);
  const providerId = options.providerId ?? MORPHO_LIVE_PROVIDER_V1.id;
  const providerDisplayName = options.providerDisplayName ?? MORPHO_LIVE_PROVIDER_V1.displayName;

  return {
    id: providerId,
    async observe(input: EarnDataSourceObserveInput): Promise<EarnObservationResultV1> {
      if (input.protocol !== 'morpho') return { ok: false, reason: 'unsupported_protocol' };

      const variables = { address: input.venue.target, chainId: BASE_MAINNET_CHAIN_ID_V1 };
      const requestBody = JSON.stringify({ query: MORPHO_VAULT_QUERY_V1, variables });

      let body: string;
      try {
        const response = await partnerFetch(
          endpoint,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: requestBody,
          },
          { timeoutMs, fetchImpl: options.fetchImpl },
        );
        if (!response.ok) return { ok: false, reason: classifyLiveHttpStatusV1(response.status) };
        body = await response.text();
      } catch (error) {
        return { ok: false, reason: classifyLiveTransportErrorV1(error) };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return { ok: false, reason: 'provider_invalid_response' };
      }
      const parsed = MorphoResponseSchemaV1.safeParse(payload);
      if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };
      // A GraphQL 200 can still be a total failure; treat any `errors` as one.
      if (parsed.data.errors && parsed.data.errors.length > 0) {
        return { ok: false, reason: 'provider_invalid_response' };
      }
      const vault = parsed.data.data?.vaultByAddress ?? null;
      if (!vault) return { ok: false, reason: 'provider_venue_missing' };

      // --- Pinned binding (§2). Any mismatch produces NO candidate. ---------
      if (vault.chain.id !== BASE_MAINNET_CHAIN_ID_V1) return { ok: false, reason: 'pinned_chain_mismatch' };
      if (normalizeLiveAddressV1(vault.address) !== input.venue.target) {
        return { ok: false, reason: 'pinned_contract_mismatch' };
      }
      if (normalizeLiveAddressV1(vault.asset.address) !== PINNED_BASE_USDC_V1) {
        return { ok: false, reason: 'pinned_asset_mismatch' };
      }

      // --- APY, as integer basis points only (§3) ---------------------------
      const state = vault.state;
      const baseApy = fractionToApyBpsV1(state.netApyExcludingRewards);
      if (!baseApy.ok) return { ok: false, reason: baseApy.reason };
      const netApy = fractionToApyBpsV1(state.netApy);
      if (!netApy.ok) return { ok: false, reason: netApy.reason };

      let rewardApyBps: number | null = null;
      if (state.allRewards !== null && state.allRewards !== undefined) {
        let total = 0;
        for (const reward of state.allRewards) {
          const leg = fractionToApyBpsV1(reward.supplyApr);
          if (!leg.ok) return { ok: false, reason: leg.reason };
          total += leg.value ?? 0;
        }
        if (total > MAX_APY_BPS_V1) return { ok: false, reason: 'apy_out_of_range' };
        rewardApyBps = total;
      }
      const baseApyBps = baseApy.value;
      const netApyBps = clampNetApyBpsV1(netApy.value, baseApyBps, rewardApyBps);

      // --- Liquidity, fees, provenance --------------------------------------
      // What can actually be withdrawn now, not the vault's headline size: a
      // MetaMorpho vault's assets can be allocated into markets that are not
      // instantly redeemable. `totalAssets` is the fallback only when the API
      // omits the liquidity leg entirely.
      const availableLiquidityAtomic =
        parseAtomicIntegerV1(vault.liquidity?.underlying) ?? parseAtomicIntegerV1(state.totalAssets);
      const performanceFee = fractionToApyBpsV1(state.fee);
      if (!performanceFee.ok) return { ok: false, reason: performanceFee.reason };

      const observedAt = resolveObservedAtV1(state.timestamp ?? null, input.now);
      const expiresAt = new Date(Date.parse(observedAt) + freshnessTtlMs).toISOString();

      return {
        ok: true,
        observation: {
          baseApyBps,
          rewardApyBps,
          netApyBps,
          availableLiquidityAtomic,
          fees: { performanceFeeBps: performanceFee.value, managementFeeBps: null },
          withdrawalTerms: { model: input.venue.withdrawalModel, instant: true, noticePeriodSeconds: null },
          blockNumber: parseAtomicIntegerV1(state.blockNumber),
          observedAt,
          expiresAt,
          requestHash: liveRequestHashV1({
            providerId,
            method: 'POST',
            endpoint,
            query: MORPHO_VAULT_QUERY_V1,
            variables,
            asset: PINNED_BASE_USDC_V1,
          }),
          responseHash: liveResponseHashV1({ providerId, body }),
          // Morpho reporting on its own vault is a first-party reading; nothing
          // independently confirms it (spec §4).
          sourceIndependence: 'unknown',
          providerId,
          providerDisplayName,
          providerKind: 'protocol',
          providerOperator: MORPHO_LIVE_PROVIDER_V1.operator,
        },
      };
    },
  };
}
