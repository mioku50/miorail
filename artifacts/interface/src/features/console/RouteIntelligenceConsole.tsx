import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import {
  CONSOLE_BREADCRUMB_V1,
  CommerceInvoiceReviewPanel,
  CommerceRouteCardPanel,
  NftProofPanel,
  NftReviewPanel,
  NftRouteCardPanel,
  CONSOLE_COPY_V1,
  commerceCheckoutAvailableV1,
  ComparingScreen,
  ConsoleRightRail,
  ConsoleShell,
  ConsoleStepper,
  PlanScreen,
  ProofScreen,
  ReviewScreen,
  RouteScreen,
  adaptersFromStatusV1,
  ageLabelV1,
  chainLabelV1,
  comparingProgressV1,
  completeStageV1,
  consoleFailureCopyV1,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainGasPointsV1,
  coverageFromStatusV1,
  deriveAdapterRowsV1,
  deriveSimulationViewV1,
  verificationHonestyViewV1,
  routeProofViewV1,
  dispatchRouteFamilyV1,
  emptyStageClockV1,
  haltStageRailV1,
  intelligenceSpendLabelV1,
  marketRailFromSnapshotV1,
  providerUnavailableCopyV1,
  startStageV1,
  stepperFromClockV1,
  useConsoleTheme,
  usagePercentV1,
  type ConsoleScreenV1,
  type ConsoleSessionItemV1,
  type ConsoleStageClockV1,
  type ConsoleStageV1,
  B20ControlSection,
  paidEvidenceStripV1,
  paidIntelligenceStateV1,
  paidIntelligenceViewV1,
  b20ErrorCodeV1,
  b20TargetForRouteV1,
  b20UnavailableCopyV1,
  swapPrepareNoticeV1,
  swapPrepareRequestFailedNoticeV1,
  swapTerminalFailureV1,
  candidateRowsFromProjectionV1,
  comparisonClaimFromProjectionV1,
  providerDiagnosticRowsV1,
  providerFailuresFromProjectionV1,
  REGISTERED_SWAP_PROVIDERS_V1,
  evidenceRowsFromProjectionV1,
  evidenceSourcesFromProjectionV1,
  quoteFreshnessFromRouteV1,
  routeGraphFromRouteV1,
  scoreRowsFromProjectionV1,
  providerHistoryViewsV1,
  perActionAffordabilityV1,
  scoringVersionLabelV1,
  shortfallNoticeFromProjectionV1,
  simulationSourceFromResponseV1,
  type RoutePlanProjectionV1,
  AiRouteCardPanel,
  AiReviewPanel,
  AiResultPanel,
  AiProofPanel,
} from '@mioagent/ui';
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
  useB20Inspect,
  useIntelligenceCharges,
  useIntelligenceBudget,
  useMarketSnapshot,
  usePortfolio,
  usePrepareSwapBlueprint,
  useRouteHistory,
  useSimulateWithBudget,
  useStatus,
  type NftProofResponseV1,
  type SimulateWithBudgetResponseV1,
} from '@mioagent/api-client-react';
import { BlueprintSubmitButton, EarnDepositFlow, SubmissionRecoveryRail, builderCodeForSurfaceV1, type BlueprintSubmitStatus } from '@mioagent/wallet-actions';
import { useConsoleNav } from './useConsoleNav';
import { SimulateButton, type SimulateBlueprintResponseV1 } from '@mioagent/x402-actions';

// ---------------------------------------------------------------------------
// T63D — the console's complete production flow:
//   Plan → Comparing → Route → Review → Base Account submission → Proof.
//
// Every stage boundary is MEASURED through the stage clock, so the rail shows
// real intervals rather than state words. The goal is dispatched to its own
// engine (an Earn goal never reaches the swap engine), coverage and adapter
// states come from the server's flags rather than front-end constants, and
// simulation / signing / proof reuse the existing T59 / T57 / T58 machinery
// instead of being re-implemented or mocked.
// ---------------------------------------------------------------------------

// T67X-B1: BASE_BUILDER_CODE is canonical, VITE_BUILDER_CODE a deprecated
// alias, and two different values resolve to no attribution at all. Both keys
// are read as literals because that is the only form Vite inlines.
const BUILDER_CODE = builderCodeForSurfaceV1({
  VITE_BASE_BUILDER_CODE: import.meta.env?.VITE_BASE_BUILDER_CODE as string | undefined,
  VITE_BUILDER_CODE: import.meta.env?.VITE_BUILDER_CODE as string | undefined,
});

interface BlueprintSubmissionState {
  status: BlueprintSubmitStatus;
  batchId: string | null;
  txHashes: string[];
  error: string | null;
  proofId: string | null;
  recordedFinalStatus: string | null;
}

const RECONCILABLE_SUBMISSION_STATUSES: BlueprintSubmitStatus[] = ['confirmed', 'failed', 'submitted_unknown'];

function shortAddress(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

export function RouteIntelligenceConsole() {
  const { address, chainId } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  // T70 §8 — the shared section table, not a tab array typed out here.
  const consoleNav = useConsoleNav('routes');

  const [screen, setScreen] = useState<ConsoleScreenV1>('plan');
  const [goal, setGoal] = useState('');
  /** The one-word reply to a clarification. Held here rather than inside
   * ComparingScreen, which is a pure function of its model like every other
   * screen in that file. */
  const [answerDraft, setAnswerDraft] = useState('');
  const [clock, setClock] = useState<ConsoleStageClockV1>(emptyStageClockV1);
  const [submission, setSubmission] = useState<BlueprintSubmissionState | null>(null);
  const [nftSubmission, setNftSubmission] = useState<BlueprintSubmissionState | null>(null);
  const [nftProof, setNftProof] = useState<NftProofResponseV1 | null>(null);
  // T66C — the nonce lives HERE and nowhere else. The server returned it once
  // and kept no copy; losing it makes the reviewed request unrunnable, which
  // is the property that keeps a stored commitment unopenable.
  const [aiNonce, setAiNonce] = useState<string | null>(null);
  const [simulateResponse, setSimulateResponse] = useState<SimulateBlueprintResponseV1 | null>(null);
  const [budgetResponse, setBudgetResponse] = useState<SimulateWithBudgetResponseV1 | null>(null);

  const mark = useCallback((stage: ConsoleStageV1, phase: 'start' | 'complete') => {
    const at = Date.now();
    setClock((current) => (phase === 'start' ? startStageV1(current, stage, at) : completeStageV1(current, stage, at)));
  }, []);

  const status = useStatus();
  const portfolio = usePortfolio(address);
  const evaluation = useEvaluateSwapRoute();
  const earnCompare = useEarnCompare();
  const commerceCompare = useCommerceCompare();
  const nftCompare = useNftCompare();
  const nftPrepare = useNftPrepare();
  const aiCompare = useAiCompare();
  const aiExecute = useAiExecute();
  // A comparison that selected nothing still returns a card naming every model
  // it refused, so both outcomes render rather than leaving an empty screen.
  const aiCard =
    aiCompare.data?.outcome === 'compared'
      ? aiCompare.data.routeCard
      : aiCompare.data?.outcome === 'unavailable'
        ? aiCompare.data.routeCard
        : null;
  const aiRunId =
    aiCompare.data?.outcome === 'compared' || aiCompare.data?.outcome === 'unavailable'
      ? aiCompare.data.routeRunId
      : null;
  const aiExecuted =
    aiExecute.data?.outcome === 'completed' || aiExecute.data?.outcome === 'refused' ? aiExecute.data : null;
  const aiCommitment = aiCompare.data?.outcome === 'compared' ? aiCompare.data.promptCommitment : null;

  const runAi = () => {
    // Every precondition is re-checked here rather than trusted from the
    // button being enabled: the nonce in particular, because without it the
    // request cannot be proved to be the reviewed one and the server will
    // refuse it anyway.
    if (!address || !aiCard || !aiRunId || !aiNonce || !goal.trim()) return;
    mark('signed', 'start');
    aiExecute.mutate(
      {
        routeRunId: aiRunId,
        routeCardHash: aiCard.routeCardHash,
        walletAddress: address.toLowerCase() as `0x${string}`,
        messages: [{ role: 'user', text: goal }],
        promptNonce: aiNonce,
      },
      {
        onSettled: () => mark('signed', 'complete'),
        onSuccess: (response) => {
          if (response.outcome !== 'blocked') setScreen('proof');
        },
      },
    );
  };
  // A comparison that found nothing still returns a card, so both outcomes
  // render the token rather than an empty screen.
  const nftCard =
    nftCompare.data?.outcome === 'compared' || nftCompare.data?.outcome === 'unavailable'
      ? nftCompare.data.routeCard
      : null;
  const nftRunId =
    nftCompare.data?.outcome === 'compared' || nftCompare.data?.outcome === 'unavailable'
      ? nftCompare.data.routeRunId
      : null;
  const nftPrepared =
    nftPrepare.data?.outcome === 'prepared' && nftCard ? { response: nftPrepare.data, card: nftCard } : null;

  const reviewNft = () => {
    if (!address || !nftCard || !nftRunId) return;
    nftPrepare.mutate({
      routeRunId: nftRunId,
      routeCardHash: nftCard.routeCardHash,
      walletAddress: address.toLowerCase() as `0x${string}`,
    });
    setScreen('review');
  };

  // T65.1 Final §4 — reconciliation runs AFTER the shared submission records a
  // proof id, and only then. It is bounded: one attempt per terminal wallet
  // result. The proof it returns is the only thing allowed to say "you own it".
  const nftReconcile = useNftReconcile({ onSuccess: (response) => setNftProof(response) });
  const nftReconciled = useRef<string | null>(null);
  const onNftSubmission = useCallback(
    (next: BlueprintSubmissionState) => {
      setNftSubmission(next);
      if (next.status !== 'idle') mark('signed', 'start');
      const terminal = next.status === 'confirmed' || next.status === 'failed' || next.status === 'submitted_unknown';
      if (next.proofId) setScreen('proof');
      if (!next.proofId || !terminal || nftReconciled.current === next.proofId) return;
      nftReconciled.current = next.proofId;
      mark('signed', 'complete');
      nftReconcile.mutate({ proofId: next.proofId });
    },
    [mark, nftReconcile],
  );
  const commerceOrder = useCreateCommerceOrder();
  const prepare = usePrepareSwapBlueprint();
  const flags = status.data?.productMigration;
  const paidIntelligenceOn = flags?.paidIntelligence === true;
  const budget = useIntelligenceBudget({ enabled: paidIntelligenceOn });
  const budgetSimulate = useSimulateWithBudget({
    onSuccess: (response) => {
      setBudgetResponse(response);
      mark('simulation', 'complete');
    },
  });
  const history = useRouteHistory({ limit: 5 });
  // T65.2A — a REAL price, not a status flag. The rail used to pass null and
  // explain that the panel did not exist; now it shows what the server read,
  // with its age and its provider.
  const market = useMarketSnapshot();

  const walletLabel = shortAddress(address);
  const connected = Boolean(address);
  // The server's flags are what every gate on this screen reads. Not having
  // them yet is a different state from having them and finding a family off.
  const statusGate = status.data
    ? null
    : status.error
      ? `Server capabilities could not be read: ${(status.error as Error).message}`
      : 'Reading this server’s capabilities…';
  const result = evaluation.data;
  const projection = result?.outcome === 'evaluated' ? (result.projection as unknown as RoutePlanProjectionV1) : null;
  const recommended = projection?.recommendedRoute ?? null;
  const goalLabel = projection?.goalSummary ?? (goal.trim() || 'New goal');
  const prepared = prepare.data?.outcome === 'prepared' ? prepare.data : null;

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

  // --- measured stage boundaries ---------------------------------------------

  // AUDIT FIX: the earn result must be READ, not just requested. Without this
  // an Earn goal dispatched to the Earn engine and then stranded the user on
  // Comparing forever, because the Route screen only knew about swap.
  const earnCard = earnCompare.data?.outcome === 'compared' ? earnCompare.data : null;

  // The commerce result is READ, not just requested — the same dead end the
  // T63D audit found on the earn path.
  const commerceCard = commerceCompare.data?.outcome === 'compared' ? commerceCompare.data : null;
  const commerceCheckout = useMemo(
    () =>
      commerceCheckoutAvailableV1({
        routeIntelligenceV1: flags?.routeIntelligenceV1 === true,
        earnRouteV1: flags?.earnRouteV1 === true,
        commerceRouteV1: flags?.commerceRouteV1 === true,
        commerceExecutionV1: flags?.commerceExecutionV1 === true,
        nftRouteV1: flags?.nftRouteV1 === true,
        nftExecutionV1: flags?.nftExecutionV1 === true,
      }),
    [flags],
  );
  const commerceOrderResult = commerceOrder.data?.outcome === 'created' ? commerceOrder.data : null;

  const earnSettled = useRef(false);
  useEffect(() => {
    if (!earnCard || earnSettled.current) return;
    earnSettled.current = true;
    mark('evidence', 'start');
    mark('evidence', 'complete');
    mark('score', 'start');
    mark('score', 'complete');
    setScreen('route');
  }, [earnCard, mark]);

  const commerceSettled = useRef(false);
  useEffect(() => {
    if (!commerceCard || commerceSettled.current) return;
    commerceSettled.current = true;
    mark('evidence', 'start');
    mark('evidence', 'complete');
    mark('score', 'start');
    mark('score', 'complete');
    setScreen('route');
  }, [commerceCard, mark]);

  // T65.2A — the NFT family had no settled effect, so a comparison that
  // returned a card left the user on Comparing forever. The same dead end the
  // T63D and T64.3.1 audits found on the earn and commerce paths.
  const nftSettled = useRef(false);
  useEffect(() => {
    if (!nftCard || nftSettled.current) return;
    nftSettled.current = true;
    mark('evidence', 'start');
    mark('evidence', 'complete');
    mark('score', 'start');
    mark('score', 'complete');
    setScreen('route');
  }, [nftCard, mark]);

  // T66C — the same settled effect every other family needed. Without it a
  // comparison that returned a card leaves the user on Comparing forever.
  const aiSettled = useRef(false);
  useEffect(() => {
    if (!aiCard || aiSettled.current) return;
    aiSettled.current = true;
    mark('evidence', 'start');
    mark('evidence', 'complete');
    mark('score', 'start');
    mark('score', 'complete');
    setScreen('route');
  }, [aiCard, mark]);

  const evaluationSettled = useRef(false);
  useEffect(() => {
    if (!projection || evaluationSettled.current) return;
    evaluationSettled.current = true;
    mark('candidates', 'complete');
    mark('evidence', 'start');
    mark('evidence', 'complete');
    if (projection.pathScore) {
      mark('score', 'start');
      mark('score', 'complete');
    }
    setScreen('route');
  }, [projection, mark]);

  useEffect(() => {
    if (prepared) mark('review', 'complete');
  }, [prepared, mark]);

  useEffect(() => {
    if (simulateResponse) mark('simulation', 'complete');
  }, [simulateResponse, mark]);

  const submissionStatus = submission?.status;
  useEffect(() => {
    if (submissionStatus === 'confirmed' || submissionStatus === 'submitted_unknown') {
      mark('signed', 'complete');
      mark('proof', 'start');
      setScreen('proof');
    }
  }, [submissionStatus, mark]);

  // T58: bounded reconciliation — one reconcile POST plus a bounded poll, only
  // once the wallet flow is terminal AND a Route Proof id was recorded.
  const reconciliation = useBoundedProofReconciliation({
    proofId: submission?.proofId ?? null,
    routeRunId: prepared?.routeRunId ?? null,
    walletAddress: address ? (address.toLowerCase() as `0x${string}`) : null,
    enabled: Boolean(submission && submission.proofId && RECONCILABLE_SUBMISSION_STATUSES.includes(submission.status)),
  });

  useEffect(() => {
    if (reconciliation.proof) mark('proof', 'complete');
  }, [reconciliation.proof, mark]);

  // --- actions ---------------------------------------------------------------

  /**
   * `fresh` forces a NEW route run.
   *
   * T67E §3.5. `RoutePlanRequestIdentity` derives the request id from
   * (wallet, message) and reuses it, so a second `compare()` for the same goal
   * replays the idempotent request and the server returns the run it already
   * has — the same quotes, at the same age. That is exactly right for an
   * accidental double submit and exactly wrong for "Compare again" and for the
   * stale-quote "Refresh", both of which exist to obtain fresh terms. Those two
   * pass a fresh id; every other caller keeps the idempotent behaviour.
   */
  const compare = (options?: { fresh?: boolean; event?: FormEvent }) => {
    options?.event?.preventDefault();
    if (!address || !goal.trim() || dispatch.engine === null) return;
    prepare.reset();
    setSubmission(null);
    setSimulateResponse(null);
    setBudgetResponse(null);
    // A new goal clears the NFT flow too. Without this, a finished NFT purchase
    // would keep claiming the Proof screen from whatever family comes next, and
    // a stale card would keep the run from ever leaving Comparing.
    nftCompare.reset();
    nftPrepare.reset();
    setNftSubmission(null);
    setNftProof(null);
    nftReconciled.current = null;
    nftSettled.current = false;
    // A new goal clears the AI flow too, INCLUDING the nonce. A stale nonce
    // belongs to a request that is no longer on screen.
    aiCompare.reset();
    aiExecute.reset();
    setAiNonce(null);
    aiSettled.current = false;
    evaluationSettled.current = false;
    earnSettled.current = false;
    commerceSettled.current = false;
    commerceOrder.reset();

    const at = Date.now();
    let next = emptyStageClockV1();
    next = startStageV1(next, 'intent', at);
    next = completeStageV1(next, 'intent', at);
    next = startStageV1(next, 'candidates', at);
    setClock(next);
    setScreen('comparing');

    const wallet = address.toLowerCase() as `0x${string}`;
    // Route-family dispatch: an Earn goal goes to the Earn engine, never to
    // useEvaluateSwapRoute.
    if (dispatch.engine === 'private_ai') {
      // The goal text IS the prompt. It is sent, and the nonce that comes back
      // is the only thing that can later prove this exact request ran.
      aiCompare.mutate(
        {
          messages: [{ role: 'user', text: goal }],
          walletAddress: wallet,
          maxSpendUsd: '0.05',
          maxCompletionTokens: 1_024,
          privacyRequirement: 'private_only',
        },
        {
          onSettled: () => mark('candidates', 'complete'),
          onSuccess: (response) => {
            if (response.outcome === 'compared') setAiNonce(response.promptNonce);
          },
        },
      );
      return;
    }
    if (dispatch.engine === 'nft') {
      // An NFT goal never reaches the gift-card engine: the two share the verb
      // "buy" and nothing else.
      nftCompare.mutate({ message: goal, walletAddress: wallet }, { onSettled: () => mark('candidates', 'complete') });
      return;
    }
    if (dispatch.engine === 'commerce') {
      commerceCompare.mutate(
        { message: goal, walletAddress: wallet },
        { onSettled: () => mark('candidates', 'complete') },
      );
      return;
    }
    if (dispatch.engine === 'earn') {
      earnCompare.mutate({ message: goal, walletAddress: wallet }, { onSettled: () => mark('candidates', 'complete') });
      return;
    }
    // No onError here, deliberately. Sending the user back to Plan discarded the
    // reason and left them on the home screen with no explanation — a failed
    // swap comparison was indistinguishable from a button that did nothing.
    // Swap now ends where Earn, NFT, Commerce and AI already end: on Comparing,
    // with the server's own message rendered as a terminal failure.
    evaluation.mutate(
      {
        message: goal,
        walletAddress: wallet,
        // A new id ⟹ a new route run, new quotes and a new evidence set. The
        // previous Route Card is untouched in storage; it is simply no longer
        // the one on screen.
        ...(options?.fresh ? { requestId: `retry-${globalThis.crypto.randomUUID()}` } : {}),
      },
      { onSettled: () => mark('candidates', 'complete') },
    );
  };

  /**
   * Answers the server's clarification without retyping the goal.
   *
   * The amount, the pair and every constraint already stated are held SERVER
   * SIDE against this wallet, so the answer is sent as its own short message
   * and the engine completes the goal from what it already grounded. It never
   * travels back through the client, which is what stops a caller from
   * inventing an amount or a token that appeared in no message.
   *
   * Swap only: it is the family whose engine keeps a pending intent. The other
   * families still end at Edit goal, which is where they were.
   */
  const answerClarification = (answer: string) => {
    if (!address || !answer.trim() || dispatch.engine !== 'swap') return;
    setAnswerDraft('');
    evaluationSettled.current = false;
    const at = Date.now();
    let next = emptyStageClockV1();
    next = startStageV1(next, 'intent', at);
    next = completeStageV1(next, 'intent', at);
    next = startStageV1(next, 'candidates', at);
    setClock(next);
    // The goal box is left exactly as the user typed it. Appending the answer
    // would build a sentence nobody wrote — "Swap 0.1 to Eth USDC" reads as
    // ETH→USDC on the next comparison, the reverse of what was just agreed.
    evaluation.mutate(
      { message: answer.trim(), walletAddress: address.toLowerCase() as `0x${string}` },
      { onSettled: () => mark('candidates', 'complete') },
    );
  };

  /**
   * Why review cannot start, or null when it can.
   *
   * This used to be a bare `return` inside `reviewCandidate`, and the result
   * was a button that did nothing and said nothing: a degraded run left
   * `routeCardHash` empty, both "Use this" and "Review Transaction" clicked
   * into the void, and the stepper stayed on `Review —` with no way to tell
   * whether the click had registered.
   *
   * Stated as a value rather than checked at the click, so the screen can say
   * it BEFORE the click and disable the control that cannot work.
   */
  const reviewBlockedReason = !connected
    ? CONSOLE_COPY_V1.walletDisconnected
    : result?.outcome !== 'evaluated' || !projection
      ? 'This goal has not produced a route card yet.'
      : !projection.routeCardHash
        ? 'This comparison finished without a signable Route Card, so there is nothing to review. Comparing again may fix it if a provider was briefly unavailable.'
        : null;

  const reviewCandidate = (candidateHash: string) => {
    // Read out before the guard so the null check narrows the type as well as
    // the behaviour. `routeCardHash` is `string | null` — a degraded run really
    // does produce a projection with no Route Card, which is the exact state
    // that made both buttons dead, and `prepare` cannot be called without one.
    const routeCardHash = projection?.routeCardHash;
    // Belt and braces: the controls are disabled when this is set, so reaching
    // here means a caller this component does not own. Still never silent.
    if (reviewBlockedReason || !address || !routeCardHash || result?.outcome !== 'evaluated') {
      console.warn('Route review refused', { reason: reviewBlockedReason ?? 'missing route card' });
      return;
    }
    setSubmission(null);
    setSimulateResponse(null);
    setBudgetResponse(null);
    mark('review', 'start');
    setScreen('review');
    prepare.mutate({
      walletAddress: address.toLowerCase() as `0x${string}`,
      routeRunId: result.routeRunId,
      routeCardHash,
      selectedCandidateHash: candidateHash,
    });
  };

  // --- derived models --------------------------------------------------------

  const steps = useMemo(() => stepperFromClockV1(clock), [clock]);
  const evidenceRows = projection ? evidenceRowsFromProjectionV1(projection) : [];
  const evidenceSources = projection ? evidenceSourcesFromProjectionV1(projection) : [];
  const spendLabel = intelligenceSpendLabelV1(evidenceSources);

  // T67E §3 — typed provider diagnostics. Derived once: the adapter rail, the
  // candidate table and the Comparing screen must not disagree about which
  // provider failed or why.
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

  /**
   * The candidate the big Review button acts on.
   *
   * Normally the recommendation. But a run where only one provider answered
   * produces no recommendation at all — Miorail will not call a sample of one
   * "best" — and that left the button wired to `recommended && …`, which is a
   * silent no-op. The route was right there in the table with its own working
   * "Use this"; only the headline button was dead.
   *
   * So when there is no comparison to recommend from, the sole quotable
   * candidate IS the route under review. More than one and the button stays
   * off: picking for the user is exactly what the missing recommendation
   * declined to do.
   */
  const selectableCandidates = candidateRows.filter((row) => row.selectable);
  const reviewTarget =
    recommended?.candidateHash ??
    (selectableCandidates.length === 1 ? selectableCandidates[0]!.id : null);
  const reviewDisabledReason =
    reviewBlockedReason ??
    (reviewTarget
      ? null
      : selectableCandidates.length === 0
        ? 'No provider returned a quotable route for this goal, so there is nothing to review.'
        : 'No route is recommended. Choose one from the candidates below with “Use this”.');

  // --- T67E §1: the contextual B20 Control Card ------------------------------
  //
  // The card is about the token the route ACQUIRES. Selling a token whose
  // transfers are paused reverts immediately and costs only gas; acquiring one
  // succeeds, and the constraint is discovered later by the holder.
  const b20GateOn = flags?.b20ControlV1 === true;
  const b20Target = b20TargetForRouteV1(recommended?.expectedOutput.asset ?? null);
  const b20 = useB20Inspect(b20Target.address, { enabled: b20GateOn });
  const b20Card = b20.data?.card ?? null;
  const b20Unavailable = b20UnavailableCopyV1({
    gateEnabled: b20GateOn,
    skipReason: b20Target.skipReason,
    errorCode: b20ErrorCodeV1(b20.error),
  });
  // `detailed` is false on Route and true on Review: Review is the last
  // screen before a signature, so the fields and evidence hashes belong there.
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
          // T67E §3: the wire field is `provider`, an adapter id. `adapterId`
          // never existed on it, so every failed adapter rendered as
          // `undefined` here.
          providerFailures.map((failure) => ({
            name: failure.providerName,
            reason: failure.reasonLabel,
          })),
        ),
      ),
    [status.data, projection, providerFailures],
  );

  // T64.3.1 — a Commerce comparison is a comparison. Leaving it out of these
  // two made the button clickable again mid-run and the elapsed pill read
  // "done" while Bitrefill was still being read. T65.2A: the NFT comparison
  // was missing for exactly the same reason, with exactly the same effect.
  const comparePending =
    evaluation.isPending ||
    earnCompare.isPending ||
    commerceCompare.isPending ||
    nftCompare.isPending ||
    aiCompare.isPending;

  // The run is over and produced no route card. Every one of these leaves the
  // user on Comparing, so every one of them has to be terminal.
  //
  // Swap was missing from this list entirely — the one family that is always
  // on. See `swapTerminalFailureV1` for what that cost.
  const swapFailure = swapTerminalFailureV1(evaluation.data as never);
  const commerceFailure =
    commerceCompare.data?.outcome === 'needs_clarification'
      ? {
          title: 'This goal needs one more detail',
          detail: commerceCompare.data.issues.map((issue) => consoleFailureCopyV1(issue)).join(' '),
        }
      : commerceCompare.data?.outcome === 'unsupported'
        ? { title: 'Miorail cannot route this purchase', detail: consoleFailureCopyV1(commerceCompare.data.reason) }
        : null;
  const earnFailure =
    earnCompare.data?.outcome === 'needs_clarification'
      ? { title: 'This goal needs one more detail', detail: earnCompare.data.issues.map((issue) => consoleFailureCopyV1(issue)).join(' ') }
      : earnCompare.data?.outcome === 'unsupported'
        ? { title: 'Miorail cannot route this goal', detail: consoleFailureCopyV1(earnCompare.data.reason) }
        : null;
  const nftFailure =
    nftCompare.data?.outcome === 'needs_clarification'
      ? { title: 'This goal needs one more detail', detail: nftCompare.data.issues.map((issue) => consoleFailureCopyV1(issue)).join(' ') }
      : nftCompare.data?.outcome === 'unsupported'
        ? { title: 'Miorail cannot route this NFT purchase', detail: consoleFailureCopyV1(nftCompare.data.reason) }
        : null;
  const aiFailure =
    aiCompare.data?.outcome === 'needs_clarification'
      ? { title: 'This goal needs one more detail', detail: aiCompare.data.issues.map((issue) => consoleFailureCopyV1(issue)).join(' ') }
      : aiCompare.data?.outcome === 'unsupported'
        ? { title: 'Miorail cannot route this AI request', detail: consoleFailureCopyV1(aiCompare.data.reason) }
        : null;
  // The server's own message (status line or `error` code) is carried through.
  // "The server did not answer" told the operator nothing they could act on;
  // "API error: 500 commerce_compare_failed" points straight at the log.
  const transportError = (evaluation.error ??
      earnCompare.error ??
      commerceCompare.error ??
      nftCompare.error ??
      aiCompare.error) as Error | null;
  const transportFailure = transportError
    ? {
        title: 'The comparison could not be completed',
        detail: `${transportError.message} Nothing was signed or spent.`,
      }
    : null;
  // A run that produced a route card is not a failure, whatever the current
  // goal text now dispatches to. An NFT card counts: `unavailable` still names
  // the token and says why there is nothing to buy.
  const comparingFailure =
    comparePending || projection || earnCard || commerceCard || nftCard || aiCard
      ? null
      : (swapFailure ??
        commerceFailure ??
        earnFailure ??
        nftFailure ??
        aiFailure ??
        transportFailure ??
        (dispatch.blockedReason ? { title: 'This route family is off on this server', detail: dispatch.blockedReason } : null));

  const budgetRecord = budget.data?.budget ?? null;
  // Whether a swap review can be charged at all on this server. The paid
  // surface moved to the B20 exit proof — swap comparison and its safety
  // checks are free — so the server stops advertising a swap price, and the
  // budget controls have to disappear with it. Leaving them printed the B20
  // price ($0.0002) as a per-action ceiling on a swap that will never bill.
  const swapSurfacePricedV1 = Boolean(status.data?.paidIntelligence?.pricedSurfaces?.swapSimulation);
  // --- T70 §2: Budget & payments moved to Settings ---------------------------
  //
  // The full panel, the two usage bars and the adapter list are on the Settings
  // page now. What stays on the flow is one line: whether paid evidence is on,
  // that free comparison works regardless, and a way through. Nothing about the
  // spending contract changed — this surface still cannot create, raise or
  // revoke a permission.
  const charges = useIntelligenceCharges({ enabled: paidIntelligenceOn });
  const paidState = paidIntelligenceStateV1({
    featureEnabled: paidIntelligenceOn,
    settleReady: status.data?.paidIntelligence?.settleReady === true,
    budget: budgetRecord,
    charges: charges.data?.charges ?? [],
  });
  const paidStateView = paidIntelligenceViewV1(paidState);
  const paidEvidenceStrip = paidEvidenceStripV1({
    label: paidStateView.label,
    moneyAtRisk: paidStateView.moneyAtRisk,
    needsPermission: paidStateView.action === 'create_permission',
    // No wallet flow for granting a Base Account spend permission exists yet,
    // so the strip says so rather than offering a button that cannot grant one.
    permissionFlowAvailable: false,
    settingsAvailable: true,
  });

  // Still computed: the REVIEW screen shows "within your limits" and the
  // monthly bar, and T70 does not touch the Review flow. What moved to Settings
  // is the left rail's copy of it, not this.
  const limits = budgetRecord
    ? {
        dailyLabel: `$${budgetRecord.spentUsdc} / $${budgetRecord.monthlyLimitUsdc}`,
        dailyPercent: usagePercentV1(Number(budgetRecord.spentUsdc), Number(budgetRecord.monthlyLimitUsdc)),
        intelligenceLabel: `$${budgetRecord.spentUsdc} / $${budgetRecord.maxPerRequestUsdc}`,
        intelligencePercent: usagePercentV1(Number(budgetRecord.spentUsdc), Number(budgetRecord.maxPerRequestUsdc)),
      }
    : null;

  // Simulation comes from whichever paid path actually ran — never invented.
  const simulationSource = simulationSourceFromResponseV1(simulateResponse ?? budgetResponse);
  // `prepared` IS the Safety Kernel's verdict: a route it refused comes back
  // `blocked`, never prepared. The screen must not re-run that decision.
  const simulation = deriveSimulationViewV1(simulationSource, Boolean(prepared));
  const quoteFreshness = quoteFreshnessFromRouteV1(recommended);

  const historyItems = history.data?.items ?? [];
  const proofs: ConsoleSessionItemV1[] = historyItems.slice(0, 5).map((run) => ({
    id: run.routeRunId,
    title: run.intentSummary || run.routeRunId,
    tag: {
      label: run.proofFinalStatus ?? run.runStatus,
      tone: run.proofFinalStatus ? ('g' as const) : ('n' as const),
    },
    meta: run.createdAt ? new Date(run.createdAt).toLocaleTimeString() : '',
  }));

  const sessions: ConsoleSessionItemV1[] = projection
    ? [
        {
          id: 'active',
          title: goalLabel,
          tag: { label: projection.outcome, tone: projection.outcome === 'ready' ? 'b' : 'n' },
          meta: `${projection.availableRoutes.length} route${projection.availableRoutes.length === 1 ? '' : 's'}`,
          active: true,
        },
      ]
    : [];

  // Both surfaces derive the panel the same way, from the same pure mapper.
  const marketRail = marketRailFromSnapshotV1(market.data, new Date());

  const rightRail = (
    <ConsoleRightRail
      price={marketRail.price}
      priceUnavailableReason={
        marketRail.unavailableReason ??
        // Only reached before the first snapshot answers; the provider's own
        // status is the most useful thing to say until then.
        providerUnavailableCopyV1(status.data?.prices, 'price')
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
      paidSurfaceActive={swapSurfacePricedV1}
      spend={
        budgetRecord && swapSurfacePricedV1
          ? {
              percent: usagePercentV1(Number(budgetRecord.spentUsdc), Number(budgetRecord.monthlyLimitUsdc)),
              amount: `$${budgetRecord.spentUsdc}`,
              capLabel: `of $${budgetRecord.monthlyLimitUsdc} cap`,
              rows: evidenceRows.map((row) => ({ label: row.name, value: row.costLabel })),
            }
          : null
      }
      freshness={[
        { label: 'Quote age', value: quoteFreshness.label.replace('quote ', ''), tone: quoteFreshness.stale ? 'off' : undefined },
        { label: 'Simulation age', value: ageLabelV1(simulationSource?.ageSeconds ?? null) },
        { label: 'Re-sim before signing', value: simulation.passed ? 'on' : 'not run', tone: simulation.passed ? 'ok' : 'off' },
      ]}
    />
  );

  // --- screens ---------------------------------------------------------------

  let content: ReactNode;

  if (screen === 'plan') {
    content = (
      <PlanScreen
        goal={goal}
        onGoalChange={setGoal}
        onCompare={() => compare()}
        comparePending={comparePending}
        compareDisabledReason={
          !connected
            ? CONSOLE_COPY_V1.walletDisconnected
            : // Until /api/status answers, every flag reads as off — which used
              // to render as "route intelligence is off on this server" and sent
              // operators looking for a flag that was already on. A pending or
              // failed status call now says exactly that instead.
              (statusGate ?? dispatch.blockedReason)
        }
        starters={[
          { id: 'swap', title: 'Swap 100 USDC → ETH', meta: 'best net result · every live adapter' },
          {
            id: 'earn',
            title: 'Earn yield on 500 USDC, low risk',
            meta: flags?.earnRouteV1 ? 'Moonwell and Morpho' : 'earn gate is off on this server',
          },
          // T65.2A — a goal that is KNOWN to dispatch to the NFT engine. The
          // family being on is not much use if reaching it depends on guessing
          // a phrasing the classifier accepts.
          {
            id: 'nft',
            title: 'Buy NFT BasePaint #16668 under 0.02 ETH',
            meta: flags?.nftRouteV1 ? 'OpenSea listing on Base' : 'NFT gate is off on this server',
          },
          // Present ONLY when the gate is on. The other starters stay listed
          // with "gate is off" because those families are coming; Private AI is
          // switched off by choice on this deployment, and a starter is an
          // invitation to click, not a status line. Venice stays visible in the
          // adapter rail as `disabled`, which is a fact rather than an offer.
          ...(flags?.privateAiRouteV1
            ? [
                {
                  id: 'private_ai',
                  title: 'Summarise this privately with an AI model',
                  meta: 'Venice, private inference',
                },
              ]
            : []),
        ]}
        onStarter={(id) =>
          setGoal(
            id === 'swap'
              ? 'Swap 100 USDC to ETH with the best net result'
              : id === 'nft'
                ? 'Buy NFT BasePaint #16668 under 0.02 ETH on Base'
                : id === 'private_ai'
                  ? 'Summarise the following privately with an AI model: '
                  : 'Earn yield on 500 USDC with low risk',
          )
        }
        walletLabel={walletLabel}
        balances={
          portfolio.data?.tokens?.map((token: { symbol: string; balanceFormatted?: string; balanceUsd?: string }) => ({
            asset: token.symbol,
            amount: token.balanceFormatted ?? '—',
            usd: token.balanceUsd ? `$${token.balanceUsd}` : '—',
          })) ?? []
        }
        balancesUnavailableReason={connected ? CONSOLE_COPY_V1.portfolioUnavailable : CONSOLE_COPY_V1.walletDisconnected}
        coverage={coverageFromStatusV1(status.data ?? null)}
        chainKpis={[
          { k: 'Network', v: chainLabelV1(status.data?.chainId).split(' · ')[0], d: `chain ${status.data?.chainId ?? '—'}` },
          // "ready" — the count includes adapters that are configured but have
          // not been asked yet. Only one that answered is called live.
          { k: 'Adapters ready', v: adapterRows.summary, d: 'from server flags' },
          { k: 'Signing', v: 'your wallet', d: 'Miorail never signs' },
        ]}
        gasPoints={chainGasPointsV1(status.data ?? null)}
        chainNote={CONSOLE_COPY_V1.planHint}
      />
    );
  } else if (screen === 'comparing') {
    const answered = (projection?.availableRoutes ?? []).map((route) => route.provider.displayName);
    content = (
      <ComparingScreen
        steps={comparingFailure ? haltStageRailV1(steps) : steps}
        goalLabel={goalLabel}
        optimisingFor={projection ? `optimising for ${projection.optimizationMode}` : `${dispatch.family} route`}
        elapsedLabel={comparePending ? 'running' : 'done'}
        // Only this family's adapters, and only until the run is terminal.
        progress={comparingProgressV1({
          family: dispatch.family,
          adapters: adapterRows.rows,
          answered,
          terminalReason: comparingFailure?.detail ?? null,
          evidenceCount: projection ? evidenceRows.length : null,
          scored: Boolean(projection?.pathScore),
        })}
        candidates={projection ? candidateRowsFromProjectionV1(projection, REGISTERED_SWAP_PROVIDERS_V1) : []}
        sources={evidenceRows}
        failure={comparingFailure}
        diagnostics={diagnosticRows}
        claimHeadline={comparisonClaim?.headline ?? null}
        onCompareAgain={() => compare({ fresh: true })}
        comparePending={comparePending}
        onEditGoal={() => setScreen('plan')}
        // Only the swap family keeps a half-finished goal server-side, so only
        // its questions can be answered in one word.
        onAnswer={dispatch.engine === 'swap' ? answerClarification : undefined}
        answerValue={answerDraft}
        onAnswerChange={setAnswerDraft}
        answerPending={comparePending}
        shortfallNotice={projection ? shortfallNoticeFromProjectionV1(projection) : null}
        onCancel={() => setScreen('plan')}
      />
    );
  } else if (screen === 'route' && aiCard) {
    // The AI card names the model, every alternative it refused and why, what
    // leaves the machine, and seven dimensions with no combined number.
    content = (
      <>
        <ConsoleStepper steps={steps} />
        <AiRouteCardPanel
          card={aiCard}
          onReview={address && aiCard.selected ? () => setScreen('review') : undefined}
          reviewDisabledReason={
            flags?.privateAiExecutionV1 === true
              ? null
              : 'Running a model is off on this server. This comparison is read-only until it is enabled.'
          }
        />
      </>
    );
  } else if (screen === 'review' && aiCard) {
    const runnable =
      flags?.privateAiExecutionV1 === true &&
      aiCard.status !== 'failed' &&
      aiCard.status !== 'constrained' &&
      aiCard.selected !== null &&
      aiNonce !== null;
    content = (
      <>
        <ConsoleStepper steps={steps} />
        <AiReviewPanel
          card={aiCard}
          promptCommitment={aiCommitment ?? ''}
          runnable={runnable}
          blockedReason={
            flags?.privateAiExecutionV1 !== true
              ? 'Private AI execution is off on this server.'
              : aiNonce === null
                ? 'This request can no longer be proved to be the one you reviewed. Compare it again.'
                : 'This request cannot be run yet.'
          }
          runSlot={
            <button type="button" className="btn" onClick={runAi} disabled={aiExecute.isPending}>
              {aiExecute.isPending ? 'Running on Venice…' : 'Run on Venice'}
            </button>
          }
        />
        {aiExecute.data?.outcome === 'blocked' && (
          <p className="lnote">{aiExecute.data.detail}</p>
        )}
      </>
    );
  } else if (screen === 'proof' && aiExecuted) {
    // The answer and the proof are two panels. The answer was returned once
    // and stored nowhere; the proof is stored and contains none of it.
    content = (
      <>
        <ConsoleStepper steps={steps} />
        <AiResultPanel
          text={aiExecuted.outcome === 'completed' ? aiExecuted.text : ''}
          finalStatus={aiExecuted.proof.finalStatus}
        />
        <AiProofPanel proof={aiExecuted.proof} />
      </>
    );
  } else if (screen === 'route' && nftCard) {
    // The NFT card names the token by chain + contract + tokenId, shows the
    // gaps it could not fill, and offers no combined score.
    content = (
      <>
        <ConsoleStepper steps={steps} />
        <NftRouteCardPanel
          card={nftCard}
          onReview={address ? () => reviewNft() : undefined}
          reviewDisabledReason={
            flags?.nftExecutionV1 === true
              ? null
              : 'Buying is off on this server. This listing is read-only until it is enabled.'
          }
        />
      </>
    );
  } else if (screen === 'route' && commerceCard) {
    // Commerce has its own Route Card, its own payment review, and a proof
    // made of three legs. Checkout is a separate server gate from comparison.
    content = (
      <>
        <ConsoleStepper steps={steps} />
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
              name: commerceOrderResult.order.items[0]?.productId ?? 'product',
              packageValue: commerceOrderResult.order.items[0]?.packageValue ?? '',
              currency: 'USD',
            }}
            order={commerceOrderResult.order}
            invoice={commerceOrderResult.invoice}
            amounts={commerceOrderResult.amounts}
          />
        )}
        {commerceOrder.data?.outcome === 'invoice_creation_unknown' && (
          <p className="note warn">{commerceOrder.data.reason}</p>
        )}
        {commerceOrder.data?.outcome === 'refresh_required' && (
          <p className="note warn">{commerceOrder.data.reason}</p>
        )}
        {commerceOrder.data?.outcome === 'blocked' && <p className="note warn">{commerceOrder.data.reason}</p>}
      </>
    );
  } else if (screen === 'route' && earnCard) {
    // Earn has its own Route Card and its own persisted execution path (T62);
    // the console hosts it rather than re-implementing it.
    content = (
      <>
        <ConsoleStepper steps={steps} />
        <div className="panel">
          <div className="pb">
            <EarnDepositFlow
              routeRunId={earnCard.routeRunId ?? ''}
              routeCard={earnCard.routeCard}
              builderCode={BUILDER_CODE}
              onRefresh={() => compare({ fresh: true })}
            />
          </div>
        </div>
      </>
    );
  } else if (screen === 'route' && projection) {
    content = (
      <RouteScreen
        steps={steps}
        eyebrow={`Recommended route · ${goalLabel}`}
        amount={recommended?.expectedOutput.amountDecimal ?? '—'}
        unit={recommended?.expectedOutput.asset.symbol ?? ''}
        usd=""
        providerLabel={recommended?.provider.displayName ?? 'no provider'}
        freshness={quoteFreshness}
        why={
          // T67E §3.4 — the superlative is gated on there having been a
          // comparison. One quotable candidate cannot be the "highest" of
          // anything, and a user reads that phrase as "the alternatives lost".
          comparisonClaim?.claim !== 'comparative'
            ? (comparisonClaim?.headline ?? 'No comparative recommendation was made.')
            : projection.outcome === 'ready'
              ? 'Highest expected output after network and intelligence costs.'
              : 'No comparative recommendation was made — the routes below are shown for comparison only.'
        }
        kpis={[
          { k: 'Minimum output', v: recommended?.minimumOutput.amountDecimal ?? '—', d: `slippage ${recommended?.slippage.percent ?? '—'}%` },
          {
            k: 'Network cost',
            v: recommended?.estimatedGas.estimatedCostUsd ? `$${recommended.estimatedGas.estimatedCostUsd}` : '—',
            d: `est. ${recommended?.estimatedGas.gasUnits ?? '—'} gas`,
          },
          { k: 'Price impact', v: recommended ? `${recommended.priceImpact.percent}%` : '—', d: 'from the quote' },
          { k: 'Approvals', v: String(recommended?.approvalCount ?? '—'), d: 'exact amount' },
          { k: 'Calls', v: String(recommended?.callCount ?? '—'), d: 'one batch' },
          { k: 'Intelligence', v: spendLabel.split(' · ')[0], d: `${evidenceRows.length} sources` },
        ]}
        graph={routeGraphFromRouteV1(recommended, { amountLabel: goalLabel, walletLabel: walletLabel ?? 'your wallet' })}
        graphUnavailableReason="The provider did not return a pool breakdown for this route, so the path is not drawn."
        graphLegend={recommended ? [`executed by ${recommended.provider.displayName}`, 'Output returns to your wallet'] : []}
        simulatedPill={simulation.passed ? { label: 'simulated', tone: 'g' } : { label: 'not simulated yet', tone: 'n' }}
        scoreRows={scoreRowsFromProjectionV1(projection)}
        scoringVersion={scoringVersionLabelV1(projection.pathScore)}
        providerHistory={providerHistoryViewsV1(projection)}
        candidates={candidateRows}
        onReview={() => reviewTarget && reviewCandidate(reviewTarget)}
        tokenPanels={b20Panels(false)}
        diagnostics={diagnosticRows}
        claimHeadline={comparisonClaim?.headline ?? null}
        onCompareAgain={() => compare({ fresh: true })}
        comparePending={comparePending}
        onChangeGoal={() => setScreen('plan')}
        onSelectCandidate={reviewCandidate}
        reviewDisabledReason={reviewDisabledReason}
      />
    );
  } else if (screen === 'review' && nftPrepared) {
    // The NFT review is its own screen: the swap review reads a projection
    // this family does not have, and signing is offered only when every gate
    // passed rather than failing after the click.
    content = (
      <>
        <ConsoleStepper steps={steps} />
        <NftReviewPanel
          card={nftPrepared.card}
          blueprintHash={nftPrepared.response.blueprint.blueprintHash}
          callsHash={nftPrepared.response.blueprint.callsHash}
          valueWei={nftPrepared.response.blueprint.calls[0]?.valueWei ?? '0'}
          simulation={nftPrepared.response.simulation}
          safety={nftPrepared.response.safety}
          signable={nftPrepared.response.signable}
          blockedReason={nftPrepared.response.blockedReason}
          /* The SAME button swap and earn use. `signable` already required the
             execution flag, a passed simulation, a fresh listing and a clean
             Safety Kernel, so this control appears only when all four held. */
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
  } else if (screen === 'review') {
    // Three of prepare's four outcomes carry no blueprint, and reading only the
    // fourth left this screen blaming simulation for a refusal it never made.
    // `isError` first: a 500 leaves no body to map, and reading only the body
    // left this screen empty for a reason it could not name — the same defect
    // as reading only the `prepared` branch, one layer further out.
    const prepareNotice = prepare.isError
      ? swapPrepareRequestFailedNoticeV1()
      : swapPrepareNoticeV1(prepare.data as never);
    const priceLabel = prepared?.simulationPriceUsdc ? `${prepared.simulationPriceUsdc} USDC` : null;
    const budgetHasHeadroom = Boolean(budgetRecord && Number(budgetRecord.remainingUsdc) > 0);
    const simulationEvidence =
      simulateResponse?.outcome === 'simulated' || simulateResponse?.outcome === 'cached' ? simulateResponse.evidence : null;

    content = (
      <>
        <ReviewScreen
          steps={steps}
          // A Route Card expires with the shortest quote it displays, which is
          // ~20s. "Back to routes" led to that same expired card and the same
          // refusal, so the recoverable refusal offers the thing that fixes it.
          onCompareAgain={() => compare({ fresh: true })}
          comparePending={comparePending}
          calls={
            prepared?.blueprint.calls.map((call, index) => ({
              index: index + 1,
              title:
                call.callType === 'approval'
                  ? `Allow ${call.spender ?? 'the router'} to spend exactly ${call.amountAtomic ?? 'the quoted amount'}`
                  : 'Swap through the selected route',
              detail:
                call.callType === 'approval'
                  ? `${call.to} · exact amount, no unlimited approval`
                  : `Recipient is your own wallet · expires ${prepared.blueprint.quoteExpiry}`,
              mono: true,
            })) ?? []
          }
          notice={prepareNotice}
          simulation={simulation}
          balanceChanges={(simulationEvidence?.stateChanges ?? []).map(
            (change: { address: string; kind: string; summary: string }) => ({
              asset: change.address,
              before: '—',
              after: '—',
              change: change.summary,
              tone: 'none' as const,
            }),
          )}
          balanceUnavailableReason={
            simulation.available
              ? 'The simulation reported no decodable asset movement for this wallet.'
              : 'Simulated balance changes appear once the Alchemy simulation runs.'
          }
          /* The kernel's OWN checks, by their own descriptions. These were six
             hard-coded labels every one of which read `Boolean(prepared)` — so
             the screen restated the server's verdict in its own words instead
             of showing it, and a skipped check looked identical to a passed
             one. */
          checks={
            prepared?.review.safety.checks.map((check) => ({
              label: check.description,
              passed: check.status === 'passed',
            })) ?? []
          }
          honesty={
            prepared
              ? verificationHonestyViewV1({
                  inputAsset: prepared.review.input.asset,
                  outputAsset: prepared.review.expectedOutput.asset,
                  contractSecurity: prepared.review.contractSecurity,
                  safetyChecks: prepared.review.safety.checks,
                  simulation: { state: prepared.review.simulationState.status },
                })
              : null
          }
          limits={!swapSurfacePricedV1 ? [] : [
            {
              id: 'per-action',
              label: 'Per action',
              value: budgetRecord?.maxPerRequestUsdc ? `$${budgetRecord.maxPerRequestUsdc}` : '',
              percent: 0,
              // A ceiling below the price of a check pays for nothing, and the
              // failure only shows up as "no simulation provider answered" two
              // panels down. Said here, where the number is.
              note: budgetRecord
                ? (perActionAffordabilityV1({
                    maxPerRequestUsdc: budgetRecord.maxPerRequestUsdc,
                    priceUsdc: prepared?.simulationPriceUsdc ?? null,
                  })?.note ?? 'from your Intelligence Budget')
                : CONSOLE_COPY_V1.limitsMissing,
            },
            {
              id: 'monthly',
              label: 'Monthly',
              value: budgetRecord?.monthlyLimitUsdc ? `$${budgetRecord.monthlyLimitUsdc}` : '',
              percent: limits?.dailyPercent ?? 0,
              note: budgetRecord ? `$${budgetRecord.spentUsdc} used` : CONSOLE_COPY_V1.limitsMissing,
            },
          ]}
          onLimitChange={() => undefined}
          /* The real control, in the place the eye goes. It used to sit in a
             panel below the fold while this row held a large primary button
             wired to nothing, so the click people actually made did nothing. */
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
                  if (next.status !== 'idle') mark('signed', 'start');
                }}
              />
            ) : undefined
          }
          onApprove={() => undefined}
          tokenPanels={b20Panels(true)}
          onBack={() => setScreen('route')}
          approvePending={prepare.isPending}
        />

        {/* T59 / T60 — the two existing paid-simulation paths, unchanged. */}
        {prepared && (
          <div className="panel">
            <div className="ph">
              <h3>Simulate before signing</h3>
              <span className="sub">Alchemy eth_simulateV1 on Base</span>
              <span className="rt">
                {simulationEvidence?.evidenceHash && (
                  <span className="pill n mono">{simulationEvidence.evidenceHash.slice(0, 10)}…</span>
                )}
              </span>
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
                  // Not "misconfigured" — withdrawn. Miorail stopped charging
                  // for swap simulation, and a message implying a broken setup
                  // would send someone hunting for a fix that does not exist.
                  // The free checks below still run.
                  <span className="nt">
                    Miorail no longer charges for swap simulation. The safety checks below still run;
                    they do not include a fork simulation.
                  </span>
                )}
                {budgetHasHeadroom && address && (
                  <button
                    type="button"
                    className="btn sec"
                    disabled={budgetSimulate.isPending}
                    onClick={() => {
                      mark('simulation', 'start');
                      budgetSimulate.mutate({
                        walletAddress: address.toLowerCase() as `0x${string}`,
                        routeRunId: prepared.routeRunId,
                        blueprintId: prepared.blueprint.id,
                        blueprintHash: prepared.blueprint.blueprintHash,
                      });
                    }}
                  >
                    {budgetSimulate.isPending ? 'Charging your budget…' : 'Use Intelligence Budget'}
                  </button>
                )}
              </div>
              {simulationEvidence && (
                <p className="lnote" style={{ marginTop: 10 }}>
                  Block {simulationEvidence.blockNumber ?? '—'} · gas {simulationEvidence.gasUsed ?? '—'} · paid{' '}
                  {simulationEvidence.paidCostUsdc} USDC. The simulation covers the calls in this envelope only — it cannot
                  predict what other transactions do to the same pools before yours lands.
                </p>
              )}
            </div>
          </div>
        )}

        {/* T57's approve → wallet_sendCalls → record-submission path now lives
            in the Review CTA row above (`signSlot`), so there is exactly one
            signing button and it is the one people press. */}
      </>
    );
  } else if (screen === 'proof' && (nftProof || nftSubmission)) {
    // The NFT proof is its own screen: this family's proof succeeds or fails on
    // an ownership READ, which the swap ProofScreen has no room for. Until the
    // reconcile returns, the screen says what is known — a submitted batch —
    // and nothing more.
    content = (
      <>
        <ConsoleStepper steps={steps} />
        {nftProof ? (
          <NftProofPanel proof={nftProof.proof} asset={nftCard?.asset} />
        ) : (
          <section className="nft-proof" aria-label="NFT ownership proof">
            <h3>Submitted — waiting for the transaction</h3>
            <p className="lnote">
              {nftSubmission?.batchId
                ? `Batch ${nftSubmission.batchId}. Nothing is confirmed until the receipt, the Transfer and the ownership read all agree.`
                : 'Nothing has reached the chain yet.'}
            </p>
            {nftSubmission?.error && <p className="empty">{nftSubmission.error}</p>}
          </section>
        )}
      </>
    );
  } else if (screen === 'proof') {
    // The cast this replaces named five fields the response does not have —
    // `proofHash`, `status`, `actualOutput.amountDecimal`, `actualGasUsed`,
    // `blockNumber`. Every read was `undefined`, so a finished swap showed
    // "reconciling", em dashes for gas and block, and a GREEN "reconciled"
    // pill that was only the `??` fallback. The data was in the response the
    // whole time. An `as` cast is a claim TypeScript cannot check, so this one
    // reads the projection's real names.
    const proof = reconciliation.proof ?? null;
    const proofView = proof ? routeProofViewV1(proof) : null;
    content = (
      <ProofScreen
        steps={steps}
        eyebrow={proof ? `Route proof · ${proof.proofId.slice(-12)}` : 'Route proof · reconciling'}
        amount={proofView?.actualOutputDecimal ?? '—'}
        unit={proofView?.actualOutputDecimal ? proof!.expectedOutput.asset.symbol : ''}
        usd={proofView?.actualOutputDecimal ? 'received' : ''}
        headlinePill={
          proof
            ? { label: proofView!.statusLabel, tone: proofView!.statusTone }
            : { label: submission?.status === 'confirmed' ? 'reconciling with the chain' : 'awaiting confirmation', tone: 'n' }
        }
        why="What Miorail promised, next to what the chain actually did. Every proof is stored and exportable."
        kpis={
          proof
            ? [
                {
                  k: 'Actual output',
                  v: proofView!.actualOutputDecimal ?? 'not verifiable',
                  // Not an em dash: when the output is native ETH the chain
                  // emits no Transfer log, so Miorail declines to invent an
                  // amount rather than failing to find one.
                  d: proofView!.actualOutputDecimal
                    ? proof.expectedOutput.asset.symbol
                    : proofView!.actualOutputReason,
                },
                { k: 'Actual gas', v: proof.actualGas?.gasUnits ?? '—', d: 'from the receipt' },
              ]
            : []
        }
        timeline={[
          { title: 'Goal received', detail: goalLabel },
          { title: 'Routes compared', detail: `${projection?.availableRoutes.length ?? 0} quotable` },
          { title: simulation.passed ? 'Simulation passed' : 'Simulation not run', detail: simulation.subLabel },
          { title: 'Approved in Base Account', detail: submission?.batchId ?? 'awaiting the wallet' },
          ...(submission?.txHashes ?? []).map((hash) => ({ title: 'Transaction', detail: hash, done: true })),
          ...(proof ? [{ title: 'Reconciled onchain', detail: `block ${proofView!.blockNumber ?? '—'}`, done: true }] : []),
        ]}
        planVsActual={
          proof && recommended
            ? [
                {
                  label: 'Output',
                  expected: `${recommended.expectedOutput.amountDecimal} ${recommended.expectedOutput.asset.symbol}`,
                  actual: proofView!.actualOutputDecimal
                    ? `${proofView!.actualOutputDecimal} ${proof.expectedOutput.asset.symbol}`
                    : 'not verifiable',
                  difference: '—',
                  tone: 'none' as const,
                },
                {
                  label: 'Gas',
                  expected: recommended.estimatedGas.gasUnits,
                  actual: proof.actualGas?.gasUnits ?? '—',
                  difference: '—',
                  tone: 'none' as const,
                },
              ]
            : []
        }
        record={
          proof
            ? [
                { label: 'Proof id', value: proof.proofId },
                { label: 'Transactions', value: (proof.transactionHashes.length ? proof.transactionHashes : submission?.txHashes ?? []).join(', ') || '—' },
                { label: 'Route chosen', value: recommended?.provider.displayName ?? '—' },
                { label: 'Not scored', value: 'MEV protection — no approved source connected', dim: true },
              ]
            : [
                {
                  label: 'Proof',
                  value: 'Reconciliation has not returned a proof yet. Nothing is claimed until it does.',
                  dim: true,
                },
              ]
        }
        onExport={() => consoleNav.navigate('activity')}
        onNewGoal={() => {
          setScreen('plan');
          setGoal('');
          setClock(emptyStageClockV1());
          evaluationSettled.current = false;
        }}
      />
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

  return (
    <ConsoleShell
      header={{
        crumb: CONSOLE_BREADCRUMB_V1[screen](goalLabel),
        nav: consoleNav.header,
        onNavigate: consoleNav.navigate,
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: connected && status.data?.rpc?.status === 'connected',
        walletLabel,
      }}
      left={{
        nav: consoleNav.rail,
        sessions,
        sessionCount: String(sessions.length),
        proofs,
        proofCount: String(historyItems.length),
        // T70 §2 — one line, not a panel. The usage bars, the limits row and
        // the adapter list moved to Settings; what a user needs while planning
        // a route is whether paid evidence is on, and a way through.
        paidEvidence: paidEvidenceStrip,
        onOpenSettings: () => consoleNav.navigate('settings'),
      }}
      footer={{
        adaptersLabel: adapterRows.summary,
        sourcesLabel: String(evidenceRows.length),
        spendLabel: spendLabel.split(' · ')[0],
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      right={rightRail}
      railFold={rightRail}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => {
        setScreen('plan');
        setGoal('');
        setClock(emptyStageClockV1());
        evaluation.reset();
        earnCompare.reset();
        prepare.reset();
        evaluationSettled.current = false;
      }}
      onSelectSession={() => setScreen(projection ? 'route' : 'plan')}
      onSelectProof={() => consoleNav.navigate('activity')}
    >
      {/* T67C.2: an unfinished submission surfaces above everything else. A
          user who reloaded mid-flight needs to finish CHECKING that batch
          before they start planning another route — offering them a fresh
          plan first is how one transaction becomes two. */}
      <SubmissionRecoveryRail
        walletAddress={address ?? null}
        chainId={chainId ?? null}
        enabled={Boolean(flags?.submissionRecoveryV1)}
        onResolved={() => consoleNav.navigate('activity')}
      />
      {content}
    </ConsoleShell>
  );
}

export default RouteIntelligenceConsole;
