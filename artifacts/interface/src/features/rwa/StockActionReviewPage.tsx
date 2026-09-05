import { useMemo } from 'react';
import { useLocation, useRoute } from 'wouter';
import { useAccount, useSendCalls } from 'wagmi';
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
  useStockActionReviewConsoleV1,
  StockActionReviewScreen,
  type MarketRealityScreenModelV1,
} from '@mioagent/ui';
import {
  useOfficialAssetDossier,
  useRecordBlueprintSubmission,
  useStatus,
} from '@mioagent/api-client-react';
import { builderCodeForSurfaceV1, builderCodeToDataSuffix } from '@mioagent/wallet-actions';
import { useConsoleNav } from '../console/useConsoleNav';

/**
 * ERC-8021 attribution for this surface.
 *
 * A repo-wide test holds every `useSendCalls` site to this, and it caught the
 * omission the moment this page grew a wallet button: a batch sent without a
 * `dataSuffix` loses Builder Code attribution SILENTLY — no error, no warning,
 * just a transaction nobody can attribute to the app that produced it. This is
 * the surface where an assistant's work becomes an onchain action, so it is the
 * last one that should go unattributed.
 */
const STOCK_ACTION_BUILDER_SUFFIX_V1 = builderCodeToDataSuffix(
  builderCodeForSurfaceV1({
    VITE_BASE_BUILDER_CODE: import.meta.env?.VITE_BASE_BUILDER_CODE as string | undefined,
    VITE_BUILDER_CODE: import.meta.env?.VITE_BUILDER_CODE as string | undefined,
  }),
);

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

export function StockActionReviewPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute('/action/:draft');
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('market');

  // -------------------------------------------------------------------------
  // Phase 17.7 — the review is one shared screen now.
  //
  // Every read, every refusal sentence and every state of the confirm/sign
  // block moved into `lib/ui`, so the Base App mounts the same review rather
  // than a second one written to match. What stays here is what genuinely
  // differs: this shell, this navigation, and the wallet — `lib/ui` has no
  // wagmi dependency, and which wallet is reachable is a fact about the host.
  // -------------------------------------------------------------------------
  const sendCalls = useSendCalls();
  const recordSubmission = useRecordBlueprintSubmission();
  const reviewConsole = useStockActionReviewConsoleV1({
    draft: params?.draft ?? null,
    sendCalls: async ({ calls, atomicRequired }) => {
      const result = await sendCalls.mutateAsync({
        calls: calls as never,
        chainId: 8453,
        forceAtomic: atomicRequired,
        // Optional, so a wallet that does not understand the capability still
        // sends the batch rather than refusing it. A batch with no dataSuffix
        // loses Builder Code attribution silently.
        capabilities: STOCK_ACTION_BUILDER_SUFFIX_V1
          ? { dataSuffix: { value: STOCK_ACTION_BUILDER_SUFFIX_V1, optional: true } }
          : undefined,
      });
      return typeof result === 'string' ? result : ((result as { id?: string })?.id ?? null);
    },
    // The one submission-record route this codebase has — the same one the
    // swap and NFT families write through. A stock action's Blueprint IS a swap
    // Blueprint, so this needs no family of its own; it needed the release to
    // approve first, which is what makes a record possible at all.
    recordSubmission: async ({ routeRunId, blueprintId, approvedCallsHash, batchId }) => {
      if (!address) return;
      return recordSubmission.mutateAsync({
        blueprintId,
        routeRunId,
        walletAddress: address,
        approvedCallsHash: approvedCallsHash as `0x${string}`,
        // What the WALLET did. Not a claim that the entry happened — that is
        // reconciliation's answer, from the chain.
        status: 'submitted',
        batchId,
      });
    },
  });
  const body = reviewConsole.body;

  // Whether the position can be CLOSED, on the one page where somebody is
  // about to act. The Stocks board grew this line first; leaving it off here
  // would mean the surface nearest the wallet was the one surface that never
  // said the money might not come back. One representation, so one read.
  // The draft names one exact representation, and the server echoes it. Reading
  // it from here rather than out of `reality` keeps the address the reviewed
  // one instead of whichever card happened to be first.
  const reviewedAddress = body?.representation?.tokenAddress ?? null;
  const dossier = useOfficialAssetDossier(reviewedAddress);

  const nowIso = useMemo(() => new Date().toISOString(), [body]);

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

  // The transfer policy, the gate and every refusal sentence now live in the
  // shared review console — this page renders the board and the shell.
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
        // The draft fixes the security, the direction and the exact size, so
        // the chooser and the question controls are not rendered at all. They
        // were wired to no-ops here — dead controls offering to change the very
        // question being confirmed — and the chooser, with no index to fill it,
        // printed "No reviewed source has bound a Base contract to a security
        // yet" over five reviewed representations.
        questionFixed: true,
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
      <StockActionReviewScreen
        model={reviewConsole.model}
        board={model ? <MarketRealityScreen model={model} /> : null}
      />
    </ConsoleShell>
  );
}
