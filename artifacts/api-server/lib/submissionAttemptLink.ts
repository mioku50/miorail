import {
  attemptStatusFromSubmissionV1,
  type SubmissionAttemptRepositoryV1,
} from '@mioagent/route-storage';
import type { SubmissionAttemptV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T67C.2 — linking a submission record to its recovery attempt.
//
// Written once and used by all three submission routes. A per-family copy of
// this would be three places for the binding rules to diverge, and the binding
// rules are the only thing standing between a forged attempt id and somebody
// else's proof.
//
// The order of operations matters and is deliberate:
//
//   1. VERIFY the attempt before recording anything. An id that is not this
//      tenant's, or that names a different blueprint or different approved
//      calls, refuses the whole request — it must not be possible to ride along
//      on a legitimate submission.
//   2. RECORD the submission. That is the financial truth and it goes first.
//   3. UPDATE the attempt. If this step fails the proof is still correct and
//      the attempt simply stays open, so the user is offered a recovery card
//      for something already recorded. Resuming is idempotent, so the worst
//      outcome is one redundant check — the opposite ordering could close an
//      attempt for a submission that never landed.
// ---------------------------------------------------------------------------

export type AttemptLinkVerdictV1 =
  | { ok: true; attempt: SubmissionAttemptV1 | null }
  | { ok: false; code: 'submission_attempt_not_found' | 'submission_attempt_mismatch' };

/**
 * Re-checks that an attempt id may be used with this submission.
 *
 * An absent id is fine and returns `{ ok: true, attempt: null }` — recovery is
 * optional and every pre-T67C.2 client omits it. A present id must belong to
 * this tenant and describe exactly this blueprint and these approved calls.
 */
export async function verifySubmissionAttemptV1(
  repository: SubmissionAttemptRepositoryV1,
  input: {
    attemptId: string | undefined;
    tenantId: string;
    blueprintId: string;
    approvedCallsHash: string;
  },
): Promise<AttemptLinkVerdictV1> {
  if (!input.attemptId) return { ok: true, attempt: null };
  const attempt = await repository.getAttempt(input.attemptId, input.tenantId);
  // Another tenant's attempt is not found rather than found and refused, so a
  // caller cannot learn which attempt ids exist.
  if (!attempt) return { ok: false, code: 'submission_attempt_not_found' };
  if (
    attempt.blueprintId !== input.blueprintId ||
    attempt.approvedCallsHash !== input.approvedCallsHash.toLowerCase()
  ) {
    return { ok: false, code: 'submission_attempt_mismatch' };
  }
  return { ok: true, attempt };
}

/**
 * Records the outcome onto the attempt after the submission has been stored.
 *
 * Never throws into the caller's response path: a failure here leaves an open
 * attempt, which is recoverable, whereas a 500 after a successful record would
 * tell the user their submission failed when it did not.
 */
export async function recordAttemptOutcomeV1(
  repository: SubmissionAttemptRepositoryV1,
  input: {
    attempt: SubmissionAttemptV1 | null;
    tenantId: string;
    submissionStatus: string;
    proofId: string | null;
    batchId: string | null;
    errorCode: string | null;
    now: Date;
  },
): Promise<void> {
  if (!input.attempt) return;
  const status = attemptStatusFromSubmissionV1(input.submissionStatus);
  if (!status) return;
  try {
    await repository.updateAttempt({
      attemptId: input.attempt.id,
      tenantId: input.tenantId,
      status,
      proofId: input.proofId ?? input.attempt.proofId,
      errorCode: input.errorCode,
      // A batch id already on the attempt is never replaced here; binding is
      // the batch route's job and its conflict rules are stricter.
      batchId: input.attempt.batchId ?? input.batchId,
      now: input.now,
    });
  } catch {
    // Swallowed on purpose — see the header. The attempt stays open.
  }
}
