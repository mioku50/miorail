// T19: drop-in "Confirm in Base Account" button. Wraps useWalletConfirmAction
// and gates on the action's stored screening + simulation verdicts, the
// production action-type whitelist, a connected wallet, AND the server-reported
// userConfirmedEnabled flag. Used by both the web interface and the miniapp.
//
// T19.1: accept a raw `builderCode` (public env string) as an alternative to a
// precomputed `dataSuffix` so callers don't import `ox` at module scope — this
// keeps the ERC-8021 attribution code inside this (lazy-loaded) chunk.

import { useEffect, useRef, type ButtonHTMLAttributes } from 'react';
import { useAccount } from 'wagmi';
import type { Hex } from 'viem';
import { Button } from '@mioagent/ui';
import { useStatus, isProductionActionType } from '@mioagent/api-client-react';
import { builderCodeToDataSuffix } from './attribution';
import { useWalletConfirmAction, type ConfirmFlowStatus } from './useWalletConfirmAction';

export interface WalletConfirmAction {
  id: string;
  status: string;
  executionPayload?: {
    calls?: { to: string; value?: string; data?: string }[];
    actionType?: string;
  } | null;
  metadata?: {
    securityScreening?: { allowed?: boolean; verdict?: string; reason?: string };
    simulationResult?: { success?: boolean; method?: string };
  } | null;
}

export interface WalletConfirmButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  action: WalletConfirmAction;
  /**
   * ERC-8021 builder code data suffix (precomputed). Mutually exclusive with
   * `builderCode`; prefer `builderCode` from public env so `ox` stays lazy.
   */
  dataSuffix?: Hex;
  /** Raw ERC-8021 builder code (public env string); computed to a suffix here. */
  builderCode?: string;
  onConfirmed?: (result: { status: ConfirmFlowStatus; txHash: string | null; error: string | null }) => void;
}

export function WalletConfirmButton({
  action,
  dataSuffix,
  builderCode,
  onConfirmed,
  className,
  disabled,
  ...rest
}: WalletConfirmButtonProps) {
  const { address } = useAccount();
  // T19.1: the UI may show "Confirm in Base Account" ONLY when the server
  // reports userConfirmedEnabled === true. This is distinct from server-broadcast.
  const { data: statusData } = useStatus();
  const userConfirmedEnabled = statusData?.execution?.userConfirmedEnabled === true;

  const rawPayload = action.executionPayload;
  const payload = typeof rawPayload === 'string'
    ? (() => { try { return JSON.parse(rawPayload); } catch { return null; } })()
    : (rawPayload && typeof rawPayload === 'object' ? rawPayload : null);
  const calls = Array.isArray(payload?.calls) ? payload.calls : [];
  const hasCalls = calls.length > 0;
  const actionTypeAllowed = isProductionActionType(payload?.actionType);
  const screeningAllowed = action.metadata?.securityScreening?.allowed ?? false;
  const simSuccess = action.metadata?.simulationResult?.success ?? false;
  const isPending = action.status === 'pending';
  const canConfirm =
    isPending && hasCalls && actionTypeAllowed && screeningAllowed && simSuccess && !!address && userConfirmedEnabled;

  // Resolve the attribution suffix inside this (lazy) chunk so callers never
  // import `ox` at module scope.
  const resolvedSuffix = dataSuffix ?? builderCodeToDataSuffix(builderCode);

  const { confirm, status, error, isPreparing, isSending, isPolling, isConfirming, txHash, poller } =
    useWalletConfirmAction({ actionId: action.id, dataSuffix: resolvedSuffix });

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
    <>
      {poller}
      <Button
        variant="primary"
        className={className}
        disabled={disabled || !canConfirm || busy}
        onClick={() => {
          void confirm();
        }}
        title={
          !canConfirm
            ? 'Requires a connected wallet, a whitelisted action type (revoke_approval or limited_transfer), onchain calls, passing security screening, a successful static validation, and the user-confirmed flow to be enabled.'
            : error ?? undefined
        }
        {...rest}
      >
        ⚡ {label}
      </Button>
    </>
  );
}
