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
import { reconstructAssetChangesV1 } from './assetChanges.js';
import { ROUTE_PROOF_TERMINAL_FINAL_STATUSES } from './constants.js';
import { computeRouteProofDeviationV1 } from './deviation.js';
import {
  RouteProofReconciliationResultV1Schema,
  toRouteProofProjectionV1,
  type RouteProofReconciliationResultV1,
} from './projection.js';
import { verifyTransactionReceiptsV1, type BaseReceiptReader, type VerifiedReceiptSourceV1 } from './receipts.js';

// T58: orchestrates receipt verification -> asset reconstruction ->
// finalization -> append-only events for one Route Proof, bounded to a
// single pass over its transaction hashes (no internal retries/polling). The
// server never signs/broadcasts here — this only reads injected chain data
// and honestly reconciles it against the pending proof. Unknown NEVER
// becomes success; a native-ETH (or otherwise unsupported) output is never
// guessed — it routes to `reconciliation_required`.

/**
 * T67C.1 — the seam the outcome projector arrives through.
 *
 * Declared HERE and implemented in `@mioagent/route-outcomes`, so route-proof
 * gains no dependency on it: the projector needs a persisted candidate and the
 * scoring vocabulary, and importing that here would drag route-engine into the
 * package that reconciles receipts.
 *
 * It returns rather than throws, and the call site below ignores the result. A
 * statistic failing to record is not a reason to fail a reconcile response
 * about somebody's settled trade — `outcomes:backfill` repairs the gap.
 */
export interface RouteOutcomeProjectorPortV1 {
  projectFinalizedProof(input: {
    proof: RouteProofV1;
    events: readonly RouteProofEventV1[];
    routeRunId: string;
    now: Date;
  }): Promise<unknown>;
}

export interface RouteProofReconcilerDependencies {
  repository: RouteStorageRepository;
  receiptReader: BaseReceiptReader;
  /** Absent means no outcome is recorded at all — which is exactly what the
   * feature flag being off must look like from in here. */
  outcomeProjector?: RouteOutcomeProjectorPortV1;
}

export interface ReconcileRouteProofInput {
  tenantId: string;
  walletAddress: `0x${string}`;
  routeRunId: string;
  routeProofId: string;
  now: Date;
}

export type RouteProofReconcileBindingErrorCode =
  | 'route_proof_not_found'
  | 'wallet_mismatch'
  | 'route_proof_conflict';

/** Mapped by the API route to 404 (not_found) / 403 (wallet_mismatch) / 409
 * (conflict) — never a 500. A receipt STATUS conflict (verified success vs.
 * verified reverted across calls) is NOT one of these; it is an honest
 * `reconciliation_required` 200 outcome, handled inside `reconcile`. */
export class RouteProofReconcileBindingError extends Error {
  readonly code: RouteProofReconcileBindingErrorCode;
  constructor(code: RouteProofReconcileBindingErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RouteProofReconciler {
  reconcile(input: ReconcileRouteProofInput): Promise<RouteProofReconciliationResultV1>;
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

/** Mirrors transaction-composer/src/approval.ts `routeProofIdV1` EXACTLY.
 * Duplicated (not imported) because route-proof must not depend on
 * transaction-composer — that would drag in swap-adapters/security (see T58
 * spec decision #1). If that formula ever changes it must change here too. */
function routeProofIdV1Mirror(blueprintId: string): string {
  return `route-proof:${stableHashV1('route-proof-id/v1', { blueprintId }).slice(2)}`;
}

/** Mirrors transaction-composer/src/lifecycle.ts's post-approval,
 * pre-T58-terminal heuristic (same duplication rationale as above). Only
 * reached when finalStatus is still `pending` after this reconcile pass. */
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

/** T74: old native ETH proofs entered manual review solely because the first
 * reconciler knew ERC-20 Transfer logs only. They may be retried exactly once
 * under the new WETH9-event reconstruction, but a receipt conflict or any
 * other asset remains sticky manual review. */
function nativeReconstructionRetryEligibleV1(
  proof: RouteProofV1,
  events: readonly RouteProofEventV1[],
): boolean {
  if (proof.finalStatus !== 'reconciliation_required' || proof.reconciliationState !== 'manual_review') return false;
  if (proof.actualResult !== null) return false;
  if (!proof.expectedResult.assetChanges.some((change) => change.asset.kind === 'native')) return false;
  if (proof.receipts.length === 0 || proof.receipts.some((receipt) => receipt.status !== 'success')) return false;
  const hasReceiptConflict = events.some((event) => {
    const conflicts = event.payload.receiptConflicts;
    return Array.isArray(conflicts) && conflicts.length > 0;
  });
  return !hasReceiptConflict;
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

function computeActualGasV1(
  sources: readonly (VerifiedReceiptSourceV1 | null)[],
): RouteProofV1['actualGas'] {
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

export function createRouteProofReconciler(deps: RouteProofReconcilerDependencies): RouteProofReconciler {
  const { repository, receiptReader, outcomeProjector } = deps;

  return {
    async reconcile(input: ReconcileRouteProofInput): Promise<RouteProofReconciliationResultV1> {
      const { tenantId, walletAddress, routeRunId, routeProofId, now } = input;

      // --- Fail-closed binding validation --------------------------------
      const run = await repository.getRouteRun(routeRunId, tenantId);
      if (!run) {
        throw new RouteProofReconcileBindingError(
          'route_proof_not_found',
          'Route run does not exist for this tenant',
        );
      }
      if (run.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new RouteProofReconcileBindingError('wallet_mismatch', 'walletAddress does not match the route run');
      }
      if (run.chainId !== 8453) {
        throw new RouteProofReconcileBindingError('route_proof_conflict', 'Route run is not on Base mainnet');
      }
      const proof = await repository.getProofProjection(routeProofId, tenantId);
      if (!proof) {
        throw new RouteProofReconcileBindingError(
          'route_proof_not_found',
          'Route Proof was not found for this tenant',
        );
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
        throw new RouteProofReconcileBindingError(
          'route_proof_conflict',
          'Route Proof event history is not a valid hash chain',
        );
      }
      if (new Set(proof.transactionHashes).size !== proof.transactionHashes.length) {
        throw new RouteProofReconcileBindingError(
          'route_proof_conflict',
          'Route Proof transaction hashes are not unique',
        );
      }

      // --- Idempotent no-op for an already-finalized proof ----------------
      // `manual_review` is sticky for conflicts and unknown assets. The only
      // narrow retry is a legacy Base native-ETH proof: older code lacked the
      // canonical WETH9 event reconstruction now available below. A conflict
      // can therefore never be "washed" clean by a flapping RPC.
      if (
        (ROUTE_PROOF_TERMINAL_FINAL_STATUSES as readonly string[]).includes(proof.finalStatus) ||
        (proof.reconciliationState === 'manual_review' && !nativeReconstructionRetryEligibleV1(proof, events))
      ) {
        return RouteProofReconciliationResultV1Schema.parse({
          outcome: 'already_finalized',
          proof: toRouteProofProjectionV1(proof, { blueprintId: blueprint.id }),
          lifecycle: deriveLifecycleAfterReconcileV1(proof, events),
        });
      }

      // --- No onchain hashes yet: a batchId alone is never proof ----------
      if (proof.transactionHashes.length === 0) {
        return RouteProofReconciliationResultV1Schema.parse({
          outcome: 'pending',
          proof: toRouteProofProjectionV1(proof, { blueprintId: blueprint.id }),
          lifecycle: deriveLifecycleAfterReconcileV1(proof, events),
        });
      }

      // --- Verify every hash against the injected chain reader ------------
      const verifications = await verifyTransactionReceiptsV1({
        transactionHashes: proof.transactionHashes,
        existingReceipts: proof.receipts,
        reader: receiptReader,
      });

      // A conflicting fresh read must NOT overwrite the previously VERIFIED
      // receipt in the projection — the original verified fact is preserved
      // and the dispute is surfaced via manual_review + the event payload.
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
        // Fail closed: a previously verified receipt disagrees with a fresh
        // read. Never silently overwrite — surface for manual review.
        nextFinalStatus = 'reconciliation_required';
        nextReconciliationState = 'manual_review';
        actualResult = null;
        deviation = { outputBps: null, gasCostUsd: null, withinTolerance: null };
      } else if (hasUnavailable) {
        // At least one receipt is not yet observable onchain — stay pending.
        // Whatever DID verify this round is still persisted below (honest,
        // incremental progress), but the proof is never finalized on partial
        // information.
      } else {
        const successes = verifications.filter((verification) => verification.receipt.status === 'success');
        const allSuccess = successes.length === verifications.length;
        const allReverted = successes.length === 0;

        if (allReverted) {
          nextFinalStatus = 'failed';
          nextReconciliationState = 'failed';
          actualResult = null;
          deviation = { outputBps: null, gasCostUsd: null, withinTolerance: null };
        } else {
          const successLogs = successes.flatMap((verification) => verification.source?.logs ?? []);
          const reconstruction = reconstructAssetChangesV1({
            walletAddress,
            expectedAssetChanges: proof.expectedResult.assetChanges,
            successReceiptLogs: successLogs,
            approvedCallTargets: proof.approvedCalls.map((call) => call.to),
          });
          if (reconstruction.kind === 'unsupported') {
            nextFinalStatus = 'reconciliation_required';
            nextReconciliationState = 'manual_review';
            actualResult = null;
            deviation = { outputBps: null, gasCostUsd: null, withinTolerance: null };
          } else {
            actualResult = reconstruction.actualResult;
            const outputChange = proof.expectedResult.assetChanges.find((change) => change.direction === 'credit') ?? null;
            const { outputBps, minimumSatisfied } = computeRouteProofDeviationV1({
              expectedOutputAtomic: proof.expectedResult.outputAmountAtomic,
              actualOutputAtomic: reconstruction.actualResult.outputAmountAtomic,
              minimumOutputAtomic: outputChange?.minimumAmountAtomic ?? null,
            });
            deviation = { outputBps, gasCostUsd: null, withinTolerance: minimumSatisfied };
            if (allSuccess) {
              nextFinalStatus = 'completed';
              nextReconciliationState = minimumSatisfied === false ? 'deviated' : 'matched';
            } else {
              nextFinalStatus = 'partial_failure';
              nextReconciliationState = 'partial';
            }
          }
        }
      }

      // actualGas is persisted only when THIS pass finalizes the proof — a
      // partial sum over the receipts that happened to verify while others
      // are still unavailable would be a lie in the projection.
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
            // On a receipt conflict, BOTH disputed values are recorded per
            // transaction hash so the manual-review trail carries the exact
            // disagreement (verified-then vs chain-now), not just the state
            // flip.
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

      // T67C.1: the proof is written and its events are appended. ONLY now,
      // and only when THIS pass moved it into a terminal state, is the outcome
      // projected — so a repeated reconcile of an already-final proof (which
      // returns early far above) never re-derives, and a proof that is still
      // pending never contributes a statistic about a trade nobody has seen
      // finish.
      //
      // Wrapped even though the projector already returns its failures: this
      // call must not be able to fail a reconcile response under ANY
      // implementation of the port, including a future one that throws.
      if (
        outcomeProjector &&
        finalStatusChanged &&
        (nextFinalStatus === 'completed' ||
          nextFinalStatus === 'partial_failure' ||
          nextFinalStatus === 'failed')
      ) {
        try {
          await outcomeProjector.projectFinalizedProof({
            proof: updatedProof,
            events: currentEvents,
            routeRunId,
            now,
          });
        } catch {
          // Deliberately swallowed. The proof stays terminal and stored.
        }
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
