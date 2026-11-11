// T19: orchestrates the user-confirmed action flow on the CLIENT. The server
// only prepares an unsigned EIP-5792 payload and records the result — all
// signing happens here via Base Account `wallet_sendCalls`. Flow:
//   prepare (server, no broadcast) → wallet_sendCalls (user signs)
//   → poll wallet_getCallsStatus → confirm (server records, read-only verify).

import { useEffect, useRef, useState, useCallback, createElement, type ReactNode } from 'react';
import { useAccount, useCapabilities, useConfig, useSendCalls, useCallsStatus } from 'wagmi';
import { attributedCallsV1 } from './attribution';
import { requireLiveWalletAccountV1 } from './liveWalletConnection';
import { base } from 'wagmi/chains';
import type { Address, Hex } from 'viem';
import { usePrepareAction, useConfirmAction } from '@mioagent/api-client-react';
import { walletDidNotSendV1, walletSubmissionFailureMessageV1 } from './walletBatchSupport';

/** The server's code for an action already handed to the wallet with no answer on record. */
export const WALLET_HANDOFF_UNRESOLVED_V1 = 'wallet_handoff_unresolved';
/** What the page says when the wallet's answer proves nothing either way. */
export const WALLET_CONFIRM_UNKNOWN_V1 = 'Your wallet did not say whether it sent this. Check the wallet’s activity: if it was sent, it is done; it will not be asked again from here.';

/**
 * What a failed wallet request proves, for the Action Inbox (audit WAL-7, 2026-11-10). The words of an
 * error decide nothing: "connection closed" used to count as a cancellation, although it can arrive
 * after the wallet took the request, and the transfer was then recorded as cancelled while it may have gone.
 */
export function walletConfirmOutcomeV1(cause: unknown): 'cancelled' | 'not_sent' | 'unknown' {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (record.code === 4001 || record.name === 'UserRejectedRequestError') return 'cancelled';
    current = record.cause;
  }
  return walletDidNotSendV1(cause) ? 'not_sent' : 'unknown';
}

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
  /** Kick off prepare → wallet send → poll → confirm. `again` is the person's own word that an earlier
   * handoff of this action to their wallet sent nothing (see `handedBefore`). */
  confirm: (options?: { again?: boolean }) => Promise<void>;
  /** The server holds an earlier handoff of this action to the wallet with no answer on record: the wallet
   * may have sent it. Nothing is asked of the wallet again until the person says nothing was sent. */
  handedBefore: boolean;
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

export type AtomicCapabilityStatus = 'supported' | 'ready' | 'unsupported';

export function readAtomicCapabilityStatus(value: unknown): AtomicCapabilityStatus | null {
  if (!value || typeof value !== 'object') return null;
  const root = value as Record<string, unknown>;
  const chainCapabilities = (
    root.atomic
      ? root
      : root[base.id]
        || root[String(base.id)]
        || root['0x2105']
  ) as Record<string, unknown> | undefined;
  const atomic = chainCapabilities?.atomic;
  if (!atomic || typeof atomic !== 'object') return null;
  const entry = atomic as Record<string, unknown>;
  const status = entry.status || entry.supported;
  return status === 'supported' || status === 'ready' || status === 'unsupported' ? status : null;
}

export function atomicCapabilityAllowsBatch(value: unknown): boolean {
  const status = readAtomicCapabilityStatus(value);
  return status === 'supported' || status === 'ready';
}

export function useWalletConfirmAction({
  actionId,
  dataSuffix,
  initialBatchId,
}: UseWalletConfirmActionArgs): UseWalletConfirmActionResult {
  const prepareAction = usePrepareAction();
  const confirmAction = useConfirmAction();
  const sendCalls = useSendCalls();
  const config = useConfig();
  const { address } = useAccount();
  const walletCapabilities = useCapabilities({
    account: address,
    chainId: base.id,
    query: { enabled: Boolean(address), retry: false },
  });

  const [batchId, setBatchId] = useState<string | null>(initialBatchId || null);
  const [status, setStatus] = useState<ConfirmFlowStatus>(initialBatchId ? 'pending' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [handedBefore, setHandedBefore] = useState(false);
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

  const confirm = async (options: { again?: boolean } = {}) => {
    if (!address) {
      setError('Connect your wallet first');
      setStatus('failed');
      return;
    }
    let capabilityData: unknown = walletCapabilities.data;
    if (!readAtomicCapabilityStatus(capabilityData)) {
      const refreshed = await walletCapabilities.refetch();
      capabilityData = refreshed.data;
    }
    if (!atomicCapabilityAllowsBatch(capabilityData)) {
      setError('Connected wallet does not report atomic Base transaction support');
      setStatus('failed');
      return;
    }
    // Reset for a fresh attempt.
    confirmedRef.current = false;
    setBatchId(null);
    setTxHash(null);
    setError(null);
    setStatus('preparing');

    // Whether the server has this press on record as handed to the wallet. Before that, a failure is the
    // page's own and is reported to nobody; after it, the wallet's answer is what the server is told.
    let handed = false;
    try {
      // A restored connection is brought back before anything is recorded or the wallet is asked
      // (2026-11-09), and it must hold the account the action is prepared for (audit WAL-1).
      await requireLiveWalletAccountV1(config, address);
      const prepared = await prepareAction.mutateAsync({ actionId, walletAddress: address, ...(options.again === true ? { again: true } : {}) });
      if (!prepared.success || !prepared.calls?.length) {
        // Handed to the wallet before, with no answer on record: the wallet may have sent it (audit WAL-7).
        setHandedBefore((prepared as { code?: unknown }).code === WALLET_HANDOFF_UNRESOLVED_V1);
        setStatus('failed');
        setError(prepared.error ?? 'Action is not confirmable');
        return;
      }
      setHandedBefore(false);
      handed = true;

      setStatus('sending');
      const result = await sendCalls.mutateAsync({
        account: address,
        // A wallet that drops `dataSuffix` (MetaMask) gets the code in each call's own data; a plain ETH
        // transfer, which has none, is left exactly as prepared (audit WAL-5).
        calls: attributedCallsV1({ calls: prepared.calls.map(normalizeCall), suffix: dataSuffix, capabilities: capabilityData, chainId: base.id }) as unknown as Parameters<typeof sendCalls.mutateAsync>[0]['calls'],
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
      // Nothing was handed to the wallet: the connection was not ready, the wallet answers as another
      // account, or the server refused. The action stays as it was, and nothing is recorded about it.
      if (!handed) {
        setStatus('failed');
        setError(walletSubmissionFailureMessageV1(e));
        return;
      }
      // What the wallet's answer proves (audit WAL-7). Its own code for the person's No is a cancellation.
      // A refusal that shows nothing was sent is a failure. Anything else, "connection closed" among it,
      // may have come after the wallet took the request: the outcome is unknown, and is recorded as that.
      const outcome = walletConfirmOutcomeV1(e);
      const isCancelled = outcome === 'cancelled';
      setStatus(isCancelled ? 'cancelled' : 'failed');
      const errMsg = isCancelled ? 'Cancelled by user'
        : outcome === 'not_sent' ? walletSubmissionFailureMessageV1(e) : WALLET_CONFIRM_UNKNOWN_V1;
      setError(errMsg);

      try {
        await confirmAction.mutateAsync(
          sanitizeBigInts({
            actionId,
            batchId: '',
            // 0 is "sent or not, unknown": the server keeps the action as submitted, outcome unknown.
            status: isCancelled ? 4001 : outcome === 'not_sent' ? 500 : 0,
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
    handedBefore,
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
