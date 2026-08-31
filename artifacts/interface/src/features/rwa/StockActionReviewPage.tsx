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
  underlyingChoicesV1,
  useConsoleTheme,
  type MarketRealityScreenModelV1,
} from '@mioagent/ui';
import {
  useOfficialAssetDossier,
  useStatus,
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
// The page confirms nothing and executes nothing. It ends where every Stocks
// card already ends: at the advanced route surface, which is itself an intent
// to look.
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
  transferEligibility?: {
    scopes?: { scope?: string; verdict?: string; policyId?: string | null; reason?: string | null }[];
  } | null;
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

export function StockActionReviewPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute('/action/:draft');
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('market');

  const review = useStockActionReview(params?.draft ?? null);
  const body = (review.data ?? null) as ReviewBodyV1 | null;

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

  // Built here rather than in the shared view module: this is the only surface
  // that knows WHICH wallet the draft was issued to, and a verdict about a
  // different address would be worse than none.
  const eligibilityNotice = useMemo(() => {
    const scopes = body?.transferEligibility?.scopes ?? [];
    if (scopes.length === 0) return null;
    const denied = scopes.filter((scope) => scope.verdict === 'denied');
    if (denied.length > 0) {
      const sending = denied.some((scope) => scope.scope === 'transfer_sender');
      const receiving = denied.some((scope) => scope.scope === 'transfer_receiver');
      const what = sending && receiving ? 'send or receive' : sending ? 'send' : 'receive';
      return `This token's transfer policy does not currently authorize this wallet to ${what} it. That is the issuer's policy for this contract, read on chain — it says nothing about the market or about any other asset you hold.`;
    }
    if (scopes.every((scope) => scope.verdict === 'authorized')) {
      return `This token's transfer policy authorizes this wallet to send and receive it, as read on chain. A policy can change, and this says nothing about whether a route exists or what it costs.`;
    }
    // Partly or wholly unread. Never a reassuring default — "no restriction
    // found" and "we did not look" are the two states this product separates.
    const reason = scopes.find((scope) => scope.reason)?.reason;
    return reason
      ? `${reason} Nothing about this wallet's permission to move this token was established, which is not the same as being blocked.`
      : null;
  }, [body?.transferEligibility]);

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
            {/* Whether this wallet may move this token at all — read on chain
                from a registry documented never to revert. Everything else on
                this page is about the market; a transfer policy can deny one
                address while the market is perfectly healthy, and every
                reviewed Coinbase representation points its transfer scopes at
                a live blocklist. Rendered only when the chain answered: a
                missing verdict prints nothing rather than reassurance. */}
            {eligibilityNotice ? (
              <p className="cr-verdict">{eligibilityNotice}</p>
            ) : null}
            {model ? <MarketRealityScreen model={model} /> : null}
            <p className="lnote">
              Miorail never signs and never broadcasts. Continuing opens the advanced route surface,
              which prepares nothing on its own — only your own Base Account can move anything.
            </p>
          </>
        ) : null}
      </section>
    </ConsoleShell>
  );
}
