// T57: pure presentational submission status (wagmi-free by design). The
// surfaces feed it the wallet-actions hook state; this component only renders
// what it is told — it never polls, signs, or invents outcomes.

import React from 'react';

void React;

export type SubmissionStatusState =
  | 'idle'
  | 'approving'
  | 'submitting'
  | 'submitted'
  | 'confirmed'
  | 'submitted_unknown'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'expired';

/** Builds a basescan.org transaction URL for a valid 32-byte tx hash, or null. */
export function baseExplorerTxUrl(hash: string): string | null {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return null;
  return `https://basescan.org/tx/${hash}`;
}

const STATUS_COPY: Record<SubmissionStatusState, { label: string; detail: string; tone: 'neutral' | 'progress' | 'success' | 'warn' | 'risk' }> = {
  idle: { label: 'Not submitted', detail: 'No wallet submission has been started.', tone: 'neutral' },
  approving: { label: 'Approving', detail: 'The server is re-validating the reviewed blueprint.', tone: 'progress' },
  submitting: { label: 'Wallet open', detail: 'Waiting for you to sign the batch in your Base Account wallet.', tone: 'progress' },
  submitted: { label: 'Submitted', detail: 'The wallet accepted the batch. Waiting for onchain confirmation.', tone: 'progress' },
  confirmed: { label: 'Confirmed', detail: 'The wallet reported the batch as confirmed onchain.', tone: 'success' },
  submitted_unknown: { label: 'Status unknown', detail: 'The batch was sent but its final status could not be verified yet.', tone: 'warn' },
  failed: { label: 'Failed', detail: 'The submission failed. Nothing further was sent automatically.', tone: 'risk' },
  cancelled: { label: 'Cancelled', detail: 'You declined the batch in the wallet. Nothing was sent.', tone: 'neutral' },
  blocked: { label: 'Blocked', detail: 'The Safety Kernel blocked this blueprint at approval time.', tone: 'risk' },
  expired: { label: 'Expired', detail: 'The reviewed quote expired before approval. Refresh the plan.', tone: 'warn' },
};

const TONE_CLASSES: Record<'neutral' | 'progress' | 'success' | 'warn' | 'risk', string> = {
  neutral: 'border-line bg-panel text-ink-2',
  progress: 'border-accent/35 bg-accent-soft text-accent-2',
  success: 'border-accent/35 bg-accent-soft text-ink',
  warn: 'border-warn/40 bg-warn-soft text-warn',
  risk: 'border-risk/35 bg-risk-soft text-risk',
};

export interface SubmissionStatusProps {
  state: SubmissionStatusState;
  batchId?: string | null;
  transactionHashes?: string[];
  error?: string | null;
  /** Override the explorer base URL builder (defaults to basescan.org). */
  explorerTxUrl?: (hash: string) => string | null;
}

export function SubmissionStatus({
  state,
  batchId = null,
  transactionHashes = [],
  error = null,
  explorerTxUrl = baseExplorerTxUrl,
}: SubmissionStatusProps) {
  const copy = STATUS_COPY[state];
  return (
    <section
      aria-label="Submission status"
      data-submission-state={state}
      className={`rounded-xl border p-4 ${TONE_CLASSES[copy.tone]}`}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-sm font-semibold">{copy.label}</h3>
        <span className="rounded-full bg-bg/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em]">{state}</span>
      </div>
      <p className="mt-2 text-xs">{copy.detail}</p>
      {batchId && <p className="mt-2 break-all font-mono text-[11px]">batch {batchId}</p>}
      {transactionHashes.length > 0 && (
        <ul className="mt-2 space-y-1 font-mono text-[11px]">
          {transactionHashes.map((hash) => {
            const href = explorerTxUrl(hash);
            return (
              <li key={hash} className="break-all">
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
                    {hash}
                  </a>
                ) : (
                  hash
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="mt-2 text-xs">{error}</p>}
    </section>
  );
}
