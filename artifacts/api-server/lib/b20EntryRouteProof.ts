import type { RouteProofEventV1, RouteProofV1 } from '@mioagent/route-domain';
import {
  appendB20EntryProofEventIfNewV1,
  buildPendingB20EntryRouteProofV1,
  projectB20EntryRouteProofV1,
  type B20EntryRouteProofRepositoryV1,
  type B20EntrySubmissionAttemptV1,
  type B20PreparedEntryPlanV1,
} from '@mioagent/route-storage';

function proofIsStickyV1(proof: RouteProofV1): boolean {
  return (
    ['completed', 'partial_failure', 'failed', 'cancelled'].includes(proof.finalStatus) ||
    proof.reconciliationState === 'manual_review'
  );
}

async function appendLifecycleEventsV1(input: {
  repository: B20EntryRouteProofRepositoryV1;
  proof: RouteProofV1;
  attempt: B20EntrySubmissionAttemptV1;
  existingEvents: readonly RouteProofEventV1[];
  now: Date;
}): Promise<RouteProofEventV1[]> {
  const { repository, proof, attempt, now } = input;
  let events = [...input.existingEvents];
  if (attempt.batchId) {
    events = await appendB20EntryProofEventIfNewV1({
      repository,
      proof,
      existingEvents: events,
      eventType: 'submitted',
      payload: { batchId: attempt.batchId, status: 'submitted' },
      now,
    });
  }
  if (attempt.receipts.length > 0) {
    events = await appendB20EntryProofEventIfNewV1({
      repository,
      proof,
      existingEvents: events,
      eventType: 'receipt_observed',
      payload: { source: 'server_reconciliation', receipts: attempt.receipts },
      now,
    });
  }
  if (proof.finalStatus === 'completed') {
    events = await appendB20EntryProofEventIfNewV1({
      repository,
      proof,
      existingEvents: events,
      eventType: 'completed',
      payload: {
        proofHash: proof.proofHash,
        transactionHashes: proof.transactionHashes,
        reconciliationState: proof.reconciliationState,
      },
      now,
    });
  } else if (proof.finalStatus !== 'pending') {
    events = await appendB20EntryProofEventIfNewV1({
      repository,
      proof,
      existingEvents: events,
      eventType: 'reconciliation_updated',
      payload: {
        finalStatus: proof.finalStatus,
        reconciliationState: proof.reconciliationState,
        errorCode: attempt.errorCode,
      },
      now,
    });
  }
  return events;
}

/** Opens the canonical RouteProofV1 projection before calls leave the server.
 * Retried begin-submission calls recover the same deterministic proof. */
export async function ensureB20EntryRouteProofV1(input: {
  repository: B20EntryRouteProofRepositoryV1;
  plan: B20PreparedEntryPlanV1;
  attempt: B20EntrySubmissionAttemptV1;
  now: Date;
}): Promise<RouteProofV1> {
  const existing = await input.repository.getProofForAttempt({
    attemptId: input.attempt.id,
    tenantId: input.plan.tenantId,
  });
  const stored = existing ?? await input.repository.upsertProof({
    ...input,
    proof: buildPendingB20EntryRouteProofV1(input),
  });
  // Proof insertion and event append are separate durable writes. A retry must
  // repair the narrow case where the proof committed but the first event did
  // not, before executable bytes may leave the server.
  const existingEvents = await input.repository.listEvents(stored.id, stored.tenantId);
  await appendB20EntryProofEventIfNewV1({
    repository: input.repository,
    proof: stored,
    existingEvents,
    eventType: 'calls_approved',
    payload: {
      planId: input.plan.id,
      attemptId: input.attempt.id,
      approvedCallsHash: stored.approvedCallsHash,
    },
    now: input.now,
  });
  return stored;
}

/** Mirrors the durable B20 attempt into RouteProofV1 and appends its hash-chain
 * history. Wallet submission alone stays pending; only the reconciled attempt
 * can complete or fail the proof. */
export async function syncB20EntryRouteProofV1(input: {
  repository: B20EntryRouteProofRepositoryV1;
  plan: B20PreparedEntryPlanV1;
  attempt: B20EntrySubmissionAttemptV1;
  now: Date;
}): Promise<RouteProofV1> {
  let proof = await ensureB20EntryRouteProofV1(input);
  const events = await input.repository.listEvents(proof.id, proof.tenantId);
  if (!proofIsStickyV1(proof)) {
    proof = projectB20EntryRouteProofV1({ ...input, proof });
    proof = await input.repository.upsertProof({ plan: input.plan, attempt: input.attempt, proof });
  }
  await appendLifecycleEventsV1({ ...input, proof, existingEvents: events });
  return proof;
}

export function b20EntryProofSummaryV1(proof: RouteProofV1 | null) {
  return proof
    ? {
        proofId: proof.id,
        proofHash: proof.proofHash,
        finalStatus: proof.finalStatus,
        reconciliationState: proof.reconciliationState,
        approvedCallsHash: proof.approvedCallsHash,
        transactionHashes: proof.transactionHashes,
        updatedAt: proof.updatedAt,
      }
    : null;
}
