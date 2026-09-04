import { useMemo } from 'react';
import { useLocation, useRoute } from 'wouter';
import { useAccount } from 'wagmi';
import {
  ConsoleShell,
  MarketRealityScreen,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  chainUnavailableReasonV1,
  consoleSectionPathV1,
  exitEvidenceV1,
  marketRealityViewV1,
  transferGateViewV1,
  transferPolicyViewV1,
  underlyingChoicesV1,
  useConsoleTheme,
  STOCK_ISSUER_NOTICE_V1,
  TRANSFER_POLICY_FOOTNOTE_V1,
  type MarketRealityScreenModelV1,
  type TransferPolicyWireV1,
} from '@mioagent/ui';
import {
  useOfficialAssetDossier,
  useStatus,
  useStockActionConfirm,
  useStockActionReview,
} from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';

// ---------------------------------------------------------------------------
// Connected Intelligence 1 — the review a draft points at.
//
// An external assistant established WHICH representation and WHICH question.
// It was told nothing about what that costs, and this page is where the cost is
// established: the server re-assembles the exact question from canonical
// evidence under this session, and what is rendered is that answer — never
// anything the conversation carried.
//
// Phase 17.5 — and it now ends one step further, because it used to end one
// step too early. The confirm endpoint existed from the start and nothing in
// the interface ever called it, so the chain an assistant starts stopped here:
// a review could be prepared and a person could read it, and there was no way
// for that person to say yes. The clearance it produces is what the assistant
// needs to ask for an unsigned request, and it is minted only in a human's own
// session, only for terms this server established a moment ago.
//
// Confirming is still not approving. Nothing on this page is executable, no
// wallet opens here, and the clearance authorises ONE exact action and expires
// in minutes.
// ---------------------------------------------------------------------------

function shortAddressV1(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

interface ReviewBodyV1 {
  outcome?: 'review' | 'refused';
  reason?: string;
  detail?: string;
  evidenceState?: 'fresh_quote' | 'expired_quote' | 'no_quote';
  draftExpiresAt?: string;
  representation?: { tokenAddress?: string; caip10?: string; issuerId?: string };
  question?: {
    direction?: 'buy' | 'sell';
    requestedCashAtomic?: string;
    destination?: 'USDC' | 'ETH';
  };
  reality?: unknown;
  transferEligibility?: TransferPolicyWireV1 | null;
  /** Phase 17.5 — the same read, asked as the question `confirm` will ask.
   * `denied` is the only state that stops anything, and this page says so
   * BEFORE the button rather than at it. */
  transferGate?: { state?: string; detail?: string; direction?: string } | null;
}

/** What the reader is told about freshness, in the words the rest of Stocks
 * uses. An expired quote is a legitimate state to review in; it is never
 * described as a current one. */
const EVIDENCE_COPY_V1: Readonly<Record<string, string>> = {
  fresh_quote:
    'A router quote for this exact question is open right now. It lives about twenty seconds.',
  expired_quote:
    'The router quote this was prepared beside has expired. Nothing from the conversation was carried over — measure again for a current answer.',
  no_quote:
    'No router quote is open for this exact question. Measure to establish one before going further.',
};

function failureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('stock_action_draft_expired')) {
    return 'This review link has expired. Drafts are deliberately short-lived, because a review that opens later is about a different market — ask Miorail to prepare it again.';
  }
  if (message.includes('stock_action_draft_wrong_wallet')) {
    return 'This review link belongs to a different wallet. Miorail will not open one account’s review under another’s session.';
  }
  if (message.includes('stock_action_draft_bad_signature') || message.includes('malformed')) {
    return 'This is not a review link this server issued.';
  }
  if (message.includes('authentication_required') || /\b401\b/.test(message)) {
    return 'Your session is not valid for this server, so nothing was read. Signing in again is the fix.';
  }
  return 'This review could not be read on this server. Nothing here is a statement about the security.';
}

/**
 * Why a confirmation did not happen, in the reader's words.
 *
 * The issuer refusal is first because it is the one cause that is not about
 * Miorail at all, and a reader told "something went wrong" when the token's own
 * registry refused them would go looking for a fault that does not exist.
 */
function confirmFailureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('issuer_transfer_policy_denied')) {
    return 'The token’s own policy registry refuses this wallet for this action, so no clearance was issued. That is the issuer’s rule, read on chain — Miorail does not set it and cannot lift it.';
  }
  if (message.includes('route_policy_changed')) {
    return 'The reviewed measurement basis changed while this page was open, so these are no longer the terms you read. Nothing was confirmed — ask again for a current answer.';
  }
  if (message.includes('stock_action_draft_expired')) {
    return 'This review link expired before it was confirmed. Drafts are deliberately short-lived, because a review confirmed later is a review of a different market.';
  }
  if (message.includes('zero_supply') || message.includes('representation_not_reviewed')) {
    return 'This exact representation is no longer one this answer can carry, so nothing was confirmed and nothing was substituted for it.';
  }
  return 'This could not be confirmed on this server. Nothing was recorded, nothing is executable, and this is not a statement about the security.';
}

export function StockActionReviewPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute('/action/:draft');
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('market');

  const review = useStockActionReview(params?.draft ?? null);
  const body = (review.data ?? null) as ReviewBodyV1 | null;
  const confirm = useStockActionConfirm();
  const confirmed = (confirm.data ?? null) as { clearance?: string; expiresAt?: string } | null;

  const nowIso = useMemo(() => new Date().toISOString(), [review.dataUpdatedAt]);

  // Whether the position can be CLOSED, on the one page where somebody is
  // about to act. The Stocks board grew this line first; leaving it off here
  // would mean the surface nearest the wallet was the one surface that never
  // said the money might not come back. One representation, so one read.
  // The draft names one exact representation, and the server echoes it. Reading
  // it from here rather than out of `reality` keeps the address the reviewed
  // one instead of whichever card happened to be first.
  const reviewedAddress = body?.representation?.tokenAddress ?? null;
  const dossier = useOfficialAssetDossier(reviewedAddress);

  const view = useMemo(() => {
    if (!body?.reality) return null;
    const choices = underlyingChoicesV1(null);
    const question = {
      requestedCashAtomic: body.question?.requestedCashAtomic ?? '0',
      destination: body.question?.destination ?? ('USDC' as const),
    };
    const ladder =
      dossier.data && dossier.data.outcome === 'dossier' ? dossier.data.dossier : null;
    return marketRealityViewV1({
      wire: body.reality as never,
      choice: choices[0] ?? null,
      now: nowIso,
      ...(ladder && reviewedAddress
        ? {
            ladders: {
              [reviewedAddress.toLowerCase()]: {
                rungs: [],
                note: null,
                exit: exitEvidenceV1(ladder.cashExitLadder.rungs, question),
              },
            },
          }
        : {}),
    });
  }, [body?.reality, body?.question, dossier.data, reviewedAddress, nowIso]);

  // The words live in the shared console projection, not here. This page used
  // to build the same sentences inline from the same wire, which is how one
  // verdict comes to be worded two ways on two surfaces.
  const transferPolicy = useMemo(
    () => transferPolicyViewV1(body?.transferEligibility ?? null),
    [body?.transferEligibility],
  );
  // The gate, not the evidence. The lines above say what the registry answered
  // for each scope; this says what that means for the ONE action this draft is
  // about — and it is rendered even when nothing was established, because a
  // gate that fails open and shows nothing lets a reader conclude somebody
  // checked when in fact nobody could reach the registry.
  const transferGate = useMemo(
    () => transferGateViewV1(body?.transferGate ?? null),
    [body?.transferGate],
  );

  const refused = body?.outcome === 'refused';
  const model: MarketRealityScreenModelV1 | null = view
    ? {
        choices: [],
        choicesLoading: false,
        choicesError: null,
        counters: [],
        selectedKey: null,
        direction: body?.question?.direction ?? 'sell',
        requestedCashAtomic: body?.question?.requestedCashAtomic ?? '0',
        surface: 'market',
        historyPeriod: 'now',
        view,
        viewLoading: false,
        viewError: null,
        history: null,
        historyLoading: false,
        historyError: null,
        measuring: false,
        measurementNote: null,
        measurementError: null,
        watchedTokenAddresses: [],
        watchingTokenAddress: null,
        removingWatchTokenAddress: null,
        watchError: null,
        actions: {
          onUnderlying: () => undefined,
          onDirection: () => undefined,
          onSize: () => undefined,
          onSurface: () => undefined,
          onHistoryPeriod: () => undefined,
          onInvestigate: (tokenAddress) => navigate(`/investigate?token=${tokenAddress}`),
        },
      }
    : null;

  return (
    <ConsoleShell
      header={{
        crumb: ['Stocks', 'Review'],
        nav: nav.header,
        onNavigate: nav.navigate,
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        chainUnavailableReason: chainUnavailableReasonV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: Boolean(address) && status.data?.rpc?.status === 'connected',
        walletLabel: shortAddressV1(address),
      }}
      left={{
        nav: nav.rail,
        sessions: [],
        sessionCount: '0',
        proofs: [],
        proofCount: '0',
        onOpenSettings: () => nav.navigate('settings'),
      }}
      footer={{
        adaptersLabel: '—',
        sourcesLabel: String(view?.representations.length ?? 0),
        spendLabel: '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      right={null}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => navigate(consoleSectionPathV1('routes'))}
      onSelectSession={() => navigate(consoleSectionPathV1('routes'))}
      onSelectProof={() => navigate(consoleSectionPathV1('activity'))}
    >
      <section className="mr" aria-label="Stock action review">
        <h3>Review before anything is signed</h3>
        <p className="lnote">
          An assistant prepared this review. It was told which representation and which question —
          never what they cost. Everything below was established on this server just now, under your
          own session.
        </p>

        {review.isLoading ? <p className="empty">Establishing the current terms…</p> : null}

        {review.error ? <p className="lnote warn">{failureCopyV1(review.error)}</p> : null}

        {refused ? (
          <>
            <p className="cr-verdict">{body?.detail ?? 'This review cannot continue.'}</p>
            <p className="lnote">
              Nothing was prepared and nothing is executable. Ask Miorail again for a current
              answer.
            </p>
          </>
        ) : null}

        {body?.outcome === 'review' ? (
          <>
            <p className="cr-verdict">
              {EVIDENCE_COPY_V1[body.evidenceState ?? 'no_quote'] ??
                EVIDENCE_COPY_V1.no_quote}
            </p>
            {/* The exact address, spelled out. A review that named a ticker
                would be a review of whichever contract the reader assumed. */}
            <p className="lnote mono">{body.representation?.caip10}</p>
            {/* The token's own rules about moving it — read on chain from a
                registry documented never to revert. Everything else on this
                page is about the market; these rules can deny one address
                while the market is perfectly healthy, and every reviewed
                Coinbase representation points all three transfer scopes at a
                live blocklist. Rendered only when the chain answered: a
                missing verdict prints nothing rather than reassurance. */}
            {transferPolicy ? (
              <>
                <p className="lnote">{transferPolicy.title}</p>
                {transferPolicy.lines.map((line) => (
                  <p
                    key={line.text}
                    className={line.tone === 'neutral' ? 'cr-verdict' : `cr-verdict ${line.tone}`}
                  >
                    {line.text}
                  </p>
                ))}
                <p className="lnote">{TRANSFER_POLICY_FOOTNOTE_V1}</p>
              </>
            ) : null}
            {transferGate ? (
              <div className="mr-gate">
                <span className="pill cr-status" data-tone={transferGate.tone}>
                  {transferGate.label}
                </span>
                <p className="mr-gate-detail">{transferGate.detail}</p>
              </div>
            ) : null}
            {model ? <MarketRealityScreen model={model} /> : null}
            <p className="lnote">
              Miorail never signs and never broadcasts. Continuing opens the advanced route surface,
              which prepares nothing on its own — only your own Base Account can move anything.
            </p>

            {/* The step this page was missing. An assistant established which
                representation and which question; this server established what
                they cost. Only a person, in their own session, can say yes to
                that — and this is where they say it.
                Absent when the issuer's own registry refused: the server would
                refuse anyway, and offering a button that cannot work is worse
                than saying why. */}
            {transferGate?.blocking ? (
              <p className="cr-verdict bad">
                Nothing can be confirmed for this wallet while the issuer’s policy refuses it.
              </p>
            ) : confirmed ? (
              <div className="mr-clearance">
                <p className="cr-verdict good">
                  Confirmed. This authorises one exact action and expires shortly.
                </p>
                <p className="mr-gate-detail">
                  Hand this clearance back to the assistant that prepared the review. It is not a
                  signature and not a transaction: with it, the assistant can ask this server for an
                  unsigned request, which your own Base Account then reviews and signs — or does
                  not.
                </p>
                <code className="mr-clearance-token mono">{confirmed.clearance}</code>
                <p className="lnote">Expires {confirmed.expiresAt}</p>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="btn lg"
                  disabled={confirm.isPending}
                  title="Records that you agreed to these exact terms. Nothing is signed, submitted, or broadcast here."
                  onClick={() => confirm.mutate(params?.draft ?? '')}
                >
                  {confirm.isPending ? 'Confirming…' : 'Confirm these terms'}
                </button>
                {confirm.error ? (
                  <p className="cr-verdict bad">{confirmFailureCopyV1(confirm.error)}</p>
                ) : null}
                <p className="lnote">
                  Confirming records that a person, in their own session, agreed to terms this
                  server established just now. It signs nothing, submits nothing and opens no
                  wallet.
                </p>
              </>
            )}

            <p className="mr-issuer-note">{STOCK_ISSUER_NOTICE_V1}</p>
          </>
        ) : null}
      </section>
    </ConsoleShell>
  );
}
