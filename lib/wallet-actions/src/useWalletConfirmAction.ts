// T19: orchestrates the user-confirmed action flow on the CLIENT. The server
// only prepares an unsigned EIP-5792 payload and records the result — all
// signing happens here via Base Account `wallet_sendCalls`. Flow:
//   prepare (server, no broadcast) → wallet_sendCalls (user signs)
//   → poll wallet_getCallsStatus → confirm (server records, read-only verify).

import { useEffect, useRef, useState, useCallback, createElement, type ReactNode } from 'react';
import { useAccount, useSendCalls, useCallsStatus } from 'wagmi';
import { base } from 'wagmi/chains';
import type { Address, Hex } from 'viem';
import { usePrepareAction, useConfirmAction } from '@mioagent/api-client-react';

export type ConfirmFlowStatus =
  | 'idle'
  | 'preparing'
  | 'sending'
  | 'pending'
  | 'confirming'
  | 'success'
  | 'failed';

export interface CallsStatusPollerProps {
  batchId: string;
  onStatusChange: (status: {
    status?: string;
    statusCode?: number;
    receipts?: Array<{ transactionHash?: string }>;
  }) => void;
}

export function CallsStatusPoller({ batchId, onStatusChange }: CallsStatusPollerProps) {
  const callsStatus = useCallsStatus({
    id: batchId,
    query: {
      enabled: !!batchId && typeof batchId === 'string' && batchId.trim().length > 0,
      refetchInterval: 2000,
    },
  });

  const cs = callsStatus.data;
  useEffect(() => {
    if (!cs || (cs.status !== 'success' && cs.status !== 'failure')) return;
    onStatusChange(cs as unknown as {
      status?: string;
      statusCode?: number;
      receipts?: Array<{ transactionHash?: string }>;
    });
  }, [cs, onStatusChange]);

  return null;
}

export interface UseWalletConfirmActionResult {
  /** Kick off prepare → wallet send → poll → confirm. */
  confirm: () => Promise<void>;
  isPreparing: boolean;
  isSending: boolean;
  isPolling: boolean;
  isConfirming: boolean;
  status: ConfirmFlowStatus;
  error: string | null;
  batchId: string | null;
  txHash: string | null;
  /** React element to mount for polling when a batchId exists. */
  poller: ReactNode;
}

export interface UseWalletConfirmActionArgs {
  actionId: string;
  /** ERC-8021 builder code data suffix, or undefined to send unattributed. */
  dataSuffix?: Hex;
}

export function useWalletConfirmAction({
  actionId,
  dataSuffix,
}: UseWalletConfirmActionArgs): UseWalletConfirmActionResult {
  const prepareAction = usePrepareAction();
  const confirmAction = useConfirmAction();
  const sendCalls = useSendCalls();
  const { address } = useAccount();

  const [batchId, setBatchId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConfirmFlowStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const confirmedRef = useRef(false);

  const handleStatusChange = useCallback(
    (cs: { status?: string; statusCode?: number; receipts?: Array<{ transactionHash?: string }> }) => {
      if (!batchId || confirmedRef.current) return;
      if (!cs || (cs.status !== 'success' && cs.status !== 'failure')) return;

      confirmedRef.current = true;
      const receipt = cs.receipts?.[0];
      const finalTxHash = receipt?.transactionHash ?? null;
      if (finalTxHash) setTxHash(finalTxHash);

      setStatus('confirming');
      confirmAction
        .mutateAsync({
          actionId,
          batchId,
          status: cs.statusCode ?? 0,
          txHash: finalTxHash ?? undefined,
          receipts: cs.receipts as Record<string, unknown>[] | undefined,
        })
        .then((r) => {
          if (r.status === 'executed') {
            setStatus('success');
          } else {
            setStatus('failed');
            setError(r.error ?? 'Onchain verification failed');
          }
        })
        .catch((e: unknown) => {
          setStatus('failed');
          setError(e instanceof Error ? e.message : 'Confirm failed');
        });
    },
    [batchId, confirmAction, actionId]
  );

  const poller: ReactNode =
    batchId && typeof batchId === 'string' && batchId.trim().length > 0
      ? createElement(CallsStatusPoller, { batchId, onStatusChange: handleStatusChange })
      : null;

  const confirm = async () => {
    if (!address) {
      setError('Connect your Base Account wallet first');
      setStatus('failed');
      return;
    }
    // Reset for a fresh attempt.
    confirmedRef.current = false;
    setBatchId(null);
    setTxHash(null);
    setError(null);
    setStatus('preparing');

    try {
      const prepared = await prepareAction.mutateAsync({ actionId });
      if (!prepared.success || !prepared.calls?.length) {
        setStatus('failed');
        setError(prepared.error ?? 'Action is not confirmable');
        return;
      }

      setStatus('sending');
      const result = await sendCalls.mutateAsync({
        calls: prepared.calls.map((c) => ({
          to: c.to as Address,
          data: c.data as Hex | undefined,
          value: c.value ? BigInt(c.value) : undefined,
        })),
        chainId: base.id,
        forceAtomic: true,
        capabilities: dataSuffix
          ? { dataSuffix: { value: dataSuffix, optional: true } }
          : undefined,
      });

      setBatchId(result.id);
      setStatus('pending');
    } catch (e: unknown) {
      setStatus('failed');
      setError(e instanceof Error ? e.message : 'Wallet flow failed');
    }
  };

  return {
    confirm,
    isPreparing: status === 'preparing',
    isSending: status === 'sending',
    isPolling: status === 'pending',
    isConfirming: status === 'confirming',
    status,
    error,
    batchId,
    txHash,
    poller,
  };
}
