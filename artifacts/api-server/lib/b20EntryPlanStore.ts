import { randomUUID } from 'node:crypto';
import { stableHashV1 } from '@mioagent/route-domain';
import {
  B20_ENTRY_EXECUTION_FAMILY_V1,
  B20PreparedEntryPlanV1Schema,
  B20EntryExecutionRunV1Schema,
  entryPlanCallsHashV1,
  type B20EntryExecutionRunV1,
  type B20OpportunityClearanceV1,
  type B20PreparedEntryPlanV1,
} from '@mioagent/route-storage';

import type { B20EntryBlueprintV1 } from './b20EntryPlan.js';
import type { PrepareSimulationEvidenceV1 } from './b20EntryRunner.js';

// ---------------------------------------------------------------------------
// T68F-A — turning a prepared blueprint into a stored execution subject.
//
// Everything here is derived from the server's own record: the clearance it
// read, the blueprint it built, the controls it re-read and the simulation it
// ran. Nothing structural comes from the request — the client sends a clearance
// id, a profile identity and a request id, and that is the entire input.
//
// In particular §10: the provider id, the source key and the route hash come
// from the clearance and the fresh route. A caller cannot name a venue.
// ---------------------------------------------------------------------------

/** The clearance document, hashed whole. A clearance that changed under a plan
 * is caught here rather than assumed impossible. */
export function clearanceHashV1(clearance: B20OpportunityClearanceV1): string {
  return stableHashV1('b20-opportunity-clearance/v1', clearance);
}

export interface BuildPreparedPlanInputV1 {
  clearance: B20OpportunityClearanceV1;
  blueprint: B20EntryBlueprintV1;
  simulation: PrepareSimulationEvidenceV1;
  tokenName: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  requestId: string;
  now: Date;
  /** Injected so a test does not have to accept a random id. */
  newId?: () => string;
}

export interface PreparedPlanDraftV1 {
  plan: B20PreparedEntryPlanV1;
  run: B20EntryExecutionRunV1;
}

export function buildPreparedPlanV1(input: BuildPreparedPlanInputV1): PreparedPlanDraftV1 {
  const newId = input.newId ?? (() => randomUUID());
  const planId = newId();
  const blueprint = input.blueprint;

  const plan = B20PreparedEntryPlanV1Schema.parse({
    schemaVersion: 'b20-prepared-entry-plan/v1',
    executionFamily: B20_ENTRY_EXECUTION_FAMILY_V1,
    id: planId,
    tenantId: input.clearance.tenantId,
    walletAddress: input.clearance.walletAddress,
    chainId: 8453,
    clearanceId: input.clearance.id,
    clearanceHash: clearanceHashV1(input.clearance),
    profileIdentity: input.clearance.profileIdentity,
    tokenAddress: input.clearance.tokenAddress,
    tokenName: input.tokenName,
    tokenSymbol: input.tokenSymbol,
    tokenDecimals: input.tokenDecimals,
    quoteAsset: blueprint.quoteAsset,
    positionAtomic: blueprint.positionAtomic,

    // §10 — the venue is named by the clearance and the route the server
    // re-quoted, never by the request.
    entryProviderId: input.clearance.entryProvider,
    entrySourceKey: blueprint.entrySourceKey,
    entryRouteHash: blueprint.entryRouteHash,

    blueprintHash: blueprint.blueprintHash,
    callsHash: entryPlanCallsHashV1(blueprint.calls),
    freshQuoteHash: blueprint.freshQuoteHash,
    certificationControlSnapshotHash: blueprint.certifiedControlSnapshotHash,
    prepareControlSnapshotHash: blueprint.prepareControlSnapshotHash,
    certificationSimulationEvidenceHash: blueprint.certificationEvidenceHash,
    prepareSimulationEvidenceHash: input.simulation.evidenceHash,
    prepareSimulationGasUsed: input.simulation.gasUsed,

    expectedOutputAtomic: blueprint.expectedOutputAtomic,
    minimumOutputAtomic: blueprint.minimumOutputAtomic,
    deadlineSeconds: blueprint.deadlineSeconds,

    coverage: blueprint.coverage,
    viableRouteConfirmed: true,
    bestRouteConfirmed: blueprint.bestRouteConfirmed,
    certificationRoundTripBps: input.clearance.simulatedRoundTripBps,

    certificationBlockNumber: input.clearance.controlBlockNumber,
    prepareControlBlockNumber: blueprint.prepareControlBlockNumber,
    prepareSimulationBlockNumber: input.simulation.blockNumber,

    clearanceCreatedAt: input.clearance.createdAt,
    clearanceExpiresAt: input.clearance.expiresAt,

    // Exactly the calls the kernel checked and the simulator ran. Never
    // rebuilt, never accepted from a client.
    calls: blueprint.calls.map((call) => ({
      index: call.index,
      callType: call.callType,
      to: call.to,
      data: call.data,
      valueWei: call.valueWei,
      amountAtomic: call.amountAtomic,
      recipient: call.recipient,
      spender: call.spender,
    })),

    lifecycle: 'prepared',
    submissionId: null,
    requestId: input.requestId,
    createdAt: input.now.toISOString(),
    // A plan cannot outlive the swap deadline in its own calls: past that
    // second they revert on chain, and offering them would be a lie.
    expiresAt: new Date(Number(blueprint.deadlineSeconds) * 1000).toISOString(),
  });

  const run = B20EntryExecutionRunV1Schema.parse({
    schemaVersion: 'b20-entry-execution-run/v1',
    id: newId(),
    tenantId: plan.tenantId,
    walletAddress: plan.walletAddress,
    chainId: 8453,
    executionFamily: B20_ENTRY_EXECUTION_FAMILY_V1,
    preparedPlanId: plan.id,
    clearanceId: plan.clearanceId,
    // Not `submitted`, not `pending`. Nothing has been offered to a wallet.
    state: 'prepared',
    submissionId: null,
    createdAt: plan.createdAt,
  });

  return { plan, run };
}
