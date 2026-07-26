"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import {
  CONSOLE_COPY_V1,
  CandidateCards,
  CommerceInvoiceReviewPanel,
  CommerceRouteCardPanel,
  commerceCheckoutAvailableV1,
  ConsoleMiniShell,
  ConsoleRightRail,
  ConsoleStepperCompact,
  MiniScorePanel,
  PlanScreen,
  PlanVsActualCards,
  ReviewScreen,
  RouteGraph,
  adaptersFromStatusV1,
  consoleFailureCopyV1,
  ageLabelV1,
  candidateRowsFromProjectionV1,
  chainLabelV1,
  compactStepLabelV1,
  completeStageV1,
  coverageFromStatusV1,
  deriveAdapterRowsV1,
  deriveSimulationViewV1,
  dispatchRouteFamilyV1,
  emptyStageClockV1,
  evidenceRowsFromProjectionV1,
  evidenceSourcesFromProjectionV1,
  intelligenceSpendLabelV1,
  providerUnavailableCopyV1,
  quoteFreshnessFromRouteV1,
  routeGraphFromRouteV1,
  scoreRowsFromProjectionV1,
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
  useCreateCommerceOrder,
  useEarnCompare,
  useEvaluateSwapRoute,
  useIntelligenceBudget,
  usePrepareSwapBlueprint,
  usePortfolio,
  useRouteHistory,
  useSimulateWithBudget,
  useStatus,
  type SimulateWithBudgetResponseV1,
} from "@mioagent/api-client-react";
import { BlueprintSubmitButton, EarnDepositFlow, type BlueprintSubmitStatus } from "@mioagent/wallet-actions";
import { SimulateButton, type SimulateBlueprintResponseV1 } from "@mioagent/x402-actions";
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

const BUILDER_CODE = process.env.NEXT_PUBLIC_BUILDER_CODE;

interface SubmissionState {
  status: BlueprintSubmitStatus;
  batchId: string | null;
  txHashes: string[];
  error: string | null;
  proofId: string | null;
  recordedFinalStatus: string | null;
}

const RECONCILABLE: BlueprintSubmitStatus[] = ["confirmed", "failed", "submitted_unknown"];

export function MiniConsole() {
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();

  const [screen, setScreen] = useState<ConsoleScreenV1>("plan");
  const [goal, setGoal] = useState("");
  const [clock, setClock] = useState<ConsoleStageClockV1>(emptyStageClockV1);
  const [railOpen, setRailOpen] = useState(false);
  const [submission, setSubmission] = useState<SubmissionState | null>(null);
  const [simulateResponse, setSimulateResponse] = useState<SimulateBlueprintResponseV1 | null>(null);
  const [budgetResponse, setBudgetResponse] = useState<SimulateWithBudgetResponseV1 | null>(null);

  const mark = useCallback((stage: ConsoleStageV1, phase: "start" | "complete") => {
    const at = Date.now();
    setClock((current) => (phase === "start" ? startStageV1(current, stage, at) : completeStageV1(current, stage, at)));
  }, []);

  const status = useStatus();
  const evaluation = useEvaluateSwapRoute();
  const earnCompare = useEarnCompare();
  const commerceCompare = useCommerceCompare();
  const commerceOrder = useCreateCommerceOrder();
  const prepare = usePrepareSwapBlueprint();
  const flags = status.data?.productMigration;
  const paidIntelligenceOn = flags?.paidIntelligence === true;
  const budget = useIntelligenceBudget({ enabled: paidIntelligenceOn });
  const budgetSimulate = useSimulateWithBudget({
    onSuccess: (response) => {
      setBudgetResponse(response);
      mark("simulation", "complete");
    },
  });
  const history = useRouteHistory({ limit: 5 });
  const portfolio = usePortfolio(address);

  const connected = Boolean(address);
  const result = evaluation.data;
  const projection = result?.outcome === "evaluated" ? (result.projection as unknown as RoutePlanProjectionV1) : null;
  const recommended = projection?.recommendedRoute ?? null;
  const goalLabel = projection?.goalSummary ?? (goal.trim() || "New goal");
  const prepared = prepare.data?.outcome === "prepared" ? prepare.data : null;

  const dispatch = useMemo(
    () =>
      dispatchRouteFamilyV1(goal, {
        routeIntelligenceV1: flags?.routeIntelligenceV1 === true,
        earnRouteV1: flags?.earnRouteV1 === true,
        commerceRouteV1: flags?.commerceRouteV1 === true,
        commerceExecutionV1: flags?.commerceExecutionV1 === true,
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

  // T64.3.1 — the same two defects the console had: a Commerce comparison did
  // not count as pending, and a `needs_clarification` result left this screen
  // waiting on a run that had already finished, with raw issue codes as the
  // only explanation and no way back to the goal.
  const comparePending = evaluation.isPending || earnCompare.isPending || commerceCompare.isPending;
  const comparingFailure = (() => {
    if (comparePending || projection || earnCard || commerceCard) return null;
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
    if (evaluation.isError || earnCompare.isError || commerceCompare.isError) {
      return {
        title: "The comparison could not be completed",
        detail: "The server did not answer this request. Nothing was signed or spent.",
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

  const compare = () => {
    if (!address || !goal.trim() || dispatch.engine === null) return;
    prepare.reset();
    setSubmission(null);
    setSimulateResponse(null);
    setBudgetResponse(null);
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
    if (dispatch.engine === "commerce") {
      commerceCompare.mutate(
        { message: goal, walletAddress: wallet },
        { onSettled: () => mark("candidates", "complete") },
      );
      return;
    }
    if (dispatch.engine === "earn") {
      earnCompare.mutate({ message: goal, walletAddress: wallet }, { onSettled: () => mark("candidates", "complete") });
      return;
    }
    evaluation.mutate({ message: goal, walletAddress: wallet }, { onError: () => setScreen("plan") });
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
  const adapterRows = useMemo(
    () =>
      deriveAdapterRowsV1(
        adaptersFromStatusV1(
          status.data ?? null,
          (projection?.availableRoutes ?? []).map((route) => ({ name: route.provider.displayName })),
          (projection?.providerFailures ?? []).map((failure) => ({ name: failure.adapterId })),
        ),
      ),
    [status.data, projection],
  );
  const budgetRecord = budget.data?.budget ?? null;
  const simulationSource = simulationSourceFromResponseV1(simulateResponse ?? budgetResponse);
  const simulation = deriveSimulationViewV1(simulationSource);
  const quoteFreshness = quoteFreshnessFromRouteV1(recommended);
  const historyItems = history.data?.items ?? [];

  const panels = (
    <ConsoleRightRail
      price={null}
      priceUnavailableReason={providerUnavailableCopyV1(status.data?.prices, "price")}
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

  let content: ReactNode;

  if (screen === "plan") {
    content = (
      <PlanScreen
        goal={goal}
        onGoalChange={setGoal}
        onCompare={compare}
        comparePending={comparePending}
        compareDisabledReason={!connected ? CONSOLE_COPY_V1.walletDisconnected : dispatch.blockedReason}
        starters={[
          { id: "swap", title: "Swap 100 USDC → ETH", meta: "best net result" },
          { id: "earn", title: "Earn yield on 500 USDC", meta: flags?.earnRouteV1 ? "Moonwell and Morpho" : "earn gate is off on this server" },
        ]}
        onStarter={(id) => setGoal(id === "swap" ? "Swap 100 USDC to ETH with the best net result" : "Earn yield on 500 USDC with low risk")}
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
        gasPoints={[]}
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
            <CandidateCards rows={projection ? candidateRowsFromProjectionV1(projection) : []} />
            {projection && shortfallNoticeFromProjectionV1(projection) && (
              <p className="lnote" style={{ marginTop: 10 }}>{shortfallNoticeFromProjectionV1(projection)}</p>
            )}
            {comparingFailure && (
              <div className="note warn" role="alert">
                <b>{comparingFailure.title}</b>
                <p style={{ margin: "6px 0 10px" }}>{comparingFailure.detail}</p>
                <button type="button" className="btn" onClick={() => setScreen("plan")}>
                  Edit goal
                </button>
              </div>
            )}
          </div>
        </div>
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
            <EarnDepositFlow routeRunId={earnCard.routeRunId ?? ""} routeCard={earnCard.routeCard} builderCode={BUILDER_CODE} onRefresh={compare} />
          </div>
        </div>
      </>
    );
  } else if (screen === "route" && projection) {
    const graph = routeGraphFromRouteV1(recommended, { amountLabel: goalLabel, walletLabel: "your wallet" });
    content = (
      <>
        <ConsoleStepperCompact label={stepLabel} steps={steps} expanded={railOpen} onToggle={() => setRailOpen((open) => !open)} />
        <div className="herostrip">
          <div className="heroL">
            <p className="eyebrow">Recommended route</p>
            <div className="amtrow">
              <span className="amount mono">{recommended?.expectedOutput.amountDecimal ?? "—"}</span>
              <span className="unit">{recommended?.expectedOutput.asset.symbol ?? ""}</span>
              <span style={{ paddingBottom: 6, display: "flex", gap: 7 }}>
                <span className="pill br">{recommended?.provider.displayName ?? "no provider"}</span>
                <span className={`pill ${quoteFreshness.tone}`}>{quoteFreshness.label}</span>
              </span>
            </div>
          </div>
        </div>
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
        <MiniScorePanel rows={scoreRowsFromProjectionV1(projection)} note={scoredCountLabelV1(scoreRowsFromProjectionV1(projection))} />
        <div className="panel">
          <div className="ph">
            <h3>All candidates</h3>
          </div>
          <div className="pb tight">
            <CandidateCards rows={candidateRowsFromProjectionV1(projection)} onSelect={reviewCandidate} />
          </div>
        </div>
        <div className="ctarow">
          <button type="button" className="btn lg" disabled={!connected || !recommended} onClick={() => recommended && reviewCandidate(recommended.candidateHash)}>
            Review transaction
          </button>
          <span className="nt">{connected ? CONSOLE_COPY_V1.nothingSigned : CONSOLE_COPY_V1.walletDisconnected}</span>
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
          onApprove={() => undefined}
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
                  <span className="nt">Paid simulation is not configured on this server.</span>
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
        {prepared && (
          <div className="panel">
            <div className="ph">
              <h3>Sign in Base Account</h3>
              <span className="sub">{CONSOLE_COPY_V1.prepared}</span>
            </div>
            <div className="pb">
              {simulation.canSign ? (
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
              ) : (
                <p className="empty">{simulation.disabledReason}</p>
              )}
            </div>
          </div>
        )}
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
                      { label: "Gas", expected: recommended.estimatedGas.gasUnits, actual: proof.actualGasUsed ?? "—", difference: "—", tone: "none" as const },
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

  return (
    <ConsoleMiniShell
      goalLine={goalLabel}
      stepLine={`${stepLabel} · ${spendLabel.split(" · ")[0]}`}
      networkLabel={chainLabelV1(status.data?.chainId)}
      connected={connected && status.data?.rpc?.status === "connected"}
      blockNumber={null}
      theme={theme}
      onThemeChange={setTheme}
      drawer={drawer}
      panels={panels}
    >
      {content}
    </ConsoleMiniShell>
  );
}

export default MiniConsole;
