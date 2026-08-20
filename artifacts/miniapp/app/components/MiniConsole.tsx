"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAccount, useCallsStatus, useSendCalls } from "wagmi";
import {
  CONSOLE_COPY_V1,
  CandidateCards,
  CommerceInvoiceReviewPanel,
  CommerceRouteCardPanel,
  AiProofPanel,
  AiResultPanel,
  AiReviewPanel,
  AiRouteCardPanel,
  NftProofPanel,
  NftReviewPanel,
  NftRouteCardPanel,
  commerceCheckoutAvailableV1,
  CONSOLE_PRIMARY_SECTIONS_V1,
  ConsoleMiniShell,
  ConsoleRightRail,
  B20ExitCard,
  B20EntryReviewCard,
  B20ConsolePanel,
  B20PortfolioPanel,
  BaseMcpConsoleCard,
  BASE_MCP_CONSOLE_INPUT_ID_V1,
  BaseMcpExtensionsCard,
  BaseMcpPluginsCard,
  BaseMcpActionReceiptsCard,
  EXIT_PROFILE_DEFAULTS_V1,
  WalletBalancesCard,
  formatAtomicAmount,
  percentToBpsV1,
  usdcToAtomicV1,
  type ExitProfileV1,
  OpportunitiesScreen,
  ActivityRunsCard,
  ActivitySpendCard,
  consoleHomeSectionV1,
  consoleNavModelV1,
  opportunityCardViewV1,
  type B20ConsoleScopeViewV1,
  type ConsolePipelineStateV1,
  type ConsoleSectionV1,
  type OpportunityFilterV1,
  type OpportunityStandingFilterV1,
  ConsoleStepperCompact,
  MiniScorePanel,
  PlanScreen,
  PlanVsActualCards,
  ReviewScreen,
  swapPrepareNoticeV1,
  swapPrepareRequestFailedNoticeV1,
  RouteGraph,
  adaptersFromStatusV1,
  consoleFailureCopyV1,
  ageLabelV1,
  B20ControlSection,
  BudgetPaymentsPanel,
  b20ErrorCodeV1,
  b20TargetForRouteV1,
  b20UnavailableCopyV1,
  swapTerminalFailureV1,
  candidateRowsFromProjectionV1,
  comparisonClaimFromProjectionV1,
  providerDiagnosticRowsV1,
  providerFailuresFromProjectionV1,
  ProviderDiagnosticsPanel,
  REGISTERED_SWAP_PROVIDERS_V1,
  chainLabelV1,
  compactStepLabelV1,
  completeStageV1,
  chainBlockNumberV1,
  chainGasPointsV1,
  coverageFromStatusV1,
  deriveAdapterRowsV1,
  deriveSimulationViewV1,
  dispatchRouteFamilyV1,
  emptyStageClockV1,
  evidenceRowsFromProjectionV1,
  evidenceSourcesFromProjectionV1,
  intelligenceSpendLabelV1,
  marketRailFromSnapshotV1,
  providerUnavailableCopyV1,
  providerConstrainedGoalV1,
  providerConstraintResolutionV1,
  quoteFreshnessFromRouteV1,
  routeGraphFromRouteV1,
  scoreRowsFromProjectionV1,
  providerHistoryViewsV1,
  scoringVersionLabelV1,
  scoredCountLabelV1,
  shortfallNoticeFromProjectionV1,
  simulationSourceFromResponseV1,
  activeStageStepV1,
  startStageV1,
  stepperFromClockV1,
  useConsoleTheme,
  usagePercentV1,
  type ConsoleScreenV1,
  type ConsoleStageClockV1,
  type ConsoleStageV1,
  type RoutePlanProjectionV1,
} from "@mioagent/ui";
import {
  useBoundedProofReconciliation,
  useCommerceCompare,
  useAiCompare,
  useAiExecute,
  useNftCompare,
  useNftPrepare,
  useNftReconcile,
  useCreateCommerceOrder,
  useEarnCompare,
  useEvaluateSwapRoute,
  useAddB20Watch,
  useB20Inspect,
  useB20ConsoleAsk,
  useB20CopilotAsk,
  useB20LaunchContext,
  useB20PublicContext,
  useB20Opportunities,
  useB20Watch,
  useB20Watchlist,
  useIntelligenceCharges,
  useIntelligenceBudget,
  usePauseIntelligenceBudget,
  useResumeIntelligenceBudget,
  useRevokeIntelligenceBudget,
  useMarketSnapshot,
  usePrepareSwapBlueprint,
  useB20ExitCheck,
  useB20PrepareEntry,
  useB20BeginEntrySubmission,
  useB20EntryStatus,
  useB20ReconcileEntrySubmission,
  useB20RecordEntrySubmission,
  useB20OpportunitySimulate,
  useBaseMcpConsole,
  useBaseMcpPlugins,
  useBaseMcpToolsProbe,
  useBaseMcpActionReceipts,
  useReconcileBaseMcpAction,
  usePortfolio,
  useRouteHistory,
  useX402Ledger,
  useSimulateWithBudget,
  useStatus,
  type NftProofResponseV1,
  type SimulateWithBudgetResponseV1,
} from "@mioagent/api-client-react";
import {
  BlueprintSubmitButton,
  EarnDepositFlow,
  SubmissionRecoveryRail,
  builderCodeForSurfaceV1,
  builderCodeToDataSuffix,
  isWalletRejectionError,
  transactionHashesFromReceipts,
  useSpendPermissionGrant,
  type BlueprintSubmitStatus,
} from "@mioagent/wallet-actions";
import { SimulateButton, useB20ExitProofPayment, type SimulateBlueprintResponseV1 } from "@mioagent/x402-actions";
import { WalletConnect } from "./WalletConnect";

// ---------------------------------------------------------------------------
// The miniapp console: the centre column and the status bar.
//
// It runs the SAME flow as the web console (plan → comparing → route → review →
// submission → proof) on the same hooks and the same view model — the layout is
// what compresses, never the honesty. The three things that survive at 390px
// without compromise: unavailable routes stay visible with their reason, an
// unscored dimension keeps its hatched track and "not scored", and Review still
// gates signing on a real simulation.
//
// The miniapp previously had no plan screen, so the flow started in the middle.
// It starts at the goal now.
// ---------------------------------------------------------------------------

// T67X-B1: canonical key first, deprecated alias second, conflict → no
// attribution. Literal member access is the only form Next inlines.
const BUILDER_CODE = builderCodeForSurfaceV1({
  NEXT_PUBLIC_BASE_BUILDER_CODE: process.env.NEXT_PUBLIC_BASE_BUILDER_CODE,
  NEXT_PUBLIC_BUILDER_CODE: process.env.NEXT_PUBLIC_BUILDER_CODE,
});
const BUILDER_SUFFIX = builderCodeToDataSuffix(BUILDER_CODE);

const B20_QUOTE_ASSET_V1 = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

interface SubmissionState {
  status: BlueprintSubmitStatus;
  batchId: string | null;
  txHashes: string[];
  error: string | null;
  proofId: string | null;
  recordedFinalStatus: string | null;
}

const RECONCILABLE: BlueprintSubmitStatus[] = ["confirmed", "failed", "submitted_unknown"];

const SECTION_STORAGE_KEY_V1 = "miorail.section.v1";

function readStoredSectionV1(): ConsoleSectionV1 {
  try {
    const stored = globalThis.sessionStorage?.getItem(SECTION_STORAGE_KEY_V1);
    if (stored && (MINIAPP_SECTIONS_V1 as readonly string[]).includes(stored)) {
      return stored as ConsoleSectionV1;
    }
  } catch {
    /* storage can be blocked; Opportunities is the default either way */
  }
  return "opportunities";
}

/** T70 §4 — every one of these has a real handler below. A section with none
 * would be absent from this list, not present and inert. */
const MINIAPP_SECTIONS_V1 = CONSOLE_PRIMARY_SECTIONS_V1;


export function MiniConsole() {
  const { address, chainId } = useAccount();
  const { theme, setTheme } = useConsoleTheme();

  // T70 §4/§8 — the Base App section, from the SAME table the web header reads.
  //
  // Persisted in sessionStorage rather than a URL: the miniapp is one page, and
  // a Mini App host can remount it on resume. What is stored is the section
  // name and nothing else — no address, no balance, no goal.
  const [section, setSection] = useState<ConsoleSectionV1>(readStoredSectionV1);
  useEffect(() => {
    try {
      globalThis.sessionStorage?.setItem(SECTION_STORAGE_KEY_V1, section);
    } catch {
      /* a blocked store costs the section on resume and nothing else */
    }
  }, [section]);

  const [screen, setScreen] = useState<ConsoleScreenV1>("plan");
  const [goal, setGoal] = useState("");
  /** The one-word reply to a clarification, held beside the goal it completes. */
  const [answerDraft, setAnswerDraft] = useState("");
  const [clock, setClock] = useState<ConsoleStageClockV1>(emptyStageClockV1);
  const [railOpen, setRailOpen] = useState(false);
  const [submission, setSubmission] = useState<SubmissionState | null>(null);
  const [nftSubmission, setNftSubmission] = useState<SubmissionState | null>(null);
  const [nftProof, setNftProof] = useState<NftProofResponseV1 | null>(null);
  const [simulateResponse, setSimulateResponse] = useState<SimulateBlueprintResponseV1 | null>(null);
  const [budgetResponse, setBudgetResponse] = useState<SimulateWithBudgetResponseV1 | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);

  const mark = useCallback((stage: ConsoleStageV1, phase: "start" | "complete") => {
    const at = Date.now();
    setClock((current) => (phase === "start" ? startStageV1(current, stage, at) : completeStageV1(current, stage, at)));
  }, []);

  const status = useStatus();
  const evaluation = useEvaluateSwapRoute();
  const earnCompare = useEarnCompare();
  const commerceCompare = useCommerceCompare();
  const nftCompare = useNftCompare();
  const aiCompare = useAiCompare();
  const aiExecute = useAiExecute();
  // T66C — the nonce lives HERE and nowhere else. The server returned it once
  // and kept no copy.
  const [aiNonce, setAiNonce] = useState<string | null>(null);
  const nftPrepare = useNftPrepare();
  const commerceOrder = useCreateCommerceOrder();
  const prepare = usePrepareSwapBlueprint();
  const flags = status.data?.productMigration;
  const paidIntelligenceOn = flags?.paidIntelligence === true;
  const budget = useIntelligenceBudget({ enabled: paidIntelligenceOn });
  // T71 — the SAME flow the web console uses. A second implementation here
  // would be a second payment path, and the second one always skips a check.
  const pauseBudget = usePauseIntelligenceBudget();
  const resumeBudget = useResumeIntelligenceBudget();
  const revokeBudget = useRevokeIntelligenceBudget();
  const spendPermissionGrant = useSpendPermissionGrant();
  const budgetSimulate = useSimulateWithBudget({
    onSuccess: (response) => {
      setBudgetResponse(response);
      mark("simulation", "complete");
    },
  });
  const history = useRouteHistory({ limit: 5 });
  // The paid ledger, only while Activity is open: it is the one thing this
  // product has provably completed, and it was invisible on a tab that showed
  // route runs which never reached a signature.
  const ledger = useX402Ledger({ enabled: section === "activity" });
  const market = useMarketSnapshot();
  const portfolio = usePortfolio(address);

  const connected = Boolean(address);
  // Not having the server's flags yet is a different state from having them
  // and finding a family off. Saying "off" for both sent operators looking for
  // a flag that was already on.
  const statusGate = status.data
    ? null
    : status.error
      ? `Server capabilities could not be read: ${(status.error as Error).message}`
      : "Reading this server’s capabilities…";
  const result = evaluation.data;
  const projection = result?.outcome === "evaluated" ? (result.projection as unknown as RoutePlanProjectionV1) : null;
  const recommended = projection?.recommendedRoute ?? null;
  const primaryRoute =
    recommended ?? (projection?.availableRoutes.length === 1 ? projection.availableRoutes[0]! : null);
  const goalLabel = projection?.goalSummary ?? (goal.trim() || "New goal");
  const prepared = prepare.data?.outcome === "prepared" ? prepare.data : null;

  const dispatch = useMemo(
    () =>
      dispatchRouteFamilyV1(goal, {
        routeIntelligenceV1: flags?.routeIntelligenceV1 === true,
        earnRouteV1: flags?.earnRouteV1 === true,
        commerceRouteV1: flags?.commerceRouteV1 === true,
        commerceExecutionV1: flags?.commerceExecutionV1 === true,
        nftRouteV1: flags?.nftRouteV1 === true,
        nftExecutionV1: flags?.nftExecutionV1 === true,
      }),
    [goal, flags],
  );

  // The earn result is READ here too — a dispatched Earn goal must land on a
  // Route Card, not sit on Comparing.
  const earnCard = earnCompare.data?.outcome === "compared" ? earnCompare.data : null;

  // The commerce result is READ, not just requested — the same dead end the
  // T63D audit found on the earn path.
  const commerceCard = commerceCompare.data?.outcome === "compared" ? commerceCompare.data : null;
  const commerceCheckout = useMemo(
    () =>
      commerceCheckoutAvailableV1({
        routeIntelligenceV1: flags?.routeIntelligenceV1 === true,
        earnRouteV1: flags?.earnRouteV1 === true,
        commerceRouteV1: flags?.commerceRouteV1 === true,
        commerceExecutionV1: flags?.commerceExecutionV1 === true,
      }),
    [flags],
  );
  const commerceOrderResult = commerceOrder.data?.outcome === "created" ? commerceOrder.data : null;

  // Both NFT outcomes carry a card: a listing that vanished still names the
  // token and says why there is nothing to buy.
  const nftCard =
    nftCompare.data?.outcome === "compared" || nftCompare.data?.outcome === "unavailable"
      ? nftCompare.data.routeCard
      : null;
  const nftRunId =
    nftCompare.data?.outcome === "compared" || nftCompare.data?.outcome === "unavailable"
      ? nftCompare.data.routeRunId
      : null;
  const nftPrepared = nftPrepare.data?.outcome === "prepared" && nftCard ? { response: nftPrepare.data, card: nftCard } : null;
  const aiCard =
    aiCompare.data?.outcome === "compared" || aiCompare.data?.outcome === "unavailable"
      ? aiCompare.data.routeCard
      : null;
  const aiRunId =
    aiCompare.data?.outcome === "compared" || aiCompare.data?.outcome === "unavailable"
      ? aiCompare.data.routeRunId
      : null;
  const aiCommitment = aiCompare.data?.outcome === "compared" ? aiCompare.data.promptCommitment : null;
  const aiExecuted =
    aiExecute.data?.outcome === "completed" || aiExecute.data?.outcome === "refused" ? aiExecute.data : null;

  const runAi = () => {
    if (!address || !aiCard || !aiRunId || !aiNonce || !goal.trim()) return;
    mark("signed", "start");
    aiExecute.mutate(
      {
        routeRunId: aiRunId,
        routeCardHash: aiCard.routeCardHash,
        walletAddress: address.toLowerCase() as `0x${string}`,
        messages: [{ role: "user", text: goal }],
        promptNonce: aiNonce,
      },
      {
        onSettled: () => mark("signed", "complete"),
        onSuccess: (response) => {
          if (response.outcome !== "blocked") setScreen("proof");
        },
      },
    );
  };

  const reviewNft = () => {
    if (!address || !nftCard || !nftRunId) return;
    nftPrepare.mutate({
      routeRunId: nftRunId,
      routeCardHash: nftCard.routeCardHash,
      walletAddress: address.toLowerCase() as `0x${string}`,
    });
    setScreen("review");
  };

  // The same sequence the web console runs, driven by the same shared hook:
  // one bounded reconcile per terminal wallet result, never a second wallet
  // prompt and never a claim of ownership this surface made up.
  const nftReconcile = useNftReconcile({ onSuccess: (response) => setNftProof(response) });
  const nftReconciled = useRef<string | null>(null);
  const onNftSubmission = useCallback(
    (next: SubmissionState) => {
      setNftSubmission(next);
      if (next.status !== "idle") mark("signed", "start");
      const terminal = next.status === "confirmed" || next.status === "failed" || next.status === "submitted_unknown";
      if (next.proofId) setScreen("proof");
      if (!next.proofId || !terminal || nftReconciled.current === next.proofId) return;
      nftReconciled.current = next.proofId;
      mark("signed", "complete");
      nftReconcile.mutate({ proofId: next.proofId });
    },
    [mark, nftReconcile],
  );

  // T64.3.1 — the same two defects the console had: a Commerce comparison did
  // not count as pending, and a `needs_clarification` result left this screen
  // waiting on a run that had already finished, with raw issue codes as the
  // only explanation and no way back to the goal.
  // T65.2A: the NFT comparison was missing from both, so an NFT run read
  // "done" while OpenSea was still being asked, and a card that arrived was
  // treated as a failed run.
  const comparePending =
    evaluation.isPending ||
    earnCompare.isPending ||
    commerceCompare.isPending ||
    nftCompare.isPending ||
    aiCompare.isPending;
  const comparingFailure = (() => {
    if (comparePending || projection || earnCard || commerceCard || nftCard || aiCard) return null;
    // Swap was missing from this chain in BOTH consoles — the one family that
    // is always on. Without it a goal the server asked a question about left
    // this screen waiting on a run that had already finished.
    const swapFailure = swapTerminalFailureV1(evaluation.data as never);
    if (swapFailure) return swapFailure;
    if (commerceCompare.data?.outcome === "needs_clarification") {
      return {
        title: "This goal needs one more detail",
        detail: commerceCompare.data.issues.map((issue) => consoleFailureCopyV1(issue)).join(" "),
      };
    }
    if (commerceCompare.data?.outcome === "unsupported") {
      return { title: "Miorail cannot route this purchase", detail: consoleFailureCopyV1(commerceCompare.data.reason) };
    }
    if (earnCompare.data?.outcome === "needs_clarification") {
      return {
        title: "This goal needs one more detail",
        detail: earnCompare.data.issues.map((issue) => consoleFailureCopyV1(issue)).join(" "),
      };
    }
    if (earnCompare.data?.outcome === "unsupported") {
      return { title: "Miorail cannot route this goal", detail: consoleFailureCopyV1(earnCompare.data.reason) };
    }
    if (nftCompare.data?.outcome === "needs_clarification") {
      return {
        title: "This goal needs one more detail",
        detail: nftCompare.data.issues.map((issue) => consoleFailureCopyV1(issue)).join(" "),
      };
    }
    if (nftCompare.data?.outcome === "unsupported") {
      return { title: "Miorail cannot route this NFT purchase", detail: consoleFailureCopyV1(nftCompare.data.reason) };
    }
    if (aiCompare.data?.outcome === "needs_clarification") {
      return {
        title: "This goal needs one more detail",
        detail: aiCompare.data.issues.map((issue) => consoleFailureCopyV1(issue)).join(" "),
      };
    }
    if (aiCompare.data?.outcome === "unsupported") {
      return { title: "Miorail cannot route this AI request", detail: consoleFailureCopyV1(aiCompare.data.reason) };
    }
    const transportError = (evaluation.error ??
      earnCompare.error ??
      commerceCompare.error ??
      nftCompare.error ??
      aiCompare.error) as Error | null;
    if (transportError) {
      return {
        title: "The comparison could not be completed",
        detail: `${transportError.message} Nothing was signed or spent.`,
      };
    }
    return dispatch.blockedReason
      ? { title: "This route family is off on this server", detail: dispatch.blockedReason }
      : null;
  })();
  const commerceSettled = useRef(false);
  useEffect(() => {
    if (!commerceCard || commerceSettled.current) return;
    commerceSettled.current = true;
    mark("evidence", "start");
    mark("evidence", "complete");
    mark("score", "start");
    mark("score", "complete");
    setScreen("route");
  }, [commerceCard, mark]);
  // Without this the NFT family had no way off Comparing at all.
  const aiSettled = useRef(false);
  useEffect(() => {
    if (!aiCard || aiSettled.current) return;
    aiSettled.current = true;
    mark("evidence", "start");
    mark("evidence", "complete");
    mark("score", "start");
    mark("score", "complete");
    setScreen("route");
  }, [aiCard, mark]);

  const nftSettled = useRef(false);
  useEffect(() => {
    if (!nftCard || nftSettled.current) return;
    nftSettled.current = true;
    mark("evidence", "start");
    mark("evidence", "complete");
    mark("score", "start");
    mark("score", "complete");
    setScreen("route");
  }, [nftCard, mark]);

  const earnSettled = useRef(false);
  useEffect(() => {
    if (!earnCard || earnSettled.current) return;
    earnSettled.current = true;
    mark("evidence", "start");
    mark("evidence", "complete");
    mark("score", "start");
    mark("score", "complete");
    setScreen("route");
  }, [earnCard, mark]);

  const settled = useRef(false);
  useEffect(() => {
    if (!projection || settled.current) return;
    settled.current = true;
    mark("candidates", "complete");
    mark("evidence", "start");
    mark("evidence", "complete");
    if (projection.pathScore) {
      mark("score", "start");
      mark("score", "complete");
    }
    setScreen("route");
  }, [projection, mark]);

  useEffect(() => {
    if (prepared) mark("review", "complete");
  }, [prepared, mark]);

  useEffect(() => {
    if (simulateResponse) mark("simulation", "complete");
  }, [simulateResponse, mark]);

  const submissionStatus = submission?.status;
  useEffect(() => {
    if (submissionStatus === "confirmed" || submissionStatus === "submitted_unknown") {
      mark("signed", "complete");
      mark("proof", "start");
      setScreen("proof");
    }
  }, [submissionStatus, mark]);

  const reconciliation = useBoundedProofReconciliation({
    proofId: submission?.proofId ?? null,
    routeRunId: prepared?.routeRunId ?? null,
    walletAddress: address ? (address.toLowerCase() as `0x${string}`) : null,
    enabled: Boolean(submission && submission.proofId && RECONCILABLE.includes(submission.status)),
  });

  useEffect(() => {
    if (reconciliation.proof) mark("proof", "complete");
  }, [reconciliation.proof, mark]);

  /** `fresh` forces a NEW route run — see the web console for why the
   * default is idempotent and these two callers are not. */
  const compare = (options?: { fresh?: boolean; goalOverride?: string }) => {
    const requestGoal = options?.goalOverride?.trim() || goal.trim();
    if (!address || !requestGoal || dispatch.engine === null) return;
    prepare.reset();
    setSubmission(null);
    setSimulateResponse(null);
    setBudgetResponse(null);
    // A new goal clears the NFT flow too. Without this, a finished NFT purchase
    // would keep claiming the Proof screen from whatever family comes next.
    nftCompare.reset();
    nftPrepare.reset();
    setNftSubmission(null);
    setNftProof(null);
    nftReconciled.current = null;
    nftSettled.current = false;
    aiCompare.reset();
    aiExecute.reset();
    setAiNonce(null);
    aiSettled.current = false;
    settled.current = false;
    earnSettled.current = false;
    commerceSettled.current = false;
    commerceOrder.reset();
    const at = Date.now();
    let next = emptyStageClockV1();
    next = startStageV1(next, "intent", at);
    next = completeStageV1(next, "intent", at);
    next = startStageV1(next, "candidates", at);
    setClock(next);
    setScreen("comparing");
    const wallet = address.toLowerCase() as `0x${string}`;
    if (dispatch.engine === "private_ai") {
      // The goal text IS the prompt.
      aiCompare.mutate(
        {
          messages: [{ role: "user", text: requestGoal }],
          walletAddress: wallet,
          maxSpendUsd: "0.05",
          maxCompletionTokens: 1_024,
          privacyRequirement: "private_only",
        },
        {
          onSettled: () => mark("candidates", "complete"),
          onSuccess: (response) => {
            if (response.outcome === "compared") setAiNonce(response.promptNonce);
          },
        },
      );
      return;
    }
    if (dispatch.engine === "nft") {
      // NFT before commerce: the two families share the verb "buy".
      nftCompare.mutate({ message: requestGoal, walletAddress: wallet }, { onSettled: () => mark("candidates", "complete") });
      return;
    }
    if (dispatch.engine === "commerce") {
      commerceCompare.mutate(
        { message: requestGoal, walletAddress: wallet },
        { onSettled: () => mark("candidates", "complete") },
      );
      return;
    }
    if (dispatch.engine === "earn") {
      earnCompare.mutate({ message: requestGoal, walletAddress: wallet }, { onSettled: () => mark("candidates", "complete") });
      return;
    }
    // No onError here, deliberately — see RouteIntelligenceConsole. Bouncing to
    // Plan threw away the reason and left the user on the home screen with
    // nothing to act on.
    evaluation.mutate(
      {
        message: requestGoal,
        walletAddress: wallet,
        ...(options?.fresh ? { requestId: `retry-${globalThis.crypto.randomUUID()}` } : {}),
      },
      { onSettled: () => mark("candidates", "complete") },
    );
  };

  /**
   * Answers the server's clarification without retyping the goal. The rest of
   * the goal is held server-side against this wallet, so one word finishes it —
   * see RouteIntelligenceConsole for why it never travels through the client.
   *
   * Swap only: it is the family whose engine keeps a pending intent.
   */
  const answerClarification = (answer: string) => {
    const trimmed = answer.trim();
    if (!address || !trimmed || dispatch.engine !== "swap") return;
    setAnswerDraft("");
    settled.current = false;
    const at = Date.now();
    let next = emptyStageClockV1();
    next = startStageV1(next, "intent", at);
    next = completeStageV1(next, "intent", at);
    next = startStageV1(next, "candidates", at);
    setClock(next);
    // The goal box is left as the user typed it: appending the answer would
    // build a sentence nobody wrote, and "Swap 0.1 to Eth USDC" re-reads as the
    // reverse pair.
    evaluation.mutate(
      { message: trimmed, walletAddress: address.toLowerCase() as `0x${string}` },
      { onSettled: () => mark("candidates", "complete") },
    );
  };

  const reviewCandidate = (candidateHash: string) => {
    if (!address || !projection?.routeCardHash || result?.outcome !== "evaluated") return;
    setSubmission(null);
    setSimulateResponse(null);
    setBudgetResponse(null);
    mark("review", "start");
    setScreen("review");
    prepare.mutate({
      walletAddress: address.toLowerCase() as `0x${string}`,
      routeRunId: result.routeRunId,
      routeCardHash: projection.routeCardHash,
      selectedCandidateHash: candidateHash,
    });
  };

  const steps = useMemo(() => stepperFromClockV1(clock), [clock]);
  const stepLabel = compactStepLabelV1(activeStageStepV1(clock));
  const evidenceRows = projection ? evidenceRowsFromProjectionV1(projection) : [];
  const spendLabel = intelligenceSpendLabelV1(projection ? evidenceSourcesFromProjectionV1(projection) : []);

  // T67E §3 — same derivation as the web console, from the same helper, so the
  // two surfaces cannot report different reasons for the same run.
  const providerFailures = useMemo(
    () => (projection ? providerFailuresFromProjectionV1(projection) : []),
    [projection],
  );
  const comparisonClaim = useMemo(
    () => (projection ? comparisonClaimFromProjectionV1(projection) : null),
    [projection],
  );
  const diagnosticRows = useMemo(
    () => (projection ? providerDiagnosticRowsV1(projection, REGISTERED_SWAP_PROVIDERS_V1) : []),
    [projection],
  );
  const candidateRows = useMemo(
    () => (projection ? candidateRowsFromProjectionV1(projection, REGISTERED_SWAP_PROVIDERS_V1) : []),
    [projection],
  );
  const selectableCandidates = candidateRows.filter((row) => row.selectable);
  const reviewTarget =
    recommended?.candidateHash ??
    (selectableCandidates.length === 1 ? selectableCandidates[0]!.id : null);
  const providerConstraintResolution = providerConstraintResolutionV1({
    hasProjection: Boolean(projection),
    routeCardHash: projection?.routeCardHash ?? null,
    protocolConstraint:
      result?.outcome === "evaluated" ? result.intent.protocolConstraint : null,
    providerDisplayName: primaryRoute?.provider.displayName,
  });
  const needsProviderConstraint = providerConstraintResolution.needsConstraint;

  const selectCandidateForReview = (candidateHash: string) => {
    if (projection?.routeCardHash) {
      reviewCandidate(candidateHash);
      return;
    }
    if (providerConstraintResolution.blockedReason) return;
    const route = projection?.availableRoutes.find((entry) => entry.candidateHash === candidateHash);
    if (!route) return;
    const constrainedGoal = providerConstrainedGoalV1(goal, route.provider.displayName);
    setGoal(constrainedGoal);
    compare({ fresh: true, goalOverride: constrainedGoal });
  };

  // T67E §1 — same target rule and same copy as the web console: the card is
  // about the token the route ACQUIRES.
  const b20GateOn = flags?.b20ControlV1 === true;
  const b20Target = b20TargetForRouteV1(primaryRoute?.expectedOutput.asset ?? null);
  const b20 = useB20Inspect(b20Target.address, { enabled: b20GateOn });
  const b20Card = b20.data?.card ?? null;
  const b20Unavailable = b20UnavailableCopyV1({
    gateEnabled: b20GateOn,
    skipReason: b20Target.skipReason,
    errorCode: b20ErrorCodeV1(b20.error),
  });
  const b20Panels = (detailed: boolean) => (
    <B20ControlSection
      card={b20Card}
      watch={b20.data?.watch ?? null}
      loading={b20.isPending && b20GateOn && b20Target.address !== null}
      unavailableReason={b20Card ? null : b20Unavailable}
      cached={b20.data?.cached === true}
      detailed={detailed}
    />
  );
  const adapterRows = useMemo(
    () =>
      deriveAdapterRowsV1(
        adaptersFromStatusV1(
          status.data ?? null,
          (projection?.availableRoutes ?? []).map((route) => ({ name: route.provider.displayName })),
          // Same defect as the web console: the wire field is `provider`.
          providerFailures.map((failure) => ({
            name: failure.providerName,
            reason: failure.reasonLabel,
          })),
        ),
      ),
    [status.data, projection, providerFailures],
  );
  const budgetRecord = budget.data?.budget ?? null;

  // T67E §2 — the same drawer as the web console, from the same component.
  const charges = useIntelligenceCharges({ enabled: paidIntelligenceOn });
  const budgetPanel = (
    <BudgetPaymentsPanel
      featureEnabled={paidIntelligenceOn}
      settleReady={status.data?.paidIntelligence?.settleReady === true}
      budget={budgetRecord}
      charges={charges.data?.charges ?? []}
      chargesLoading={charges.isPending && paidIntelligenceOn}
      chargesUnavailableReason={charges.error ? "Your charge history could not be read right now." : null}
      onEnablePaidEvidence={spendPermissionGrant.enable}
      onboardingStatus={spendPermissionGrant.status}
      onboardingDetail={spendPermissionGrant.detail}
      onboardingConsent={spendPermissionGrant.consent}
      onRetryVerification={spendPermissionGrant.retryVerification}
      canRetryVerification={spendPermissionGrant.canRetryVerification}
      onPause={() => pauseBudget.mutate()}
      onResume={() => resumeBudget.mutate()}
      onRevoke={() => revokeBudget.mutate()}
      changePending={
        spendPermissionGrant.pending ||
        pauseBudget.isPending ||
        resumeBudget.isPending ||
        revokeBudget.isPending
      }
    />
  );
  const simulationSource = simulationSourceFromResponseV1(simulateResponse ?? budgetResponse);
  // Same rule as the web console: `prepared` is the Safety Kernel's verdict.
  const simulation = deriveSimulationViewV1(simulationSource, Boolean(prepared));
  const quoteFreshness = quoteFreshnessFromRouteV1(primaryRoute);
  const historyItems = history.data?.items ?? [];
  // The same pure mapper the web console uses, so both surfaces state a price,
  // its age and its provider identically — or state why there is none.
  const marketRail = marketRailFromSnapshotV1(market.data, new Date());

  const panels = (
    <ConsoleRightRail
      price={marketRail.price}
      priceUnavailableReason={
        marketRail.unavailableReason ?? providerUnavailableCopyV1(status.data?.prices, "price")
      }
      depth={null}
      depthUnavailableReason="No depth source is connected — liquidity stays unscored rather than guessed."
      evidenceFeed={evidenceRows.map((row, index) => ({
        id: `${row.name}-${index}`,
        time: row.freshnessLabel,
        source: row.name,
        text: row.available ? `${row.kind} · ${row.costLabel}` : row.resultLabel,
        available: row.available,
      }))}
      spend={
        budgetRecord
          ? {
              percent: usagePercentV1(Number(budgetRecord.spentUsdc), Number(budgetRecord.monthlyLimitUsdc)),
              amount: `$${budgetRecord.spentUsdc}`,
              capLabel: `of $${budgetRecord.monthlyLimitUsdc} cap`,
              rows: evidenceRows.map((row) => ({ label: row.name, value: row.costLabel })),
            }
          : null
      }
      freshness={[
        { label: "Quote age", value: quoteFreshness.label.replace("quote ", ""), tone: quoteFreshness.stale ? "off" : undefined },
        { label: "Simulation age", value: ageLabelV1(simulationSource?.ageSeconds ?? null) },
        { label: "Re-sim before signing", value: simulation.passed ? "on" : "not run", tone: simulation.passed ? "ok" : "off" },
      ]}
    />
  );

  const drawer = (
    <>
      <button type="button" className="newgoal" onClick={() => { setScreen("plan"); setGoal(""); setClock(emptyStageClockV1()); settled.current = false; }}>
        + New goal
      </button>
      <div className="sechead">
        <span>Active session</span>
      </div>
      {projection ? (
        <button type="button" className="item on" onClick={() => setScreen("route")}>
          <span className="t">{goalLabel}</span>
          <span className="m">
            <span className="tag b">{projection.outcome}</span>
            {projection.availableRoutes.length} routes
          </span>
        </button>
      ) : (
        <p className="empty">No active session yet — start one above.</p>
      )}
      {/* T67E §2.1 — the drawer opens from the panel that already shows the
          spend, not from a nav entry called "x402". */}
      <div className="minipanel">
        <div className="row">
          <span>Budget &amp; payments</span>
          <button type="button" className="btn sec" onClick={() => setBudgetOpen((open) => !open)}>
            {budgetOpen ? "Close" : "Open"}
          </button>
        </div>
      </div>
      <div className="sechead">
        <span>Recent proofs</span>
        <span className="mono">{historyItems.length}</span>
      </div>
      {historyItems.length === 0 ? (
        <p className="empty">No proofs yet. They appear here after your first signed route.</p>
      ) : (
        historyItems.slice(0, 5).map((run) => (
          <div key={run.routeRunId} className="item">
            <span className="t">{run.intentSummary || run.routeRunId}</span>
            <span className="m">
              <span className="tag n">{run.proofFinalStatus ?? run.runStatus}</span>
            </span>
          </div>
        ))
      )}
      <div className="minipanel">
        <div className="row">
          <span>Route adapters</span>
          <span className="v mono">{adapterRows.summary}</span>
        </div>
        {adapterRows.rows.map((row) => (
          <div key={row.name} className={`row${row.usable ? "" : " off"}`}>
            <span>{row.name}</span>
            <span className={`v${row.live ? " ok" : ""}`}>{row.label}</span>
          </div>
        ))}
      </div>
      <div className="minipanel">
        <WalletConnect />
      </div>
    </>
  );

  // --- T70 §4: the three sections beside Routes ------------------------------
  //
  // All three reuse existing hooks and existing shared projections. Base App
  // gets no Discover logic, no card projection and no qualification path of its
  // own — the whole point of §4 is that there is one of each.

  const [feedFilter, setFeedFilter] = useState<OpportunityFilterV1>("all");
  const [feedStanding, setFeedStanding] = useState<OpportunityStandingFilterV1>("all");
  const [feedFresh, setFeedFresh] = useState(false);
  const [copilotToken, setCopilotToken] = useState<string | null>(null);
  const [consoleScope, setConsoleScope] = useState<B20ConsoleScopeViewV1>("explore");
  // The B20 tab's own console state. Separate from Discover's: they are two
  // surfaces asking two different questions, and sharing one would move a
  // reader's scope when they switched tabs.
  const [portfolioScope, setPortfolioScope] = useState<B20ConsoleScopeViewV1>("portfolio");
  const [consoleTokens, setConsoleTokens] = useState<readonly string[]>([]);
  const [contextToken, setContextToken] = useState<string | null>(null);
  const opportunities = useB20Opportunities(
    // The verdict section is filtered by the server, so Base App gets the same
    // sections the web console does without a second grouping rule of its own.
    { state: feedFilter, standing: feedStanding, freshness: feedFresh ? "fresh" : "all" },
    { enabled: b20GateOn && section === "opportunities" },
  );
  const copilot = useB20CopilotAsk();
  const launchContext = useB20LaunchContext(contextToken);
  // Unverified public context, on request. Base App renders the same
  // shared card as the web console, so the two surfaces cannot drift on
  // what the layer claims.
  const [publicContextToken, setPublicContextToken] = useState<string | null>(null);
  const publicContext = useB20PublicContext();
  // The scope the SERVER answered in wins: an address in the question moves the
  // answer to that token, and leaving the tab where it was would label it wrongly.
  const b20Console = useB20ConsoleAsk({ onSuccess: (answer) => setConsoleScope(answer.scope) });
  const feedPipeline = opportunities.data?.pipeline ?? null;
  const feedHome = consoleHomeSectionV1({
    pipeline: feedPipeline
      ? { state: feedPipeline.state as ConsolePipelineStateV1, message: feedPipeline.message }
      : null,
    observationCount: opportunities.data?.cards.length ?? 0,
    walletConnected: Boolean(address),
  });

  // The B20 tab: what is held, plus adding one by address. The same server-side
  // watchlist the web console writes to — not a second list in this browser.
  const watchlist = useB20Watchlist({ enabled: b20GateOn && Boolean(address) && section === "portfolio" });
  // A mutation, and only when the surface is open: every call is an
  // authenticated round trip to somebody else's server with the user's
  // credentials attached, so it is never a poll and never runs on mount.
  const baseMcpProbe = useBaseMcpToolsProbe();
  // The published plugin specs, unlike the tools above: public, cheap, and
  // true whether or not this Base App session has ever authorized. Fetched
  // only while the section is open so an unopened tab costs nothing.
  const baseMcpPlugins = useBaseMcpPlugins({ enabled: section === "extensions" });
  // The Base MCP thread, kept out of the B20 and Routes surfaces: those carry
  // measured routes, this carries whatever a third-party tool returned.
  const baseMcpAsk = useBaseMcpConsole();
  const reconcileBaseMcpAction = useReconcileBaseMcpAction();
  const baseMcpActionReceipts = useBaseMcpActionReceipts({ enabled: section === "activity" });
  const [baseMcpQuestion, setBaseMcpQuestion] = useState("");

  // --- the paid B20 exit proof and explicit entry, in Base App ---------------
  //
  // The exit card still exposes entry only for a live qualified clearance.
  // From there Base App uses the same server projection, exact calls, Base
  // Account approval and server receipt reconciliation as the web console.
  const [exitToken, setExitToken] = useState<string | null>(null);
  const [exitProfile, setExitProfile] = useState<ExitProfileV1>(EXIT_PROFILE_DEFAULTS_V1);
  const exitCheck = useB20ExitCheck();
  const exitSimulate = useB20OpportunitySimulate();
  const exitProofPriceUsdc =
    status.data?.paidIntelligence?.pricedSurfaces?.b20ExitProof?.priceUsdc ?? null;
  const exitProofPayment = useB20ExitProofPayment({});

  const exitProfileAtomic = useMemo(() => {
    const positionAtomic = usdcToAtomicV1(exitProfile.position);
    const maxRoundTripBps = percentToBpsV1(exitProfile.maxRoundTrip);
    const maxExitSlippageBps = percentToBpsV1(exitProfile.maxSlippage);
    if (!positionAtomic || !maxRoundTripBps || !maxExitSlippageBps) return null;
    return { positionAtomic, maxRoundTripBps, maxExitSlippageBps };
  }, [exitProfile]);

  const runExitCheck = useCallback(
    (token: string) => {
      if (!exitProfileAtomic) return;
      setExitToken(token);
      exitCheck.mutate({
        tokenAddress: token,
        positionAtomic: exitProfileAtomic.positionAtomic,
        maxRoundTripBps: exitProfileAtomic.maxRoundTripBps,
        maxSlippageBps: exitProfileAtomic.maxExitSlippageBps,
      });
    },
    [exitCheck, exitProfileAtomic],
  );

  // Two paths, chosen by whether the SERVER says this costs money — the same
  // rule as the web console. The paid path needs a wallet client to answer the
  // 402; the free path cannot answer one at all.
  const runExitSimulation = useCallback(
    (token: string) => {
      if (!exitProfileAtomic) return;
      setExitToken(token);
      const request = {
        tokenAddress: token,
        positionAtomic: exitProfileAtomic.positionAtomic,
        maxRoundTripBps: exitProfileAtomic.maxRoundTripBps,
        maxExitSlippageBps: exitProfileAtomic.maxExitSlippageBps,
      };
      if (exitProofPriceUsdc) {
        void exitProofPayment.run(request);
        return;
      }
      exitSimulate.mutate(request);
    },
    [exitProfileAtomic, exitProofPayment, exitProofPriceUsdc, exitSimulate],
  );

  // The simulation's answer wins when there is one: it is the only measurement
  // that can confirm, and a stale provisional beside a fresh confirmation
  // would be two answers to one question.
  const exitResult = useMemo(() => {
    const simulated = exitSimulate.data ?? exitProofPayment.response;
    if (simulated) {
      return {
        status: simulated.viability,
        reason: simulated.rejectionReason,
        unmeasuredReason: simulated.unmeasuredReason,
        coverage: simulated.coverage,
        viableRouteConfirmed: simulated.viableRouteConfirmed,
        bestRouteConfirmed: simulated.bestRouteConfirmed,
        clearanceId: simulated.clearanceId,
        expiresAt: simulated.expiresAt,
        simulatedRoundTripBps: simulated.simulatedRoundTripBps,
        simulationBlockNumber: simulated.simulationBlockNumber,
        controlsBlockNumber: simulated.controlsBlockNumber,
        checkedAt: simulated.checkedAt,
        measurement: null,
        optimistic: false,
        roundTripCostBps: simulated.simulatedRoundTripBps,
        exitCapacityAtomic: null,
        firstFailingAtomic: null,
        probeCount: 0,
        capacityInformative: false,
        referenceSizeAtomic: null,
        endpointDegraded: false,
      };
    }
    return exitCheck.data ?? null;
  }, [exitSimulate.data, exitProofPayment.response, exitCheck.data]);

  // The B20 entry flow is intentionally adapted here rather than replaced by
  // a miniapp-only state machine. The server remains the source of calls,
  // lifecycle and proof truth; this surface only opens the Base Account and
  // forwards the resulting batch/transaction identifiers.
  const [b20EntryPlanId, setB20EntryPlanId] = useState<string | null>(null);
  const [b20WalletError, setB20WalletError] = useState<string | null>(null);
  const b20PrepareEntry = useB20PrepareEntry();
  const b20BeginSubmission = useB20BeginEntrySubmission();
  const b20RecordSubmission = useB20RecordEntrySubmission();
  const b20ReconcileSubmission = useB20ReconcileEntrySubmission();
  const b20SendCalls = useSendCalls();
  const b20EntryStatus = useB20EntryStatus(b20EntryPlanId, { enabled: Boolean(b20EntryPlanId) });
  const b20EntryReview = b20EntryStatus.data?.review ?? b20PrepareEntry.data?.review ?? null;
  const b20EntryState = b20EntryStatus.data?.status ?? null;
  const b20WalletBatchStatus = useCallsStatus({
    id: b20EntryState?.batchId ?? "",
    query: {
      enabled: Boolean(
        b20EntryState?.batchId &&
        (b20EntryState.state === "submitted" || b20EntryState.state === "reconciling"),
      ),
      refetchInterval: 2_000,
      retry: false,
    },
  });
  const reconciledB20WalletStatusRef = useRef<string | null>(null);

  useEffect(() => {
    const walletStatus = b20WalletBatchStatus.data as {
      status?: string;
      receipts?: Array<{ transactionHash?: string }>;
    } | undefined;
    if (
      !b20EntryPlanId ||
      !b20EntryState?.attemptId ||
      (walletStatus?.status !== "success" && walletStatus?.status !== "failure")
    ) return;
    const transactionHashes = transactionHashesFromReceipts(walletStatus.receipts);
    if (transactionHashes.length === 0) return;
    const key = `${b20EntryState.attemptId}:${transactionHashes.join(",")}`;
    if (reconciledB20WalletStatusRef.current === key) return;
    reconciledB20WalletStatusRef.current = key;
    b20ReconcileSubmission.mutate(
      { planId: b20EntryPlanId, attemptId: b20EntryState.attemptId, transactionHashes },
      {
        onError: () => {
          setB20WalletError("Base receipt verification is temporarily unavailable. Use Check proof to retry.");
        },
      },
    );
  }, [b20EntryPlanId, b20EntryState?.attemptId, b20ReconcileSubmission, b20WalletBatchStatus.data]);

  const b20ProfileIdentityV1 = useCallback(
    () =>
      [
        B20_QUOTE_ASSET_V1,
        usdcToAtomicV1(exitProfile.position),
        percentToBpsV1(exitProfile.maxRoundTrip),
        percentToBpsV1(exitProfile.maxSlippage),
      ].join(":"),
    [exitProfile],
  );

  const buildB20EntryPlan = useCallback(
    (clearanceId: string) => {
      setB20WalletError(null);
      b20PrepareEntry.mutate(
        {
          clearanceId,
          profileIdentity: b20ProfileIdentityV1(),
          requestId: `entry:${clearanceId}`,
        },
        { onSuccess: (data) => setB20EntryPlanId(data.planId) },
      );
    },
    [b20PrepareEntry, b20ProfileIdentityV1],
  );

  const confirmB20EntryInWallet = useCallback(async () => {
    if (!b20EntryPlanId) return;
    setB20WalletError(null);
    const begun = await b20BeginSubmission.mutateAsync({
      planId: b20EntryPlanId,
      profileIdentity: b20ProfileIdentityV1(),
      attemptRequestId: `attempt:${b20EntryPlanId}`,
    });
    if (begun.outcome !== "ready") {
      setB20WalletError(begun.detail);
      return;
    }
    try {
      const result = await b20SendCalls.mutateAsync({
        calls: begun.payload.calls as never,
        chainId: 8453,
        forceAtomic: begun.payload.atomicRequired,
        capabilities: BUILDER_SUFFIX
          ? { dataSuffix: { value: BUILDER_SUFFIX, optional: true } }
          : undefined,
      });
      const batchId = typeof result === "string" ? result : (result as { id?: string })?.id ?? null;
      if (!batchId) {
        await b20RecordSubmission.mutateAsync({
          planId: b20EntryPlanId,
          attemptId: begun.attemptId,
          result: "wallet_failed",
          batchId: null,
        });
        return;
      }
      await b20RecordSubmission.mutateAsync({
        planId: b20EntryPlanId,
        attemptId: begun.attemptId,
        result: "submitted",
        batchId,
      });
    } catch (error) {
      await b20RecordSubmission.mutateAsync({
        planId: b20EntryPlanId,
        attemptId: begun.attemptId,
        result: isWalletRejectionError(error) ? "user_rejected" : "wallet_failed",
        batchId: null,
      });
    }
  }, [b20BeginSubmission, b20EntryPlanId, b20ProfileIdentityV1, b20RecordSubmission, b20SendCalls]);

  const refreshB20EntryProof = useCallback(() => {
    const walletStatus = b20WalletBatchStatus.data as {
      receipts?: Array<{ transactionHash?: string }>;
    } | undefined;
    const transactionHashes = transactionHashesFromReceipts(walletStatus?.receipts);
    if (b20EntryPlanId && b20EntryState?.attemptId && b20EntryState.batchId) {
      b20ReconcileSubmission.mutate({
        planId: b20EntryPlanId,
        attemptId: b20EntryState.attemptId,
        transactionHashes,
      });
      return;
    }
    void b20EntryStatus.refetch();
  }, [b20EntryPlanId, b20EntryState, b20EntryStatus, b20ReconcileSubmission, b20WalletBatchStatus.data]);
  const addWatch = useAddB20Watch();
  const sweep = useB20Watch();
  const [tokenInput, setTokenInput] = useState("");
  const heldTokens = useMemo(
    () =>
      (portfolio.data?.tokens ?? []).filter(
        (token) => /^0x[0-9a-fA-F]{40}$/.test(token.address) && token.possibleSpam !== true,
      ),
    [portfolio.data],
  );
  const sweepTokens = useMemo(() => {
    const tracked = (watchlist.data?.tokens ?? []).map((entry) => entry.tokenAddress);
    return [...new Set([...tracked, ...heldTokens.map((token) => token.address.toLowerCase())])].slice(0, 25);
  }, [watchlist.data, heldTokens]);
  const holdings = useMemo(() => {
    const balances = new Map(heldTokens.map((token) => [token.address.toLowerCase(), token]));
    return (sweep.data?.tokens ?? [])
      .filter((token) => {
        if (token.outcome !== "watched" || token.balanceAtomic == null) return false;
        try {
          return BigInt(token.balanceAtomic) > BigInt(0);
        } catch {
          return false;
        }
      })
      .map((token) => {
        const balance = balances.get(token.tokenAddress.toLowerCase());
        const changes = token.watch?.status === "compared" ? token.watch.changes : [];
        return {
          tokenAddress: token.tokenAddress,
          name: token.displayName,
          symbol: token.displaySymbol ?? balance?.symbol ?? null,
          balanceLabel: token.balanceAtomic ?? "not read",
          // The miniapp shows the ATOMIC balance and has no swap handoff, so
          // there is no decimal figure to hand a goal. Null keeps the amount
          // out of a sentence rather than putting base units into one.
          balanceDecimal: null,
          decimals: token.decimals ?? null,
          // A missing price stays null all the way to the card. A 0 here would
          // reach a user as "worthless".
          usdLabel: balance?.usdValue ? `$${balance.usdValue}` : null,
          controls: token.controls ?? null,
          changeCount: changes.length,
          hasAcuteChange: changes.some((change) => change.severity === "acute"),
          lastReadBlock: token.controls?.blockNumber ?? token.watch?.toBlock ?? null,
        };
      });
  }, [sweep.data, heldTokens]);
  const b20HoldingAddresses = useMemo(
    () => new Set(holdings.map((holding) => holding.tokenAddress.toLowerCase())),
    [holdings],
  );
  const otherTokenCount = heldTokens.filter(
    (token) => !b20HoldingAddresses.has(token.address.toLowerCase()),
  ).length;

  let content: ReactNode;

  if (screen === "plan") {
    content = (
      <PlanScreen
        goal={goal}
        onGoalChange={setGoal}
        onCompare={compare}
        comparePending={comparePending}
        compareDisabledReason={
          !connected ? CONSOLE_COPY_V1.walletDisconnected : (statusGate ?? dispatch.blockedReason)
        }
        starters={[
          { id: "swap", title: "Swap 100 USDC → ETH", meta: "best net result" },
          { id: "earn", title: "Earn yield on 500 USDC", meta: flags?.earnRouteV1 ? "Moonwell, Morpho, and YO" : "earn gate is off on this server" },
          // A goal known to reach the NFT engine, so the family is reachable
          // without guessing a phrasing the classifier accepts.
          {
            id: "nft",
            title: "Buy NFT BasePaint #16668",
            meta: flags?.nftRouteV1 ? "OpenSea listing on Base" : "NFT gate is off on this server",
          },
        ]}
        onStarter={(id) =>
          setGoal(
            id === "swap"
              ? "Swap 100 USDC to ETH with the best net result"
              : id === "nft"
                ? "Buy NFT BasePaint #16668 under 0.02 ETH on Base"
                : "Earn yield on 500 USDC with low risk",
          )
        }
        walletLabel={address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null}
        balances={
          portfolio.data?.tokens?.map((token: { symbol: string; balanceFormatted?: string; balanceUsd?: string }) => ({
            asset: token.symbol,
            amount: token.balanceFormatted ?? "—",
            usd: token.balanceUsd ? `$${token.balanceUsd}` : "—",
          })) ?? []
        }
        balancesUnavailableReason={connected ? CONSOLE_COPY_V1.portfolioUnavailable : CONSOLE_COPY_V1.walletDisconnected}
        coverage={coverageFromStatusV1(status.data ?? null)}
        chainKpis={[
          { k: "Network", v: chainLabelV1(status.data?.chainId).split(" · ")[0], d: `chain ${status.data?.chainId ?? "—"}` },
          { k: "Adapters", v: adapterRows.summary, d: "from server flags" },
        ]}
        gasPoints={chainGasPointsV1(status.data ?? null)}
        chainNote={CONSOLE_COPY_V1.planHint}
      />
    );
  } else if (screen === "comparing") {
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <div className="panel">
          <div className="ph">
            <h3>{goalLabel}</h3>
            <span className="sub">{comparePending ? "running" : "done"}</span>
          </div>
          <div className="pb tight">
            <CandidateCards rows={projection ? candidateRowsFromProjectionV1(projection, REGISTERED_SWAP_PROVIDERS_V1) : []} />
            {projection && shortfallNoticeFromProjectionV1(projection) && (
              <p className="lnote" style={{ marginTop: 10 }}>{shortfallNoticeFromProjectionV1(projection)}</p>
            )}
            {/* T67E §3 — the same typed diagnostics as the web console, from
                the same helper, so the two cannot disagree about a run. */}
            <ProviderDiagnosticsPanel
              rows={diagnosticRows}
              claimHeadline={comparisonClaim?.headline ?? null}
              onCompareAgain={() => compare({ fresh: true })}
              comparePending={comparePending}
            />
            {comparingFailure && (
              <div className="note warn" role="alert">
                <b>{comparingFailure.title}</b>
                <p style={{ margin: "6px 0 10px" }}>{comparingFailure.detail}</p>
                {/* A question gets a field to answer it in. Retyping a sentence
                    on a phone to add one word is the whole cost this removes. */}
                {comparingFailure.answerable && dispatch.engine === "swap" && (
                  <div className="ctarow" style={{ marginBottom: 10 }}>
                    <label
                      htmlFor="mio-clarification-answer"
                      style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}
                    >
                      {comparingFailure.detail}
                    </label>
                    <input
                      id="mio-clarification-answer"
                      className="goalinput"
                      style={{ flex: 1, minWidth: 120 }}
                      placeholder="USDC"
                      value={answerDraft}
                      disabled={comparePending}
                      onChange={(event) => setAnswerDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          answerClarification(answerDraft);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={!answerDraft.trim() || comparePending}
                      onClick={() => answerClarification(answerDraft)}
                    >
                      {comparePending ? "Answering…" : "Answer"}
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className={comparingFailure.answerable && dispatch.engine === "swap" ? "btn sec" : "btn"}
                  onClick={() => setScreen("plan")}
                >
                  Edit goal
                </button>
              </div>
            )}
          </div>
        </div>
      </>
    );
  } else if (screen === "route" && aiCard) {
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <AiRouteCardPanel
          card={aiCard}
          onReview={address && aiCard.selected ? () => setScreen("review") : undefined}
          reviewDisabledReason={
            flags?.privateAiExecutionV1 === true
              ? null
              : "Running a model is off on this server. This comparison is read-only until it is enabled."
          }
        />
      </>
    );
  } else if (screen === "review" && aiCard) {
    const aiRunnable =
      flags?.privateAiExecutionV1 === true &&
      aiCard.status !== "failed" &&
      aiCard.status !== "constrained" &&
      aiCard.selected !== null &&
      aiNonce !== null;
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <AiReviewPanel
          card={aiCard}
          promptCommitment={aiCommitment ?? ""}
          runnable={aiRunnable}
          blockedReason={
            flags?.privateAiExecutionV1 !== true
              ? "Private AI execution is off on this server."
              : aiNonce === null
                ? "This request can no longer be proved to be the one you reviewed. Compare it again."
                : "This request cannot be run yet."
          }
          runSlot={
            <button type="button" className="btn" onClick={runAi} disabled={aiExecute.isPending}>
              {aiExecute.isPending ? "Running on Venice…" : "Run on Venice"}
            </button>
          }
        />
        {aiExecute.data?.outcome === "blocked" && <p className="lnote">{aiExecute.data.detail}</p>}
      </>
    );
  } else if (screen === "proof" && aiExecuted) {
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <AiResultPanel
          text={aiExecuted.outcome === "completed" ? aiExecuted.text : ""}
          finalStatus={aiExecuted.proof.finalStatus}
        />
        <AiProofPanel proof={aiExecuted.proof} />
      </>
    );
  } else if (screen === "route" && nftCard) {
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <NftRouteCardPanel
          card={nftCard}
          onReview={address && flags?.nftExecutionV1 === true ? () => reviewNft() : undefined}
          reviewDisabledReason={
            flags?.nftExecutionV1 === true
              ? null
              : "Buying is off on this server. This listing is read-only until it is enabled."
          }
        />
      </>
    );
  } else if (screen === "review" && nftPrepared) {
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <NftReviewPanel
          card={nftPrepared.card}
          blueprintHash={nftPrepared.response.blueprint.blueprintHash}
          callsHash={nftPrepared.response.blueprint.callsHash}
          valueWei={nftPrepared.response.blueprint.calls[0]?.valueWei ?? "0"}
          simulation={nftPrepared.response.simulation}
          safety={nftPrepared.response.safety}
          signable={nftPrepared.response.signable}
          blockedReason={nftPrepared.response.blockedReason}
          submitSlot={
            nftRunId ? (
              <BlueprintSubmitButton
                goal="nft"
                routeRunId={nftRunId}
                blueprintId={nftPrepared.response.blueprintId}
                blueprintHash={nftPrepared.response.blueprint.blueprintHash}
                quoteExpiry={nftPrepared.response.blueprint.expiresAt}
                builderCode={BUILDER_CODE}
                onStateChange={onNftSubmission}
              />
            ) : null
          }
        />
      </>
    );
  } else if (screen === "proof" && (nftProof || nftSubmission)) {
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        {nftProof ? (
          <NftProofPanel proof={nftProof.proof} asset={nftCard?.asset} />
        ) : (
          <section className="nft-proof" aria-label="NFT ownership proof">
            <h3>Submitted — waiting for the transaction</h3>
            <p className="lnote">
              {nftSubmission?.batchId
                ? `Batch ${nftSubmission.batchId}. Nothing is confirmed until the receipt, the Transfer and the ownership read all agree.`
                : "Nothing has reached the chain yet."}
            </p>
            {nftSubmission?.error && <p className="empty">{nftSubmission.error}</p>}
          </section>
        )}
      </>
    );
  } else if (screen === "route" && commerceCard) {
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <CommerceRouteCardPanel
          card={commerceCard.routeCard}
          countryInferred={commerceCard.countryInferred}
          excluded={commerceCard.excluded}
          checkout={commerceCheckout}
          ordering={commerceOrder.isPending}
          onOrder={(candidateHash) => {
            if (!address) return;
            commerceOrder.mutate({
              routeRunId: commerceCard.routeRunId,
              walletAddress: address.toLowerCase() as `0x${string}`,
              routeCardHash: commerceCard.routeCard.routeCardHash,
              selectedCandidateHash: candidateHash,
            });
          }}
        />
        {commerceOrderResult && (
          <CommerceInvoiceReviewPanel
            product={{
              name: commerceOrderResult.order.items[0]?.productId ?? "product",
              packageValue: commerceOrderResult.order.items[0]?.packageValue ?? "",
              currency: "USD",
            }}
            order={commerceOrderResult.order}
            invoice={commerceOrderResult.invoice}
            amounts={commerceOrderResult.amounts}
          />
        )}
        {commerceOrder.data?.outcome === "invoice_creation_unknown" && (
          <p className="note warn">{commerceOrder.data.reason}</p>
        )}
        {commerceOrder.data?.outcome === "refresh_required" && <p className="lnote">{commerceOrder.data.reason}</p>}
        {commerceOrder.data?.outcome === "blocked" && <p className="lnote">{commerceOrder.data.reason}</p>}
      </>
    );
  } else if (screen === "route" && earnCard) {
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <div className="panel">
          <div className="pb">
            <EarnDepositFlow routeRunId={earnCard.routeRunId ?? ""} routeCard={earnCard.routeCard} builderCode={BUILDER_CODE} onRefresh={() => compare({ fresh: true })} />
          </div>
        </div>
      </>
    );
  } else if (screen === "route" && projection) {
    const graph = routeGraphFromRouteV1(primaryRoute, { amountLabel: goalLabel, walletLabel: "your wallet" });
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <div className="herostrip">
          <div className="heroL">
            <p className="eyebrow">{recommended ? "Recommended route" : "Available route"}</p>
            <div className="amtrow">
              <span className="amount mono">{primaryRoute?.expectedOutput.amountDecimal ?? "—"}</span>
              <span className="unit">{primaryRoute?.expectedOutput.asset.symbol ?? ""}</span>
              <span style={{ paddingBottom: 6, display: "flex", gap: 7 }}>
                <span className="pill br">{primaryRoute?.provider.displayName ?? "no provider"}</span>
                <span className={`pill ${quoteFreshness.tone}`}>{quoteFreshness.label}</span>
              </span>
            </div>
            <p className="why">{comparisonClaim?.headline ?? "No comparative recommendation was made."}</p>
          </div>
        </div>
        {primaryRoute && (
          <div className="panel">
            <div className="ph">
              <h3>Quoted terms</h3>
              <span className="sub">provider facts</span>
            </div>
            <div className="pb tight">
              <div className="kv"><span>Minimum output</span><span className="mono">{primaryRoute.minimumOutput.amountDecimal} {primaryRoute.expectedOutput.asset.symbol}</span></div>
              <div className="kv"><span>Slippage</span><span className="mono">{primaryRoute.slippage.percent}%</span></div>
              <div className="kv"><span>Approvals</span><span className="mono">{primaryRoute.approvalCount}</span></div>
              <div className="kv"><span>Calls</span><span className="mono">{primaryRoute.callCount}</span></div>
            </div>
          </div>
        )}
        <div className="panel">
          <div className="ph">
            <h3>Route path</h3>
            <span className="sub">{graph ? `${graph.pools.length} pools` : "path not available"}</span>
          </div>
          {/* The graph is the product's core idea — it survives at 390px,
              turned vertical: input top, pools middle, output bottom. */}
          {graph ? (
            <RouteGraph model={graph} orientation="vertical" />
          ) : (
            <div className="pb">
              <p className="empty">The provider did not return a pool breakdown for this route.</p>
            </div>
          )}
        </div>
        {/* No radar at this width — the five bars carry the same information. */}
        {/* Both facts, same as the web console's header: which policy scored
            this, and how many dimensions it could actually score. */}
        <MiniScorePanel
          rows={scoreRowsFromProjectionV1(projection, primaryRoute?.pathScore ?? null)}
          note={`${scoringVersionLabelV1(primaryRoute?.pathScore ?? null)} · ${scoredCountLabelV1(scoreRowsFromProjectionV1(projection, primaryRoute?.pathScore ?? null))}`}
        />
        {/* T67C.1 Part 2: the SAME projection helper the web console uses, so
            the two surfaces cannot report different numbers for one run. */}
        {providerHistoryViewsV1(projection).length > 0 && (
          <div className="panel">
            <div className="ph">
              <h3>Provider history</h3>
              <span className="sub">verified routes only</span>
            </div>
            <div className="pb tight">
              {providerHistoryViewsV1(projection).map((entry) => (
                <div key={entry.providerName} className="note" style={{ marginBottom: 10 }}>
                  <b>{entry.providerName}</b>
                  <p className="lnote" style={{ margin: "4px 0 8px" }}>{entry.headline}</p>
                  <div className="kv">
                    {entry.rows.map((row) => (
                      <div key={row.label}>
                        <span>{row.label}</span>
                        <span className="mono">{row.value}</span>
                      </div>
                    ))}
                    <div>
                      <span>Provider quote</span>
                      <span className="mono">{entry.quotedResult ?? "Not available"}</span>
                    </div>
                    <div>
                      <span>History-adjusted estimate</span>
                      <span className="mono">{entry.historyAdjustedResult ?? "Not available"}</span>
                    </div>
                  </div>
                  {entry.uncalibratedNote && (
                    <p className="lnote" style={{ marginTop: 8 }}>{entry.uncalibratedNote}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {b20Panels(false)}
        <div className="panel">
          <div className="ph">
            <h3>All candidates</h3>
          </div>
          <div className="pb tight">
            <CandidateCards
              rows={candidateRows}
              onSelect={
                providerConstraintResolution.blockedReason
                  ? undefined
                  : selectCandidateForReview
              }
              actionLabel={needsProviderConstraint ? "Use only" : "Use this"}
            />
          </div>
        </div>
        <div className="ctarow">
          <button
            type="button"
            className="btn lg"
            disabled={
              !connected ||
              !reviewTarget ||
              Boolean(providerConstraintResolution.blockedReason)
            }
            onClick={() => reviewTarget && selectCandidateForReview(reviewTarget)}
          >
            {needsProviderConstraint && primaryRoute
              ? `Use ${primaryRoute.provider.displayName} only`
              : "Review transaction"}
          </button>
          <span className="nt">
            {!connected
              ? CONSOLE_COPY_V1.walletDisconnected
              : providerConstraintResolution.blockedReason
                ? providerConstraintResolution.blockedReason
              : !reviewTarget && selectableCandidates.length > 1
                ? "Choose one provider above. Miorail will not pick from an unranked comparison."
                : needsProviderConstraint
                  ? "This fixes your provider choice first; Review opens after the constrained Route Card is built."
                  : CONSOLE_COPY_V1.nothingSigned}
          </span>
        </div>
      </>
    );
  } else if (screen === "review") {
    const priceLabel = prepared?.simulationPriceUsdc ? `${prepared.simulationPriceUsdc} USDC` : null;
    const budgetHasHeadroom = Boolean(budgetRecord && Number(budgetRecord.remainingUsdc) > 0);
    const simulationEvidence =
      simulateResponse?.outcome === "simulated" || simulateResponse?.outcome === "cached" ? simulateResponse.evidence : null;
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <ReviewScreen
          steps={steps}
          // Same defect as the web console: three of prepare's four outcomes
          // carry no blueprint, and reading only the fourth left this screen
          // blaming simulation for a refusal it never made.
          // `isError` first: a 500 leaves no body to map, so reading only the
          // body left this screen empty with no reason on it.
          notice={prepare.isError ? swapPrepareRequestFailedNoticeV1() : swapPrepareNoticeV1(prepare.data as never)}
          // And the same dead end: the card expires with its shortest quote,
          // so "back" returned to a card that refused again.
          onCompareAgain={() => compare({ fresh: true })}
          comparePending={comparePending}
          calls={
            prepared?.blueprint.calls.map((call, index) => ({
              index: index + 1,
              title: call.callType === "approval" ? "Allow the router to spend exactly this amount" : "Swap through the selected route",
              detail: call.callType === "approval" ? `${call.to} · exact amount` : "Recipient is your own wallet",
              mono: true,
            })) ?? []
          }
          simulation={simulation}
          balanceChanges={(simulationEvidence?.stateChanges ?? []).map((change: { address: string; summary: string }) => ({
            asset: change.address,
            before: "—",
            after: "—",
            change: change.summary,
            tone: "none" as const,
          }))}
          balanceUnavailableReason={
            simulation.available
              ? "The simulation reported no decodable asset movement for this wallet."
              : "Simulated balance changes appear once the Alchemy simulation runs."
          }
          checks={[
            { label: "Chain is Base mainnet", passed: Boolean(prepared) },
            { label: "Recipient is your wallet", passed: Boolean(prepared) },
            { label: "Approval exact, not unlimited", passed: Boolean(prepared) },
            { label: "Simulation passed", passed: simulation.passed },
          ]}
          limits={[
            {
              id: "monthly",
              label: "Monthly",
              value: budgetRecord?.monthlyLimitUsdc ? `$${budgetRecord.monthlyLimitUsdc}` : "",
              percent: budgetRecord ? usagePercentV1(Number(budgetRecord.spentUsdc), Number(budgetRecord.monthlyLimitUsdc)) : 0,
              note: budgetRecord ? `$${budgetRecord.spentUsdc} used` : CONSOLE_COPY_V1.limitsMissing,
            },
          ]}
          onLimitChange={() => undefined}
          // Same as the web console: the real control belongs in the CTA row,
          // not in a panel below the fold with a dead button above it.
          signSlot={
            prepared && simulation.canSign ? (
              <BlueprintSubmitButton
                routeRunId={prepared.routeRunId}
                blueprintId={prepared.blueprint.id}
                blueprintHash={prepared.blueprint.blueprintHash}
                quoteExpiry={prepared.blueprint.quoteExpiry}
                builderCode={BUILDER_CODE}
                onStateChange={(next) => {
                  setSubmission(next);
                  if (next.status !== "idle") mark("signed", "start");
                }}
              />
            ) : undefined
          }
          onApprove={() => undefined}
          tokenPanels={b20Panels(true)}
          onBack={() => setScreen("route")}
          approvePending={prepare.isPending}
        />
        {prepared && (
          <div className="panel">
            <div className="ph">
              <h3>Simulate before signing</h3>
              <span className="sub">Alchemy eth_simulateV1</span>
            </div>
            <div className="pb">
              <div className="ctarow">
                {priceLabel ? (
                  <SimulateButton
                    priceLabel={priceLabel}
                    routeRunId={prepared.routeRunId}
                    blueprintId={prepared.blueprint.id}
                    blueprintHash={prepared.blueprint.blueprintHash}
                    onSuccess={(response) => setSimulateResponse(response)}
                    className="btn"
                  />
                ) : (
                  // Withdrawn, not broken. See the web console's copy: implying
                  // a misconfiguration sends someone looking for a fix that
                  // does not exist.
                  <span className="nt">
                    Miorail no longer charges for swap simulation. The safety checks still run,
                    without a fork simulation.
                  </span>
                )}
                {budgetHasHeadroom && address && (
                  <button
                    type="button"
                    className="btn sec"
                    disabled={budgetSimulate.isPending}
                    onClick={() => {
                      mark("simulation", "start");
                      budgetSimulate.mutate({
                        walletAddress: address.toLowerCase() as `0x${string}`,
                        routeRunId: prepared.routeRunId,
                        blueprintId: prepared.blueprint.id,
                        blueprintHash: prepared.blueprint.blueprintHash,
                      });
                    }}
                  >
                    {budgetSimulate.isPending ? "Charging…" : "Use Intelligence Budget"}
                  </button>
                )}
              </div>
              {simulationEvidence && (
                <p className="lnote" style={{ marginTop: 10 }}>
                  Block {simulationEvidence.blockNumber ?? "—"} · gas {simulationEvidence.gasUsed ?? "—"}. The simulation covers
                  these calls only.
                </p>
              )}
            </div>
          </div>
        )}
        {/* The signing control now lives in the Review CTA row above
            (`signSlot`), so there is exactly one and it is the real one. */}
      </>
    );
  } else if (screen === "proof") {
    const proof = reconciliation.proof as
      | { proofHash?: string; status?: string; actualOutput?: { amountDecimal?: string; asset?: { symbol?: string } }; actualGasUsed?: string; blockNumber?: string }
      | null;
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <div className="herostrip">
          <div className="heroL">
            <p className="eyebrow">{proof?.proofHash ? `Route proof · ${proof.proofHash.slice(0, 12)}…` : "Route proof · reconciling"}</p>
            <div className="amtrow">
              <span className="amount mono">{proof?.actualOutput?.amountDecimal ?? "—"}</span>
              <span className="unit">{proof?.actualOutput?.asset?.symbol ?? ""}</span>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="ph">
            <h3>Plan vs actual</h3>
          </div>
          <div className="pb tight">
            <PlanVsActualCards
              rows={
                proof && recommended
                  ? [
                      {
                        label: "Output",
                        expected: `${recommended.expectedOutput.amountDecimal} ${recommended.expectedOutput.asset.symbol}`,
                        actual: `${proof.actualOutput?.amountDecimal ?? "—"} ${proof.actualOutput?.asset?.symbol ?? ""}`,
                        difference: "—",
                        tone: "none" as const,
                      },
                      { label: "Gas", expected: recommended.estimatedGas.gasUnits === "0" ? "Not provided" : recommended.estimatedGas.gasUnits, actual: proof.actualGasUsed ?? "—", difference: "—", tone: "none" as const },
                    ]
                  : []
              }
            />
            {!proof && (
              <p className="empty">Reconciliation has not returned a proof yet. Nothing is claimed until it does.</p>
            )}
          </div>
        </div>
        <div className="ctarow">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setScreen("plan");
              setGoal("");
              setClock(emptyStageClockV1());
              settled.current = false;
            }}
          >
            New goal
          </button>
        </div>
      </>
    );
  } else {
    content = (
      <div className="panel">
        <div className="pb">
          <p className="empty">Start a goal to compare routes.</p>
        </div>
      </div>
    );
  }

  // T70 §4 — Opportunities, B20, Routes, Proofs. Built from the shared table,
  // so the bar cannot drift from the web header's words or order. Opportunities
  // is marked unavailable rather than hidden when the server flag is off: the
  // section exists, the data does not, and the user is told which.
  const nav = consoleNavModelV1({
    mounted: MINIAPP_SECTIONS_V1,
    active: section,
    unavailable: b20GateOn
      ? undefined
      : {
          opportunities:
            "B20 Discover is off on this server, so there is no launch feed. This is not a statement about what is launching.",
          portfolio: "B20 inspection is off on this server, so your tokens were not read.",
        },
  });

  let sectionContent: ReactNode = content;
  if (section === "opportunities") {
    sectionContent = (
      <OpportunitiesScreen
        pipelineNotice={
          b20GateOn
            ? opportunities.isPending
              ? null
              : feedHome.notice
            : "B20 Discover is off on this server, so no launches are being read."
        }
        pipelineState={(feedPipeline?.state as ConsolePipelineStateV1 | undefined) ?? null}
        feedRenderable={b20GateOn && (opportunities.isPending || feedHome.feedRenderable)}
        cards={(opportunities.data?.cards ?? []).map((card) => opportunityCardViewV1(card))}
        filter={feedFilter}
        standingFilter={feedStanding}
        freshOnly={feedFresh}
        loading={opportunities.isPending && b20GateOn}
        onFilterChange={setFeedFilter}
        onStandingFilterChange={setFeedStanding}
        onFreshOnlyChange={setFeedFresh}
        // Hands the token to the B20 tab, which owns the wallet-bound checks.
        // Discover creates no clearance here either.
        onOpenToken={(token) => {
          setTokenInput(token);
          setSection("portfolio");
        }}
        onRefresh={() => void opportunities.refetch()}
        // The same card as the web console, from the same shared screen —
        // Base App gets the layer by construction rather than by a second
        // implementation that could disagree about what "unverified" means.
        publicContext={{
          tokenAddress: publicContextToken,
          loading: publicContext.isPending,
          context: (publicContext.data as never) ?? null,
          error: publicContext.error
            ? 'Miorail could not complete a public search for this token. That is about the search, not about the token.'
            : null,
          onLook: (token: string, domain?: string) => {
            setPublicContextToken(token);
            publicContext.mutate({ tokenAddress: token, ...(domain ? { domain } : {}) });
          },
        }}
        launchContext={{
          tokenAddress: contextToken,
          loading: launchContext.isPending && contextToken !== null,
          context: launchContext.data ?? null,
          error: launchContext.error?.message ?? null,
          onOpen: setContextToken,
        }}
        console={{
          scope: consoleScope,
          tokenAddresses: consoleTokens,
          loading: b20Console.isPending,
          answer: b20Console.data ?? null,
          error: b20Console.error?.message ?? null,
          onScopeChange: setConsoleScope,
          onTokensChange: setConsoleTokens,
          onAsk: (input) => {
            b20Console.mutate({
              schemaVersion: "b20-console-ask/v1",
              scope: input.scope,
              question: input.question,
              ...(input.tokenAddresses.length > 0 ? { tokenAddresses: [...input.tokenAddresses] } : {}),
            });
          },
        }}
        copilot={{
          tokenAddress: copilotToken,
          loading: copilot.isPending,
          answer: copilot.data?.subject.tokenAddress === copilotToken ? copilot.data : null,
          error: copilot.error?.message ?? null,
          onAsk: (input) => {
            setCopilotToken(input.tokenAddress);
            copilot.mutate({ schemaVersion: "b20-copilot-ask/v1", ...input });
          },
          onOpenRoutes: (nextGoal) => {
            // Base App uses one page rather than URL routes. The handoff only
            // fills the goal; comparison remains an explicit tap in Routes.
            setGoal(nextGoal);
            setScreen("plan");
            setSection("routes");
          },
        }}
      />
    );
  } else if (section === "portfolio") {
    sectionContent = (
      <>
        {/* First, because the first question on this surface is "what do I
            hold". Base App reaches the same endpoint as the web console, so
            the two cannot drift apart. */}
        <WalletBalancesCard
          loading={portfolio.isPending && Boolean(address)}
          unavailableReason={
            !address
              ? "Connect your wallet to see your balances."
              : portfolio.error
                // Never the provider's message: it can carry an endpoint, and
                // an endpoint can carry a key.
                ? "Your balances could not be read. This is not a statement about what you hold."
                : null
          }
          rows={portfolio.data?.tokens ?? []}
        />
        <div className="panel">
          <div className="ph">
            <h3>Watch a token</h3>
          </div>
          <div className="pb">
            <input
              className="goalinput"
              value={tokenInput}
              placeholder="0x…"
              aria-label="Token address"
              onChange={(event) => setTokenInput(event.target.value)}
            />
            <button
              type="button"
              className="btn sec"
              disabled={!/^0x[0-9a-fA-F]{40}$/.test(tokenInput.trim()) || addWatch.isPending}
              onClick={() => {
                addWatch.mutate({ tokenAddress: tokenInput.trim().toLowerCase() });
                setTokenInput("");
              }}
            >
              Add to watchlist
            </button>
            {addWatch.error && (
              // Never the raw message: a server error can carry an endpoint.
              <p className="note warn">That token could not be added to your watchlist.</p>
            )}
            <button
              type="button"
              className="btn sec"
              disabled={sweepTokens.length === 0 || sweep.isPending}
              onClick={() => sweep.mutate({ tokens: sweepTokens })}
            >
              {sweep.isPending ? "Reading B20 controls…" : "Read B20 controls"}
            </button>
            {/* The sweep is explicit here for the same reason as on the web:
                each run is up to 25 metered onchain reads. */}
            <p className="lnote">Each check reads the controls of up to 25 tokens on Base.</p>
          </div>
        </div>
        <B20PortfolioPanel
          holdings={holdings}
          otherTokenCount={otherTokenCount}
          emptyReason={
            !address
              ? "Connect your wallet to see what the tokens you hold have done."
              : !b20GateOn
                ? "B20 control inspection is off on this server, so nothing was read."
                : sweep.data
                  ? null
                  : "Read B20 controls to see what your tokens permit right now."
          }
          checked={Boolean(sweep.data)}
          loading={sweep.isPending}
          onCheckWallet={() => {
            if (sweepTokens.length > 0) sweep.mutate({ tokens: sweepTokens });
          }}
          onCheckExit={(token) => runExitCheck(token)}
          exitCheckedToken={exitToken}
        />
        {/* Stage 08 — the same console, with the Portfolio scope, directly
            under the holdings it ranks. The scope appears only because this
            surface has read the wallet. */}
        <B20ConsolePanel
          scope={portfolioScope}
          tokenAddresses={[]}
          heldTokenAddresses={holdings.map((holding) => holding.tokenAddress)}
          loading={b20Console.isPending}
          answer={b20Console.data ?? null}
          error={b20Console.error?.message ?? null}
          onScopeChange={setPortfolioScope}
          onTokensChange={() => {}}
          onAsk={(input) => {
            b20Console.mutate({
              schemaVersion: "b20-console-ask/v1",
              scope: input.scope,
              question: input.question,
              ...(input.tokenAddresses.length > 0 ? { tokenAddresses: [...input.tokenAddresses] } : {}),
            });
          }}
        />
        {b20EntryReview && b20EntryState && (
          <B20EntryReviewCard
            review={b20EntryReview}
            status={b20EntryState}
            routeProof={
              b20EntryStatus.data?.routeProof ??
              (b20BeginSubmission.data?.outcome === "ready" ? b20BeginSubmission.data.routeProof : null)
            }
            now={new Date()}
            busy={
              b20BeginSubmission.isPending ||
              b20SendCalls.isPending ||
              b20RecordSubmission.isPending ||
              b20ReconcileSubmission.isPending
            }
            onConfirm={b20EntryReview.executionAvailable ? confirmB20EntryInWallet : undefined}
            onRefresh={refreshB20EntryProof}
            onBack={() => setB20EntryPlanId(null)}
          />
        )}
        {b20WalletError && <p className="note warn">{b20WalletError}</p>}
        {/* Only a live qualified clearance gets the entry-plan handler. */}
        <B20ExitCard
          check={exitResult as never}
          tokenLabel={
            exitToken === null
              ? null
              : (holdings.find((holding) => holding.tokenAddress === exitToken)?.symbol
                ?? `${exitToken.slice(0, 8)}…${exitToken.slice(-4)}`)
          }
          tokenDecimals={
            exitToken === null
              ? null
              : (holdings.find((holding) => holding.tokenAddress === exitToken)?.decimals ?? null)
          }
          profile={exitProfile}
          onProfileChange={setExitProfile}
          positionLabel={`${exitProfile.position} USDC`}
          slippagePercentLabel={`${exitProfile.maxSlippage}%`}
          // Atomic units of the TOKEN being sold, so the decimals are the
          // token's. Unknown decimals render the raw amount rather than a
          // number scaled by a guess.
          formatTokenAmount={(atomic) => {
            // From the portfolio provider, which is where decimals are known.
            // The miniapp's holdings projection carries a formatted label, not
            // the raw scale.
            const decimals =
              heldTokens.find((token) => token.address.toLowerCase() === exitToken?.toLowerCase())
                ?.decimals ?? null;
            // Unknown decimals render the raw amount rather than a number
            // scaled by a guess — a balance off by a factor of 10^18 is worse
            // than an unformatted one.
            return decimals === null ? atomic : formatAtomicAmount(atomic, decimals);
          }}
          loading={exitCheck.isPending}
          simulating={exitSimulate.isPending || exitProofPayment.isBusy}
          simulationPriceUsdc={exitProofPriceUsdc}
          unavailableReason={
            !address
              ? "Connect your wallet to check an exit."
              : !b20GateOn
                ? "B20 inspection is off on this server, so nothing was read."
                : exitProofPayment.error
                  ? exitProofPayment.error
                  : exitCheck.error
                    // Never the raw message: a server error can carry an endpoint.
                    ? "That exit could not be checked. Nothing here is a statement about the token."
                    : null
          }
          onCheck={() => {
            if (exitToken) runExitCheck(exitToken);
          }}
          onSimulate={() => {
            if (exitToken) runExitSimulation(exitToken);
          }}
          onBuildEntryPlan={buildB20EntryPlan}
          now={new Date()}
        />
        {/* The way into Extensions in Base App. NOT a fifth tab: four tabs get
            about 90px each at 390px, and a fifth ellipsises every label to
            reach an informational catalogue. A one-line entry costs no tab
            width and keeps the B20 content unmuddled. */}
        <div className="ctarow">
          <button type="button" className="btn sec" onClick={() => setSection("extensions")}>
            Base MCP Extensions →
          </button>
        </div>
      </>
    );
  } else if (section === "extensions") {
    sectionContent = (
      <>
        {status.data?.baseMcp?.enabled === true && (
          <div id="base-mcp-console">
            <BaseMcpConsoleCard
              question={baseMcpQuestion}
              onQuestionChange={setBaseMcpQuestion}
              onAsk={() => {
                const message = baseMcpQuestion.trim();
                if (message) {
                  reconcileBaseMcpAction.reset();
                  baseMcpAsk.mutate(message);
                }
              }}
              pending={baseMcpAsk.isPending}
              answer={
                reconcileBaseMcpAction.data && baseMcpAsk.data?.action
                  ? { ...baseMcpAsk.data, action: reconcileBaseMcpAction.data }
                  : baseMcpAsk.data ?? null
              }
              readTools={baseMcpProbe.data?.routing.read}
              actionTools={baseMcpProbe.data?.routing.action}
              releasedActionTools={baseMcpProbe.data?.tools.filter(
                (tool) => tool.surface === "action" && tool.surfaceEnabled,
              ).length}
              routableTools={baseMcpProbe.data?.routing.routable}
              reconcilingAction={reconcileBaseMcpAction.isPending}
              onOpenRoutes={(message) => {
                setGoal(message);
                setSection("routes");
              }}
              onReconcileAction={(receiptId) => reconcileBaseMcpAction.mutate(receiptId)}
              unavailableReason={
                baseMcpAsk.error
                  ? "The console could not reach the server. Nothing here is a statement about Base MCP."
                  : null
              }
            />
          </div>
        )}
        <BaseMcpPluginsCard
          loading={baseMcpPlugins.isPending}
          plugins={baseMcpPlugins.data?.plugins ?? []}
          drift={baseMcpPlugins.data?.drift ?? null}
          generatedAt={baseMcpPlugins.data?.generatedAt ?? null}
          unavailableReason={
            baseMcpPlugins.error ? "The plugin catalogue could not be read from this server." : null
          }
          onSelectPrompt={(prompt) => {
            setBaseMcpQuestion(prompt);
            globalThis.requestAnimationFrame?.(() => {
              globalThis.document?.getElementById("base-mcp-console")?.scrollIntoView({ behavior: "smooth", block: "start" });
              const input = globalThis.document?.getElementById(BASE_MCP_CONSOLE_INPUT_ID_V1) as HTMLTextAreaElement | null;
              input?.focus({ preventScroll: true });
            });
          }}
        />
        <BaseMcpExtensionsCard
          enabled={status.data?.baseMcp?.enabled === true}
          loading={baseMcpProbe.isPending}
          status={baseMcpProbe.data?.status ?? null}
          endpointHost={baseMcpProbe.data?.endpointHost ?? null}
          tools={baseMcpProbe.data?.tools ?? []}
          unavailableReason={
            baseMcpProbe.error
              // Never the error's own message: a transport failure can carry
              // the endpoint, and the endpoint can carry a token.
              ? "The tool catalogue could not be read. Nothing here is a statement about which tools exist."
              : null
          }
          onRefresh={() => baseMcpProbe.mutate()}
        />
        <div className="ctarow">
          <button type="button" className="btn sec" onClick={() => setSection("portfolio")}>
            ← Back to B20
          </button>
        </div>
      </>
    );
  } else if (section === "activity") {
    sectionContent = (
      <>
        <ActivitySpendCard
          loading={ledger.isPending}
          entries={ledger.data?.entries ?? []}
          summary={ledger.data?.summary ?? null}
          unavailableReason={
            ledger.error
              ? "The payment ledger could not be read. This says nothing about what was paid."
              : null
          }
        />
        <BaseMcpActionReceiptsCard
          loading={baseMcpActionReceipts.isPending}
          receipts={baseMcpActionReceipts.data?.receipts ?? []}
          unavailableReason={
            baseMcpActionReceipts.error
              ? "Base MCP action receipts could not be read. This says nothing about whether an action completed."
              : null
          }
        />
        <ActivityRunsCard
          loading={history.isPending}
          runs={historyItems}
          selectedRunId={null}
          onSelect={() => undefined}
          hasMore={false}
          unavailableReason={
            history.isError
              ? "Route history could not be read on this server. This says nothing about what you have run."
              : null
          }
        />
      </>
    );
  }

  return (
    <ConsoleMiniShell
      goalLine={goalLabel}
      stepLine={`${stepLabel} · ${spendLabel.split(" · ")[0]}`}
      networkLabel={chainLabelV1(status.data?.chainId)}
      connected={connected && status.data?.rpc?.status === "connected"}
      blockNumber={chainBlockNumberV1(status.data ?? null)}
      theme={theme}
      onThemeChange={setTheme}
      drawer={drawer}
      panels={section === "routes" ? panels : null}
      nav={nav}
      onNavigate={setSection}
    >
      {/* T67C.2: the SAME rail the web console mounts. Recovery orchestration
          is written once — two copies would mean two answers to "did we
          already send this?", and that question must have one.

          Not scoped to a section: an unfinished submission has to be visible
          wherever the user happens to be. */}
      <SubmissionRecoveryRail
        walletAddress={address ?? null}
        chainId={chainId ?? null}
        enabled={Boolean(flags?.submissionRecoveryV1)}
      />
      {budgetOpen && budgetPanel}
      {sectionContent}
    </ConsoleMiniShell>
  );
}

export default MiniConsole;
