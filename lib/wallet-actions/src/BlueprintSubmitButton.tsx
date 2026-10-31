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
  type SequentialStepV1,
} from './useSubmitApprovedBlueprint';
import { BUILDER_ATTRIBUTION_LABELS_V1, type BuilderAttributionOutcomeV1 } from './attribution';
import { SPONSORED_GAS_LABELS_V1, type SponsoredGasStateV1 } from './sponsoredGas';

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
  /** Say why the last attempt failed under the button, not only in its hover
   * title. Off where the surface already prints `error` from onStateChange. */
  failureNote?: boolean;
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
    /** Growth plan step 2: who pays the network fee on the latest attempt. */
    sponsoredGas: SponsoredGasStateV1 | null;
  }) => void;
}

const BUSY_STATUSES: BlueprintSubmitStatus[] = ['approving', 'submitting', 'submitted'];

export function blueprintSubmitLabel(
  status: BlueprintSubmitStatus,
  disabledReason: string | null,
  step: SequentialStepV1 | null = null,
): string {
  if (disabledReason) return disabledReason;
  // A swap sent one transaction at a time says which one the wallet is on.
  if (step && step.total > 1) {
    return step.phase === 'wallet'
      ? `Step ${step.index} of ${step.total}: confirm in your wallet`
      : `Step ${step.index} of ${step.total}: confirming onchain…`;
  }
  switch (status) {
    case 'approving':
      return 'Approving on server…';
    case 'submitting':
      return 'Opening your wallet…';
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
      return 'Confirm in your wallet';
  }
}

export function blueprintSubmitDisabledReason(input: {
  address: string | undefined;
  chainId: number | undefined;
  quoteExpiry: string;
  now: Date;
  /** The wallet already said it cannot send one batch. */
  walletBlocker?: string | null;
}): string | null {
  if (!input.address) return 'Connect a wallet to confirm';
  if (input.walletBlocker) return 'This wallet cannot send it';
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
  failureNote = false,
  now = () => new Date(),
  onStateChange,
  className,
  disabled,
  ...rest
}: BlueprintSubmitButtonProps) {
  const { address, chainId } = useAccount();
  const { submit, status, error, batchId, txHashes, proofId, recordedFinalStatus, builderAttribution, sponsoredGas, walletBlocker, deliveryNotice, step, poller } =
    useSubmitApprovedBlueprint({
      routeRunId,
      blueprintId,
      blueprintHash,
      builderCode,
      goal,
      quoteExpiry,
    });

  const lastReported = useRef<string>('');
  useEffect(() => {
    const snapshot = `${status}:${batchId ?? ''}:${txHashes.join(',')}:${error ?? ''}:${proofId ?? ''}:${recordedFinalStatus ?? ''}:${builderAttribution?.status ?? ''}:${sponsoredGas ?? ''}`;
    if (snapshot !== lastReported.current && onStateChange) {
      lastReported.current = snapshot;
      onStateChange({ status, batchId, txHashes, error, proofId, recordedFinalStatus, builderAttribution, sponsoredGas });
    }
  }, [status, batchId, txHashes, error, proofId, recordedFinalStatus, builderAttribution, sponsoredGas, onStateChange]);

  const disabledReason =
    status === 'idle' || status === 'cancelled' || status === 'failed'
      ? blueprintSubmitDisabledReason({ address, chainId, quoteExpiry, now: now(), walletBlocker })
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
            ? 'Opens your connected wallet to sign the reviewed batch. The server never signs or broadcasts.'
            : (error ?? undefined))
        }
        {...rest}
      >
        {blueprintSubmitLabel(status, disabledReason, step)}
      </Button>
      {status === 'idle' && !disabledReason && (
        <p className="mt-2 text-xs text-ink-3">
          This opens your wallet with the exact reviewed calls. Nothing is sent until you sign there.
        </p>
      )}
      {/* What the wallet said about itself, before anything was approved. A
          disabled button with no reason is a screen that does not say what
          can be done. */}
      {walletBlocker && address && (status === 'idle' || status === 'cancelled' || status === 'failed') ? (
        <p className="mt-2 text-xs note warn sign-reason" role="status">{walletBlocker}</p>
      ) : failureNote && (status === 'failed' || status === 'cancelled' || status === 'expired' || status === 'submitted_unknown') && error && error !== 'Cancelled in wallet' ? (
        <p className="mt-2 text-xs note warn sign-reason" role="alert">{error}</p>
      ) : deliveryNotice && address && ((status === 'idle' && !disabledReason) || step) ? (
        // Before the first press, and while the steps run: this wallet is
        // asked once per step.
        <p className="mt-2 text-xs note sign-reason" role="status">{deliveryNotice}</p>
      ) : null}
      {/* T67X-B5: stated only once a batch exists, and only when it is not the
          plain success. An "included" line on every confirmation would be
          noise; the two other outcomes are the ones nobody would otherwise
          discover, because unattributed activity looks exactly like attributed
          activity everywhere else. */}
      {/* Growth plan step 2: who pays the network fee. Known only once the
          approval has been read, so it appears as the wallet opens — never as
          a promise before the server has made one. */}
      {sponsoredGas && SPONSORED_GAS_LABELS_V1[sponsoredGas] && (
        <p className="mt-2 text-xs text-ink-3">{SPONSORED_GAS_LABELS_V1[sponsoredGas]}</p>
      )}
      {builderAttribution && builderAttribution.status !== 'included' && (
        <p className="mt-2 text-xs text-ink-3">
          {BUILDER_ATTRIBUTION_LABELS_V1[builderAttribution.status]}. The transaction itself is unaffected.
        </p>
      )}
    </>
  );
}
