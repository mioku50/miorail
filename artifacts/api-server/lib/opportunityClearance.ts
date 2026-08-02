import { stableHashV1 } from '@mioagent/route-domain';
import {
  aerodromeSourceKeyV1,
  type AerodromeRouteLegV1,
} from '@mioagent/swap-adapters';
import {
  B20_CLEARANCE_TTL_MS_V1,
  B20OpportunityClearanceV1Schema,
  type B20OpportunityClearanceV1,
} from '@mioagent/route-storage';
import {
  ROUND_TRIP_CALL_COUNT_V1,
  certifyRoundTripV1,
  coverageV1,
  entryOutputFromSimulationV1,
  profileIdentityV1,
  type OpportunityCoverageV1,
  type OpportunityOutcomeV2,
  type OpportunityProfileV2,
  type OpportunityUnmeasuredReasonV1,
} from '@mioagent/opportunity-rail';
import type { ExecutionCallV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T68D — turning a simulation into a clearance, or into an honest refusal.
//
// The rule the whole task exists for lives here: `qualified` is reachable only
// from `certifyRoundTripV1`, which requires four calls executed sequentially
// against ONE state with the wallet's own decoded movements. Nothing on the
// quote path can reach it.
//
// The second rule is about blame. A provider that would not answer, a wallet
// without the probe balance, an undecodable log — none of those is a finding
// about the token, and each maps to a NAMED `unmeasured` reason rather than to
// a rejection wearing the token's name. That distinction is the AERO lesson,
// applied one layer up.
// ---------------------------------------------------------------------------

/** The route, hashed. Two routes that differ in factory, curve or hop produce
 * different hashes, so a clearance cannot survive a re-route. */
export function routeHashV1(route: readonly AerodromeRouteLegV1[]): string {
  return stableHashV1('b20-opportunity-route/v1', {
    legs: route.map((leg) => aerodromeSourceKeyV1(leg)),
  });
}

/** What the simulation seam gives back, structurally. Kept local so this file
 * does not depend on the paid-intelligence package's own shapes. */
export interface SimulationOutcomeLikeV1 {
  ok: boolean;
  errorCode?: string;
  blockNumber?: number;
  calls?: readonly { index: number; status: 'success' | 'reverted' }[];
  assetChangesAvailable?: boolean;
  assetChanges?: readonly {
    token: string;
    direction: 'in' | 'out';
    amountAtomic: string;
    callIndex: number;
  }[];
}

/**
 * A transport failure, classified as evidence rather than as a verdict.
 *
 * `provider_insufficient_funds` is the one that matters most: a wallet without
 * the USDC to probe the position tells you nothing whatever about the token,
 * and reporting it as a rejection would blame the token for the user's balance.
 */
export function unmeasuredFromSimulationV1(errorCode: string | undefined): OpportunityUnmeasuredReasonV1 {
  if (errorCode === 'provider_insufficient_funds') return 'insufficient_probe_balance';
  if (errorCode === 'provider_invalid_schema' || errorCode === 'provider_call_count_mismatch') {
    return 'simulation_undecodable';
  }
  return 'simulation_unavailable';
}

export interface CertifyOpportunityInputV1 {
  profile: OpportunityProfileV2;
  tokenAddress: string;
  /** The four-call round trip, as the provider answered it. */
  roundTrip: SimulationOutcomeLikeV1;
  candidatesTotal: number;
  candidatesAnswered: number;
}

export interface CertifiedOpportunityV1 {
  outcome: OpportunityOutcomeV2;
  coverage: OpportunityCoverageV1;
  simulatedRoundTripBps: number | null;
  simulatedReturnedAtomic: string | null;
  simulatedAcquiredAtomic: string | null;
  simulationBlockNumber: string | null;
}

/**
 * The one function that may return `qualified`.
 *
 * Fail-closed throughout: an unusable simulation is `unmeasured`, a revert is a
 * rejection about the transaction, and a certified round trip still has to come
 * in under the user's own tolerance before it clears.
 */
export function certifyOpportunityV1(input: CertifyOpportunityInputV1): CertifiedOpportunityV1 {
  const noCoverage = coverageV1({
    candidatesTotal: input.candidatesTotal,
    candidatesAnswered: input.candidatesAnswered,
    simulationProvedRoute: false,
  });
  const empty = (outcome: OpportunityOutcomeV2): CertifiedOpportunityV1 => ({
    outcome,
    coverage: noCoverage,
    simulatedRoundTripBps: null,
    simulatedReturnedAtomic: null,
    simulatedAcquiredAtomic: null,
    simulationBlockNumber: null,
  });

  if (!input.roundTrip.ok) {
    return empty({
      viability: 'unmeasured',
      reason: unmeasuredFromSimulationV1(input.roundTrip.errorCode),
    });
  }

  const calls = input.roundTrip.calls ?? [];
  if (calls.length !== ROUND_TRIP_CALL_COUNT_V1) {
    return empty({ viability: 'unmeasured', reason: 'simulation_undecodable' });
  }

  const certification = certifyRoundTripV1({
    quoteAsset: input.profile.quoteAsset,
    tokenAddress: input.tokenAddress,
    positionAtomic: input.profile.positionAtomic,
    calls,
    assetChangesAvailable: input.roundTrip.assetChangesAvailable === true,
    assetChanges: input.roundTrip.assetChanges ?? [],
  });

  if (certification.status === 'reverted') {
    // A revert IS an answer about the transaction: the round trip does not
    // execute as quoted. That is a sound rejection, not missing evidence.
    return empty({ viability: 'rejected', reason: 'simulation_reverted' });
  }
  if (certification.status === 'undecodable') {
    return empty({ viability: 'unmeasured', reason: 'simulation_undecodable' });
  }

  const block =
    typeof input.roundTrip.blockNumber === 'number'
      ? String(input.roundTrip.blockNumber)
      : null;
  const coverage = coverageV1({
    candidatesTotal: input.candidatesTotal,
    candidatesAnswered: input.candidatesAnswered,
    simulationProvedRoute: true,
  });

  if (certification.costBps > input.profile.maxRoundTripBps) {
    // Measured end to end and over the user's own limit. Sound, and named
    // differently from the quoted rejection so a reader can tell which
    // measurement produced it.
    return {
      outcome: { viability: 'rejected', reason: 'simulated_round_trip_above_tolerance' },
      coverage,
      simulatedRoundTripBps: certification.costBps,
      simulatedReturnedAtomic: certification.returnedAtomic,
      simulatedAcquiredAtomic: certification.acquiredAtomic,
      simulationBlockNumber: block,
    };
  }

  return {
    outcome: { viability: 'qualified' },
    coverage,
    simulatedRoundTripBps: certification.costBps,
    simulatedReturnedAtomic: certification.returnedAtomic,
    simulatedAcquiredAtomic: certification.acquiredAtomic,
    simulationBlockNumber: block,
  };
}

/** The entry probe's observed output, or why there is none. */
export function entryProbeOutputV1(
  tokenAddress: string,
  probe: SimulationOutcomeLikeV1,
): { status: 'measured'; acquiredAtomic: string } | { status: 'unmeasured'; reason: OpportunityUnmeasuredReasonV1 } | { status: 'rejected'; reason: 'simulation_reverted' } {
  if (!probe.ok) {
    return { status: 'unmeasured', reason: unmeasuredFromSimulationV1(probe.errorCode) };
  }
  const result = entryOutputFromSimulationV1({
    tokenAddress,
    calls: probe.calls ?? [],
    assetChangesAvailable: probe.assetChangesAvailable === true,
    assetChanges: probe.assetChanges ?? [],
  });
  if (result.status === 'measured') return result;
  if (result.status === 'reverted') return { status: 'rejected', reason: 'simulation_reverted' };
  return { status: 'unmeasured', reason: 'simulation_undecodable' };
}

export interface BuildClearanceInputV1 {
  id: string;
  tenantId: string;
  walletAddress: string;
  tokenAddress: string;
  profile: OpportunityProfileV2;
  controlSnapshotHash: string;
  controlBlockNumber: string;
  entryRoute: readonly AerodromeRouteLegV1[];
  exitRoute: readonly AerodromeRouteLegV1[];
  calls: readonly ExecutionCallV1[];
  simulationEvidenceHash: string;
  certified: CertifiedOpportunityV1;
  now: Date;
  ttlMs?: number;
}

/**
 * The clearance record.
 *
 * Hashes only. There is no field here for a provider body, an endpoint or a
 * key, and the schema is `.strict()` so one cannot be added by accident.
 */
export function buildClearanceV1(input: BuildClearanceInputV1): B20OpportunityClearanceV1 {
  if (input.certified.outcome.viability !== 'qualified') {
    throw new Error('Only a qualified simulation may produce a clearance');
  }
  const ttl = input.ttlMs ?? B20_CLEARANCE_TTL_MS_V1;
  return B20OpportunityClearanceV1Schema.parse({
    schemaVersion: 'b20-opportunity-clearance/v1',
    id: input.id,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress.toLowerCase(),
    chainId: 8453,
    tokenAddress: input.tokenAddress.toLowerCase(),
    quoteAsset: input.profile.quoteAsset,
    positionAtomic: input.profile.positionAtomic,
    maxRoundTripBps: input.profile.maxRoundTripBps,
    maxExitSlippageBps: input.profile.maxExitSlippageBps,
    profileIdentity: profileIdentityV1(input.profile),
    controlSnapshotHash: input.controlSnapshotHash,
    controlBlockNumber: input.controlBlockNumber,
    entryRouteHash: routeHashV1(input.entryRoute),
    exitRouteHash: routeHashV1(input.exitRoute),
    entrySourceKey: aerodromeSourceKeyV1(input.entryRoute[0]!),
    exitSourceKey: aerodromeSourceKeyV1(input.exitRoute[0]!),
    // The calls, hashed — never the calls themselves. A clearance is a
    // justification, not a second place execution bytes live.
    simulationRequestHash: stableHashV1('b20-opportunity-request/v1', {
      calls: input.calls.map((call) => ({ to: call.to, data: call.data, value: call.valueWei })),
    }),
    simulationEvidenceHash: input.simulationEvidenceHash,
    simulationBlockNumber: input.certified.simulationBlockNumber ?? '0',
    entryProvider: 'aerodrome',
    viability: 'qualified',
    coverage: input.certified.coverage.coverage,
    viableRouteConfirmed: true,
    bestRouteConfirmed: input.certified.coverage.bestRouteConfirmed,
    simulatedReturnedAtomic: input.certified.simulatedReturnedAtomic ?? '0',
    simulatedAcquiredAtomic: input.certified.simulatedAcquiredAtomic ?? '0',
    simulatedRoundTripBps: input.certified.simulatedRoundTripBps ?? 0,
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + ttl).toISOString(),
  });
}
