import { stableHashV1, type EarnProtocolV1 } from '@mioagent/route-domain';
import type { EarnDataSourceObserveInput, EarnDataSourceV1, EarnObservationResultV1 } from './types.js';

// ---------------------------------------------------------------------------
// Curated earn data source (T61). Deterministic, offline, no network.
//
// As of T63A this is NO LONGER the default: production compares LIVE Moonwell +
// Morpho readings (see live-source.ts). It stays as the explicit operator
// fallback behind MIORAIL_EARN_LIVE_DATA=false and as a fixture for pipeline
// tests — the numbers below are a fixed table, NOT market data, and must never
// be presented as a live quote.
// APY is integer basis points; liquidity is atomic USDC (6 decimals).
// ---------------------------------------------------------------------------

interface CuratedEntryV1 {
  baseApyBps: number | null;
  rewardApyBps: number | null;
  netApyBps: number | null;
  availableLiquidityAtomic: string | null;
  performanceFeeBps: number | null;
  managementFeeBps: number | null;
}

const CURATED_TABLE_V1: Record<EarnProtocolV1, CuratedEntryV1> = {
  // Net = base + reward (no protocol fee on the supply side).
  moonwell: { baseApyBps: 520, rewardApyBps: 60, netApyBps: 580, availableLiquidityAtomic: '4200000000000', performanceFeeBps: 0, managementFeeBps: 0 },
  // Higher headline APY, but a 10% performance fee already netted into netApy.
  morpho: { baseApyBps: 790, rewardApyBps: 0, netApyBps: 710, availableLiquidityAtomic: '1800000000000', performanceFeeBps: 1000, managementFeeBps: 0 },
  // No canonical APY is available from YO onchain contracts.
  yo: { baseApyBps: null, rewardApyBps: null, netApyBps: null, availableLiquidityAtomic: null, performanceFeeBps: null, managementFeeBps: null },
};

export interface CuratedEarnSourceOptionsV1 {
  /** APY freshness horizon; defaults to 5 minutes. */
  freshnessWindowMs?: number;
  providerId?: string;
  providerDisplayName?: string;
}

const DEFAULT_FRESHNESS_WINDOW_MS = 5 * 60_000;

export function createCuratedEarnDataSourceV1(options: CuratedEarnSourceOptionsV1 = {}): EarnDataSourceV1 {
  const windowMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS;
  const providerId = options.providerId ?? 'curated-earn-v1';
  const providerDisplayName = options.providerDisplayName ?? 'Miorail Curated Earn';

  return {
    id: providerId,
    supportedProtocols: ['moonwell', 'morpho', 'yo'],
    async observe(input: EarnDataSourceObserveInput): Promise<EarnObservationResultV1> {
      const entry = CURATED_TABLE_V1[input.protocol];
      if (!entry) return { ok: false, reason: 'unsupported_protocol' };
      const observedAt = input.now.toISOString();
      const expiresAt = new Date(input.now.getTime() + windowMs).toISOString();
      const requestHash = stableHashV1('earn-observation-request/v1', {
        protocol: input.protocol,
        target: input.venue.target,
        amountAtomic: input.amountAtomic,
        providerId,
      });
      const responseHash = stableHashV1('earn-observation-response/v1', {
        protocol: input.protocol,
        entry,
        observedAt,
        providerId,
      });
      return {
        ok: true,
        observation: {
          baseApyBps: entry.baseApyBps,
          rewardApyBps: entry.rewardApyBps,
          netApyBps: entry.netApyBps,
          availableLiquidityAtomic: entry.availableLiquidityAtomic,
          fees: { performanceFeeBps: entry.performanceFeeBps, managementFeeBps: entry.managementFeeBps },
          withdrawalTerms: input.protocol === 'yo'
            ? { model: input.venue.withdrawalModel, instant: false, noticePeriodSeconds: 86_400 }
            : { model: input.venue.withdrawalModel, instant: true, noticePeriodSeconds: null },
          blockNumber: null,
          observedAt,
          expiresAt,
          requestHash,
          responseHash,
          // Both venues are backed by the same curated provider, so agreement
          // between them is NOT an independent risk confirmation (spec §4).
          sourceIndependence: 'overlapping',
          providerId,
          providerDisplayName,
        },
      };
    },
  };
}
