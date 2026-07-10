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
  | 'failed'
  | 'cancelled';

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
  initialBatchId?: string | null;
}

/**
 * Safely normalizes call value for JSON-RPC / Base Account EIP-5792 `wallet_sendCalls`.
 * Never returns a raw BigInt, which causes `JSON.stringify` to throw:
 * "TypeError: Do not know how to serialize a BigInt".
 *
 * For zero values ("0", 0, "0x0", ""), returns undefined (omits property).
 * For non-zero values, returns a JSON-safe hex quantity string ("0x...").
 */
export function normalizeCallValue(value?: string | number | bigint | null): Hex | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    const valStr = typeof value === 'bigint' ? value.toString() : String(value).trim();
    if (valStr === '0' || valStr === '0x0' || valStr === '0x') return undefined;
    const bi = valStr.startsWith('0x') ? BigInt(valStr) : BigInt(valStr);
    if (bi === BigInt(0)) return undefined;
    return `0x${bi.toString(16)}` as Hex;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes a prepared call object into a JSON/RPC serializable EIP-5792 call.
 */
export function normalizeCall(c: { to: string; data?: string; value?: string | number | bigint | null }) {
  const val = normalizeCallValue(c.value);
  const call: { to: Address; data?: Hex; value?: Hex } = {
    to: c.to as Address,
  };
  if (c.data) call.data = c.data as Hex;
  if (val !== undefined) call.value = val;
  return call;
}

/**
 * Recursively converts any BigInt values in an object/array to strings
 * so JSON.stringify never throws when sending confirm payloads or logs.
 */
export function sanitizeBigInts<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString() as unknown as T;
  if (Array.isArray(value)) return value.map(sanitizeBigInts) as unknown as T;
  if (typeof value === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      res[k] = sanitizeBigInts(v);
    }
    return res as unknown as T;
  }
  return value;
}

export function useWalletConfirmAction({
  actionId,
  dataSuffix,
  initialBatchId,
}: UseWalletConfirmActionArgs): UseWalletConfirmActionResult {
  const prepareAction = usePrepareAction();
  const confirmAction = useConfirmAction();
  const sendCalls = useSendCalls();
  const { address } = useAccount();

  const [batchId, setBatchId] = useState<string | null>(initialBatchId || null);
  const [status, setStatus] = useState<ConfirmFlowStatus>(initialBatchId ? 'pending' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const confirmedRef = useRef(false);

  useEffect(() => {
    if (initialBatchId && !batchId && !confirmedRef.current) {
      setBatchId(initialBatchId);
      setStatus('pending');
    }
  }, [initialBatchId, batchId]);

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
        .mutateAsync(
          sanitizeBigInts({
            actionId,
            batchId,
            status: cs.statusCode ?? 0,
            txHash: finalTxHash ?? undefined,
            receipts: cs.receipts as Record<string, unknown>[] | undefined,
          }) as {
            actionId: string;
            batchId: string;
            status: number;
            txHash?: string;
            receipts?: Record<string, unknown>[];
          }
        )
        .then((r) => {
          if (r.status === 'executed') {
            setStatus('success');
          } else if (r.status === 'cancelled') {
            setStatus('cancelled');
          } else if (r.status === 'pending_confirmation' || r.status === 'submitted_unknown') {
            setStatus('pending');
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
      const prepared = await prepareAction.mutateAsync({ actionId, walletAddress: address });
      if (!prepared.success || !prepared.calls?.length) {
        setStatus('failed');
        setError(prepared.error ?? 'Action is not confirmable');
        return;
      }

      setStatus('sending');
      const result = await sendCalls.mutateAsync({
        calls: prepared.calls.map(normalizeCall) as unknown as Parameters<typeof sendCalls.mutateAsync>[0]['calls'],
        chainId: base.id,
        forceAtomic: true,
        capabilities: dataSuffix
          ? { dataSuffix: { value: dataSuffix, optional: true } }
          : undefined,
      });

      setBatchId(result.id);
      setStatus('pending');
      try {
        await confirmAction.mutateAsync(
          sanitizeBigInts({
            actionId,
            batchId: result.id,
            status: 102,
          }) as unknown as { actionId: string; batchId: string; status: number }
        );
      } catch {
        // Continue polling even if initial persistence call fails
      }
    } catch (e: unknown) {
      const errStr = e instanceof Error ? e.message : String(e);
      const isCancelled =
        errStr.toLowerCase().includes('reject') ||
        errStr.toLowerCase().includes('cancel') ||
        errStr.toLowerCase().includes('close') ||
        errStr.toLowerCase().includes('denied') ||
        (e as { code?: number })?.code === 4001 ||
        (e as { shortMessage?: string })?.shortMessage?.toLowerCase()?.includes('reject');

      const finalStatus = isCancelled ? 'cancelled' : 'failed';
      setStatus(finalStatus);
      const errMsg = isCancelled ? 'Cancelled by user' : (e instanceof Error ? e.message : 'Wallet flow failed');
      setError(errMsg);

      try {
        await confirmAction.mutateAsync(
          sanitizeBigInts({
            actionId,
            batchId: '',
            status: isCancelled ? 4001 : 500,
            error: errMsg,
          }) as unknown as { actionId: string; batchId: string; status: number }
        );
      } catch {
        // Ignore network error on cancellation/failure reporting
      }
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
