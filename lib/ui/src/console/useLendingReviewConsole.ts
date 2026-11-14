import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lendingRequestV1 } from '@mioagent/api-client-react';
import { handOffFreshBorrowV1 } from './borrowReviewFreshness';
import { borrowSubmissionKeyV1, borrowSubmissionMarkerV1, borrowSubmissionLockCopyV1, borrowUserRejectedV1,
  BorrowSubmissionStorageErrorV1, submitBorrowOnceV1, type BorrowSubmissionMarkerV1 } from './borrowSubmissionGuard';
import { WALLET_CONNECTION_NOT_READY_V1, sendRetryingWalletNetworkV1, walletCannotSendSentenceV1, walletConnectionNotReadyV1, walletDidNotSendV1,
  walletNetworkFailureSentenceV1, walletNotAskedSentenceV1 } from './walletBatchSupport';
import { describeLendingTermsChangesV1, LENDING_FOLLOW_MS_V1, lendingBackLinkV1, lendingFollowsResultV1, lendingHeldByWireV1, lendingReviewReadsTheSameV1, parseLendingExecutionWireV1,
  parseLendingFeeSponsorV1, parseLendingReviewWireV1, type LendingExecutionStateV1, type LendingExecutionWireV1, type LendingFeeSponsorV1, type LendingReadyWireV1,
  type LendingHeldByV1, type LendingReviewWireV1 } from './lendingReviewView';

const ROOT = '/api/route-intelligence/rwa/lending';
type CallsV1 = LendingReadyWireV1['calls'];

/** Where a loan in steps stands: which step, and whether the wallet, the chain or Still has it. */
export interface LendingStepProgressV1 { index: number; total: number; phase: 'wallet' | 'confirming' | 'checking' }
/** A wallet that cannot send a batch: one call as one transaction, and how it ended once mined. */
export interface LendingStepsWalletV1 {
  /** `beforeWallet` is the host's last step before the wallet opens, after its own waits (a restored
   * connection, a gas measure): it throws when the person has left, and then the wallet is not asked. */
  send: (call: CallsV1[number], beforeWallet?: () => Promise<void>) => Promise<string>;
  receipt: (hash: string) => Promise<'success' | 'reverted' | null>;
}
/** The steps stopped after some landed: what landed is recorded, and the person is told what it means. */
export class LendingStepsStoppedV1 extends Error {
  readonly batchId: string | null;
  /** The server's own code for why it stopped them, when it did. */
  readonly refusal: string | null;
  constructor(message: string, batchId: string | null, refusal: string | null = null) { super(message); this.batchId = batchId; this.refusal = refusal; }
}
export function stepsStoppedV1(operation: 'borrow' | 'repay', index: number, total: number, detail: string | null, paying = false, returning = false): string {
  // A Spend loan pays last: with every step but the payment in place, the loan was taken and Bitrefill was not paid.
  if (paying && operation === 'borrow' && index === total - 1) {
    return `${detail ? `${detail} ` : 'The payment to Bitrefill was not sent. '}The loan is in place and the USDC is in your wallet. Repay it, or open Spend for a new invoice.`;
  }
  // Repay all and take the collateral back takes it back last: with every step but that one in place, the
  // debt was repaid (re-audit R4, 2026-11-04: this said "nothing was repaid").
  if (returning && operation === 'repay' && index === total - 1 && total > 1) {
    return `${detail ? `${detail} ` : `Step ${total} of ${total} was not sent. `}Your debt is repaid, and your collateral was not taken back yet. Open Repay to take it back.`;
  }
  const kept = index === 1 ? 'Step 1 is in place' : `Steps 1–${index} are in place`;
  const after = operation === 'borrow' ? 'and no loan was taken. Open Get money again to go on from here.' : 'and nothing was repaid. Open Repay again to go on from here.';
  return `${detail ? `${detail} ` : `Step ${index + 1} of ${total} was not sent. `}${kept}, ${after}`;
}
/** A later step the wallet may have sent: what landed is in place, and nothing is claimed about the rest until the chain says. */
export function stepsUnknownV1(operation: 'borrow' | 'repay', index: number, total: number, paying = false, returning = false): string {
  // The payment may have gone, so where the USDC is is not said (re-audit R4, 2026-11-04).
  if (paying && operation === 'borrow' && index === total - 1) {
    return 'The wallet did not say whether it sent the payment to Bitrefill. The loan is in place, and its USDC is either still in your wallet or already with Bitrefill. Check the onchain result before paying again or repaying.';
  }
  if (returning && operation === 'repay' && index === total - 1 && total > 1) {
    return `The wallet did not say whether it sent step ${total} of ${total}, which takes your collateral back. Your debt is repaid; check the onchain result before pressing again.`;
  }
  const kept = index === 1 ? 'Step 1 is in place' : `Steps 1–${index} are in place`;
  return `The wallet did not say whether it sent step ${index + 1} of ${total}. ${kept}; check the onchain result before pressing again.`;
}

interface StateV1 {
  identity: string; loading: boolean; body: LendingReviewWireV1 | null; error: string | null;
  walletError: string | null; walletBusy: boolean; checking: boolean;
  marker: BorrowSubmissionMarkerV1 | null; batchId: string | null; execution: LendingExecutionWireV1 | null;
  transactionHint: string; step: LendingStepProgressV1 | null;
  /** Why the server stopped this loan's steps, by its own code. */
  stepsRefusal: string | null;
  /** The last press found the terms changed and showed the new ones: the next press accepts them. */
  termsChanged: boolean;
  /** The page is reading the result from Base by itself (LENDING_FOLLOW_MS_V1). */
  following: boolean;
  /** Those reads ran out with no final answer from Base, so the press is offered. */
  followEnded: boolean;
  /** The attempt that holds this market, as the arm's refusal named it (audit UI-19). */
  heldBy: LendingHeldByV1 | null;
  /** The first of the release's two readings: the page asks again with this note at its time (audit LL-1). */
  releaseCheck: { check: string; checkAgainAt: string } | null;
}
const initial = (identity: string): StateV1 => ({ identity, loading: true, body: null, error: null, walletError: null,
  walletBusy: false, checking: false, marker: null, batchId: null, execution: null, transactionHint: '', step: null, stepsRefusal: null,
  termsChanged: false, following: false, followEnded: false, heldBy: null, releaseCheck: null });
const FINAL_STATES_V1: ReadonlySet<LendingExecutionStateV1> = new Set(['confirmed', 'failed']);
const address = (value: string | null): value is string => value !== null && /^0x[0-9a-f]{40}$/i.test(value);
/** The server's own sentence for a refusal it names (`code: detail`), or null for anything else. */
function serverDetailV1(error: unknown, codes: RegExp): string | null {
  const message = error instanceof Error ? error.message : '';
  const at = message.indexOf(': ');
  return at > 0 && codes.test(message.slice(0, at)) && message.length > at + 2 ? message.slice(at + 2) : null;
}
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
  /** The terms moved while the person read them, and the page now shows the new ones: nothing failed, and
   * the same button accepts them. Said as that, by the button, not as an error under the page (2026-11-11:
   * a red line after the first press, and no word that pressing again was the way on). */
  termsChanged?: boolean;
  /** The page where the wallet's own USDC pays this loan's invoice, when its steps stopped before the payment. */
  walletPayPath?: string | null;
  onOpen: (() => void) | null; onCheck: (() => void) | null;
  transactionHint?: string;
  onTransactionHint?: (value: string) => void;
  onFindTransaction?: (() => void) | null;
  /** A loan in steps left part way: stop it after the steps that landed (the server checks Base first). */
  onStop?: (() => void) | null;
  /** Releases an attempt its wallet never sent, when the server offers it. */
  onRelease?: (() => void) | null;
  /** The release read Base once and found nothing of it: it reads again by itself at this time. */
  releaseCheckAgainAt?: string | null;
  /** The attempt that holds this market, with its own review, when an arm was refused for it (audit UI-19). */
  heldBy?: LendingHeldByV1 | null;
  /** A loan in steps, while it is being sent. */
  step?: LendingStepProgressV1 | null;
  /** The page that asked this review, offered when it is refused or cannot be read. */
  back?: { href: string; label: string } | null;
  /** Said beside the wallet button of a batch: Still offers to pay the network fee. */
  feeNote?: string | null;
  /** The page is reading the result from Base by itself; nothing needs pressing. */
  following?: boolean;
  /** Those reads ended with no final answer from Base: the press reads it once more. */
  followEnded?: boolean;
}

/** One signed-in session and one connected wallet own this hook's state.
 * Stale asynchronous answers are masked during render, before effects clear
 * them. The only wallet entry is an explicit click after a fresh server read. */
export function useLendingReviewConsoleV1(input: {
  draft: string | null;
  sessionWalletAddress: string | null;
  walletAddress: string | null;
  /** One batch to the wallet. `sponsorship` is Still's offer to pay its network fee, when the arm made
   * one: the host hands it to a wallet that takes a fee sponsor, and may ignore it. */
  /** `beforeWallet`: the host calls it as its last step before the wallet opens, after its own waits; it
   * throws when the person has left or another wallet signed in, and then the wallet is not asked. */
  sendCalls: (batch: { calls: CallsV1; sponsorship?: LendingFeeSponsorV1 | null; beforeWallet: () => Promise<void> }) => Promise<string | null>;
  /** What the host may say about the fee before the press (`lendingFeeNoteV1`); shown for a batch only. */
  feeNote?: string | null;
  /** Why the connected wallet cannot send one batch, read from the wallet by
   * the host before anything is opened. The wallet button is not offered. */
  walletBlocker?: string | null;
  /** The connected wallet's own name, for its refusals. */
  walletName?: string | null;
  /** Told when the wallet refused because of what it is, so the host stops
   * offering it a batch before the next press. */
  onWalletRefusal?: (error: unknown) => void;
  /** For a wallet that cannot send a batch: the review is asked for steps,
   * and a review granted in steps goes one transaction at a time. */
  steps?: LendingStepsWalletV1 | null;
  /** How the review and its execution are asked for: the page's own session by
   * default; Still's card in an assistant's chat asks through the MCP host. */
  request?: typeof lendingRequestV1;
  /** A new value reads the review again from the start: after the person confirmed they are not a
   * US person, a review refused for want of that confirmation (2026-11-10). */
  rereadKey?: number;
  /** Reads the result from Base by itself once something was sent (the default). Still's card in an
   * assistant's chat sets false: it follows the wallet's own status on its own clock (StillCardSign). */
  autoResult?: boolean;
  /** The waits between those reads; tests make them short. */
  followMs?: readonly number[];
}): { model: LendingReviewConsoleModelV1; body: LendingReviewWireV1 | null } {
  const request = input.request ?? lendingRequestV1;
  const session = input.sessionWalletAddress?.toLowerCase() ?? null;
  const connected = input.walletAddress?.toLowerCase() ?? null;
  const eligible = Boolean(input.draft && address(session) && session === connected);
  const sequential = Boolean(input.steps);
  const identity = JSON.stringify([input.draft, session, connected, sequential, input.rereadKey ?? 0]);
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
      const answer = parseLendingReviewWireV1(await request(`${ROOT}/review/${encodeURIComponent(input.draft ?? '')}${sequential ? '?delivery=sequential' : ''}`));
      if (!answer) throw new Error('lending_review_unreadable');
      update({ body: answer, loading: false, error: null });
      return answer;
    } catch (error) { update({ body: null, loading: false, error: readableError(error) }); throw error; }
  }, [input.draft, request, sequential, update]);

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
      const answer = parseLendingExecutionWireV1(await request(`${ROOT}/executions/${encodeURIComponent(executionId)}`), executionId);
      if (!answer) throw new Error('lending_execution_unreadable');
      update({ execution: answer });
    } catch { update({ walletError: 'The onchain result could not be read. The submission remains unconfirmed, and this review will not be sent again.' }); }
    finally { update({ checking: false }); }
  }, [active.checking, eligible, executionId, request, update]);

  // What was sent, as far as this page knows: the server's word, else a batch the wallet just returned,
  // else this browser's own record of a submission (a marker survives a reload; the review does not).
  const serverState: LendingExecutionStateV1 | undefined = active.execution?.state
    ?? (active.body?.state === 'refused' ? active.body.executionState : undefined);
  const sentState: LendingExecutionStateV1 | null = serverState ?? (active.batchId ? 'submitted' : active.marker ? 'unknown' : null);
  const autoResult = input.autoResult !== false;
  // Read by itself while Base owes an answer, and not while the wallet or a step is still under way.
  const follows = eligible && Boolean(executionId) && autoResult && !active.walletBusy && !active.step &&
    lendingFollowsResultV1({ state: sentState, batchId: active.batchId, transactionHash: active.execution?.transactionHash ?? null });
  // One allowance of reads per execution on this page. A state that moves between "submitted" and
  // "unknown" while Base catches up must not start the allowance over, or the reads would never end.
  const followed = useRef<{ executionId: string; reads: number } | null>(null);
  // By value: a schedule written inline is a new array on every render, and the reads would restart with each.
  const followKey = input.followMs ? input.followMs.join(',') : '';
  const followMs = useMemo(() => (followKey ? followKey.split(',').map(Number) : LENDING_FOLLOW_MS_V1), [followKey]);
  useEffect(() => {
    if (!follows || !executionId) return undefined;
    if (followed.current?.executionId !== executionId) followed.current = { executionId, reads: 0 };
    const allowance = followed.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      if (stopped) return;
      if (allowance.reads >= followMs.length) { update({ following: false, followEnded: true }); return; }
      timer = setTimeout(() => void (async () => {
        allowance.reads += 1;
        // A read that fails is followed by the next one; the press is offered when they run out.
        const answer: LendingExecutionWireV1 | null = await request(`${ROOT}/executions/${encodeURIComponent(executionId)}`)
          .then(value => parseLendingExecutionWireV1(value, executionId), () => null);
        if (stopped || current.current !== identity) return;
        if (answer) update({ execution: answer });
        if (answer && FINAL_STATES_V1.has(answer.state)) { update({ following: false, followEnded: false }); return; }
        next();
      })(), followMs[allowance.reads]);
    };
    update({ following: true, followEnded: false });
    next();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [executionId, followMs, follows, identity, request, update]);

  const onFindTransaction = useCallback(async () => {
    if (!eligible || !executionId || active.checking || current.current !== identity) return;
    const hash = active.transactionHint.trim();
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) { update({ walletError: 'Paste the full transaction hash from your wallet activity.' }); return; }
    update({ checking: true, walletError: null });
    try {
      const saved = parseLendingExecutionWireV1(await request(`${ROOT}/executions/${encodeURIComponent(executionId)}/transaction`, {
        method: 'POST', body: JSON.stringify({ transactionHash: hash }),
      }), executionId);
      if (!saved || current.current !== identity) return;
      update({ execution: saved });
      const checked = parseLendingExecutionWireV1(await request(`${ROOT}/executions/${encodeURIComponent(executionId)}`), executionId);
      if (!checked) throw new Error('lending_execution_unreadable');
      update({ execution: checked });
    } catch (error) {
      // A stopped loan in steps is not locked by a hash that is not its next step; the server says so.
      update({ walletError: serverDetailV1(error, /^(?:loan_step_not_matched|loan_receipt_not_matched|lending_market_held)$/) ?? 'The transaction could not be verified. No new wallet request was made; this review remains locked.' });
    }
    finally { update({ checking: false }); }
  }, [active.checking, active.transactionHint, eligible, executionId, identity, request, update]);

  // Stopped here only when Base shows the wallet sent nothing after the last landed step; the server says why not.
  const onStop = useCallback(async () => {
    if (!eligible || !executionId || active.checking || active.walletBusy || current.current !== identity) return;
    update({ checking: true, walletError: null });
    try {
      const stopped = parseLendingExecutionWireV1(await request(`${ROOT}/executions/${encodeURIComponent(executionId)}/stop`, {
        method: 'POST', body: JSON.stringify({}),
      }), executionId);
      if (!stopped) throw new Error('lending_execution_unreadable');
      update({ execution: stopped });
    } catch (error) {
      update({ walletError: serverDetailV1(error, /^(?:lending_attempt_changed|loan_steps_[a-z_]+|loan_step_[a-z_]+|loan_receipt_[a-z_]+)$/)
        ?? 'Still could not stop this loan just now. Nothing was changed; check the onchain result.' });
    }
    finally { update({ checking: false }); }
  }, [active.checking, active.walletBusy, eligible, executionId, identity, request, update]);

  const onOpen = useCallback(async () => {
    if (!eligible || active.body?.state !== 'ready' || opening.current || active.marker || active.batchId ||
        (active.execution && active.execution.state !== 'ready')) return;
    opening.current = true; update({ walletBusy: true, walletError: null, termsChanged: false });
    const previous = active.body;
    let approved = active.body;
    let handedToWallet = false;
    try {
      const result = await handOffFreshBorrowV1({ seen: approved, confirmedTermsHash: confirmed.current?.identity === identity ? confirmed.current.hash : null,
        maxCalls: 8, current: () => alive.current && current.current === identity,
        // Calls prepared again for this moment, under every figure and step the person just read, go on at once.
        readsTheSame: (seen, fresh) => seen.state === 'ready' && fresh.state === 'ready' &&
          lendingReviewReadsTheSameV1(seen as LendingReadyWireV1, fresh as LendingReadyWireV1),
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
              const arm = await request<{ attemptId?: unknown; sponsorship?: unknown }>(`${ROOT}/executions/${encodeURIComponent(approved.executionId)}/arm`,
                { method: 'POST', body: JSON.stringify({ callsHash: approved.callsHash, signingTermsHash: approved.signingTermsHash }) });
              if (typeof arm.attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(arm.attemptId)) throw new Error('lending_arm_unreadable');
              // Still's offer to pay this batch's network fee, bound by the server to these calls; anything else is none.
              const sponsorship = parseLendingFeeSponsorV1(arm.sponsorship);
              // Addressed to this arm's own attempt, so it is sent after the page was left too: the wallet's answer is
              // the record, and without it the review would hold the market until its owner released it (audit WAL-3).
              const report = async (outcome: 'submitted' | 'unknown' | 'rejected' | 'stopped', batchId?: string) => {
                if (current.current !== identity) throw new Error('lending_identity_changed');
                await request(`${ROOT}/executions/${encodeURIComponent(approved.executionId)}/submission`,
                  { method: 'POST', body: JSON.stringify({ attemptId: arm.attemptId, outcome, ...(batchId ? { batchId } : {}) }) });
              };
              // The wallet was never asked for this arm: it goes back as not sent, for its own attempt, so the
              // review is ready again. Only while the session is still this wallet's; another wallet leaves it.
              const release = () => current.current === identity
                ? request(`${ROOT}/executions/${encodeURIComponent(approved.executionId)}/submission`,
                  { method: 'POST', body: JSON.stringify({ attemptId: arm.attemptId, outcome: 'rejected' }) }).catch(() => undefined)
                : Promise.resolve();
              // Left while the arm was answered (another wallet, or the page closed): the wallet is not asked, so no
              // prompt opens after the person has gone, with nobody left to record what it sent (final audit FA2).
              if (current.current !== identity || !alive.current) { await release(); throw new Error('lending_identity_changed'); }
              // The same question again at the host's last step before the wallet opens: its own waits come after
              // this point (a restored connection up to 93 s, a gas measure up to 2.5 s), and a person who left in
              // them had a wallet prompt open after them all the same (audit WAL-3, 2026-11-14).
              let left = false;
              const beforeWallet = async () => {
                if (current.current === identity && alive.current) return;
                left = true;
                await release();
                throw new Error('lending_identity_changed');
              };
              if (approved.delivery === 'sequential') {
                if (!input.steps) { await report('rejected').catch(() => undefined); throw new Error('lending_steps_unavailable'); }
                // One transaction per call. After each lands, Still reads it from the
                // chain and runs the review again before the wallet is asked for the next.
                const wallet = input.steps, operation = approved.facts.operation, paying = Boolean(approved.facts.payment);
                const returning = approved.facts.collateralReturnAssets !== undefined;
                let landed: string | null = null;
                // Left part way (another review, or the page closed): nothing more is sent from this one, so what
                // landed is its result. Addressed to its own attempt, so no other review is touched.
                const leave = (batchId: string) => request(`${ROOT}/executions/${encodeURIComponent(approved.executionId)}/submission`,
                  { method: 'POST', body: JSON.stringify({ attemptId: arm.attemptId, outcome: 'stopped', batchId }) });
                // After the first step the arm is spent: leaving between steps stops them, it releases nothing.
                const stillHere = async () => {
                  if (current.current === identity && alive.current) return;
                  left = true;
                  throw new Error('lending_identity_changed');
                };
                for (let index = 0; index < calls.length; index++) {
                  if (current.current !== identity || !alive.current) {
                    if (landed) await leave(landed).catch(() => undefined);
                    else if (!handedToWallet) await release();
                    throw new LendingStepsStoppedV1(stepsStoppedV1(operation, index, calls.length, null, paying, returning), landed);
                  }
                  update({ step: { index: index + 1, total: calls.length, phase: 'wallet' } });
                  let hash: string;
                  try { handedToWallet = true; hash = await wallet.send(calls[index]!, index === 0 ? beforeWallet : stillHere); }
                  catch (error) {
                    if (left) {
                      // Left in the host's own wait: this step was never asked of the wallet.
                      if (index === 0) handedToWallet = false;
                      else if (landed) await leave(landed).catch(() => undefined);
                      throw new LendingStepsStoppedV1(stepsStoppedV1(operation, index, calls.length, null, paying, returning), landed);
                    }
                    if (index === 0) { await report(walletDidNotSendV1(error) ? 'rejected' : 'unknown').catch(() => undefined); throw error; }
                    // What landed stays recorded. A refusal the wallet names sent nothing more, so the rest is
                    // stopped for good; any other error may have sent this step, and the chain says which.
                    const unsent = walletDidNotSendV1(error);
                    if (landed) await report(unsent ? 'stopped' : 'submitted', landed).catch(() => undefined);
                    throw new LendingStepsStoppedV1(unsent
                      ? stepsStoppedV1(operation, index, calls.length, borrowUserRejectedV1(error) ? `You declined step ${index + 1} of ${calls.length}.` : walletNotAskedSentenceV1(error), paying, returning)
                      : stepsUnknownV1(operation, index, calls.length, paying, returning), landed);
                  }
                  update({ step: { index: index + 1, total: calls.length, phase: 'confirming' } });
                  await wallet.receipt(hash).catch(() => null);
                  update({ step: { index: index + 1, total: calls.length, phase: 'checking' } });
                  let answer: { state?: unknown; batchId?: unknown; detail?: unknown; refusal?: unknown };
                  try {
                    answer = await request(`${ROOT}/executions/${encodeURIComponent(approved.executionId)}/steps`,
                      { method: 'POST', body: JSON.stringify({ attemptId: arm.attemptId, index, transactionHash: hash }) });
                  } catch {
                    throw new LendingStepsStoppedV1(`Step ${index + 1} of ${calls.length} was sent, and Still could not read it from the chain yet. Check the onchain result before pressing again.`, landed);
                  }
                  const batch: string | null = typeof answer.batchId === 'string' ? answer.batchId : landed;
                  if (answer.state === 'submitted' && batch) return batch;
                  if (answer.state === 'next') { landed = batch; continue; }
                  // A step that failed onchain is not in place; one that landed before a refused review is.
                  const inPlace = answer.refusal === 'loan_step_reverted' ? index : index + 1;
                  throw new LendingStepsStoppedV1(stepsStoppedV1(operation, inPlace, calls.length, typeof answer.detail === 'string' ? answer.detail : null, paying, returning), batch,
                    typeof answer.refusal === 'string' ? answer.refusal : null);
                }
                throw new LendingStepsStoppedV1('The steps ended without a final answer. Check the onchain result before pressing again.', landed);
              }
              try {
                handedToWallet = true;
                // A wallet whose own connection to Base failed before it sent anything is asked once more, after
                // the wait it named (MetaMask, 2026-11-08); the person is told why the press is waiting.
                let waited = false;
                const batchId = await sendRetryingWalletNetworkV1(() => input.sendCalls({ calls, sponsorship, beforeWallet }), {
                  onWait: ms => { waited = true; update({ walletError: `Your wallet could not reach Base, so nothing was sent. Still asks it again in ${Math.ceil(ms / 1000)} seconds…` }); },
                });
                if (waited) update({ walletError: null });
                await report(batchId ? 'submitted' : 'unknown', batchId ?? undefined).catch(() => {
                  update({ walletError: 'Your wallet returned, but the submission record could not be updated. Check the onchain result before taking another action.' });
                });
                return batchId;
              } catch (error) {
                // Left before the wallet was asked: released already, and nothing was sent.
                if (left) { handedToWallet = false; throw error; }
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
        update({ walletError: previous !== approved ? describeLendingTermsChangesV1(previous, approved) : result.message, termsChanged: true });
      }
      else {
        confirmed.current = null;
        if (result.state === 'refused') update({ walletError: result.message });
        else update({ batchId: result.batchId, ...(!result.batchId ? { walletError: 'Your wallet did not return a batch ID. The result is unknown. Check wallet activity; this review will not be sent again.' } : {}) });
      }
    } catch (error) {
      confirmed.current = null;
      if (error instanceof LendingStepsStoppedV1) { update({ walletError: error.message, stepsRefusal: error.refusal, ...(error.batchId ? { batchId: error.batchId } : {}) }); return; }
      if (walletCannotSendSentenceV1(error) !== null) input.onWalletRefusal?.(error);
      // Which attempt holds the market, with its own review: said under the refusal (audit UI-19).
      const heldBy = !handedToWallet && /^execution_active: /.test(error instanceof Error ? error.message : '')
        ? lendingHeldByWireV1((error as { body?: { heldBy?: unknown } }).body?.heldBy) : null;
      update({ heldBy, walletError: borrowUserRejectedV1(error) ? 'You declined in your wallet. Nothing was sent.'
        : walletCannotSendSentenceV1(error, input.walletName) ?? walletNetworkFailureSentenceV1(error, input.walletName)
          // The page's connection was not live, or the wallet answers as another account: it was never
          // asked, the review is ready again, and "the result is unknown" would be false both ways (audit WAL-3).
          ?? (walletConnectionNotReadyV1(error) ? WALLET_CONNECTION_NOT_READY_V1 : null) ?? walletNotAskedSentenceV1(error)
          // Another attempt holds the market, or landed after this review was read (audit LEND-3): the
          // server says which, before the wallet was ever asked.
          ?? (!handedToWallet ? serverDetailV1(error, /^(?:execution_active|lending_position_changed|lending_wallet_moved)$/) : null)
          ?? (error instanceof BorrowSubmissionStorageErrorV1 ? error.message
          : handedToWallet ? 'The wallet result is unknown. Check its activity and the onchain result; this review will not be sent again.'
            : 'The wallet request could not be armed. Your wallet was not asked. Check this review’s recorded result before trying another action.') });
    } finally { opening.current = false; update({ walletBusy: false, step: null }); }
  }, [active, eligible, identity, input, read, request, session, update]);

  // Released only when Base bears out, twice and a minute apart, that the wallet sent nothing of it since the
  // review (audit LL-1). The first press reads once; the page reads again by itself at the time the server
  // names, with the note of the first reading, while the page is open. The server says why not.
  const onRelease = useCallback(async (check: string | null = null) => {
    if (!eligible || !executionId || active.walletBusy || current.current !== identity) return;
    update({ checking: true, walletError: null });
    try {
      const released = parseLendingExecutionWireV1(await request(`${ROOT}/executions/${encodeURIComponent(executionId)}/release`, {
        method: 'POST', body: JSON.stringify(check ? { check } : {}),
      }), executionId);
      if (!released) throw new Error('lending_execution_unreadable');
      update({ execution: released, releaseCheck: released.releasing ?? null });
    } catch (error) {
      update({ releaseCheck: null, walletError: serverDetailV1(error, /^(?:lending_attempt_changed|loan_release_[a-z_]+)$/)
        ?? 'Still could not release this review just now. Nothing was changed; check the onchain result.' });
    }
    finally { update({ checking: false }); }
  }, [active.walletBusy, eligible, executionId, identity, request, update]);
  const releaseCheck = active.releaseCheck;
  useEffect(() => {
    if (!releaseCheck) return undefined;
    const timer = setTimeout(() => { void onRelease(releaseCheck.check); }, Math.max(0, Date.parse(releaseCheck.checkAgainAt) - Date.now()) + 250);
    return () => clearTimeout(timer);
  }, [onRelease, releaseCheck]);

  const locked = Boolean(active.marker || active.batchId || (active.execution && active.execution.state !== 'ready') || active.body?.state === 'refused');
  // A review released as never sent still takes a transaction its wallet sent after all, by that transaction's hash.
  const releasedUnsent = active.execution?.state === 'failed' && active.execution.errorCode === 'loan_wallet_sent_nothing';
  // A loan in steps stopped part way still takes a step its wallet sent after all, by that step's hash.
  const stoppedInSteps = active.execution?.state === 'failed' && active.execution.errorCode === 'loan_steps_stopped' && Boolean(active.execution.steps);
  // A Spend loan in steps that stopped before its payment: while Bitrefill holds the invoice, the wallet's own
  // USDC may pay it on that invoice's page. The server says so with the attempt (and with the review, when
  // the page is opened again); a stop this page just saw because Bitrefill could not be read says it at once.
  const payingOrder = active.body?.facts?.payment?.orderId ?? null;
  const offeredOrder = active.execution?.walletPay?.orderId ?? (active.body?.state === 'refused' ? active.body.walletPay?.orderId : null)
    ?? (active.stepsRefusal === 'spend_invoice_unread' ? payingOrder : null);
  const walletPayPath = offeredOrder && /^[0-9a-f-]{36}$/.test(offeredOrder) ? `/spend/pay/${offeredOrder}` : null;
  return { body: eligible ? active.body : null, model: {
    loading: eligible && active.loading, error: !eligible ? 'Sign in and connect the same wallet to read this private review.' : active.error,
    body: eligible ? active.body : null, walletBusy: eligible && active.walletBusy,
    termsChanged: eligible && active.termsChanged && active.walletError !== null,
    // The wallet's own answer about itself is said before the button would be.
    walletError: eligible ? active.walletError ?? (active.body?.state === 'ready' && !locked ? input.walletBlocker ?? null : null) : null,
    batchId: eligible ? active.batchId : null, execution: eligible ? active.execution : null, checking: eligible && active.checking,
    walletPayPath: eligible ? walletPayPath : null,
    submissionLock: eligible && active.marker ? borrowSubmissionLockCopyV1(active.marker) : null,
    onOpen: eligible && active.body?.state === 'ready' && !locked && !input.walletBlocker ? () => void onOpen() : null,
    // Read by itself, the result needs no press. The press is offered for what was sent and has no final
    // answer: after the reads ran out, or where there is nothing for a read to find. Without automatic
    // reads (the assistant's card), as before.
    onCheck: eligible && executionId && (!autoResult || (sentState !== null && sentState !== 'ready' && !FINAL_STATES_V1.has(sentState) &&
      !(follows && active.following) && (!follows || active.followEnded))) ? () => void onCheck() : null,
    following: eligible && follows && active.following,
    followEnded: eligible && follows && active.followEnded,
    transactionHint: eligible ? active.transactionHint : '',
    onTransactionHint: eligible ? value => update({ transactionHint: value }) : undefined,
    onFindTransaction: eligible && executionId && locked && (!['confirmed','failed'].includes(active.execution?.state ?? '') || stoppedInSteps || releasedUnsent) ? () => void onFindTransaction() : null,
    onStop: eligible && executionId && active.execution?.steps?.stoppable && !active.walletBusy && !active.step ? () => void onStop() : null,
    onRelease: eligible && executionId && active.execution?.release?.offered && !active.walletBusy && !active.step && !active.releaseCheck ? () => void onRelease() : null,
    releaseCheckAgainAt: eligible && active.releaseCheck ? active.releaseCheck.checkAgainAt : null,
    heldBy: eligible ? active.heldBy : null,
    step: eligible ? active.step : null,
    back: lendingBackLinkV1(input.draft),
    // A wallet that sends in steps pays each step's fee itself, so it is told nothing about a sponsor.
    feeNote: eligible && !sequential ? input.feeNote ?? null : null,
  } };
}
