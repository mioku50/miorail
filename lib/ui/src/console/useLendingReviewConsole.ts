import { useCallback, useEffect, useRef, useState } from 'react';
import { lendingRequestV1 } from '@mioagent/api-client-react';
import { handOffFreshBorrowV1 } from './borrowReviewFreshness';
import { borrowSubmissionKeyV1, borrowSubmissionMarkerV1, borrowSubmissionLockCopyV1, borrowUserRejectedV1,
  BorrowSubmissionStorageErrorV1, submitBorrowOnceV1, type BorrowSubmissionMarkerV1 } from './borrowSubmissionGuard';
import { walletCannotSendSentenceV1, walletDidNotSendV1 } from './walletBatchSupport';
import { describeLendingTermsChangesV1, parseLendingExecutionWireV1, parseLendingReviewWireV1,
  type LendingExecutionWireV1, type LendingReadyWireV1, type LendingReviewWireV1 } from './lendingReviewView';

const ROOT = '/api/route-intelligence/rwa/lending';
type CallsV1 = LendingReadyWireV1['calls'];
interface StateV1 {
  identity: string; loading: boolean; body: LendingReviewWireV1 | null; error: string | null;
  walletError: string | null; walletBusy: boolean; checking: boolean;
  marker: BorrowSubmissionMarkerV1 | null; batchId: string | null; execution: LendingExecutionWireV1 | null;
  transactionHint: string;
}
const initial = (identity: string): StateV1 => ({ identity, loading: true, body: null, error: null, walletError: null,
  walletBusy: false, checking: false, marker: null, batchId: null, execution: null, transactionHint: '' });
const address = (value: string | null): value is string => value !== null && /^0x[0-9a-f]{40}$/i.test(value);
const readableError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  if (/authentication_required|wrong_wallet/.test(message)) return 'Sign in and connect the wallet this review was prepared for.';
  if (/draft_expired/.test(message)) return 'This review link expired. Open a new review for a fresh measurement.';
  if (/draft_malformed|signature_invalid/.test(message)) return 'This review link could not be verified. Nothing was prepared.';
  return 'The review could not be read. No wallet request was made.';
};

export interface LendingReviewConsoleModelV1 {
  loading: boolean; error: string | null; body: LendingReviewWireV1 | null;
  walletBusy: boolean; walletError: string | null; submissionLock: string | null; batchId: string | null;
  execution: LendingExecutionWireV1 | null; checking: boolean;
  onOpen: (() => void) | null; onCheck: (() => void) | null;
  transactionHint?: string;
  onTransactionHint?: (value: string) => void;
  onFindTransaction?: (() => void) | null;
}

/** One signed-in session and one connected wallet own this hook's state.
 * Stale asynchronous answers are masked during render, before effects clear
 * them. The only wallet entry is an explicit click after a fresh server read. */
export function useLendingReviewConsoleV1(input: {
  draft: string | null;
  sessionWalletAddress: string | null;
  walletAddress: string | null;
  sendCalls: (batch: { calls: CallsV1 }) => Promise<string | null>;
  /** Why the connected wallet cannot send one batch, read from the wallet by
   * the host before anything is opened. The wallet button is not offered. */
  walletBlocker?: string | null;
  /** The connected wallet's own name, for its refusals. */
  walletName?: string | null;
}): { model: LendingReviewConsoleModelV1; body: LendingReviewWireV1 | null } {
  const session = input.sessionWalletAddress?.toLowerCase() ?? null;
  const connected = input.walletAddress?.toLowerCase() ?? null;
  const eligible = Boolean(input.draft && address(session) && session === connected);
  const identity = JSON.stringify([input.draft, session, connected]);
  const current = useRef(identity); current.current = identity;
  const alive = useRef(true);
  const opening = useRef(false);
  const confirmed = useRef<{ identity: string; hash: string } | null>(null);
  const [state, setState] = useState<StateV1>(() => initial(identity));
  const active = state.identity === identity ? state : initial(identity);
  const update = useCallback((patch: Partial<StateV1>) => {
    if (alive.current && current.current === identity) setState(previous => ({ ...(previous.identity === identity ? previous : initial(identity)), ...patch }));
  }, [identity]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const read = useCallback(async (): Promise<LendingReviewWireV1> => {
    try {
      const answer = parseLendingReviewWireV1(await lendingRequestV1(`${ROOT}/review/${encodeURIComponent(input.draft ?? '')}`));
      if (!answer) throw new Error('lending_review_unreadable');
      update({ body: answer, loading: false, error: null });
      return answer;
    } catch (error) { update({ body: null, loading: false, error: readableError(error) }); throw error; }
  }, [input.draft, update]);

  useEffect(() => {
    let valid = true;
    confirmed.current = null;
    setState(initial(identity));
    if (!eligible) { update({ loading: false }); return; }
    void (async () => {
      try {
        const key = await borrowSubmissionKeyV1(`lending/v1:${input.draft}`, session);
        let marker: BorrowSubmissionMarkerV1 | null = null;
        if (key) marker = borrowSubmissionMarkerV1(window.sessionStorage, key);
        if (!valid || current.current !== identity) return;
        update({ marker });
        await read();
      } catch (error) { if (valid) update({ loading: false, error: readableError(error) }); }
    })();
    return () => { valid = false; };
  }, [eligible, identity, input.draft, read, session, update]);

  const executionId = active.body?.executionId ?? active.execution?.executionId ?? null;
  const onCheck = useCallback(async () => {
    if (!eligible || !executionId || active.checking) return;
    update({ checking: true, walletError: null });
    try {
      const answer = parseLendingExecutionWireV1(await lendingRequestV1(`${ROOT}/executions/${encodeURIComponent(executionId)}`), executionId);
      if (!answer) throw new Error('lending_execution_unreadable');
      update({ execution: answer });
    } catch { update({ walletError: 'The onchain result could not be read. The submission remains unconfirmed, and this review will not be sent again.' }); }
    finally { update({ checking: false }); }
  }, [active.checking, eligible, executionId, update]);

  const onFindTransaction = useCallback(async () => {
    if (!eligible || !executionId || active.checking || current.current !== identity) return;
    const hash = active.transactionHint.trim();
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) { update({ walletError: 'Paste the full transaction hash from your wallet activity.' }); return; }
    update({ checking: true, walletError: null });
    try {
      const saved = parseLendingExecutionWireV1(await lendingRequestV1(`${ROOT}/executions/${encodeURIComponent(executionId)}/transaction`, {
        method: 'POST', body: JSON.stringify({ transactionHash: hash }),
      }), executionId);
      if (!saved || current.current !== identity) return;
      update({ execution: saved });
      const checked = parseLendingExecutionWireV1(await lendingRequestV1(`${ROOT}/executions/${encodeURIComponent(executionId)}`), executionId);
      if (!checked) throw new Error('lending_execution_unreadable');
      update({ execution: checked });
    } catch { update({ walletError: 'The transaction could not be verified. No new wallet request was made; this review remains locked.' }); }
    finally { update({ checking: false }); }
  }, [active.checking, active.transactionHint, eligible, executionId, identity, update]);

  const onOpen = useCallback(async () => {
    if (!eligible || active.body?.state !== 'ready' || opening.current || active.marker || active.batchId ||
        (active.execution && active.execution.state !== 'ready')) return;
    opening.current = true; update({ walletBusy: true, walletError: null });
    const previous = active.body;
    let approved = active.body;
    let handedToWallet = false;
    try {
      const result = await handOffFreshBorrowV1({ seen: approved, confirmedTermsHash: confirmed.current?.identity === identity ? confirmed.current.hash : null,
        maxCalls: 8, current: () => alive.current && current.current === identity,
        refresh: async () => { const fresh = await read(); if (fresh.state === 'ready') approved = fresh; return fresh; },
        send: async calls => {
          let key: string | null;
          try { key = await borrowSubmissionKeyV1(`lending/v1:${input.draft}`, session); } catch { throw new BorrowSubmissionStorageErrorV1(); }
          if (!key) throw new BorrowSubmissionStorageErrorV1();
          let storage: Storage;
          try { storage = window.sessionStorage; } catch { throw new BorrowSubmissionStorageErrorV1(); }
          try {
            return await submitBorrowOnceV1({ key, storage, enteredWallet: () => handedToWallet, send: async () => {
              if (current.current !== identity) throw new Error('lending_identity_changed');
              const arm = await lendingRequestV1<{ attemptId?: unknown }>(`${ROOT}/executions/${encodeURIComponent(approved.executionId)}/arm`,
                { method: 'POST', body: JSON.stringify({ callsHash: approved.callsHash, signingTermsHash: approved.signingTermsHash }) });
              if (typeof arm.attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(arm.attemptId)) throw new Error('lending_arm_unreadable');
              const report = async (outcome: 'submitted' | 'unknown' | 'rejected', batchId?: string) => {
                if (current.current !== identity || !alive.current) throw new Error('lending_identity_changed');
                await lendingRequestV1(`${ROOT}/executions/${encodeURIComponent(approved.executionId)}/submission`,
                  { method: 'POST', body: JSON.stringify({ attemptId: arm.attemptId, outcome, ...(batchId ? { batchId } : {}) }) });
              };
              if (current.current !== identity) { await report('unknown').catch(() => undefined); throw new Error('lending_identity_changed'); }
              try {
                handedToWallet = true;
                const batchId = await input.sendCalls({ calls });
                await report(batchId ? 'submitted' : 'unknown', batchId ?? undefined).catch(() => {
                  update({ walletError: 'Your wallet returned, but the submission record could not be updated. Check the onchain result before taking another action.' });
                });
                return batchId;
              } catch (error) {
                // A refusal, or a wallet that cannot send a batch at all, sent
                // nothing; anything else may have been sent.
                await report(walletDidNotSendV1(error) ? 'rejected' : 'unknown').catch(() => undefined);
                throw error;
              }
            } });
          } finally {
            try { update({ marker: borrowSubmissionMarkerV1(storage, key) }); } catch { update({ marker: 'unknown' }); }
          }
        },
      });
      if (current.current !== identity) return;
      if (result.state === 'review_changed') {
        confirmed.current = { identity, hash: result.termsHash };
        update({ walletError: previous !== approved ? describeLendingTermsChangesV1(previous, approved) : result.message });
      }
      else {
        confirmed.current = null;
        if (result.state === 'refused') update({ walletError: result.message });
        else update({ batchId: result.batchId, ...(!result.batchId ? { walletError: 'Your wallet did not return a batch ID. The result is unknown. Check wallet activity; this review will not be sent again.' } : {}) });
      }
    } catch (error) {
      confirmed.current = null;
      update({ walletError: borrowUserRejectedV1(error) ? 'You declined in your wallet. Nothing was sent.'
        : walletCannotSendSentenceV1(error, input.walletName) ?? (error instanceof BorrowSubmissionStorageErrorV1 ? error.message
          : handedToWallet ? 'The wallet result is unknown. Check its activity and the onchain result; this review will not be sent again.'
            : 'The wallet request could not be armed. Your wallet was not asked. Check this review’s recorded result before trying another action.') });
    } finally { opening.current = false; update({ walletBusy: false }); }
  }, [active, eligible, identity, input, read, session, update]);

  const locked = Boolean(active.marker || active.batchId || (active.execution && active.execution.state !== 'ready') || active.body?.state === 'refused');
  return { body: eligible ? active.body : null, model: {
    loading: eligible && active.loading, error: !eligible ? 'Sign in and connect the same wallet to read this private review.' : active.error,
    body: eligible ? active.body : null, walletBusy: eligible && active.walletBusy,
    // The wallet's own answer about itself is said before the button would be.
    walletError: eligible ? active.walletError ?? (active.body?.state === 'ready' && !locked ? input.walletBlocker ?? null : null) : null,
    batchId: eligible ? active.batchId : null, execution: eligible ? active.execution : null, checking: eligible && active.checking,
    submissionLock: eligible && active.marker ? borrowSubmissionLockCopyV1(active.marker) : null,
    onOpen: eligible && active.body?.state === 'ready' && !locked && !input.walletBlocker ? () => void onOpen() : null,
    onCheck: eligible && executionId ? () => void onCheck() : null,
    transactionHint: eligible ? active.transactionHint : '',
    onTransactionHint: eligible ? value => update({ transactionHint: value }) : undefined,
    onFindTransaction: eligible && executionId && locked && !['confirmed','failed'].includes(active.execution?.state ?? '') ? () => void onFindTransaction() : null,
  } };
}
