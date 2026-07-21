import type { EarnProtocolV1, HashV1, WithdrawalModelV1 } from '@mioagent/route-domain';
import type { PinnedEarnVenueV1 } from './pinned-config.js';

/** Raw, provider-neutral observation of a single pinned venue. The curated
 * source produces these deterministically today; the real Alchemy source
 * (T61 follow-up) produces the same shape. APY is ALWAYS integer basis points
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

/** The injected data seam. Curated implementation ships in T61; the real
 * Alchemy adapter is slotted in later without touching the adapters/engine. */
export interface EarnDataSourceV1 {
  readonly id: string;
  observe(input: EarnDataSourceObserveInput): Promise<EarnObservationResultV1>;
}
