// T19: drop-in "Confirm in Base Account" button. Wraps useWalletConfirmAction
// and gates on the action's stored screening + simulation verdicts, the
// production action-type whitelist, a connected wallet, AND the server-reported
// userConfirmedEnabled flag. Used by both the web interface and the miniapp.
//
// T19.1: accept a raw `builderCode` (public env string) as an alternative to a
// precomputed `dataSuffix` so callers don't import `ox` at module scope — this
// keeps the ERC-8021 attribution code inside this (lazy-loaded) chunk.

import React, { useEffect, useRef, type ButtonHTMLAttributes } from 'react';
void React;
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
    actionType?: string;
    userConfirmable?: boolean;
    executionStatus?: string;
    securityScreening?: { allowed?: boolean; verdict?: string; reason?: string };
    simulationResult?: { success?: boolean; method?: string; reason?: string; error?: string };
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
  const { address, chainId } = useAccount();
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
  const effectiveActionType = payload?.actionType || action.metadata?.actionType;
  const isConfirmableMeta =
    action.metadata?.userConfirmable === true ||
    action.metadata?.executionStatus === 'user-confirmable' ||
    effectiveActionType === 'revoke_approval' ||
    effectiveActionType === 'limited_transfer';
  const actionTypeAllowed = isProductionActionType(effectiveActionType) || isConfirmableMeta;
  const screeningAllowed = action.metadata?.securityScreening?.allowed ?? false;
  const simSuccess = action.metadata?.simulationResult?.success ?? false;
  const isPending = action.status === 'pending' || action.status === 'pending_confirmation' || action.status === 'submitted_unknown';
  const isSupportedChain = !chainId || chainId === 8453 || chainId === 84532 || chainId === 0x2105 || chainId === 0x14a34;
  const canConfirm =
    isPending && hasCalls && actionTypeAllowed && screeningAllowed && simSuccess && !!address && isSupportedChain && userConfirmedEnabled;

  // Resolve the attribution suffix inside this (lazy) chunk so callers never
  // import `ox` at module scope.
  const resolvedSuffix = dataSuffix ?? builderCodeToDataSuffix(builderCode);

  const { confirm, status, error, isPreparing, isSending, isPolling, isConfirming, txHash, poller } =
    useWalletConfirmAction({ actionId: action.id, dataSuffix: resolvedSuffix, initialBatchId: action.metadata?.confirmation?.batchId || null });

  // Fire onConfirmed once per terminal transition (success or failed or cancelled).
  const lastReported = useRef<ConfirmFlowStatus | null>(null);
  useEffect(() => {
    if ((status === 'success' || status === 'failed' || status === 'cancelled') && status !== lastReported.current && onConfirmed) {
      lastReported.current = status;
      onConfirmed({ status, txHash, error });
    }
  }, [status, txHash, error, onConfirmed]);

  let disabledReason: string | null = null;
  if (!address) {
    disabledReason = 'Connect Wallet to confirm';
  } else if (!isSupportedChain) {
    disabledReason = `Unsupported chain (${chainId}) — switch to Base`;
  } else if (!userConfirmedEnabled) {
    disabledReason = 'User confirmation disabled by server config';
  } else if (!screeningAllowed) {
    disabledReason = `Security screening blocked: ${action.metadata?.securityScreening?.reason || 'unapproved action'}`;
  } else if (!simSuccess) {
    disabledReason = `Validation failed: ${action.metadata?.simulationResult?.reason || action.metadata?.simulationResult?.error || 'static check failed'}`;
  } else if (!actionTypeAllowed) {
    disabledReason = `Unsupported action type: ${effectiveActionType || 'unknown'}`;
  } else if (!hasCalls) {
    disabledReason = 'No planned calls to execute';
  } else if (!isPending) {
    disabledReason = `Action status: ${action.status}`;
  }

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
              : (disabledReason || 'Confirm in Base Account');

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
