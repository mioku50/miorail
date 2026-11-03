import { useCallback, useEffect, useRef, useState } from 'react';
import { spendWalletRequestV1 } from '@mioagent/api-client-react';
import { borrowSubmissionKeyV1, borrowSubmissionLockCopyV1, borrowSubmissionMarkerV1, borrowUserRejectedV1,
  BorrowSubmissionLockedErrorV1, BorrowSubmissionStorageErrorV1, submitBorrowOnceV1, type BorrowSubmissionMarkerV1 } from '../console/borrowSubmissionGuard';
import { walletCannotSendSentenceV1, walletDidNotSendV1 } from '../console/walletBatchSupport';
import { spendWalletViewV1, type SpendWalletViewV1 } from './spendView';

// Still Spend paid from the wallet's own USDC, on the person's page. The
// server prepares one transfer and reads its result from the chain; this hook
// only asks for the review, arms it after a fresh read, hands the one call to
// the wallet, and says what the wallet answered. A wallet answer that may hide
// a sent payment keeps the review locked, here and on the server.

/** What the wallet answered for the one call: a batch id (wallet_sendCalls) or a transaction hash. */
export type SpendWalletSentV1 = { batchId: string } | { transactionHash: string };
type CallV1 = { to: string; value: string; data: string };

export interface StillSpendWalletModelV1 {
  loading: boolean;
  /** The review could not be read at all. */
  error: string | null;
  view: SpendWalletViewV1 | null;
  /** The wallet has the payment, or Still is arming it. */
  busy: boolean;
  walletError: string | null;
  /** This browser already handed this payment to a wallet. */
  lock: string | null;
  onPay: (() => void) | null;
  checking: boolean;
  onCheck: (() => void) | null;
  /** A refused review read again: a refusal can be of a moment (a node a block behind, Bitrefill busy). */
  onRetry: (() => void) | null;
}

const ROOT = '/api/still/spend/orders';
const FINAL = new Set(['confirmed', 'failed', 'refused']);
const ON_ITS_WAY = new Set(['awaiting_wallet', 'submitted', 'unknown']);

function armRefusalV1(error: unknown): string | null {
  const code = (error instanceof Error ? error.message : '').split(':')[0]!.trim();
  switch (code) {
    case 'spend_invoice_has_attempt': return 'A loan from Still already paid this invoice, or tried to. Nothing was sent from your wallet.';
    case 'spend_wallet_not_ready': return 'This payment’s review expired or changed. Read it again before paying; nothing was sent.';
    case 'spend_order_unread': return 'Still no longer holds this Bitrefill invoice: it expired, or the server restarted. Nothing was sent. Open a new one from Spend.';
    case 'spend_pay_off': return 'Paying from Still is turned off on this server. Nothing was sent.';
    default: return null;
  }
}

export function useSpendWalletPaymentV1(input: {
  orderId: string | null;
  sessionWalletAddress: string | null;
  walletAddress: string | null;
  /** Sends the one call: as a batch of one where the wallet sends batches, else as one transaction. */
  send: (call: CallV1) => Promise<SpendWalletSentV1>;
  walletName?: string | null;
  request?: typeof spendWalletRequestV1;
  /** How long between reads of a payment on its way. */
  pollMs?: number;
}): StillSpendWalletModelV1 {
  const request = input.request ?? spendWalletRequestV1;
  const session = input.sessionWalletAddress?.toLowerCase() ?? null, connected = input.walletAddress?.toLowerCase() ?? null;
  const orderId = input.orderId && /^[0-9a-f-]{36}$/.test(input.orderId) ? input.orderId : null;
  const eligible = Boolean(orderId && session && /^0x[0-9a-f]{40}$/.test(session) && session === connected);
  const identity = JSON.stringify([orderId, session, connected]);
  const current = useRef(identity); current.current = identity;
  const alive = useRef(true);
  const pressing = useRef(false);
  const [state, setState] = useState(() => ({ identity, loading: true, error: null as string | null, view: null as SpendWalletViewV1 | null,
    busy: false, walletError: null as string | null, marker: null as BorrowSubmissionMarkerV1 | null, checking: false }));
  const active = state.identity === identity ? state : { ...state, identity, loading: true, error: null, view: null, busy: false, walletError: null, marker: null, checking: false };
  const update = useCallback((patch: Partial<typeof state>) => {
    if (alive.current && current.current === identity) setState((previous) => ({ ...(previous.identity === identity ? previous : { ...previous, identity, loading: true,
      error: null, view: null, busy: false, walletError: null, marker: null, checking: false }), ...patch }));
  }, [identity]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const path = orderId ? `${ROOT}/${orderId}/wallet` : null;

  const review = useCallback(async (): Promise<SpendWalletViewV1> => {
    const view = spendWalletViewV1(await request(path!, { method: 'POST', body: '{}' }));
    if (!view) throw new Error('spend_wallet_unreadable');
    return view;
  }, [path, request]);

  useEffect(() => {
    if (!eligible || !path) { update({ loading: false }); return; }
    let valid = true;
    void (async () => {
      try {
        const key = await borrowSubmissionKeyV1(`spend-wallet/v1:${orderId}`, session);
        let marker: BorrowSubmissionMarkerV1 | null = null;
        try { if (key) marker = borrowSubmissionMarkerV1(window.sessionStorage, key); } catch { marker = 'unknown'; }
        if (!valid) return;
        update({ marker, view: await review(), loading: false });
      } catch {
        if (valid) update({ loading: false, error: 'This payment could not be read. Nothing was sent from your wallet.' });
      }
    })();
    return () => { valid = false; };
  }, [eligible, orderId, path, review, session, update]);

  const read = useCallback(async () => {
    const view = spendWalletViewV1(await request(path!));
    if (view) update({ view });
    return view;
  }, [path, request, update]);

  // A payment on its way is read again until the chain says how it ended.
  const waiting = eligible && active.view !== null && ON_ITS_WAY.has(active.view.state);
  useEffect(() => {
    if (!waiting) return;
    let stopped = false, rounds = 0;
    const tick = async () => {
      if (stopped || rounds++ >= 60) return;
      const view = await read().catch(() => null);
      if (!stopped && (!view || !FINAL.has(view.state))) timer = setTimeout(() => void tick(), input.pollMs ?? 4_000);
    };
    let timer = setTimeout(() => void tick(), input.pollMs ?? 4_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [waiting, read, input.pollMs, identity]);

  const onCheck = useCallback(async () => {
    if (!eligible || active.checking) return;
    update({ checking: true });
    try { await read(); } catch { update({ walletError: 'The result could not be read just now. Nothing more was sent.' }); }
    finally { update({ checking: false }); }
  }, [active.checking, eligible, read, update]);

  const onRetry = useCallback(async () => {
    if (!eligible || active.checking || active.view?.state !== 'refused') return;
    update({ checking: true, walletError: null });
    try { update({ view: await review() }); } catch { update({ walletError: 'This payment could not be read again just now. Nothing was sent from your wallet.' }); }
    finally { update({ checking: false }); }
  }, [active.checking, active.view?.state, eligible, review, update]);

  const onPay = useCallback(async () => {
    const shown = active.view;
    if (!eligible || !path || pressing.current || active.marker || shown?.state !== 'ready' || !shown.ready) return;
    pressing.current = true; update({ busy: true, walletError: null });
    let handedToWallet = false, storage: Storage | null = null, key: string | null = null;
    try {
      // A fresh reading first: the wallet is asked only for what was just checked again, and only if it is what the person read.
      const fresh = await review();
      if (current.current !== identity) return;
      if (fresh.state !== 'ready' || !fresh.ready) { update({ view: fresh }); return; }
      if (fresh.ready.callsHash !== shown.ready.callsHash || fresh.ready.signingTermsHash !== shown.ready.signingTermsHash) {
        update({ view: fresh, walletError: 'The payment changed since you read it. Read it again, then press Pay once more; nothing was sent.' });
        return;
      }
      update({ view: fresh });
      try { key = await borrowSubmissionKeyV1(`spend-wallet/v1:${orderId}`, session); storage = window.sessionStorage; } catch { throw new BorrowSubmissionStorageErrorV1(); }
      if (!key) throw new BorrowSubmissionStorageErrorV1();
      const ready = fresh.ready;
      await submitBorrowOnceV1({ key, storage, enteredWallet: () => handedToWallet, send: async () => {
        const arm = await request<{ attemptId?: unknown }>(`${path}/arm`, { method: 'POST', body: JSON.stringify({ callsHash: ready.callsHash, signingTermsHash: ready.signingTermsHash }) });
        if (typeof arm.attemptId !== 'string' || !/^[0-9a-f-]{36}$/.test(arm.attemptId)) throw new Error('spend_wallet_arm_unreadable');
        const report = async (body: Record<string, unknown>) => {
          const saved = spendWalletViewV1(await request(`${path}/submission`, { method: 'POST', body: JSON.stringify({ attemptId: arm.attemptId, ...body }) }));
          if (saved) update({ view: saved });
        };
        let sent: SpendWalletSentV1;
        try {
          handedToWallet = true;
          sent = await input.send(ready.calls[0]!);
        } catch (error) {
          // A refusal, or a wallet that cannot do this at all, sent nothing; anything else may have been sent.
          await report({ outcome: walletDidNotSendV1(error) ? 'rejected' : 'unknown' }).catch(() => undefined);
          throw error;
        }
        await report({ outcome: 'submitted', ...sent }).catch(() => {
          update({ walletError: 'Your wallet sent the payment, and Still could not record it just now. Do not pay again; its result is read from Base.' });
        });
        return 'batchId' in sent ? sent.batchId : sent.transactionHash;
      } });
    } catch (error) {
      update({ walletError: borrowUserRejectedV1(error) ? 'You declined in your wallet. Nothing was sent.'
        : walletCannotSendSentenceV1(error, input.walletName) ?? armRefusalV1(error)
          ?? (error instanceof BorrowSubmissionStorageErrorV1 || error instanceof BorrowSubmissionLockedErrorV1 ? error.message
            : handedToWallet ? 'Your wallet did not say whether it sent the payment. Check its activity before paying again; Still reads the result from Base.'
              : 'The payment could not be prepared for your wallet. Your wallet was not asked.') });
    } finally {
      pressing.current = false;
      try { if (storage && key) update({ marker: borrowSubmissionMarkerV1(storage, key) }); } catch { update({ marker: 'unknown' }); }
      update({ busy: false });
      // What the server holds now, whichever way the press ended.
      await read().catch(() => null);
    }
  }, [active.marker, active.view, eligible, identity, input, orderId, path, read, request, review, session, update]);

  const ready = eligible && active.view?.state === 'ready' && active.view.ready !== null;
  return {
    loading: eligible && active.loading,
    error: !eligible ? 'Sign in and connect the wallet that opened this invoice to pay it.' : active.error,
    view: eligible ? active.view : null,
    busy: eligible && active.busy,
    walletError: eligible ? active.walletError : null,
    // A marker without a server attempt (the server says ready) still holds: this browser handed the payment over once.
    lock: eligible && active.marker ? borrowSubmissionLockCopyV1(active.marker) : null,
    onPay: ready && !active.marker && !active.busy ? () => void onPay() : null,
    checking: eligible && active.checking,
    onCheck: eligible && active.view !== null && !FINAL.has(active.view.state) && active.view.state !== 'ready' ? () => void onCheck() : null,
    onRetry: eligible && active.view?.state === 'refused' ? () => void onRetry() : null,
  };
}
