import {
  ExecutionBlueprintV1Schema,
  RouteProofV1Schema,
  SafetyKernelResultV1Schema,
  ZERO_HASH_V1,
  buildRouteProofEventV1,
  hashApprovedCallsV1,
  hashExecutionBlueprintV1,
  hashRouteProofV1,
  nextRouteProofEventV1,
  stableHashV1,
  type ExecutionBlueprintV1,
  type HashV1,
  type RouteCandidateV1,
  type RouteProofEventV1,
  type RouteProofV1,
  type SafetyKernelResultV1,
} from '@mioagent/route-domain';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import { simulationHonesty, TransactionComposerBindingError } from './coordinator.js';
import { runSafetyKernel } from './safetyKernel.js';
import type { ContractSecurityLookup } from './types.js';
import { deriveBlueprintLifecycleV1, type LifecycleStateV1 } from './lifecycle.js';

// ---------------------------------------------------------------------------
// T57: server-side approve coordinator. Re-validates a previously prepared,
// stored ExecutionBlueprintV1 (fail-closed, no client-supplied calls/calldata
// accepted or echoed) and, if the Safety Kernel still allows it, transitions
// the Blueprint to `approved` and opens a pending RouteProofV1 + its first
// `calls_approved` event. The server NEVER signs or broadcasts here — the
// response only ever carries the SAME unsigned calls the client already
// reviewed, now bound to an approvedCallsHash.
// ---------------------------------------------------------------------------

export interface BlueprintApprovalDependencies {
  repository: RouteStorageRepository;
  contractSecurity: ContractSecurityLookup;
}

export interface ApproveExecutionBlueprintInput {
  tenantId: string;
  walletAddress: `0x${string}`;
  routeRunId: string;
  blueprintId: string;
  blueprintHash: HashV1;
  now: Date;
}

export interface ApprovedBlueprintPayloadV1 {
  blueprintId: string;
  blueprintHash: HashV1;
  approvedCallsHash: HashV1;
  chainId: '0x2105';
  from: `0x${string}`;
  calls: { to: `0x${string}`; value: `0x${string}`; data: `0x${string}` }[];
  atomicRequired: true;
}

export type SwapBlueprintApproveResultV1 =
  | { outcome: 'approved'; payload: ApprovedBlueprintPayloadV1; lifecycle: LifecycleStateV1 }
  | { outcome: 'expired'; reason: string }
  | { outcome: 'blocked'; reason: string; safety: SafetyKernelResultV1 };

/** Deterministic from the Blueprint id alone — stable across retries and
 * independent of routeRunId/tenantId so the same proof id is recoverable by
 * both the approve and submission coordinators. */
export function routeProofIdV1(blueprintId: string): string {
  return `route-proof:${stableHashV1('route-proof-id/v1', { blueprintId }).slice(2)}`;
}

function invalidBlueprintStatusSafetyResult(status: string): SafetyKernelResultV1 {
  return SafetyKernelResultV1Schema.parse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict: 'blocked',
    checks: [
      {
        id: 'blueprint_status',
        description: 'Blueprint must be ready_for_review or already approved to be approvable',
        status: 'failed',
        detail: `Blueprint status ${status} is not approvable`,
      },
    ],
    blockedReason: `Blueprint status ${status} is not approvable`,
  });
}

function buildApprovedPayload(
  blueprint: ExecutionBlueprintV1,
  walletAddress: `0x${string}`,
): ApprovedBlueprintPayloadV1 {
  return {
    blueprintId: blueprint.id,
    blueprintHash: blueprint.blueprintHash,
    approvedCallsHash: blueprint.approvedCallsHash!,
    chainId: '0x2105',
    from: walletAddress,
    calls: blueprint.calls.map((call) => ({
      to: call.to,
      value: `0x${BigInt(call.valueWei).toString(16)}` as `0x${string}`,
      data: call.data,
    })),
    atomicRequired: true,
  };
}

function buildPendingRouteProofV1(input: {
  blueprint: ExecutionBlueprintV1;
  candidate: RouteCandidateV1;
  now: Date;
}): RouteProofV1 {
  const { blueprint, candidate, now } = input;
  const nowIso = now.toISOString();
  const outputChange = blueprint.expectedAssetChanges.find((change) => change.direction === 'credit')!;
  const draft: RouteProofV1 = {
    schemaVersion: 'route-proof/v1',
    id: routeProofIdV1(blueprint.id),
    tenantId: blueprint.tenantId,
    walletAddress: blueprint.walletAddress,
    chainId: blueprint.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'pending',
    intentHash: blueprint.intentHash,
    selectedCandidateHash: blueprint.selectedCandidateHash,
    evidenceSetHash: blueprint.evidenceSetHash,
    blueprintHash: blueprint.blueprintHash,
    approvedCallsHash: blueprint.approvedCallsHash!,
    proofHash: ZERO_HASH_V1,
    approvedCalls: blueprint.calls,
    expectedResult: {
      assetChanges: blueprint.expectedAssetChanges,
      outputAmountAtomic: outputChange.amountAtomic,
      outputAsset: outputChange.asset,
    },
    actualResult: null,
    estimatedGas: candidate.estimatedGas,
    actualGas: null,
    deviation: { outputBps: null, gasCostUsd: null, withinTolerance: null },
    transactionHashes: [],
    receipts: [],
    finalStatus: 'pending',
    reconciliationState: 'pending',
  };
  return RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });
}

// T58: the pure event-construction/duplicate-check core now lives in
// @mioagent/route-domain (proof-events.ts) so route-proof's reconciler can
// reuse it without depending on transaction-composer. `buildProofEventV1`
// stays exported here (part of this package's public surface) as a thin
// alias; `appendProofEventIfNewV1` stays the repository-aware wrapper.
export const buildProofEventV1 = buildRouteProofEventV1;

/** Check-before-append: skips writing when an event of the same eventType and
 * payloadHash already exists, so retries never duplicate history. Returns the
 * up-to-date event list (including any newly appended event). */
export async function appendProofEventIfNewV1(
  repository: RouteStorageRepository,
  proof: RouteProofV1,
  existingEvents: readonly RouteProofEventV1[],
  eventType: RouteProofEventV1['eventType'],
  payload: Record<string, unknown>,
  now: Date,
): Promise<RouteProofEventV1[]> {
  const event = nextRouteProofEventV1({ proof, existingEvents, eventType, payload, now });
  if (!event) return [...existingEvents];
  await repository.appendProofEvent(proof.id, event);
  return [...existingEvents, event];
}

export async function approveExecutionBlueprintV1(
  deps: BlueprintApprovalDependencies,
  input: ApproveExecutionBlueprintInput,
): Promise<SwapBlueprintApproveResultV1> {
  const { repository } = deps;

  // --- Binding validation (fail closed, mirrors reviewStoredBlueprint) ------
  const run = await repository.getRouteRun(input.routeRunId, input.tenantId);
  if (!run) {
    throw new TransactionComposerBindingError('route_run_not_found', 'Route run does not exist for this tenant');
  }
  if (run.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    throw new TransactionComposerBindingError('wallet_binding_mismatch', 'walletAddress does not match the route run');
  }
  if (run.chainId !== 8453) {
    throw new TransactionComposerBindingError('unsupported_chain', 'Route run is not on Base mainnet');
  }
  const blueprints = await repository.listBlueprints(input.routeRunId, input.tenantId);
  const stored = blueprints.find((entry) => entry.blueprint.id === input.blueprintId);
  if (!stored) {
    throw new TransactionComposerBindingError('blueprint_not_found', 'Blueprint was not found for this route run');
  }
  const blueprint = stored.blueprint;
  if (blueprint.blueprintHash !== input.blueprintHash) {
    throw new TransactionComposerBindingError(
      'blueprint_hash_mismatch',
      'blueprintHash does not match the stored Blueprint',
    );
  }
  if (blueprint.intentHash !== run.intentHash) {
    throw new TransactionComposerBindingError(
      'blueprint_intent_mismatch',
      'Blueprint intent hash does not match the route run',
    );
  }
  if (blueprint.blueprintHash !== hashExecutionBlueprintV1(blueprint)) {
    throw new TransactionComposerBindingError('blueprint_hash_invalid', 'Stored Blueprint content hash is invalid');
  }
  const recomputedCallsHash = hashApprovedCallsV1(blueprint.calls);
  if (blueprint.callsHash !== recomputedCallsHash) {
    throw new TransactionComposerBindingError('blueprint_calls_hash_invalid', 'Stored Blueprint calls hash is invalid');
  }

  if (Date.parse(blueprint.quoteExpiry) <= input.now.getTime()) {
    return { outcome: 'expired', reason: 'Blueprint quote has expired and can no longer be approved' };
  }

  const alreadyApproved = blueprint.status === 'approved' && blueprint.approvedCallsHash === recomputedCallsHash;

  let approvedBlueprint: ExecutionBlueprintV1;

  if (alreadyApproved) {
    approvedBlueprint = blueprint;
  } else {
    if (blueprint.status !== 'ready_for_review') {
      return {
        outcome: 'blocked',
        reason: `Blueprint status ${blueprint.status} is not approvable`,
        safety: invalidBlueprintStatusSafetyResult(blueprint.status),
      };
    }

    const candidates = await repository.listCandidates(input.routeRunId, input.tenantId);
    const candidate = candidates.find((entry) => entry.candidateHash === blueprint.selectedCandidateHash);
    if (!candidate) {
      throw new TransactionComposerBindingError('candidate_not_found', 'Selected candidate is missing for this Blueprint');
    }
    const providerId = candidate.provider.id as 'uniswap' | 'kyberswap';
    const intent = run.intent;
    const usdcAsset = intent.fromAsset!;
    const routerCall = blueprint.calls.find((call) => call.callType === 'swap');
    const routerAddress = (routerCall?.to ?? candidate.provider.id) as `0x${string}`;
    const simulation = simulationHonesty(intent);
    const contractSecurityAddresses = [usdcAsset.address].filter((value): value is `0x${string}` => Boolean(value));
    const contractSecurityResults = await deps.contractSecurity({
      chainId: intent.chainId,
      addresses: contractSecurityAddresses,
    });
    const contractSecurityProviderName = contractSecurityResults.some((entry) => entry.provider === 'goplus')
      ? 'goplus'
      : (contractSecurityResults[0]?.provider ?? 'none');

    const { result: safety } = runSafetyKernel({
      provider: providerId,
      routerAddress,
      chainId: intent.chainId,
      walletAddress: input.walletAddress,
      intent,
      calls: blueprint.calls,
      quoteExpiry: blueprint.quoteExpiry,
      now: input.now,
      contractSecurityRequired: true,
      contractSecurityProvider: contractSecurityProviderName,
      contractSecurityResults,
      contractSecurityAddresses,
      simulationAcceptable: simulation.acceptable,
      simulationDetail: simulation.detail,
      intentHash: blueprint.intentHash,
      selectedCandidateHash: blueprint.selectedCandidateHash,
    });

    if (safety.verdict === 'blocked') {
      return { outcome: 'blocked', reason: safety.blockedReason ?? 'Safety Kernel blocked this Blueprint', safety };
    }

    approvedBlueprint = ExecutionBlueprintV1Schema.parse({
      ...blueprint,
      status: 'approved',
      approvedCallsHash: recomputedCallsHash,
      updatedAt: input.now.toISOString(),
    });
    await repository.approveBlueprint(input.routeRunId, blueprint.id, input.tenantId, approvedBlueprint);
  }

  // --- Pending Route Proof + calls_approved event (idempotent, self-healing) -
  // A retry never regresses an already-progressed proof (e.g. one that has
  // recorded a submission): the projection is only created when missing.
  const proofId = routeProofIdV1(approvedBlueprint.id);
  let proof = await repository.getProofProjection(proofId, input.tenantId);
  if (!proof) {
    const candidatesForProof = await repository.listCandidates(input.routeRunId, input.tenantId);
    const candidateForProof = candidatesForProof.find(
      (entry) => entry.candidateHash === approvedBlueprint.selectedCandidateHash,
    );
    if (!candidateForProof) {
      throw new TransactionComposerBindingError(
        'candidate_not_found',
        'Selected candidate is missing for this Blueprint',
      );
    }
    proof = buildPendingRouteProofV1({ blueprint: approvedBlueprint, candidate: candidateForProof, now: input.now });
    await repository.upsertProofProjection(input.routeRunId, proof);
  }

  const existingEvents = await repository.listProofEvents(proof.id, input.tenantId);
  const eventPayload = {
    blueprintId: approvedBlueprint.id,
    blueprintHash: approvedBlueprint.blueprintHash,
    approvedCallsHash: approvedBlueprint.approvedCallsHash,
  };
  const events = await appendProofEventIfNewV1(
    repository,
    proof,
    existingEvents,
    'calls_approved',
    eventPayload,
    input.now,
  );

  const lifecycle = deriveBlueprintLifecycleV1({ blueprint: approvedBlueprint, proof, events });
  return { outcome: 'approved', payload: buildApprovedPayload(approvedBlueprint, run.walletAddress as `0x${string}`), lifecycle };
}
