import {
  RouteProofV1Schema,
  TransactionReceiptV1Schema,
  ZERO_HASH_V1,
  hashRouteProofV1,
  type HashV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from '@mioagent/route-domain';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import { TransactionComposerBindingError } from './coordinator.js';
import { appendProofEventIfNewV1, routeProofIdV1 } from './approval.js';
import { deriveBlueprintLifecycleV1, type LifecycleStateV1 } from './lifecycle.js';

// ---------------------------------------------------------------------------
// T57: idempotent server-side record of a CLIENT-side Base Account batch
// submission. The server never signs, broadcasts, or resends anything;
// this module only persists honest facts the wallet reported (batch id,
// transaction hashes, raw receipts, refusal) onto the pending RouteProofV1 and
// its hash-chained event history. Final receipt reconciliation and proof
// completion belong to T58 — finalStatus here never becomes `completed`.
// ---------------------------------------------------------------------------

export type BlueprintSubmissionStatusV1 =
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'cancelled'
  | 'submitted_unknown';

export interface RecordBlueprintSubmissionInput {
  tenantId: string;
  walletAddress: `0x${string}`;
  routeRunId: string;
  blueprintId: string;
  approvedCallsHash: HashV1;
  status: BlueprintSubmissionStatusV1;
  batchId?: string;
  transactionHashes?: string[];
  receipts?: unknown[];
  error?: string;
  now: Date;
}

export interface BlueprintSubmissionRecordedV1 {
  outcome: 'recorded';
  lifecycle: LifecycleStateV1;
  proofId: string;
  finalStatus: RouteProofV1['finalStatus'];
}

/** Mapped by the API route to HTTP 409 blueprint_submission_conflict. */
export class BlueprintSubmissionConflictError extends Error {
  readonly code = 'blueprint_submission_conflict';
}

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function normalizedHashes(values: readonly string[] | undefined): HashV1[] {
  const out: HashV1[] = [];
  for (const value of values ?? []) {
    if (!HASH_PATTERN.test(value)) continue;
    const lower = value.toLowerCase() as HashV1;
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

const FINAL_STATUS_BY_SUBMISSION: Record<BlueprintSubmissionStatusV1, RouteProofV1['finalStatus']> = {
  submitted: 'pending',
  confirmed: 'pending',
  submitted_unknown: 'pending',
  failed: 'failed',
  cancelled: 'cancelled',
};

function recordedBatchIds(events: readonly RouteProofEventV1[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.eventType !== 'submitted') continue;
    const batchId = event.payload.batchId;
    if (typeof batchId === 'string' && batchId.length > 0 && !out.includes(batchId)) out.push(batchId);
  }
  return out;
}

export async function recordBlueprintSubmissionV1(
  deps: { repository: RouteStorageRepository },
  input: RecordBlueprintSubmissionInput,
): Promise<BlueprintSubmissionRecordedV1> {
  const { repository } = deps;

  // --- Binding validation (fail closed, mirrors approve) --------------------
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
  if (blueprint.status !== 'approved') {
    throw new TransactionComposerBindingError(
      'blueprint_not_approved',
      'Submissions can only be recorded against an approved Blueprint',
    );
  }
  if (blueprint.approvedCallsHash !== input.approvedCallsHash) {
    throw new TransactionComposerBindingError(
      'approved_calls_hash_mismatch',
      'approvedCallsHash does not match the approved Blueprint',
    );
  }
  // A NEW submission of an expired quote must never start; terminal records
  // (confirmed/failed/cancelled/submitted_unknown) describe a batch that was
  // already sent and are honest facts we accept regardless of expiry.
  if (input.status === 'submitted' && Date.parse(blueprint.quoteExpiry) <= input.now.getTime()) {
    throw new TransactionComposerBindingError(
      'blueprint_expired',
      'Blueprint quote has expired; a new submission cannot be recorded',
    );
  }

  const proofId = routeProofIdV1(blueprint.id);
  const proof = await repository.getProofProjection(proofId, input.tenantId);
  if (!proof) {
    throw new TransactionComposerBindingError(
      'route_proof_missing',
      'No pending Route Proof projection exists for this Blueprint',
    );
  }
  const events = await repository.listProofEvents(proofId, input.tenantId);

  // --- Conflict rules --------------------------------------------------------
  const currentTerminal = proof.finalStatus === 'cancelled' || proof.finalStatus === 'failed';
  // Only a REAL success receipt counts as "already confirmed" — a placeholder
  // `unknown` receipt (a hash observed without a parseable receipt) must never
  // block an honest cancelled/failed correction.
  const confirmedAlready = proof.receipts.some((receipt) => receipt.status === 'success');
  const knownBatchIds = recordedBatchIds(events);
  const batchId = input.batchId && input.batchId.trim().length > 0 ? input.batchId.trim() : null;

  if (batchId && knownBatchIds.length > 0 && !knownBatchIds.includes(batchId) && !currentTerminal) {
    throw new BlueprintSubmissionConflictError(
      'A different batch is already recorded for this Blueprint and is not failed or cancelled',
    );
  }
  if (input.status === 'confirmed' && currentTerminal && (!batchId || knownBatchIds.includes(batchId))) {
    throw new BlueprintSubmissionConflictError(
      'A confirmed result contradicts the recorded cancelled/failed submission',
    );
  }
  if ((input.status === 'cancelled' || input.status === 'failed') && confirmedAlready) {
    throw new BlueprintSubmissionConflictError(
      'A cancelled/failed result contradicts the recorded confirmed submission',
    );
  }

  // --- Honest fact extraction -------------------------------------------------
  // A proof's onchain facts (transactionHashes / receipts) may ONLY be mutated
  // by a batch-bound record, because that mutation is always paired with a
  // `receipt_observed` (and, on first sight, `submitted`) event. Without a
  // batch id there is no event to anchor the change, so a batch-less terminal
  // (failed/cancelled) updates finalStatus only and never smuggles fabricated
  // hashes/receipts into the projection.
  const parsedReceipts = batchId
    ? (input.receipts ?? []).flatMap((raw) => {
        const parsed = TransactionReceiptV1Schema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const newHashes = batchId
    ? normalizedHashes([
        ...(input.transactionHashes ?? []),
        ...parsedReceipts.map((receipt) => receipt.transactionHash),
      ])
    : [];

  let mergedReceipts = proof.receipts;
  let mergedHashes = proof.transactionHashes;
  if (batchId) {
    mergedReceipts = [...proof.receipts];
    for (const receipt of parsedReceipts) {
      if (!mergedReceipts.some((existing) => existing.transactionHash === receipt.transactionHash)) {
        mergedReceipts.push(receipt);
      }
    }
    mergedHashes = normalizedHashes([...proof.transactionHashes, ...newHashes]);
    // RouteProofV1 requires every transaction hash to carry a receipt; a hash
    // observed without a parseable receipt gets an honest `unknown` placeholder
    // (never a fabricated success) until T58 reconciles the real receipt.
    for (const hash of mergedHashes) {
      if (!mergedReceipts.some((existing) => existing.transactionHash === hash)) {
        mergedReceipts.push({ transactionHash: hash, status: 'unknown', blockNumber: null, gasUsed: null });
      }
    }
  }

  const finalStatus = FINAL_STATUS_BY_SUBMISSION[input.status];
  const draft: RouteProofV1 = {
    ...proof,
    status: finalStatus,
    finalStatus,
    transactionHashes: mergedHashes,
    receipts: mergedReceipts,
    updatedAt: input.now.toISOString(),
    proofHash: ZERO_HASH_V1,
  };
  const updatedProof = RouteProofV1Schema.parse({ ...draft, proofHash: hashRouteProofV1(draft) });
  await repository.upsertProofProjection(input.routeRunId, updatedProof);

  // --- Hash-chained events (check-before-append, byte-identical retries) ------
  let currentEvents = events;
  if (batchId && !knownBatchIds.includes(batchId)) {
    currentEvents = await appendProofEventIfNewV1(
      repository,
      updatedProof,
      currentEvents,
      'submitted',
      { batchId, status: input.status },
      input.now,
    );
  }
  if (batchId && (newHashes.length > 0 || (input.receipts ?? []).length > 0)) {
    currentEvents = await appendProofEventIfNewV1(
      repository,
      updatedProof,
      currentEvents,
      'receipt_observed',
      { batchId, transactionHashes: newHashes, receiptsRaw: input.receipts ?? [] },
      input.now,
    );
  }

  const lifecycle = deriveBlueprintLifecycleV1({ blueprint, proof: updatedProof, events: currentEvents });
  return { outcome: 'recorded', lifecycle, proofId, finalStatus: updatedProof.finalStatus };
}
