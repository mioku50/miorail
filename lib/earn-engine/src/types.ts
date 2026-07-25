import type { EarnProtocolV1, HashV1, WithdrawalModelV1 } from '@mioagent/route-domain';
import type { PinnedEarnVenueV1 } from './pinned-config.js';

/** Raw, provider-neutral observation of a single pinned venue. Produced in
 * production by the live Moonwell/Morpho sources (T63A) and, behind the
 * operator fallback, by the curated table. APY is ALWAYS integer basis points
 * or null — never float. `null` means "no datum", which flows through to a
 * Not-scored dimension, never a fabricated value. */
export interface EarnObservationV1 {
  baseApyBps: number | null;
  rewardApyBps: number | null;
  netApyBps: number | null;
  availableLiquidityAtomic: string | null;
  fees: { performanceFeeBps: number | null; managementFeeBps: number | null };
  withdrawalTerms: { model: WithdrawalModelV1; instant: boolean; noticePeriodSeconds: number | null };
  blockNumber: string | null;
  observedAt: string;
  /** APY freshness horizon — the engine drops candidates observed past this. */
  expiresAt: string;
  requestHash: HashV1;
  responseHash: HashV1;
  sourceIndependence: 'independent' | 'overlapping' | 'unknown';
  providerId: string;
  providerDisplayName: string;
  /** Provenance of the reading. A live first-party source sets `protocol` +
   * its own operator so the Route Card can name the real source; omitted, it
   * falls back to an internal Miorail data provider. */
  providerKind?: 'aggregator' | 'dex' | 'protocol' | 'data_provider' | 'simulation' | 'internal';
  providerOperator?: string;
}

export type EarnObservationResultV1 =
  | { ok: true; observation: EarnObservationV1 }
  | { ok: false; reason: string };

export interface EarnDataSourceObserveInput {
  protocol: EarnProtocolV1;
  venue: PinnedEarnVenueV1;
  amountAtomic: string;
  now: Date;
}

/** The injected data seam. The live Moonwell/Morpho sources (T63A) and the
 * curated fallback both implement it, so the adapters/engine never change when
 * the provider does. */
export interface EarnDataSourceV1 {
  readonly id: string;
  observe(input: EarnDataSourceObserveInput): Promise<EarnObservationResultV1>;
}
