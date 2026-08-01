// T57: "Confirm in Base Account" button for an already-reviewed (prepared)
// ExecutionBlueprintV1. Modeled on WalletConfirmButton: gates on a connected
// wallet, Base mainnet, and an unexpired review; then drives
// useSubmitApprovedBlueprint (server approve → wallet → submission record).
// The button copy is honest about opening the wallet — nothing is signed or
// sent by the server.

import React, { useEffect, useRef, type ButtonHTMLAttributes } from 'react';
void React;
import { useAccount } from 'wagmi';
import { Button } from '@mioagent/ui';
import {
  useSubmitApprovedBlueprint,
  type BlueprintSubmitStatus,
} from './useSubmitApprovedBlueprint';
import { BUILDER_ATTRIBUTION_LABELS_V1, type BuilderAttributionOutcomeV1 } from './attribution';

export interface BlueprintSubmitButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  routeRunId: string;
  blueprintId: string;
  blueprintHash: string;
  /** ISO quote expiry of the reviewed blueprint; the button disables once stale. */
  quoteExpiry: string;
  /** Public ERC-8021 builder code (optional attribution). */
  builderCode?: string;
  /** 'swap' (default), 'earn' or 'nft' — selects the server approve/record
   * routes. The wallet submission path is identical for all three. */
  goal?: 'swap' | 'earn' | 'nft';
  now?: () => Date;
  onStateChange?: (state: {
    status: BlueprintSubmitStatus;
    batchId: string | null;
    txHashes: string[];
    error: string | null;
    /** T58: Route Proof handle from the last successful submission record —
     * lets the surface start bounded reconciliation once terminal. */
    proofId: string | null;
    recordedFinalStatus: string | null;
    /** T67X-B5: what happened to the Builder Code on this batch. Null until a
     * batch exists. Carried alongside the submission, never inside it — see the
     * note in useSubmitApprovedBlueprint. */
    builderAttribution: BuilderAttributionOutcomeV1 | null;
  }) => void;
}

const BUSY_STATUSES: BlueprintSubmitStatus[] = ['approving', 'submitting', 'submitted'];

export function blueprintSubmitLabel(status: BlueprintSubmitStatus, disabledReason: string | null): string {
  if (disabledReason) return disabledReason;
  switch (status) {
    case 'approving':
      return 'Approving on server…';
    case 'submitting':
      return 'Opening Base Account wallet…';
    case 'submitted':
      return 'Confirming onchain…';
    case 'confirmed':
      return 'Confirmed onchain';
    case 'submitted_unknown':
      return 'Submitted — status unknown';
    case 'cancelled':
      return 'Cancelled in wallet — retry';
    case 'failed':
      return 'Failed — retry';
    case 'blocked':
      return 'Blocked by Safety Kernel';
    case 'expired':
      return 'Review expired — refresh';
    default:
      return 'Confirm in Base Account';
  }
}

export function blueprintSubmitDisabledReason(input: {
  address: string | undefined;
  chainId: number | undefined;
  quoteExpiry: string;
  now: Date;
}): string | null {
  if (!input.address) return 'Connect a wallet to confirm';
  if (input.chainId !== 8453) return 'Switch to Base Mainnet (8453)';
  if (Date.parse(input.quoteExpiry) <= input.now.getTime()) return 'Review expired — refresh the plan';
  return null;
}

export function BlueprintSubmitButton({
  routeRunId,
  blueprintId,
  blueprintHash,
  quoteExpiry,
  builderCode,
  goal = 'swap',
  now = () => new Date(),
  onStateChange,
  className,
  disabled,
  ...rest
}: BlueprintSubmitButtonProps) {
  const { address, chainId } = useAccount();
  const { submit, status, error, batchId, txHashes, proofId, recordedFinalStatus, builderAttribution, poller } =
    useSubmitApprovedBlueprint({
      routeRunId,
      blueprintId,
      blueprintHash,
      builderCode,
      goal,
    });

  const lastReported = useRef<string>('');
  useEffect(() => {
    const snapshot = `${status}:${batchId ?? ''}:${txHashes.join(',')}:${error ?? ''}:${proofId ?? ''}:${recordedFinalStatus ?? ''}:${builderAttribution?.status ?? ''}`;
    if (snapshot !== lastReported.current && onStateChange) {
      lastReported.current = snapshot;
      onStateChange({ status, batchId, txHashes, error, proofId, recordedFinalStatus, builderAttribution });
    }
  }, [status, batchId, txHashes, error, proofId, recordedFinalStatus, builderAttribution, onStateChange]);

  const disabledReason =
    status === 'idle' || status === 'cancelled' || status === 'failed'
      ? blueprintSubmitDisabledReason({ address, chainId, quoteExpiry, now: now() })
      : null;
  const busy = BUSY_STATUSES.includes(status);
  const terminalLock = status === 'confirmed' || status === 'submitted_unknown' || status === 'blocked' || status === 'expired';

  return (
    <>
      {poller}
      <Button
        variant="primary"
        className={className}
        disabled={disabled || Boolean(disabledReason) || busy || terminalLock}
        onClick={() => {
          void submit();
        }}
        title={
          disabledReason ??
          (status === 'idle'
            ? 'Opens your connected Base Account wallet to sign the reviewed batch. The server never signs or broadcasts.'
            : (error ?? undefined))
        }
        {...rest}
      >
        {blueprintSubmitLabel(status, disabledReason)}
      </Button>
      {status === 'idle' && !disabledReason && (
        <p className="mt-2 text-xs text-ink-3">
          This opens your Base Account wallet with the exact reviewed calls. Nothing is sent until you sign there.
        </p>
      )}
      {/* T67X-B5: stated only once a batch exists, and only when it is not the
          plain success. An "included" line on every confirmation would be
          noise; the two other outcomes are the ones nobody would otherwise
          discover, because unattributed activity looks exactly like attributed
          activity everywhere else. */}
      {builderAttribution && builderAttribution.status !== 'included' && (
        <p className="mt-2 text-xs text-ink-3">
          {BUILDER_ATTRIBUTION_LABELS_V1[builderAttribution.status]}. The transaction itself is unaffected.
        </p>
      )}
    </>
  );
}
