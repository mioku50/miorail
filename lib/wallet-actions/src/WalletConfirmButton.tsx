// T19: drop-in "Confirm in Base Account" button. Wraps useWalletConfirmAction
// and gates on the action's stored screening + simulation verdicts plus a
// connected wallet. Used by both the web interface and the miniapp.

import { useEffect, useRef, type ButtonHTMLAttributes } from 'react';
import { useAccount } from 'wagmi';
import type { Hex } from 'viem';
import { Button } from '@mioagent/ui';
import { useWalletConfirmAction, type ConfirmFlowStatus } from './useWalletConfirmAction';

export interface WalletConfirmAction {
  id: string;
  status: string;
  executionPayload?: { calls?: { to: string; value?: string; data?: string }[] } | null;
  metadata?: {
    securityScreening?: { allowed?: boolean; verdict?: string; reason?: string };
    simulationResult?: { success?: boolean; method?: string };
  } | null;
}

export interface WalletConfirmButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  action: WalletConfirmAction;
  /** ERC-8021 builder code data suffix, or undefined to send unattributed. */
  dataSuffix?: Hex;
  onConfirmed?: (result: { status: ConfirmFlowStatus; txHash: string | null; error: string | null }) => void;
}

export function WalletConfirmButton({
  action,
  dataSuffix,
  onConfirmed,
  className,
  disabled,
  ...rest
}: WalletConfirmButtonProps) {
  const { address } = useAccount();
  const calls = action.executionPayload?.calls ?? [];
  const hasCalls = calls.length > 0;
  const screeningAllowed = action.metadata?.securityScreening?.allowed ?? false;
  const simSuccess = action.metadata?.simulationResult?.success ?? false;
  const isPending = action.status === 'pending';
  const canConfirm = isPending && hasCalls && screeningAllowed && simSuccess && !!address;

  const { confirm, status, error, isPreparing, isSending, isPolling, isConfirming, txHash } =
    useWalletConfirmAction({ actionId: action.id, dataSuffix });

  // Fire onConfirmed once per terminal transition (success or failed).
  const lastReported = useRef<ConfirmFlowStatus | null>(null);
  useEffect(() => {
    if ((status === 'success' || status === 'failed') && status !== lastReported.current && onConfirmed) {
      lastReported.current = status;
      onConfirmed({ status, txHash, error });
    }
  }, [status, txHash, error, onConfirmed]);

  const label = isPreparing
    ? 'Preparing…'
    : isSending
      ? 'Open wallet…'
      : isPolling
        ? 'Confirming onchain…'
        : isConfirming
          ? 'Recording…'
          : status === 'success'
            ? 'Confirmed ✓'
            : status === 'failed'
              ? 'Failed — retry'
              : 'Confirm in Base Account';

  const busy = isPreparing || isSending || isPolling || isConfirming;

  return (
    <Button
      variant="primary"
      className={className}
      disabled={disabled || !canConfirm || busy}
      onClick={() => {
        void confirm();
      }}
      title={
        !canConfirm
          ? 'Requires a connected wallet, onchain calls, passing security screening, and a successful static validation.'
          : error ?? undefined
      }
      {...rest}
    >
      ⚡ {label}
    </Button>
  );
}
