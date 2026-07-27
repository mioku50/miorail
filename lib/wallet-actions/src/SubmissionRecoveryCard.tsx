import { createElement, useCallback, useState, type ReactNode } from 'react';
import {
  useAbandonSubmissionAttempt,
  useRecordBlueprintSubmission,
  useRecordEarnBlueprintSubmission,
  useRecordNftBlueprintSubmission,
} from '@mioagent/api-client-react';
import type { SubmissionAttemptWireV1 } from '@mioagent/api-spec';

import { CallsStatusPoller } from './useWalletConfirmAction';
import { normalizeWalletReceipts, transactionHashesFromReceipts } from './useSubmitApprovedBlueprint';
import { browserMarkerStorageV1, clearRecoveryMarkerV1, type MarkerStorageV1 } from './recoveryMarker';

// ---------------------------------------------------------------------------
// T67C.2 — the recovery card, shared by the web console and the miniapp.
//
// Read this file for what it does NOT import: there is no `useSendCalls` here,
// no approve hook, no prepare hook, no re-quote. It cannot send a transaction
// because there is no code path from it to one. That is the guarantee, and it
// is structural rather than a promise.
//
// What it does: takes a batch id the wallet already returned, asks the wallet
// what became of that batch (`wallet_getCallsStatus`, through the same poller
// the normal flow uses), and records the answer through the same submission
// route the normal flow uses. One wallet path, one submission path — recovery
// is not a second one of either.
//
// When there is no batch id it says so plainly and offers no retry. A "try
// again" button in that state would be an invitation to pay twice for one
// route, because nobody — not the user, not this card — knows whether the
// first attempt reached the chain.
// ---------------------------------------------------------------------------

export const RECOVERY_NO_BATCH_COPY_V1 = [
  'The wallet batch identifier was not captured.',
  'Miorail cannot safely recover or resend this transaction.',
  'Check your Base Account activity before starting a new route.',
] as const;

/** Why this attempt is on screen at all. Each is a different sentence about
 * what is known, because "we do not know" and "it failed" are not the same
 * thing and a user acts differently on each. */
export const RECOVERY_REASON_COPY_V1: Record<string, string> = {
  wallet_pending: 'Your wallet was opened for this route, but no batch was ever reported back.',
  batch_observed: 'Your wallet returned a batch. Miorail has not yet confirmed what happened to it.',
  submitted: 'The batch was submitted. Its outcome has not been checked yet.',
  submitted_unknown: 'The batch was sent, but the record of it did not reach Miorail. Its outcome is unknown.',
  confirmed: 'The wallet reported success. The proof has not finished reconciling.',
};

export const RECOVERY_STATUS_LABEL_V1: Record<string, string> = {
  wallet_pending: 'wallet opened',
  batch_observed: 'batch returned',
  submitted: 'submitted',
  submitted_unknown: 'outcome unknown',
  confirmed: 'wallet reported success',
};

export function baseAccountActivityUrlV1(walletAddress: string): string {
  return `https://basescan.org/address/${walletAddress}`;
}

export interface SubmissionRecoveryCardProps {
  attempt: SubmissionAttemptWireV1;
  /** Shown next to the goal — a provider or blueprint label, when the surface
   * has one. Never invented here. */
  label?: string | null;
  /** Called once the outcome has been recorded, with the proof to open. */
  onResolved?: (result: { proofId: string | null; finalStatus: string | null }) => void;
  /** Called when the user dismisses the card. */
  onDismissed?: (attemptId: string) => void;
  markerStorage?: MarkerStorageV1 | null;
}

export function SubmissionRecoveryCard({
  attempt,
  label,
  onResolved,
  onDismissed,
  markerStorage,
}: SubmissionRecoveryCardProps): ReactNode {
  const recordSwap = useRecordBlueprintSubmission();
  const recordEarn = useRecordEarnBlueprintSubmission();
  const recordNft = useRecordNftBlueprintSubmission();
  const abandon = useAbandonSubmissionAttempt();
  const [resuming, setResuming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const storage = markerStorage === undefined ? browserMarkerStorageV1() : markerStorage;
  const record =
    attempt.goal === 'earn'
      ? recordEarn.mutateAsync
      : attempt.goal === 'nft'
        ? recordNft.mutateAsync
        : recordSwap.mutateAsync;

  const handleStatusChange = useCallback(
    (status: { status?: string; receipts?: Array<{ transactionHash?: string }> }) => {
      if (!attempt.batchId || outcome) return;
      if (status.status !== 'success' && status.status !== 'failure') return;
      const rawReceipts = status.receipts as unknown as ReadonlyArray<Record<string, unknown>> | undefined;
      const hashes = transactionHashesFromReceipts(status.receipts);
      // The REAL receipt statuses are recorded, including reverted ones. A
      // recovery that quietly rewrote a failure as a success would be worse
      // than no recovery at all.
      const receipts = normalizeWalletReceipts(rawReceipts);
      const resolved = status.status === 'success' ? 'confirmed' : 'failed';
      setOutcome(resolved);
      void (async () => {
        try {
          const response = await record({
            walletAddress: attempt.walletAddress as `0x${string}`,
            routeRunId: attempt.routeRunId,
            blueprintId: attempt.blueprintId,
            approvedCallsHash: attempt.approvedCallsHash,
            status: resolved,
            batchId: attempt.batchId ?? undefined,
            transactionHashes: hashes,
            receipts,
            submissionAttemptId: attempt.id,
            ...(resolved === 'failed' ? { error: 'Wallet reported the batch as failed' } : {}),
          });
          if (resolved === 'failed') {
            clearRecoveryMarkerV1(storage, attempt.walletAddress, attempt.id);
          }
          onResolved?.({
            proofId: response.proofId ?? null,
            finalStatus: response.finalStatus ?? null,
          });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'The outcome could not be recorded');
        }
      })();
    },
    [attempt, outcome, record, onResolved, storage],
  );

  const poller: ReactNode =
    resuming && attempt.batchId
      ? createElement(CallsStatusPoller, { batchId: attempt.batchId, onStatusChange: handleStatusChange })
      : null;

  const dismiss = async () => {
    try {
      await abandon.mutateAsync({ attemptId: attempt.id });
    } catch {
      /* dismissing is a UI preference; a failure here changes no proof */
    }
    clearRecoveryMarkerV1(storage, attempt.walletAddress, attempt.id);
    onDismissed?.(attempt.id);
  };

  return (
    <section className="panel">
      <h3>Unfinished submission</h3>
      <div className="kv">
        <span>Route</span>
        <span>
          {attempt.goal}
          {label ? ` · ${label}` : ''}
        </span>
      </div>
      <div className="kv">
        <span>State</span>
        <span>{RECOVERY_STATUS_LABEL_V1[attempt.status] ?? attempt.status}</span>
      </div>
      <div className="kv">
        <span>Last updated</span>
        <span className="mono">{attempt.updatedAt}</span>
      </div>
      {attempt.batchId && (
        <div className="kv">
          <span>Batch</span>
          <span className="mono">{attempt.batchId}</span>
        </div>
      )}
      <p className="note">{RECOVERY_REASON_COPY_V1[attempt.status] ?? 'This submission was not finished.'}</p>

      {attempt.batchId ? (
        <>
          <p className="note">
            Resuming asks your wallet what happened to that batch and records the answer. It does not
            send a new transaction.
          </p>
          <button type="button" onClick={() => setResuming(true)} disabled={resuming}>
            {resuming ? 'Checking with your wallet…' : 'Resume verification'}
          </button>
          {poller}
        </>
      ) : (
        <>
          {RECOVERY_NO_BATCH_COPY_V1.map((line) => (
            <p className="note" key={line}>
              {line}
            </p>
          ))}
          <a className="mono" href={baseAccountActivityUrlV1(attempt.walletAddress)} target="_blank" rel="noreferrer">
            Open wallet activity
          </a>
        </>
      )}

      {outcome && <p className="note">Recorded as {outcome}.</p>}
      {error && <p className="note">{error}</p>}
      <button type="button" onClick={() => void dismiss()}>
        Dismiss recovery
      </button>
      <p className="note">
        Dismissing only hides this card. It changes no proof, no receipt and nothing onchain.
      </p>
    </section>
  );
}
