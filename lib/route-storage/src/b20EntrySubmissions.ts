import { z } from 'zod';
import { RouteStorageConflictError } from './types.js';

// ---------------------------------------------------------------------------
// T68F-B — the submission attempt for a prepared B20 entry.
//
// A DEDICATED table rather than `submission_attempts`. That table requires a
// `route_run_id` and a `blueprint_id` (both NOT NULL, both foreign keys) and
// pins `goal IN ('swap','earn','nft')`. This family has neither a route run nor
// an execution blueprint, because a B20 token cannot form a `RouteIntentV1`.
// Reusing it would have meant nullable foreign keys and a widened goal check on
// a table three other families depend on for recovery — the exact weakening
// T68F-A avoided.
//
// WHAT THIS ROW IS FOR:
//
//   * Answering "did we already send this?" exactly once. A double click, a
//     remount, a retried fetch and a refresh must all reach the SAME attempt.
//     An unknown response after `wallet_sendCalls` is never permission to send
//     again — a batch may be in flight that nobody can see yet.
//
//   * Carrying the terminal OUTCOME, which is not the same thing as the
//     lifecycle. `entry_reverted` and `user_rejected` are both "not succeeded"
//     and mean entirely different things to a user; a generic `failed` would
//     lose the difference and, worse, would let a rejected wallet prompt read
//     as a token that reverts.
//
// WHERE THE LIFECYCLE LIVES: the PLAN records how far the wallet got
// (prepared → awaiting_wallet_approval → submitted); the ATTEMPT records what
// happened. Terminal outcomes are properties of an execution, not of a plan,
// and keeping them here is what lets the plan stay immutable evidence.
// ---------------------------------------------------------------------------

const HASH_V1 = /^0x[0-9a-f]{64}$/;
const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const UINT_V1 = /^(0|[1-9][0-9]*)$/;

export const B20_ENTRY_ATTEMPT_STATUS_V1 = [
  'awaiting_wallet_approval',
  'submitted',
  'reconciling',
  'terminal',
] as const;
export type B20EntryAttemptStatusV1 = (typeof B20_ENTRY_ATTEMPT_STATUS_V1)[number];

/**
 * How an attempt ended. Deliberately six, never one generic `failed`.
 *
 *   entry_succeeded              the wallet spent USDC and received the token
 *   entry_reverted               the batch executed and reverted on chain
 *   submitted_unknown            a batch id exists; its result is unresolved
 *   reconciliation_required      it confirmed, but the assets do not match
 *   user_rejected                the wallet prompt was declined — nothing sent
 *   cancelled_before_submission  the user backed out before the wallet opened
 */
export const B20_ENTRY_TERMINAL_OUTCOME_V1 = [
  'entry_succeeded',
  'entry_reverted',
  'submitted_unknown',
  'reconciliation_required',
  'user_rejected',
  'cancelled_before_submission',
] as const;
export type B20EntryTerminalOutcomeV1 = (typeof B20_ENTRY_TERMINAL_OUTCOME_V1)[number];

/** Outcomes that can only be reached after a wallet returned a batch id. A row
 * claiming one of these without a batch would be asserting something about a
 * transaction nobody can point at. */
export const B20_ENTRY_POST_SUBMISSION_OUTCOMES_V1: readonly B20EntryTerminalOutcomeV1[] = [
  'entry_succeeded',
  'entry_reverted',
  'submitted_unknown',
  'reconciliation_required',
];

/** Outcomes reached without ever sending anything. */
export const B20_ENTRY_PRE_SUBMISSION_OUTCOMES_V1: readonly B20EntryTerminalOutcomeV1[] = [
  'user_rejected',
  'cancelled_before_submission',
];

/** What actually happened on chain, once a confirmed batch has been checked
 * against the plan. Hashes and amounts — never a provider body. */
export const B20EntryReconciliationV1Schema = z
  .object({
    spentAtomic: z.string().regex(UINT_V1),
    receivedAtomic: z.string().regex(UINT_V1),
    confirmedBlockNumber: z.string().regex(UINT_V1).nullable(),
    transactionHashes: z.array(z.string().regex(HASH_V1)).max(16),
    evidenceHash: z.string().regex(HASH_V1),
  })
  .strict();
export type B20EntryReconciliationV1 = z.infer<typeof B20EntryReconciliationV1Schema>;

export const B20EntrySubmissionAttemptV1Schema = z
  .object({
    schemaVersion: z.literal('b20-entry-submission/v1'),
    id: z.string().min(1).max(200),
    tenantId: z.string().min(1).max(200),
    walletAddress: z.string().regex(ADDRESS_V1),
    chainId: z.literal(8453),
    planId: z.string().min(1).max(200),
    clearanceId: z.string().min(1).max(200),
    /** The hash of the calls that were handed to the wallet. It must equal the
     * plan's own `callsHash`, which is what makes "the wallet signed what was
     * simulated" a checkable claim rather than a hope. */
    submittedCallsHash: z.string().regex(HASH_V1),
    /** The wallet's `wallet_sendCalls` id. Null until the wallet returns one;
     * its ABSENCE is the honest unrecoverable state, because without it there
     * is nothing to ask a status provider about. */
    batchId: z.string().min(1).max(200).nullable(),
    status: z.enum(B20_ENTRY_ATTEMPT_STATUS_V1),
    terminalOutcome: z.enum(B20_ENTRY_TERMINAL_OUTCOME_V1).nullable(),
    /** A short, non-sensitive code. Never a provider message: those carry
     * endpoints, and endpoints carry keys. */
    errorCode: z.string().min(1).max(80).nullable(),
    submittedAt: z.string().min(1).max(60).nullable(),
    reconciliation: B20EntryReconciliationV1Schema.nullable(),
    createdAt: z.string().min(1).max(60),
    updatedAt: z.string().min(1).max(60),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    if ((value.status === 'terminal') !== (value.terminalOutcome !== null)) {
      fail('terminalOutcome', 'A terminal outcome exists exactly when the attempt is terminal');
    }
    // A state that presupposes a wallet batch cannot exist without its id.
    if ((value.status === 'submitted' || value.status === 'reconciling') && !value.batchId) {
      fail('batchId', `A ${value.status} attempt must name the wallet batch it is waiting on`);
    }
    if (value.batchId && !value.submittedAt) {
      fail('submittedAt', 'A batch id without a submission time is not a record of anything');
    }
    if (value.terminalOutcome) {
      const post = B20_ENTRY_POST_SUBMISSION_OUTCOMES_V1.includes(value.terminalOutcome);
      if (post && !value.batchId) {
        fail('batchId', `${value.terminalOutcome} is a claim about a batch, and there is no batch id`);
      }
      // The reverse matters more: an attempt that DID reach the chain must not
      // be recorded as though the user simply declined.
      if (!post && value.batchId) {
        fail('terminalOutcome', `${value.terminalOutcome} cannot describe an attempt that was sent`);
      }
    }
    // Only a checked, confirmed entry carries asset evidence.
    if (value.reconciliation && value.terminalOutcome !== 'entry_succeeded') {
      fail('reconciliation', 'Asset evidence belongs only to a successful entry');
    }
    if (value.terminalOutcome === 'entry_succeeded' && !value.reconciliation) {
      fail('reconciliation', 'A successful entry must record what the wallet actually received');
    }
  });
export type B20EntrySubmissionAttemptV1 = z.infer<typeof B20EntrySubmissionAttemptV1Schema>;

/** An attempt that is still expected to change. A plan with one of these open
 * must never hand out a second wallet action. */
export function attemptIsOpenV1(attempt: B20EntrySubmissionAttemptV1): boolean {
  return attempt.status !== 'terminal';
}

/** Whether a NEW attempt may be created for a plan that already has this one.
 * A declined prompt sent nothing, so the user may go back to Review and try
 * again. Anything that reached the chain — or might have — may not. */
export function attemptBlocksRetryV1(attempt: B20EntrySubmissionAttemptV1): boolean {
  if (attempt.status !== 'terminal') return true;
  return !B20_ENTRY_PRE_SUBMISSION_OUTCOMES_V1.includes(attempt.terminalOutcome!);
}

export type AttemptTransitionRefusalV1 = string;

/**
 * Whether an attempt may move to this state.
 *
 * Fail-closed and irreversible: a terminal attempt never moves again, and a
 * submitted one never returns to awaiting approval. The single most important
 * line is the last one — an unknown result may not be re-sent.
 */
export function attemptTransitionRefusalV1(input: {
  from: B20EntrySubmissionAttemptV1;
  to: B20EntryAttemptStatusV1;
  terminalOutcome: B20EntryTerminalOutcomeV1 | null;
  batchId: string | null;
}): AttemptTransitionRefusalV1 | null {
  const allowed: Record<B20EntryAttemptStatusV1, B20EntryAttemptStatusV1[]> = {
    awaiting_wallet_approval: ['submitted', 'terminal'],
    submitted: ['reconciling', 'terminal'],
    reconciling: ['reconciling', 'terminal'],
    terminal: [],
  };
  if (input.from.status === 'terminal') {
    return 'A terminal attempt is final and cannot be reopened';
  }
  if (!allowed[input.from.status].includes(input.to)) {
    return `A ${input.from.status} attempt cannot become ${input.to}`;
  }
  if ((input.to === 'terminal') !== (input.terminalOutcome !== null)) {
    return 'A terminal move needs an outcome, and only a terminal move may carry one';
  }
  if (input.to === 'submitted' && !(input.batchId ?? input.from.batchId)) {
    return 'A submission must name the wallet batch it created';
  }
  // A batch id, once known, identifies the thing on chain. Replacing it would
  // silently repoint the record at a different transaction.
  if (input.batchId && input.from.batchId && input.batchId !== input.from.batchId) {
    return 'This attempt already names a different wallet batch';
  }
  if (
    input.terminalOutcome &&
    B20_ENTRY_PRE_SUBMISSION_OUTCOMES_V1.includes(input.terminalOutcome) &&
    (input.batchId ?? input.from.batchId)
  ) {
    return `${input.terminalOutcome} cannot describe an attempt that already reached the wallet`;
  }
  return null;
}

export interface B20EntrySubmissionRepositoryV1 {
  /** Idempotent per plan while an attempt is open, so a double click reaches
   * one attempt. */
  createAttempt(attempt: B20EntrySubmissionAttemptV1): Promise<B20EntrySubmissionAttemptV1>;
  getAttempt(input: {
    attemptId: string;
    tenantId: string;
    walletAddress: string;
  }): Promise<B20EntrySubmissionAttemptV1 | null>;
  /** The newest attempt for a plan, whatever its state. This is what a refresh
   * reads, so a submitted entry never looks prepared again. */
  latestForPlan(input: {
    planId: string;
    tenantId: string;
  }): Promise<B20EntrySubmissionAttemptV1 | null>;
  findByBatch(batchId: string): Promise<B20EntrySubmissionAttemptV1 | null>;
  /** Applies a transition. Returns null when the attempt is not this tenant's,
   * and throws a conflict when the move itself is refused. */
  updateAttempt(input: {
    attemptId: string;
    tenantId: string;
    status: B20EntryAttemptStatusV1;
    terminalOutcome?: B20EntryTerminalOutcomeV1 | null;
    batchId?: string | null;
    errorCode?: string | null;
    reconciliation?: B20EntryReconciliationV1 | null;
    now: Date;
  }): Promise<B20EntrySubmissionAttemptV1 | null>;
}

export function assertEntryAttemptV1(
  value: unknown,
  where: 'write' | 'read',
): B20EntrySubmissionAttemptV1 {
  const parsed = B20EntrySubmissionAttemptV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new RouteStorageConflictError(
      `B20 entry submission failed validation on ${where}: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

export function entryAttemptConflictV1(reason: string): RouteStorageConflictError {
  return new RouteStorageConflictError(reason);
}

/**
 * The shared create rule.
 *
 * An identical repeat returns the existing attempt; anything else while an
 * attempt is live is refused. Both repositories call this, because a fake that
 * happily created a second attempt would hide the one bug that costs real
 * money: two wallet batches for one plan.
 */
export function attemptCreateEffectV1(input: {
  existing: B20EntrySubmissionAttemptV1 | null;
  next: B20EntrySubmissionAttemptV1;
}): { effect: 'insert' } | { effect: 'return_existing' } | { effect: 'conflict'; reason: string } {
  const existing = input.existing;
  if (!existing) return { effect: 'insert' };
  if (existing.id === input.next.id) return { effect: 'return_existing' };
  if (attemptBlocksRetryV1(existing)) {
    return {
      effect: 'conflict',
      reason:
        existing.status === 'terminal'
          ? 'This plan has already been submitted'
          : 'A submission for this plan is already in progress',
    };
  }
  // The previous attempt was declined or cancelled before anything was sent,
  // so the user may go back to Review and try again.
  return { effect: 'insert' };
}
