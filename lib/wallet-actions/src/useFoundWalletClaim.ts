// ---------------------------------------------------------------------------
// Found's claim, sent by the wallet the person is using on the page.
//
// The server read the wallet's positions, wrote the calls, checked them with
// its closed guards and simulated them together; this hook only carries those
// exact calls to the wallet, says which transactions it sent, and asks the
// server to check them on Base. It is not the trade path, and three things
// differ from it on purpose:
//   * no `forceAtomic`: each claim pays only this wallet and stands alone, and
//     a Farcaster wallet sends a batch one call after another;
//   * `experimental_fallback`: a wallet without `wallet_sendCalls` is asked
//     for one transaction at a time instead of refusing;
//   * no `dataSuffix` capability: the builder code is already in each call's
//     data, where the guard and the simulation saw it.
// Nothing is retried on its own: a second wallet prompt only ever comes from
// a second press.
// ---------------------------------------------------------------------------

import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAccount, useSendCalls, useSwitchChain } from 'wagmi';
import { base } from 'wagmi/chains';
import { useRecordFoundWalletSubmission } from '@mioagent/api-client-react';
import type { BaseMcpActionReconcileResponseV1 } from '@mioagent/api-spec';

import { callBuilderCodesV1 } from './attribution';
import { isWalletRejectionError, transactionHashesFromReceipts } from './useSubmitApprovedBlueprint';
import { CallsStatusPoller, normalizeCall } from './useWalletConfirmAction';

export interface FoundWalletClaimV1 {
  receiptId: string;
  /** The wallet the server prepared the claim for: the one signed in. */
  walletAddress: string;
  calls: readonly { to: string; value: string; data: string }[];
}

export type FoundWalletClaimStatusV1 =
  | 'idle'
  | 'sending'
  | 'sent'
  | 'checking'
  | 'completed'
  | 'unsettled'
  | 'cancelled'
  | 'failed';

export const FOUND_WALLET_CLAIM_COPY_V1 = {
  noWallet: 'Connect the wallet you signed in with, then confirm.',
  sending: 'Confirm the claim in your wallet.',
  sent: 'Sent from your wallet. Waiting for Base to include it.',
  checking: 'Included on Base. Miorail is checking every claim paid this wallet.',
  completed: 'Claimed. Base shows each prepared claim paying this wallet.',
  unsettled: 'Sent. Base has not shown it to Miorail yet: press Check status in a moment.',
  cancelled: 'Cancelled in your wallet. Nothing was sent.',
  switchChain: 'Your wallet did not switch to Base, so nothing was sent. Switch it to Base and confirm again.',
  noTransaction: 'Your wallet reported the claim as failed and named no transaction. Nothing was claimed; ask again to read what is left.',
  recordFailed: 'Sent from your wallet, but Miorail could not note the transactions just now. Your wallet’s activity shows them; press Check status in a moment.',
} as const;

function shortV1(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Fail-closed checks before the wallet opens. Pure, so it is testable
 * without wagmi. The server would refuse the events of another wallet; this
 * says so before anything is signed. */
export function foundWalletClaimPreflightV1(input: {
  claim: FoundWalletClaimV1 | null;
  connectedAddress: string | undefined;
}): { ok: true } | { ok: false; reason: string } {
  const { claim, connectedAddress } = input;
  if (!claim || !claim.calls.length) return { ok: false, reason: 'There is nothing to confirm for this claim.' };
  if (!connectedAddress) return { ok: false, reason: FOUND_WALLET_CLAIM_COPY_V1.noWallet };
  if (connectedAddress.toLowerCase() !== claim.walletAddress.toLowerCase()) {
    return {
      ok: false,
      reason: `This claim is for ${shortV1(claim.walletAddress)}, and the wallet connected here is ${shortV1(connectedAddress)}. Switch to that account in your wallet, then confirm.`,
    };
  }
  if (claim.calls.some((call) => call.value !== '0' || !/^0x[0-9a-fA-F]{40}$/u.test(call.to))) {
    return { ok: false, reason: 'These calls are not a claim. Nothing was sent.' };
  }
  // The server writes the builder code into every call it prepares; one
  // without it did not come from that path.
  if (claim.calls.some((call) => callBuilderCodesV1(call.data).length === 0)) {
    return { ok: false, reason: 'These calls are not the ones Miorail prepared. Nothing was sent.' };
  }
  return { ok: true };
}

/** What a settled receipt means, in words. */
export function foundWalletClaimOutcomeV1(receipt: BaseMcpActionReconcileResponseV1['receipt']): {
  status: FoundWalletClaimStatusV1;
  error: string | null;
} {
  if (receipt.status === 'completed') return { status: 'completed', error: null };
  if (receipt.status === 'failed' || receipt.status === 'rejected') {
    return {
      status: 'failed',
      error: receipt.errorCode === 'found_claim_reverted'
        ? 'A transaction of this claim reverted on Base, so it is not counted as claimed.'
        : 'Base’s events did not match the prepared claim, so it is not counted as claimed. Your wallet’s activity shows what happened.',
    };
  }
  return { status: 'unsettled', error: null };
}

export interface UseFoundWalletClaimArgsV1 {
  claim: FoundWalletClaimV1 | null;
  /** The page's own reconcile, so one place holds the newest receipt. */
  reconcile: (receiptId: string) => Promise<BaseMcpActionReconcileResponseV1>;
  /** Once the claim has settled, either way. */
  onSettled?: () => void;
  /** Injected in tests. */
  wait?: (ms: number) => Promise<void>;
}

export interface UseFoundWalletClaimResultV1 {
  confirm: () => Promise<void>;
  status: FoundWalletClaimStatusV1;
  /** True from the press until the server has the transactions. */
  busy: boolean;
  /** What is happening now, in words; null at rest. */
  note: string | null;
  error: string | null;
  /** The transactions the wallet reported, linkable while they are checked. */
  transactionHashes: readonly string[];
  /** Mount this; it polls the wallet for the batch once one exists. */
  poller: ReactNode;
}

const CHECKS_V1 = 6;

export function useFoundWalletClaim({ claim, reconcile, onSettled, wait }: UseFoundWalletClaimArgsV1): UseFoundWalletClaimResultV1 {
  const { address, chainId } = useAccount();
  const sendCalls = useSendCalls();
  const { switchChainAsync } = useSwitchChain();
  const record = useRecordFoundWalletSubmission();
  const [status, setStatus] = useState<FoundWalletClaimStatusV1>('idle');
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [transactionHashes, setTransactionHashes] = useState<readonly string[]>([]);
  const inFlight = useRef(false);
  const handled = useRef(false);
  // Which claim a late answer belongs to: a new question must not inherit it.
  const current = useRef<string | null>(null);
  const receiptId = claim?.receiptId ?? null;

  useEffect(() => {
    current.current = receiptId;
    inFlight.current = false;
    handled.current = false;
    setStatus('idle');
    setError(null);
    setBatchId(null);
    setTransactionHashes([]);
  }, [receiptId]);

  const settle = useCallback((id: string, next: FoundWalletClaimStatusV1, message: string | null) => {
    if (current.current !== id) return;
    setStatus(next);
    setError(message);
  }, []);

  const confirm = useCallback(async () => {
    if (!claim || inFlight.current) return;
    const id = claim.receiptId;
    const check = foundWalletClaimPreflightV1({ claim, connectedAddress: address });
    if (!check.ok) {
      settle(id, 'failed', check.reason);
      return;
    }
    inFlight.current = true;
    handled.current = false;
    settle(id, 'sending', null);
    try {
      if (chainId !== base.id) {
        try {
          await switchChainAsync({ chainId: base.id });
        } catch {
          settle(id, 'failed', FOUND_WALLET_CLAIM_COPY_V1.switchChain);
          return;
        }
      }
      const sent = await sendCalls.mutateAsync({
        calls: claim.calls.map(normalizeCall) as unknown as Parameters<typeof sendCalls.mutateAsync>[0]['calls'],
        chainId: base.id,
        experimental_fallback: true,
      });
      if (current.current !== id) return;
      setBatchId(sent.id);
      settle(id, 'sent', null);
    } catch (cause) {
      if (isWalletRejectionError(cause)) settle(id, 'cancelled', FOUND_WALLET_CLAIM_COPY_V1.cancelled);
      else {
        const message = (cause as { shortMessage?: string })?.shortMessage
          ?? (cause instanceof Error ? cause.message : 'The wallet did not send the claim.');
        settle(id, 'failed', `${message} Nothing was claimed.`);
      }
    } finally {
      inFlight.current = false;
    }
  }, [address, chainId, claim, sendCalls, settle, switchChainAsync]);

  const onBatchStatus = useCallback(
    (batch: { status?: string; receipts?: Array<{ transactionHash?: string }> }) => {
      if (!claim || handled.current) return;
      handled.current = true;
      const id = claim.receiptId;
      const hashes = transactionHashesFromReceipts(batch.receipts);
      setBatchId(null);
      if (!hashes.length) {
        settle(id, 'failed', FOUND_WALLET_CLAIM_COPY_V1.noTransaction);
        return;
      }
      setTransactionHashes(hashes);
      settle(id, 'checking', null);
      const pause = wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      void (async () => {
        try {
          await record.mutateAsync({ receiptId: id, transactionHashes: hashes });
        } catch {
          settle(id, 'unsettled', FOUND_WALLET_CLAIM_COPY_V1.recordFailed);
          onSettled?.();
          return;
        }
        // Our RPC can be a block behind the wallet's: a few short looks.
        let outcome: ReturnType<typeof foundWalletClaimOutcomeV1> = { status: 'unsettled', error: null };
        for (let look = 0; look < CHECKS_V1 && outcome.status === 'unsettled'; look += 1) {
          if (look > 0) await pause(2_500);
          if (current.current !== id) return;
          try {
            outcome = foundWalletClaimOutcomeV1((await reconcile(id)).receipt);
          } catch {
            break;
          }
        }
        settle(id, outcome.status, outcome.error);
        onSettled?.();
      })();
    },
    [claim, onSettled, reconcile, record, settle, wait],
  );

  const poller: ReactNode = batchId
    ? createElement(CallsStatusPoller, { batchId, onStatusChange: onBatchStatus })
    : null;

  const note = status === 'sending' ? FOUND_WALLET_CLAIM_COPY_V1.sending
    : status === 'sent' ? FOUND_WALLET_CLAIM_COPY_V1.sent
      : status === 'checking' ? FOUND_WALLET_CLAIM_COPY_V1.checking
        : status === 'completed' ? FOUND_WALLET_CLAIM_COPY_V1.completed
          : status === 'unsettled' && !error ? FOUND_WALLET_CLAIM_COPY_V1.unsettled
            : null;

  return {
    confirm,
    status,
    busy: status === 'sending' || status === 'sent' || status === 'checking',
    note,
    error,
    transactionHashes,
    poller,
  };
}
