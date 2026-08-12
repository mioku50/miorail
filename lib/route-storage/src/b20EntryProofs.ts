import {
  RouteProofEventV1Schema,
  RouteProofV1Schema,
  ZERO_HASH_V1,
  assetIdV1,
  hashApprovedCallsV1,
  hashRouteProofV1,
  nextRouteProofEventV1,
  stableHashV1,
  type ExecutionCallV1,
  type HashV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from '@mioagent/route-domain';
import type { B20PreparedEntryPlanV1 } from './b20EntryPlans.js';
import type { B20EntrySubmissionAttemptV1 } from './b20EntrySubmissions.js';
import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// Canonical Route Proof for the B20 entry family.
//
// The proof payload is the SAME RouteProofV1 used by swap and earn. Storage is
// separate because B20 deliberately cannot forge a trusted-asset RouteIntentV1
// merely to satisfy the generic route_runs foreign keys. The hashes below bind
// the B20 execution's real lineage into that common proof language.
// ---------------------------------------------------------------------------

const USDC_SYMBOL_V1 = 'USDC';
const USDC_DECIMALS_V1 = 6;
type AddressV1 = `0x${string}`;

export function b20EntryProofIdV1(planId: string, attemptId: string): string {
  return `route-proof:${stableHashV1('b20-entry-route-proof-id/v1', { planId, attemptId }).slice(2)}`;
}

export function b20EntryIntentHashV1(plan: B20PreparedEntryPlanV1): HashV1 {
  return stableHashV1('b20-entry-intent/v1', {
    executionFamily: plan.executionFamily,
    tenantId: plan.tenantId,
    walletAddress: plan.walletAddress,
    chainId: plan.chainId,
    profileIdentity: plan.profileIdentity,
    tokenAddress: plan.tokenAddress,
    quoteAsset: plan.quoteAsset,
    positionAtomic: plan.positionAtomic,
    executionRequested: true,
  });
}

export function b20EntryEvidenceSetHashV1(plan: B20PreparedEntryPlanV1): HashV1 {
  return stableHashV1('b20-entry-evidence-set/v1', {
    clearanceHash: plan.clearanceHash,
    freshQuoteHash: plan.freshQuoteHash,
    certificationControlSnapshotHash: plan.certificationControlSnapshotHash,
    prepareControlSnapshotHash: plan.prepareControlSnapshotHash,
    certificationSimulationEvidenceHash: plan.certificationSimulationEvidenceHash,
    prepareSimulationEvidenceHash: plan.prepareSimulationEvidenceHash,
  });
}

export function b20EntryApprovedCallsV1(plan: B20PreparedEntryPlanV1): ExecutionCallV1[] {
  return plan.calls.map((call) => ({
    index: call.index,
    callType: call.callType,
    to: call.to as AddressV1,
    valueWei: call.valueWei,
    data: call.data as `0x${string}`,
    asset: null,
    amountAtomic: call.amountAtomic,
    recipient: call.recipient as AddressV1 | null,
    spender: call.spender as AddressV1 | null,
  }));
}

export function b20EntryApprovedCallsHashV1(plan: B20PreparedEntryPlanV1): HashV1 {
  return hashApprovedCallsV1(b20EntryApprovedCallsV1(plan));
}

function tokenSymbolV1(plan: B20PreparedEntryPlanV1): string {
  const symbol = plan.tokenSymbol?.trim();
  // A generic family label is not token metadata and makes no claim about the
  // issuer. The address remains the asset identity in assetId/address.
  return symbol && symbol.length <= 32 ? symbol : 'B20';
}

function expectedResultV1(plan: B20PreparedEntryPlanV1): RouteProofV1['expectedResult'] {
  if (plan.tokenDecimals === null) {
    throw new RouteStorageIntegrityError('B20 Route Proof needs the token decimals read during preparation');
  }
  const usdc = {
    assetId: assetIdV1({ chainId: 8453, kind: 'erc20', address: plan.quoteAsset as AddressV1 }),
    chainId: 8453 as const,
    kind: 'erc20' as const,
    address: plan.quoteAsset as AddressV1,
    symbol: USDC_SYMBOL_V1,
    decimals: USDC_DECIMALS_V1,
  };
  const token = {
    assetId: assetIdV1({ chainId: 8453, kind: 'erc20', address: plan.tokenAddress as AddressV1 }),
    chainId: 8453 as const,
    kind: 'erc20' as const,
    address: plan.tokenAddress as AddressV1,
    symbol: tokenSymbolV1(plan),
    decimals: plan.tokenDecimals,
  };
  return {
    assetChanges: [
      {
        asset: usdc,
        direction: 'debit',
        amountAtomic: plan.positionAtomic,
        minimumAmountAtomic: null,
        maximumAmountAtomic: plan.positionAtomic,
      },
      {
        asset: token,
        direction: 'credit',
        amountAtomic: plan.expectedOutputAtomic,
        minimumAmountAtomic: plan.minimumOutputAtomic,
        maximumAmountAtomic: null,
      },
    ],
    outputAmountAtomic: plan.expectedOutputAtomic,
    outputAsset: token,
  };
}

export function buildPendingB20EntryRouteProofV1(input: {
  plan: B20PreparedEntryPlanV1;
  attempt: B20EntrySubmissionAttemptV1;
  now: Date;
}): RouteProofV1 {
  const { plan, attempt, now } = input;
  if (attempt.planId !== plan.id || attempt.tenantId !== plan.tenantId) {
    throw new RouteStorageIntegrityError('B20 Route Proof attempt does not belong to its plan');
  }
  if (plan.prepareSimulationGasUsed === null) {
    throw new RouteStorageIntegrityError('B20 Route Proof needs the gas observed during exact-call simulation');
  }
  const approvedCalls = b20EntryApprovedCallsV1(plan);
  const nowIso = now.toISOString();
  const expectedResult = expectedResultV1(plan);
  const draft: RouteProofV1 = {
    schemaVersion: 'route-proof/v1',
    id: b20EntryProofIdV1(plan.id, attempt.id),
    tenantId: plan.tenantId,
    walletAddress: plan.walletAddress as AddressV1,
    chainId: 8453,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'pending',
    intentHash: b20EntryIntentHashV1(plan),
    selectedCandidateHash: plan.entryRouteHash as HashV1,
    evidenceSetHash: b20EntryEvidenceSetHashV1(plan),
    blueprintHash: plan.blueprintHash as HashV1,
    approvedCallsHash: hashApprovedCallsV1(approvedCalls),
    proofHash: ZERO_HASH_V1,
    approvedCalls,
    expectedResult,
    actualResult: null,
    estimatedGas: {
      gasUnits: plan.prepareSimulationGasUsed,
      maxFeePerGasWei: null,
      estimatedCostNative: null,
      estimatedCostUsd: null,
    },
    actualGas: null,
    deviation: { outputBps: null, gasCostUsd: null, withinTolerance: null },
    transactionHashes: [],
    receipts: [],
    finalStatus: 'pending',
    reconciliationState: 'pending',
  };
  return RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });
}

function actualGasV1(attempt: B20EntrySubmissionAttemptV1): RouteProofV1['actualGas'] {
  if (attempt.receipts.length === 0 || attempt.receipts.some((receipt) => receipt.gasUsed === null)) return null;
  return {
    gasUnits: attempt.receipts.reduce((sum, receipt) => sum + BigInt(receipt.gasUsed!), 0n).toString(),
    maxFeePerGasWei: null,
    estimatedCostNative: null,
    estimatedCostUsd: null,
  };
}

function outputDeviationBpsV1(expected: string, actual: string): number | null {
  const denominator = BigInt(expected);
  if (denominator === 0n) return null;
  return Number(((BigInt(actual) - denominator) * 10_000n) / denominator);
}

/** Projects the durable attempt into the canonical proof. The attempt is the
 * source of state; this function never upgrades a wallet batch id into an
 * onchain result. */
export function projectB20EntryRouteProofV1(input: {
  proof: RouteProofV1;
  plan: B20PreparedEntryPlanV1;
  attempt: B20EntrySubmissionAttemptV1;
  now: Date;
}): RouteProofV1 {
  const { proof, plan, attempt, now } = input;
  if (
    proof.id !== b20EntryProofIdV1(plan.id, attempt.id) ||
    proof.blueprintHash !== plan.blueprintHash ||
    proof.approvedCallsHash !== b20EntryApprovedCallsHashV1(plan) ||
    attempt.planId !== plan.id ||
    attempt.tenantId !== plan.tenantId
  ) {
    throw new RouteStorageIntegrityError('B20 Route Proof lineage does not match its plan and attempt');
  }

  let finalStatus: RouteProofV1['finalStatus'] = proof.finalStatus;
  let reconciliationState: RouteProofV1['reconciliationState'] = proof.reconciliationState;
  let actualResult: RouteProofV1['actualResult'] = proof.actualResult;
  let deviation: RouteProofV1['deviation'] = proof.deviation;

  if (attempt.status === 'terminal') {
    switch (attempt.terminalOutcome) {
      case 'entry_succeeded': {
        if (
          attempt.transactionHashes.length === 0 ||
          attempt.receipts.length === 0 ||
          attempt.receipts.some((receipt) => receipt.status !== 'success')
        ) {
          finalStatus = 'reconciliation_required';
          reconciliationState = 'manual_review';
          actualResult = null;
          deviation = { outputBps: null, gasCostUsd: null, withinTolerance: null };
          break;
        }
        const reconciliation = attempt.reconciliation!;
        const expectedCredit = proof.expectedResult.assetChanges.find((change) => change.direction === 'credit')!;
        const expectedDebit = proof.expectedResult.assetChanges.find((change) => change.direction === 'debit')!;
        actualResult = {
          assetChanges: [
            { ...expectedDebit, amountAtomic: reconciliation.spentAtomic, minimumAmountAtomic: null, maximumAmountAtomic: null },
            { ...expectedCredit, amountAtomic: reconciliation.receivedAtomic, minimumAmountAtomic: null, maximumAmountAtomic: null },
          ],
          outputAmountAtomic: reconciliation.receivedAtomic,
          outputAsset: expectedCredit.asset,
        };
        const outputBps = outputDeviationBpsV1(plan.expectedOutputAtomic, reconciliation.receivedAtomic);
        finalStatus = 'completed';
        reconciliationState = 'matched';
        deviation = { outputBps, gasCostUsd: null, withinTolerance: BigInt(reconciliation.receivedAtomic) >= BigInt(plan.minimumOutputAtomic) };
        break;
      }
      case 'entry_reverted':
        finalStatus = attempt.transactionHashes.length > 0 && attempt.receipts.some((receipt) => receipt.status === 'reverted')
          ? 'failed'
          : 'reconciliation_required';
        reconciliationState = finalStatus === 'failed' ? 'failed' : 'manual_review';
        actualResult = null;
        deviation = { outputBps: null, gasCostUsd: null, withinTolerance: null };
        break;
      case 'reconciliation_required':
        finalStatus = 'reconciliation_required';
        reconciliationState = 'manual_review';
        actualResult = null;
        deviation = { outputBps: null, gasCostUsd: null, withinTolerance: null };
        break;
      case 'user_rejected':
      case 'cancelled_before_submission':
        finalStatus = 'cancelled';
        reconciliationState = 'failed';
        actualResult = null;
        deviation = { outputBps: null, gasCostUsd: null, withinTolerance: null };
        break;
      case 'submitted_unknown':
      case null:
        // Honest unresolved state: the proof remains pending and blocks retry.
        break;
    }
  }

  const draft: RouteProofV1 = {
    ...proof,
    status: finalStatus,
    finalStatus,
    reconciliationState,
    actualResult,
    actualGas: actualGasV1(attempt),
    deviation,
    transactionHashes: attempt.transactionHashes as HashV1[],
    receipts: attempt.receipts,
    updatedAt: now.toISOString(),
    proofHash: ZERO_HASH_V1,
  };
  return RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });
}

export interface B20EntryRouteProofRepositoryV1 {
  upsertProof(input: {
    plan: B20PreparedEntryPlanV1;
    attempt: B20EntrySubmissionAttemptV1;
    proof: RouteProofV1;
  }): Promise<RouteProofV1>;
  getProofForPlan(input: { planId: string; tenantId: string; walletAddress: string }): Promise<RouteProofV1 | null>;
  getProofForAttempt(input: { attemptId: string; tenantId: string }): Promise<RouteProofV1 | null>;
  appendEvent(proofId: string, event: RouteProofEventV1): Promise<void>;
  listEvents(proofId: string, tenantId: string): Promise<RouteProofEventV1[]>;
}

export function assertB20EntryProofV1(value: unknown, where: 'write' | 'read'): RouteProofV1 {
  const parsed = RouteProofV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError(`B20 Route Proof failed validation on ${where}`);
  return parsed.data;
}

export function assertB20EntryProofEventV1(value: unknown, where: 'write' | 'read'): RouteProofEventV1 {
  const parsed = RouteProofEventV1Schema.safeParse(value);
  if (!parsed.success) throw new RouteStorageIntegrityError(`B20 Route Proof event failed validation on ${where}`);
  return parsed.data;
}

export async function appendB20EntryProofEventIfNewV1(input: {
  repository: B20EntryRouteProofRepositoryV1;
  proof: RouteProofV1;
  existingEvents: readonly RouteProofEventV1[];
  eventType: RouteProofEventV1['eventType'];
  payload: Record<string, unknown>;
  now: Date;
}): Promise<RouteProofEventV1[]> {
  const event = nextRouteProofEventV1(input);
  if (!event) return [...input.existingEvents];
  await input.repository.appendEvent(input.proof.id, event);
  return [...input.existingEvents, event];
}

export function assertB20ProofStorageBindingV1(input: {
  plan: B20PreparedEntryPlanV1;
  attempt: B20EntrySubmissionAttemptV1;
  proof: RouteProofV1;
}): void {
  const { plan, attempt, proof } = input;
  if (
    proof.id !== b20EntryProofIdV1(plan.id, attempt.id) ||
    proof.tenantId !== plan.tenantId ||
    proof.walletAddress !== plan.walletAddress ||
    proof.intentHash !== b20EntryIntentHashV1(plan) ||
    proof.selectedCandidateHash !== plan.entryRouteHash ||
    proof.evidenceSetHash !== b20EntryEvidenceSetHashV1(plan) ||
    proof.blueprintHash !== plan.blueprintHash ||
    proof.approvedCallsHash !== b20EntryApprovedCallsHashV1(plan) ||
    attempt.planId !== plan.id ||
    attempt.tenantId !== plan.tenantId
  ) {
    throw new RouteStorageConflictError('B20 Route Proof is bound to different lineage');
  }
}
