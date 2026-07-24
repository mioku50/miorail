import {
  RouteProofV1Schema,
  ZERO_HASH_V1,
  hashRouteProofV1,
  nextRouteProofEventV1,
  stableHashV1,
  type RouteProofEventV1,
  type RouteProofV1,
  type TransactionReceiptV1,
} from '@mioagent/route-domain';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import {
  earnPositionProofOutcomeV1,
  reconstructEarnPositionV1,
  type EarnPositionReconstructionV1,
} from './earnAssetChanges.js';
import { ROUTE_PROOF_TERMINAL_FINAL_STATUSES } from './constants.js';
import {
  RouteProofReconciliationResultV1Schema,
  toRouteProofProjectionV1,
  type RouteProofReconciliationResultV1,
} from './projection.js';
import {
  RouteProofReconcileBindingError,
  type ReconcileRouteProofInput,
  type RouteProofReconciler,
} from './reconciler.js';
import { verifyTransactionReceiptsV1, type BaseReceiptReader, type VerifiedReceiptSourceV1 } from './receipts.js';

// ---------------------------------------------------------------------------
// T62 §5 — earn deposit Route Proof reconciliation. Structurally mirrors the
// swap reconciler (createRouteProofReconciler) but:
//   • binds through getEarnRouteRun (an earn run, goal='earn'), never
//     getRouteRun — a swap run can never be reconciled here and vice versa;
//   • reconstructs the position with reconstructEarnPositionV1 + the
//     earnPositionProofOutcomeV1 policy ("receipt success ≠ deposit proof").
// The USDC debit asset and the position credit asset both come from the pending
// proof's own expectedResult (assetChanges' debit leg + outputAsset), so no
// candidate reload is needed. Self-contained (its own copies of the small pure
// helpers) so the tested swap reconciler.ts stays byte-for-byte unchanged. The
// server never signs/broadcasts here — this only reads injected chain data.
// ---------------------------------------------------------------------------

export interface EarnRouteProofReconcilerDependencies {
  repository: RouteStorageRepository;
  receiptReader: BaseReceiptReader;
}

type NonTerminalOrReconcileStatus =
  | 'pending'
  | 'completed'
  | 'partial_failure'
  | 'failed'
  | 'reconciliation_required';

function verifyEventChainV1(events: readonly RouteProofEventV1[]): boolean {
  let previousHash: string | null = null;
  for (const [index, event] of events.entries()) {
    if (event.eventIndex !== index) return false;
    if (index === 0) {
      if (event.previousEventHash !== null) return false;
    } else if (event.previousEventHash !== previousHash) {
      return false;
    }
    previousHash = event.eventHash;
  }
  return true;
}

/** Mirrors transaction-composer/src/approval.ts `routeProofIdV1` EXACTLY (same
 * duplication rationale as the swap reconciler: route-proof must not depend on
 * transaction-composer). If that formula changes it must change here too. */
function routeProofIdV1Mirror(blueprintId: string): string {
  return `route-proof:${stableHashV1('route-proof-id/v1', { blueprintId }).slice(2)}`;
}

function pendingLifecycleV1(
  receipts: readonly TransactionReceiptV1[],
  events: readonly RouteProofEventV1[],
): string {
  if (receipts.some((receipt) => receipt.status === 'success')) return 'confirmed';
  if (receipts.some((receipt) => receipt.status === 'reverted')) return 'failed';
  const submittedEvents = events.filter((event) => event.eventType === 'submitted');
  if (submittedEvents.length === 0) return 'approved';
  const last = submittedEvents[submittedEvents.length - 1]!;
  const lastStatus = typeof last.payload.status === 'string' ? last.payload.status : null;
  if (lastStatus === 'submitted_unknown') return 'submitted_unknown';
  return 'submitted';
}

function deriveLifecycleAfterReconcileV1(proof: RouteProofV1, events: readonly RouteProofEventV1[]): string {
  if (proof.finalStatus === 'completed') return 'completed';
  if (proof.finalStatus === 'partial_failure') return 'partial_failure';
  if (proof.finalStatus === 'reconciliation_required') return 'reconciliation_required';
  if (proof.finalStatus === 'cancelled') return 'cancelled';
  if (proof.finalStatus === 'failed') return 'failed';
  return pendingLifecycleV1(proof.receipts, events);
}

function receiptsEqualV1(a: readonly TransactionReceiptV1[], b: readonly TransactionReceiptV1[]): boolean {
  if (a.length !== b.length) return false;
  const byHash = new Map(a.map((receipt) => [receipt.transactionHash, receipt]));
  return b.every((receipt) => {
    const existing = byHash.get(receipt.transactionHash);
    return (
      !!existing &&
      existing.status === receipt.status &&
      existing.blockNumber === receipt.blockNumber &&
      existing.gasUsed === receipt.gasUsed
    );
  });
}

function atomicDecimalFromWeiV1(amount: bigint): string {
  const base = BigInt(10) ** BigInt(18);
  const whole = amount / base;
  const frac = amount % base;
  if (frac === BigInt(0)) return whole.toString();
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
}

function computeActualGasV1(sources: readonly (VerifiedReceiptSourceV1 | null)[]): RouteProofV1['actualGas'] {
  const verified = sources.filter((source): source is VerifiedReceiptSourceV1 => source !== null);
  if (verified.length === 0) return null;
  const gasUnits = verified.reduce((sum, source) => sum + source.gasUsed, BigInt(0));
  const allHavePrice = verified.every((source) => source.effectiveGasPriceWei !== null);
  const estimatedCostNative = allHavePrice
    ? atomicDecimalFromWeiV1(
        verified.reduce((sum, source) => sum + source.gasUsed * (source.effectiveGasPriceWei as bigint), BigInt(0)),
      )
    : null;
  return { gasUnits: gasUnits.toString(), maxFeePerGasWei: null, estimatedCostNative, estimatedCostUsd: null };
}

async function appendProofEventV1(
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

export function createEarnRouteProofReconciler(deps: EarnRouteProofReconcilerDependencies): RouteProofReconciler {
  const { repository, receiptReader } = deps;

  return {
    async reconcile(input: ReconcileRouteProofInput): Promise<RouteProofReconciliationResultV1> {
      const { tenantId, walletAddress, routeRunId, routeProofId, now } = input;

      // --- Fail-closed binding validation (earn run, never a swap run) -----
      const run = await repository.getEarnRouteRun(routeRunId, tenantId);
      if (!run) {
        throw new RouteProofReconcileBindingError('route_proof_not_found', 'Earn Route Run does not exist for this tenant');
      }
      if (run.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new RouteProofReconcileBindingError('wallet_mismatch', 'walletAddress does not match the earn Route Run');
      }
      if (run.chainId !== 8453) {
        throw new RouteProofReconcileBindingError('route_proof_conflict', 'Earn Route Run is not on Base mainnet');
      }
      const proof = await repository.getProofProjection(routeProofId, tenantId);
      if (!proof) {
        throw new RouteProofReconcileBindingError('route_proof_not_found', 'Route Proof was not found for this tenant');
      }
      const blueprints = await repository.listBlueprints(routeRunId, tenantId);
      const stored = blueprints.find(
        (entry) =>
          entry.blueprint.blueprintHash === proof.blueprintHash &&
          routeProofIdV1Mirror(entry.blueprint.id) === proof.id,
      );
      if (!stored) {
        throw new RouteProofReconcileBindingError(
          'route_proof_not_found',
          'Route Proof does not correspond to a Blueprint on this Route Run',
        );
      }
      const blueprint = stored.blueprint;
      if (blueprint.goal !== 'earn') {
        throw new RouteProofReconcileBindingError('route_proof_conflict', 'Blueprint goal is not earn');
      }
      if (blueprint.status !== 'approved') {
        throw new RouteProofReconcileBindingError('route_proof_conflict', 'Blueprint is not approved');
      }
      if (blueprint.approvedCallsHash !== proof.approvedCallsHash) {
        throw new RouteProofReconcileBindingError(
          'route_proof_conflict',
          'approvedCallsHash does not match the approved Blueprint',
        );
      }

      const events = await repository.listProofEvents(proof.id, tenantId);
      if (!verifyEventChainV1(events)) {
        throw new RouteProofReconcileBindingError('route_proof_conflict', 'Route Proof event history is not a valid hash chain');
      }
      if (new Set(proof.transactionHashes).size !== proof.transactionHashes.length) {
        throw new RouteProofReconcileBindingError('route_proof_conflict', 'Route Proof transaction hashes are not unique');
      }

      // --- Idempotent no-op for an already-finalized / manual-review proof -
      if (
        (ROUTE_PROOF_TERMINAL_FINAL_STATUSES as readonly string[]).includes(proof.finalStatus) ||
        proof.reconciliationState === 'manual_review'
      ) {
        return RouteProofReconciliationResultV1Schema.parse({
          outcome: 'already_finalized',
          proof: toRouteProofProjectionV1(proof, { blueprintId: blueprint.id }),
          lifecycle: deriveLifecycleAfterReconcileV1(proof, events),
        });
      }

      // --- No onchain hashes yet: a batchId alone is never proof -----------
      if (proof.transactionHashes.length === 0) {
        return RouteProofReconciliationResultV1Schema.parse({
          outcome: 'pending',
          proof: toRouteProofProjectionV1(proof, { blueprintId: blueprint.id }),
          lifecycle: deriveLifecycleAfterReconcileV1(proof, events),
        });
      }

      // --- Verify every hash against the injected chain reader -------------
      const verifications = await verifyTransactionReceiptsV1({
        transactionHashes: proof.transactionHashes,
        existingReceipts: proof.receipts,
        reader: receiptReader,
      });

      const existingReceiptByHash = new Map(proof.receipts.map((receipt) => [receipt.transactionHash, receipt]));
      const mergedReceipts = verifications.map((verification) =>
        verification.conflict
          ? existingReceiptByHash.get(verification.transactionHash) ?? verification.receipt
          : verification.receipt,
      );
      const receiptsChanged = !receiptsEqualV1(proof.receipts, mergedReceipts);
      const hasUnavailable = verifications.some((verification) => verification.receipt.status === 'unknown');
      const conflicts = verifications.filter((verification) => verification.conflict !== null);
      const conflict = conflicts[0] ?? null;
      const gasSources = verifications.map((verification) => verification.source);

      let nextFinalStatus: NonTerminalOrReconcileStatus = proof.finalStatus as NonTerminalOrReconcileStatus;
      let nextReconciliationState: RouteProofV1['reconciliationState'] = proof.reconciliationState;
      let actualResult: RouteProofV1['actualResult'] = proof.actualResult;
      let deviation: RouteProofV1['deviation'] = proof.deviation;

      if (conflict) {
        // A previously verified receipt disagrees with a fresh read — never
        // silently overwrite; surface for manual review.
        nextFinalStatus = 'reconciliation_required';
        nextReconciliationState = 'manual_review';
        actualResult = null;
        deviation = { outputBps: null, gasCostUsd: null, withinTolerance: null };
      } else if (hasUnavailable) {
        // At least one receipt is not yet observable onchain — stay pending.
      } else {
        const successes = verifications.filter((verification) => verification.receipt.status === 'success');
        const anyReceiptSuccess = successes.length > 0;
        const allReceiptsSuccess = successes.length === verifications.length;
        const successLogs = successes.flatMap((verification) => verification.source?.logs ?? []);

        // The debit (USDC) leg and the position credit asset both come from the
        // pending proof itself — no candidate reload. A malformed pending proof
        // (missing debit leg or outputAsset) is treated as unprovable, never a
        // fabricated position.
        const usdcChange = proof.expectedResult.assetChanges.find((change) => change.direction === 'debit') ?? null;
        const positionAsset = proof.expectedResult.outputAsset ?? null;
        let reconstruction: EarnPositionReconstructionV1;
        if (!usdcChange || !positionAsset) {
          reconstruction = { kind: 'unprovable', reason: 'unsupported_asset' };
        } else {
          reconstruction = reconstructEarnPositionV1({
            walletAddress,
            usdcAsset: usdcChange.asset,
            positionAsset,
            successReceiptLogs: successLogs,
          });
        }

        const outcome = earnPositionProofOutcomeV1({ reconstruction, anyReceiptSuccess, allReceiptsSuccess });
        nextFinalStatus = outcome.finalStatus;
        nextReconciliationState = outcome.reconciliationState;
        // Earn has no minimum-output/slippage deviation semantics — the promised
        // position amount was deliberately unknown at approve time — so deviation
        // stays null; the actual position credit lives in actualResult.
        actualResult = reconstruction.kind === 'reconstructed' ? reconstruction.actualResult : null;
        deviation = { outputBps: null, gasCostUsd: null, withinTolerance: null };
      }

      const stillPending = hasUnavailable && !conflict;
      const actualGas = stillPending ? proof.actualGas : computeActualGasV1(gasSources);
      const finalStatusChanged = nextFinalStatus !== proof.finalStatus;
      const reconciliationStateChanged = nextReconciliationState !== proof.reconciliationState;

      const draft: RouteProofV1 = {
        ...proof,
        actualResult,
        actualGas,
        deviation,
        receipts: mergedReceipts,
        finalStatus: nextFinalStatus,
        status: nextFinalStatus,
        reconciliationState: nextReconciliationState,
        updatedAt: now.toISOString(),
        proofHash: ZERO_HASH_V1,
      };
      const updatedProof = RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });
      await repository.upsertProofProjection(routeRunId, updatedProof);

      let currentEvents = events;
      if (receiptsChanged) {
        const verifiedReceipts = verifications
          .filter((verification) => verification.receipt.status !== 'unknown')
          .map((verification) => verification.receipt);
        currentEvents = await appendProofEventV1(
          repository,
          updatedProof,
          currentEvents,
          'receipt_observed',
          { source: 'chain', receipts: verifiedReceipts },
          now,
        );
      }
      if (finalStatusChanged || reconciliationStateChanged) {
        currentEvents = await appendProofEventV1(
          repository,
          updatedProof,
          currentEvents,
          'reconciliation_updated',
          {
            previousState: proof.reconciliationState,
            nextState: nextReconciliationState,
            previousFinalStatus: proof.finalStatus,
            nextFinalStatus,
            ...(conflicts.length > 0
              ? {
                  receiptConflicts: conflicts.map((verification) => ({
                    transactionHash: verification.transactionHash,
                    previousStatus: verification.conflict!.previousStatus,
                    nextStatus: verification.conflict!.nextStatus,
                  })),
                }
              : {}),
          },
          now,
        );
      }
      if (finalStatusChanged && (nextFinalStatus === 'completed' || nextFinalStatus === 'partial_failure')) {
        currentEvents = await appendProofEventV1(
          repository,
          updatedProof,
          currentEvents,
          nextFinalStatus,
          { finalStatus: nextFinalStatus, outputBps: deviation.outputBps, minimumSatisfied: deviation.withinTolerance },
          now,
        );
      }

      const outcome: RouteProofReconciliationResultV1['outcome'] =
        hasUnavailable && !conflict ? 'pending' : nextFinalStatus;

      return RouteProofReconciliationResultV1Schema.parse({
        outcome,
        proof: toRouteProofProjectionV1(updatedProof, { blueprintId: blueprint.id }),
        lifecycle: deriveLifecycleAfterReconcileV1(updatedProof, currentEvents),
      });
    },
  };
}
