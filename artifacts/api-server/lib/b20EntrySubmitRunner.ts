import { randomUUID } from 'node:crypto';
import {
  B20EntrySubmissionAttemptV1Schema,
  entryCanRefreshV1,
  entryCanSubmitV1,
  entryUiStateV1,
  type B20EntryExecutionCapabilitiesV1,
  type B20EntrySubmissionAttemptV1,
  type B20EntrySubmissionRepositoryV1,
  type B20EntryUiStateV1,
  type B20PreparedEntryPlanV1,
} from '@mioagent/route-storage';

import { reconcileEntryV1, type WalletCallStatusV1, type ObservedAssetChangeV1 } from './b20EntryReconcile.js';

// ---------------------------------------------------------------------------
// T68F-B — the submission run.
//
// Three things happen here and nowhere else: an attempt is opened, the wallet's
// own report is recorded, and the result is reconciled. Each is deliberately
// small, because each one is a place where sending twice becomes possible.
// ---------------------------------------------------------------------------

/** The status shape both the wire and the surfaces read. */
export interface EntryStatusViewV1 {
  state: B20EntryUiStateV1;
  terminalOutcome: string | null;
  attemptId: string | null;
  batchId: string | null;
  submittedAt: string | null;
  errorCode: string | null;
  actualSpentAtomic: string | null;
  actualReceivedAtomic: string | null;
  confirmedBlockNumber: string | null;
  transactionHashes: string[];
  reconciliationEvidenceHash: string | null;
  canSubmit: boolean;
  canRefresh: boolean;
}

export function entryStatusViewV1(input: {
  plan: B20PreparedEntryPlanV1;
  attempt: B20EntrySubmissionAttemptV1 | null;
  capabilities: B20EntryExecutionCapabilitiesV1;
  now: Date;
}): EntryStatusViewV1 {
  const state = entryUiStateV1({ plan: input.plan, attempt: input.attempt, now: input.now });
  const reconciliation = input.attempt?.reconciliation ?? null;
  return {
    state,
    terminalOutcome: input.attempt?.terminalOutcome ?? null,
    attemptId: input.attempt?.id ?? null,
    batchId: input.attempt?.batchId ?? null,
    submittedAt: input.attempt?.submittedAt ?? null,
    errorCode: input.attempt?.errorCode ?? null,
    actualSpentAtomic: reconciliation?.spentAtomic ?? null,
    actualReceivedAtomic: reconciliation?.receivedAtomic ?? null,
    confirmedBlockNumber: reconciliation?.confirmedBlockNumber ?? null,
    transactionHashes: reconciliation?.transactionHashes ?? [],
    reconciliationEvidenceHash: reconciliation?.evidenceHash ?? null,
    // A surface never re-derives these. Two implementations of "may I show a
    // submit button?" drift, and they drift towards showing one twice.
    canSubmit: entryCanSubmitV1(state) && input.plan.lifecycle === 'prepared',
    canRefresh: entryCanRefreshV1(state),
  };
}

/** Opens the attempt that will hold this plan's submission slot. */
export async function openAttemptV1(input: {
  submissions: B20EntrySubmissionRepositoryV1;
  plan: B20PreparedEntryPlanV1;
  attemptRequestId: string;
  now: Date;
  newId?: () => string;
}): Promise<B20EntrySubmissionAttemptV1> {
  const attempt = B20EntrySubmissionAttemptV1Schema.parse({
    schemaVersion: 'b20-entry-submission/v1',
    // Deterministic in the caller's hands: the same request id must reach the
    // same attempt, which is what stops a double click opening two.
    id: (input.newId ?? randomUUID)(),
    tenantId: input.plan.tenantId,
    walletAddress: input.plan.walletAddress,
    chainId: 8453,
    planId: input.plan.id,
    clearanceId: input.plan.clearanceId,
    // The hash of what the wallet is about to be handed. It equals the plan's
    // own calls hash, which is what makes "the wallet signed what was
    // simulated" checkable later.
    submittedCallsHash: input.plan.callsHash,
    batchId: null,
    status: 'awaiting_wallet_approval',
    terminalOutcome: null,
    errorCode: null,
    submittedAt: null,
    reconciliation: null,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
  });
  return input.submissions.createAttempt(attempt);
}

export type WalletReportV1 = 'submitted' | 'user_rejected' | 'wallet_failed' | 'cancelled';

/**
 * Records what the WALLET did.
 *
 * The client reports the wallet's behaviour, never a result: a browser cannot
 * tell us that a transaction succeeded. The only thing it can contribute that
 * this server did not already know is the batch id the wallet handed back.
 */
export async function recordWalletReportV1(input: {
  submissions: B20EntrySubmissionRepositoryV1;
  attempt: B20EntrySubmissionAttemptV1;
  report: WalletReportV1;
  batchId: string | null;
  now: Date;
}): Promise<B20EntrySubmissionAttemptV1 | null> {
  const { attempt } = input;

  // Already reported. A repeat is a retried fetch or a remount, and it returns
  // what is stored rather than transitioning again.
  if (input.report === 'submitted' && attempt.batchId) {
    if (input.batchId && input.batchId !== attempt.batchId) return null;
    return attempt;
  }
  if (attempt.status === 'terminal') return attempt;

  if (input.report === 'submitted') {
    if (!input.batchId) return null;
    return input.submissions.updateAttempt({
      attemptId: attempt.id,
      tenantId: attempt.tenantId,
      status: 'submitted',
      batchId: input.batchId,
      now: input.now,
    });
  }

  // A wallet that failed to open, or a user who declined, sent NOTHING. That is
  // a fundamentally different fact from a transaction that reverted, and it
  // gets its own outcome so no surface can render it as one.
  const outcome =
    input.report === 'cancelled' ? 'cancelled_before_submission' : 'user_rejected';
  return input.submissions.updateAttempt({
    attemptId: attempt.id,
    tenantId: attempt.tenantId,
    status: 'terminal',
    terminalOutcome: outcome,
    errorCode: input.report === 'wallet_failed' ? 'wallet_request_failed' : null,
    now: input.now,
  });
}

export interface WalletStatusReadingV1 {
  status: WalletCallStatusV1;
  assetChanges: ObservedAssetChangeV1[] | null;
  transactionHashes: string[];
  blockNumber: string | null;
}

/**
 * Advances an attempt using a status reading.
 *
 * The reading comes from the canonical wallet status path. This function never
 * calls a provider itself, so it stays testable and so a transport failure is
 * expressed as a status rather than thrown into the middle of a state machine.
 */
export async function reconcileAttemptV1(input: {
  submissions: B20EntrySubmissionRepositoryV1;
  plan: B20PreparedEntryPlanV1;
  attempt: B20EntrySubmissionAttemptV1;
  reading: WalletStatusReadingV1;
  /** How many unresolved readings this attempt has already had. */
  attempts: number;
  now: Date;
}): Promise<B20EntrySubmissionAttemptV1> {
  const { attempt } = input;
  if (attempt.status === 'terminal') return attempt;
  if (!attempt.batchId) return attempt;

  const verdict = reconcileEntryV1({
    plan: input.plan,
    status: input.reading.status,
    assetChanges: input.reading.assetChanges,
    transactionHashes: input.reading.transactionHashes,
    blockNumber: input.reading.blockNumber,
    attempts: input.attempts,
  });

  if (verdict.state === 'pending') return attempt;

  if (verdict.state === 'reconciling') {
    if (attempt.status === 'reconciling') return attempt;
    return (
      (await input.submissions.updateAttempt({
        attemptId: attempt.id,
        tenantId: attempt.tenantId,
        status: 'reconciling',
        now: input.now,
      })) ?? attempt
    );
  }

  return (
    (await input.submissions.updateAttempt({
      attemptId: attempt.id,
      tenantId: attempt.tenantId,
      status: 'terminal',
      terminalOutcome: verdict.outcome,
      errorCode: verdict.errorCode,
      reconciliation: verdict.reconciliation,
      now: input.now,
    })) ?? attempt
  );
}
