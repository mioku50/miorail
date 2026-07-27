import {
  SubmissionAttemptV1Schema,
  isRecoverableAttemptStatusV1,
  type SubmissionAttemptStatusV1,
  type SubmissionAttemptV1,
  type SubmissionGoalV1,
} from '@mioagent/route-domain';

import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// T67C.2 — submission attempts, shared by swap, earn and NFT.
//
// ONE implementation for all three families. The wallet path was deliberately
// unified in T57 (a single `wallet_sendCalls`), and recovery has to stay that
// way: a second attempt store per family would mean three places where "did we
// already send this?" could be answered differently.
//
// As with B20, every decision a repository makes lives in this file so the
// in-memory fake cannot be kinder than Postgres. Three T65 production bugs came
// from a fake that accepted what the database refused.
//
// Nothing here writes a receipt or a transaction hash. Those belong to the
// proof, and an attempt that could carry them would sooner or later be read as
// evidence of an execution it never witnessed.
// ---------------------------------------------------------------------------

export interface CreateSubmissionAttemptInputV1 {
  tenantId: string;
  walletAddress: string;
  goal: SubmissionGoalV1;
  routeRunId: string;
  blueprintId: string;
  approvedCallsHash: string;
  proofId: string | null;
  now: Date;
}

export interface BindSubmissionBatchInputV1 {
  attemptId: string;
  tenantId: string;
  batchId: string;
  now: Date;
}

export interface UpdateSubmissionAttemptInputV1 {
  attemptId: string;
  tenantId: string;
  status: SubmissionAttemptStatusV1;
  proofId?: string | null;
  errorCode?: string | null;
  batchId?: string | null;
  now: Date;
}

export interface SubmissionAttemptRepositoryV1 {
  /** Idempotent per tenant + blueprint while an attempt is still open. */
  createAttempt(input: CreateSubmissionAttemptInputV1): Promise<SubmissionAttemptV1>;
  getAttempt(id: string, tenantId: string): Promise<SubmissionAttemptV1 | null>;
  findOpenAttemptByBlueprint(tenantId: string, blueprintId: string): Promise<SubmissionAttemptV1 | null>;
  findAttemptByBatch(batchId: string): Promise<SubmissionAttemptV1 | null>;
  /** Null when the attempt does not exist for this tenant — the route answers
   * an indistinguishable 404 rather than confirming somebody else's row. */
  bindBatch(input: BindSubmissionBatchInputV1): Promise<SubmissionAttemptV1 | null>;
  updateAttempt(input: UpdateSubmissionAttemptInputV1): Promise<SubmissionAttemptV1 | null>;
  /** Open attempts for one wallet, newest first. Tenant-scoped in the QUERY. */
  listRecoverable(tenantId: string, walletAddress: string): Promise<SubmissionAttemptV1[]>;
}

export type SubmissionAttemptEffectV1 =
  | { effect: 'insert' }
  | { effect: 'return_existing' }
  | { effect: 'conflict'; reason: string };

/**
 * What a create must do when an open attempt already exists for this blueprint.
 *
 * Identical binding is a repeat of the same request — a double-click, a retried
 * fetch, a remounted component — and returns the attempt that already exists.
 * A DIFFERENT binding is not a repeat: the approved calls or the run changed,
 * which means the open attempt is about a different transaction, and quietly
 * reusing it would attach a batch to the wrong route.
 */
export function submissionAttemptCreateEffectV1(
  existing: SubmissionAttemptV1 | null,
  incoming: CreateSubmissionAttemptInputV1,
): SubmissionAttemptEffectV1 {
  if (!existing) return { effect: 'insert' };
  if (!isRecoverableAttemptStatusV1(existing.status)) return { effect: 'insert' };
  const sameBinding =
    existing.routeRunId === incoming.routeRunId &&
    existing.blueprintId === incoming.blueprintId &&
    existing.approvedCallsHash === incoming.approvedCallsHash &&
    existing.goal === incoming.goal &&
    existing.walletAddress.toLowerCase() === incoming.walletAddress.toLowerCase();
  if (sameBinding) return { effect: 'return_existing' };
  return {
    effect: 'conflict',
    reason: 'An open submission attempt for this blueprint is bound to different approved calls',
  };
}

/**
 * What binding a batch id must do.
 *
 * The same batch twice is idempotent — the client may well retry the bind after
 * a dropped response, and refusing it would lose the handle it is trying to
 * save. A DIFFERENT batch is a conflict and never an overwrite: two batches
 * against one approved blueprint means one of them is a duplicate spend, and
 * discovering which is not something to do by silently replacing a field.
 */
export function submissionAttemptBatchEffectV1(
  existing: SubmissionAttemptV1,
  batchId: string,
): SubmissionAttemptEffectV1 {
  if (existing.batchId === null) return { effect: 'insert' };
  if (existing.batchId === batchId) return { effect: 'return_existing' };
  return {
    effect: 'conflict',
    reason: 'This attempt is already bound to a different wallet batch',
  };
}

/** Terminal attempts stop being worked on. Recording a new outcome against one
 * would rewrite history the user has already been shown. */
export function submissionAttemptIsOpenV1(attempt: SubmissionAttemptV1): boolean {
  return isRecoverableAttemptStatusV1(attempt.status);
}

/** The status an attempt takes from what the submission route recorded. The
 * two vocabularies are deliberately separate — a proof records what happened,
 * an attempt records what still needs doing — so the mapping is written once
 * here rather than inferred at each call site. */
export const ATTEMPT_STATUS_BY_SUBMISSION_V1: Record<string, SubmissionAttemptStatusV1> = {
  submitted: 'submitted',
  submitted_unknown: 'submitted_unknown',
  confirmed: 'confirmed',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function attemptStatusFromSubmissionV1(status: string): SubmissionAttemptStatusV1 | null {
  return ATTEMPT_STATUS_BY_SUBMISSION_V1[status] ?? null;
}

/** Validated on the way in AND on the way out: a row that stopped satisfying
 * its own schema is refused rather than acted on. */
export function assertSubmissionAttemptV1(value: unknown, where: 'write' | 'read'): SubmissionAttemptV1 {
  const parsed = SubmissionAttemptV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new RouteStorageIntegrityError(`Submission attempt failed validation on ${where}`);
  }
  return parsed.data;
}

export function submissionAttemptConflictV1(reason: string): RouteStorageConflictError {
  return new RouteStorageConflictError(reason);
}

/** Builds the row a create produces. `completedAt` is null because a brand new
 * attempt is by definition not finished. */
export function newSubmissionAttemptV1(
  id: string,
  input: CreateSubmissionAttemptInputV1,
): SubmissionAttemptV1 {
  const timestamp = input.now.toISOString();
  return assertSubmissionAttemptV1(
    {
      schemaVersion: 'submission-attempt/v1',
      id,
      tenantId: input.tenantId,
      walletAddress: input.walletAddress.toLowerCase(),
      chainId: 8453,
      goal: input.goal,
      routeRunId: input.routeRunId,
      blueprintId: input.blueprintId,
      proofId: input.proofId,
      approvedCallsHash: input.approvedCallsHash.toLowerCase(),
      batchId: null,
      status: 'wallet_pending',
      errorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    },
    'write',
  );
}

/** Applies an update to an attempt, keeping `completedAt` truthful: it is set
 * exactly when the attempt reaches a terminal status, and never cleared. */
export function applySubmissionAttemptUpdateV1(
  existing: SubmissionAttemptV1,
  input: UpdateSubmissionAttemptInputV1,
): SubmissionAttemptV1 {
  const timestamp = input.now.toISOString();
  const terminal = !isRecoverableAttemptStatusV1(input.status);
  return assertSubmissionAttemptV1(
    {
      ...existing,
      status: input.status,
      proofId: input.proofId === undefined ? existing.proofId : input.proofId,
      errorCode: input.errorCode === undefined ? existing.errorCode : input.errorCode,
      batchId: input.batchId === undefined ? existing.batchId : input.batchId,
      updatedAt: timestamp,
      completedAt: terminal ? (existing.completedAt ?? timestamp) : existing.completedAt,
    },
    'write',
  );
}
