import {
  ExecutionBlueprintV1Schema,
  RouteProofV1Schema,
  SafetyKernelResultV1Schema,
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashExecutionBlueprintV1,
  hashRouteProofV1,
  type AssetRefV1,
  type EarnCandidateV1,
  type ExecutionBlueprintV1,
  type HashV1,
  type RouteProofV1,
  type SafetyKernelResultV1,
} from '@mioagent/route-domain';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import { earnEvidenceSetHashV1 } from '@mioagent/earn-engine';
import { TransactionComposerBindingError } from './coordinator.js';
import { buildEarnDepositBlueprintV1 } from './earnComposition.js';
import { runEarnSafetyKernelV1 } from './earnSafetyKernel.js';
import {
  appendProofEventIfNewV1,
  buildApprovedPayload,
  routeProofIdV1,
  type ApprovedBlueprintPayloadV1,
} from './approval.js';
import { deriveBlueprintLifecycleV1, type LifecycleStateV1 } from './lifecycle.js';

// ---------------------------------------------------------------------------
// T62 §3/§4 — earn deposit prepare + goal-aware approve over the persisted earn
// store. `prepareEarnDepositV1` loads the persisted Earn Route Card + candidate
// (the client never supplies calldata), builds the exact deposit Blueprint, and
// persists it; `approveEarnBlueprintV1` re-validates the STORED Blueprint through
// the EARN Safety Kernel (never the swap one) and opens a pending Route Proof
// whose expected credit is the position token. Both reuse the goal-agnostic
// approve/proof storage; the server never signs or broadcasts.
// ---------------------------------------------------------------------------

export interface EarnExecutionDependencies {
  repository: RouteStorageRepository;
}

/** The position token (mToken market / ERC-4626 vault share) is the deposit
 * target. Decimals/symbol are display-only — the Route Proof reconstructs the
 * ACTUAL minted position from on-chain Transfer logs. */
function earnPositionAssetV1(candidate: EarnCandidateV1): AssetRefV1 {
  const address = candidate.contracts.target;
  return {
    assetId: `eip155:8453/erc20:${address}`,
    chainId: 8453,
    kind: 'erc20',
    address,
    symbol:
      candidate.protocol === 'moonwell' ? 'mwUSDC' :
        candidate.protocol === 'morpho' ? 'mwUSDC-vault' : 'yoUSD',
    decimals: candidate.protocol === 'moonwell' ? 8 : candidate.protocol === 'morpho' ? 18 : 6,
  };
}

function notApprovableSafetyV1(status: string): SafetyKernelResultV1 {
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

// --- Prepare ----------------------------------------------------------------

export interface PrepareEarnDepositInputV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  routeRunId: string;
  routeCardHash: HashV1;
  selectedCandidateHash: HashV1;
  requestId: string;
  now: Date;
}

export type PrepareEarnDepositResultV1 =
  | { outcome: 'prepared'; blueprint: ExecutionBlueprintV1; safety: SafetyKernelResultV1 }
  | { outcome: 'refresh_required'; reason: string }
  | { outcome: 'expired'; reason: string }
  | { outcome: 'blocked'; reason: string; safety: SafetyKernelResultV1 };

export async function prepareEarnDepositV1(
  deps: EarnExecutionDependencies,
  input: PrepareEarnDepositInputV1,
): Promise<PrepareEarnDepositResultV1> {
  const run = await deps.repository.getEarnRouteRun(input.routeRunId, input.tenantId);
  if (!run) {
    throw new TransactionComposerBindingError('earn_route_run_not_found', 'Earn Route Run does not exist for this tenant');
  }
  if (run.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    throw new TransactionComposerBindingError('wallet_binding_mismatch', 'walletAddress does not match the earn Route Run');
  }

  const cards = await deps.repository.listEarnRouteCards(input.routeRunId, input.tenantId);
  const card = cards.find((entry) => entry.routeCardHash === input.routeCardHash);
  if (!card) return { outcome: 'refresh_required', reason: 'Earn Route Card was not found for this run' };

  const candidates = await deps.repository.listEarnCandidates(input.routeRunId, input.tenantId);
  const candidate = candidates.find((entry) => entry.candidateHash === input.selectedCandidateHash);
  if (!candidate) return { outcome: 'refresh_required', reason: 'Selected earn candidate is not part of this Route Card' };

  const evidence = (await deps.repository.listEarnEvidence(input.routeRunId, input.tenantId)).find(
    (entry) => entry.candidateHash === candidate.candidateHash,
  );
  if (!evidence) return { outcome: 'refresh_required', reason: 'Persisted earn evidence is missing for the candidate' };

  const built = buildEarnDepositBlueprintV1({
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    intent: run.intent,
    candidate,
    evidenceSetHash: earnEvidenceSetHashV1(evidence),
    requestId: input.requestId,
    now: input.now,
  });
  if (built.outcome !== 'prepared') return built;

  await deps.repository.insertEarnBlueprint(input.routeRunId, built.blueprint);
  return built;
}

// --- Approve ----------------------------------------------------------------

export interface ApproveEarnBlueprintInputV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  routeRunId: string;
  blueprintId: string;
  blueprintHash: HashV1;
  now: Date;
}

export type ApproveEarnBlueprintResultV1 =
  | { outcome: 'approved'; payload: ApprovedBlueprintPayloadV1; lifecycle: LifecycleStateV1 }
  | { outcome: 'expired'; reason: string }
  | { outcome: 'blocked'; reason: string; safety: SafetyKernelResultV1 };

export function buildEarnPendingRouteProofV1(input: {
  blueprint: ExecutionBlueprintV1;
  candidate: EarnCandidateV1;
  now: Date;
}): RouteProofV1 {
  const { blueprint, candidate, now } = input;
  const nowIso = now.toISOString();
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
    // The exact USDC debit is the promised change; the position CREDIT amount is
    // unknown until settlement (proven from Transfer logs by the reconciler).
    expectedResult: {
      assetChanges: blueprint.expectedAssetChanges,
      outputAmountAtomic: null,
      outputAsset: earnPositionAssetV1(candidate),
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

export async function approveEarnBlueprintV1(
  deps: EarnExecutionDependencies,
  input: ApproveEarnBlueprintInputV1,
): Promise<ApproveEarnBlueprintResultV1> {
  const { repository } = deps;
  const run = await repository.getEarnRouteRun(input.routeRunId, input.tenantId);
  if (!run) {
    throw new TransactionComposerBindingError('earn_route_run_not_found', 'Earn Route Run does not exist for this tenant');
  }
  if (run.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    throw new TransactionComposerBindingError('wallet_binding_mismatch', 'walletAddress does not match the earn Route Run');
  }
  if (run.chainId !== 8453) {
    throw new TransactionComposerBindingError('unsupported_chain', 'Earn Route Run is not on Base mainnet');
  }

  const blueprints = await repository.listBlueprints(input.routeRunId, input.tenantId);
  const stored = blueprints.find((entry) => entry.blueprint.id === input.blueprintId);
  if (!stored) {
    throw new TransactionComposerBindingError('blueprint_not_found', 'Blueprint was not found for this earn Route Run');
  }
  const blueprint = stored.blueprint;
  if (blueprint.goal !== 'earn') {
    throw new TransactionComposerBindingError('goal_mismatch', 'Blueprint goal is not earn');
  }
  if (blueprint.blueprintHash !== input.blueprintHash) {
    throw new TransactionComposerBindingError('blueprint_hash_mismatch', 'blueprintHash does not match the stored Blueprint');
  }
  if (blueprint.intentHash !== run.intentHash) {
    throw new TransactionComposerBindingError('blueprint_intent_mismatch', 'Blueprint intent hash does not match the earn Route Run');
  }
  if (blueprint.blueprintHash !== hashExecutionBlueprintV1(blueprint)) {
    throw new TransactionComposerBindingError('blueprint_hash_invalid', 'Stored Blueprint content hash is invalid');
  }
  const recomputedCallsHash = hashApprovedCallsV1(blueprint.calls);
  if (blueprint.callsHash !== recomputedCallsHash) {
    throw new TransactionComposerBindingError('blueprint_calls_hash_invalid', 'Stored Blueprint calls hash is invalid');
  }
  if (Date.parse(blueprint.quoteExpiry) <= input.now.getTime()) {
    return { outcome: 'expired', reason: 'Earn Blueprint quote has expired and can no longer be approved' };
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
        safety: notApprovableSafetyV1(blueprint.status),
      };
    }
    const candidates = await repository.listEarnCandidates(input.routeRunId, input.tenantId);
    const candidate = candidates.find((entry) => entry.candidateHash === blueprint.selectedCandidateHash);
    if (!candidate) {
      throw new TransactionComposerBindingError('candidate_not_found', 'Selected earn candidate is missing for this Blueprint');
    }
    const { result: safety } = runEarnSafetyKernelV1({
      walletAddress: input.walletAddress,
      intent: run.intent,
      candidate,
      calls: blueprint.calls,
      quoteExpiry: blueprint.quoteExpiry,
      now: input.now,
      intentHash: blueprint.intentHash,
      selectedCandidateHash: blueprint.selectedCandidateHash,
    });
    if (safety.verdict === 'blocked') {
      return { outcome: 'blocked', reason: safety.blockedReason ?? 'Earn Safety Kernel blocked this Blueprint', safety };
    }
    approvedBlueprint = ExecutionBlueprintV1Schema.parse({
      ...blueprint,
      status: 'approved',
      approvedCallsHash: recomputedCallsHash,
      updatedAt: input.now.toISOString(),
    });
    await repository.approveBlueprint(input.routeRunId, blueprint.id, input.tenantId, approvedBlueprint);
  }

  const proofId = routeProofIdV1(approvedBlueprint.id);
  let proof = await repository.getProofProjection(proofId, input.tenantId);
  if (!proof) {
    const candidates = await repository.listEarnCandidates(input.routeRunId, input.tenantId);
    const candidate = candidates.find((entry) => entry.candidateHash === approvedBlueprint.selectedCandidateHash);
    if (!candidate) {
      throw new TransactionComposerBindingError('candidate_not_found', 'Selected earn candidate is missing for this Blueprint');
    }
    proof = buildEarnPendingRouteProofV1({ blueprint: approvedBlueprint, candidate, now: input.now });
    await repository.upsertProofProjection(input.routeRunId, proof);
  }

  const existingEvents = await repository.listProofEvents(proof.id, input.tenantId);
  const events = await appendProofEventIfNewV1(
    repository,
    proof,
    existingEvents,
    'calls_approved',
    {
      blueprintId: approvedBlueprint.id,
      blueprintHash: approvedBlueprint.blueprintHash,
      approvedCallsHash: approvedBlueprint.approvedCallsHash,
    },
    input.now,
  );

  const lifecycle = deriveBlueprintLifecycleV1({ blueprint: approvedBlueprint, proof, events });
  return {
    outcome: 'approved',
    payload: buildApprovedPayload(approvedBlueprint, run.walletAddress as `0x${string}`),
    lifecycle,
  };
}
