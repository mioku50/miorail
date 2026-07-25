import { z } from 'zod';
import { partnerFetch } from '@mioagent/security/httpAllowlist';
import { PINNED_BASE_USDC_V1 } from './pinned-config.js';
import {
  BASE_MAINNET_CHAIN_ID_V1,
  MOONWELL_LIVE_PROVIDER_V1,
  resolveFreshnessTtlMsV1,
  resolveTimeoutMsV1,
  type EarnChainReaderV1,
  type EarnLiveSourceOptionsV1,
  type EarnMoonwellMarketSnapshotV1,
} from './live-types.js';
import {
  MAX_APY_BPS_V1,
  classifyLiveHttpStatusV1,
  classifyLiveTransportErrorV1,
  liveRequestHashV1,
  liveResponseHashV1,
  normalizeLiveAddressV1,
  parseAtomicIntegerV1,
  percentToApyBpsV1,
  resolveObservedAtV1,
} from './live-normalization.js';
import type { EarnDataSourceObserveInput, EarnDataSourceV1, EarnObservationResultV1 } from './types.js';

// ---------------------------------------------------------------------------
// MoonwellEarnDataSourceV1 (T63A §1) — the official Moonwell HTTP API, read
// only. The markets LIST is requested and the pinned mToken is selected out of
// it by ADDRESS: the venue is never resolved by symbol, rank, or "best APY", so
// a renamed or re-listed market can never silently become the deposit target.
//
// The API reports APY (percent) and liquidity in USD but no atomic balance and
// no block. The exact `availableLiquidityAtomic` and `blockNumber` therefore
// come from an optional injected on-chain read (`getCash()` / `underlying()`);
// USD is never converted into an atomic amount. When that read is unavailable,
// both fields stay null and the liquidity dimension goes Not scored — an honest
// gap, not an estimate.
// ---------------------------------------------------------------------------

export const MOONWELL_MARKETS_ENDPOINT_V1 = 'https://api.moonwell.fi/v1/markets?chain=base';

/** The API tags the answering chain as a CAIP-2 id; it must be Base mainnet. */
const MOONWELL_EXPECTED_CHAIN_V1 = `eip155:${BASE_MAINNET_CHAIN_ID_V1}`;

const MoonwellMarketSchemaV1 = z
  .object({
    asset: z.string().min(1).max(64).optional(),
    assetAddress: z.string().min(1).max(100),
    mToken: z.string().min(1).max(64).optional(),
    mTokenAddress: z.string().min(1).max(100),
    deprecated: z.boolean().optional(),
    /** Native supply APY, in percent. */
    baseSupplyApy: z.number().nullable().optional(),
    /** Supply APY INCLUDING incentives, in percent (base + rewards). */
    totalSupplyApr: z.number().nullable().optional(),
  })
  .passthrough();

const MoonwellMarketsResponseSchemaV1 = z
  .object({
    success: z.boolean().optional(),
    data: z.array(MoonwellMarketSchemaV1).min(1),
    meta: z
      .object({ chain: z.string().max(100).optional(), timestamp: z.string().max(100).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface MoonwellEarnDataSourceOptionsV1 extends EarnLiveSourceOptionsV1 {
  /** Injected on-chain reader; without it liquidity/block stay null. */
  chainReader?: EarnChainReaderV1 | null;
}

export function createMoonwellEarnDataSourceV1(options: MoonwellEarnDataSourceOptionsV1 = {}): EarnDataSourceV1 {
  const endpoint = options.endpoint ?? MOONWELL_MARKETS_ENDPOINT_V1;
  const timeoutMs = resolveTimeoutMsV1(options.timeoutMs);
  const freshnessTtlMs = resolveFreshnessTtlMsV1(options.freshnessTtlMs);
  const providerId = options.providerId ?? MOONWELL_LIVE_PROVIDER_V1.id;
  const providerDisplayName = options.providerDisplayName ?? MOONWELL_LIVE_PROVIDER_V1.displayName;
  const chainReader = options.chainReader ?? null;

  return {
    id: providerId,
    async observe(input: EarnDataSourceObserveInput): Promise<EarnObservationResultV1> {
      if (input.protocol !== 'moonwell') return { ok: false, reason: 'unsupported_protocol' };

      let body: string;
      try {
        const response = await partnerFetch(
          endpoint,
          { method: 'GET', headers: { accept: 'application/json' } },
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
      const parsed = MoonwellMarketsResponseSchemaV1.safeParse(payload);
      if (!parsed.success) return { ok: false, reason: 'provider_invalid_response' };

      // --- Pinned binding (§2). Any mismatch produces NO candidate. ---------
      const meta = parsed.data.meta;
      if (meta?.chain !== undefined && meta.chain !== MOONWELL_EXPECTED_CHAIN_V1) {
        return { ok: false, reason: 'pinned_chain_mismatch' };
      }
      const market = parsed.data.data.find(
        (entry) => normalizeLiveAddressV1(entry.mTokenAddress) === input.venue.target,
      );
      if (!market) return { ok: false, reason: 'provider_venue_missing' };
      if (normalizeLiveAddressV1(market.assetAddress) !== PINNED_BASE_USDC_V1) {
        return { ok: false, reason: 'pinned_asset_mismatch' };
      }
      if (market.deprecated === true) return { ok: false, reason: 'pinned_venue_deprecated' };

      // --- APY, as integer basis points only (§3) ---------------------------
      const baseApy = percentToApyBpsV1(market.baseSupplyApy);
      if (!baseApy.ok) return { ok: false, reason: baseApy.reason };
      const totalApy = percentToApyBpsV1(market.totalSupplyApr);
      if (!totalApy.ok) return { ok: false, reason: totalApy.reason };
      const baseApyBps = baseApy.value;
      // Moonwell publishes base and base+incentives; the reward leg is their
      // difference. A total below base means no incentive is being paid, so the
      // reward leg is zero — never a negative "yield".
      const rewardApyBps =
        totalApy.value === null || baseApyBps === null ? null : Math.max(0, totalApy.value - baseApyBps);
      // Supplying on Moonwell carries no protocol fee on the supply side, so the
      // published supply APY IS the net APY.
      const netApyBps = baseApyBps === null ? null : baseApyBps + (rewardApyBps ?? 0);
      if (netApyBps !== null && netApyBps > MAX_APY_BPS_V1) return { ok: false, reason: 'apy_out_of_range' };

      // --- Optional on-chain anchor: exact liquidity + block ----------------
      let snapshot: EarnMoonwellMarketSnapshotV1 | null = null;
      if (chainReader) {
        try {
          snapshot = await chainReader.readMoonwellMarketSnapshot({ market: input.venue.target });
        } catch {
          // A degraded RPC must not invalidate a valid API reading; it only
          // costs the atomic liquidity and the block anchor.
          snapshot = null;
        }
      }
      if (snapshot && normalizeLiveAddressV1(snapshot.underlyingAsset) !== PINNED_BASE_USDC_V1) {
        // The chain disagrees with the pinned asset — fail closed, never trust
        // the API over the contract itself.
        return { ok: false, reason: 'pinned_asset_mismatch' };
      }

      // Re-validate the injected reader's integers: a malformed value becomes
      // "no datum" rather than an exception deep in schema validation.
      const liquidityAtomic = snapshot ? parseAtomicIntegerV1(snapshot.availableLiquidityAtomic) : null;
      const blockNumber = snapshot ? parseAtomicIntegerV1(snapshot.blockNumber) : null;

      const observedAt = resolveObservedAtV1(meta?.timestamp ?? null, input.now);
      const expiresAt = new Date(Date.parse(observedAt) + freshnessTtlMs).toISOString();

      return {
        ok: true,
        observation: {
          baseApyBps,
          rewardApyBps,
          netApyBps,
          availableLiquidityAtomic: liquidityAtomic,
          // The Moonwell API states no supply-side fee schedule; reporting 0
          // would be an assertion it never made.
          fees: { performanceFeeBps: null, managementFeeBps: null },
          withdrawalTerms: { model: input.venue.withdrawalModel, instant: true, noticePeriodSeconds: null },
          blockNumber,
          observedAt,
          expiresAt,
          requestHash: liveRequestHashV1({
            providerId,
            method: 'GET',
            endpoint,
            chainId: BASE_MAINNET_CHAIN_ID_V1,
            market: input.venue.target,
            asset: PINNED_BASE_USDC_V1,
          }),
          responseHash: liveResponseHashV1({ providerId, body, chain: snapshot ?? null }),
          // One first-party reading per venue: nothing independently confirms
          // it, and Moonwell/Morpho reporting on their own venues is not a
          // cross-check of each other (spec §4).
          sourceIndependence: 'unknown',
          providerId,
          providerDisplayName,
          providerKind: 'protocol',
          providerOperator: MOONWELL_LIVE_PROVIDER_V1.operator,
        },
      };
    },
  };
}
