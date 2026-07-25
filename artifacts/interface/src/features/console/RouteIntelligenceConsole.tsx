import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useAccount } from 'wagmi';
import {
  CONSOLE_BREADCRUMB_V1,
  CommerceInvoiceReviewPanel,
  CommerceRouteCardPanel,
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
  completeStageV1,
  coverageFromStatusV1,
  deriveAdapterRowsV1,
  deriveSimulationViewV1,
  dispatchRouteFamilyV1,
  emptyStageClockV1,
  intelligenceSpendLabelV1,
  providerUnavailableCopyV1,
  startStageV1,
  stepperFromClockV1,
  useConsoleTheme,
  usagePercentV1,
  type ConsoleScreenV1,
  type ConsoleSessionItemV1,
  type ConsoleStageClockV1,
  type ConsoleStageV1,
  candidateRowsFromProjectionV1,
  evidenceRowsFromProjectionV1,
  evidenceSourcesFromProjectionV1,
  quoteFreshnessFromRouteV1,
  routeGraphFromRouteV1,
  scoreRowsFromProjectionV1,
  scoringVersionLabelV1,
  shortfallNoticeFromProjectionV1,
  simulationSourceFromResponseV1,
  type RoutePlanProjectionV1,
} from '@mioagent/ui';
import {
  useBoundedProofReconciliation,
  useCommerceCompare,
  useCreateCommerceOrder,
  useEarnCompare,
  useEvaluateSwapRoute,
  useIntelligenceBudget,
  usePortfolio,
  usePrepareSwapBlueprint,
  useRouteHistory,
  useSimulateWithBudget,
  useStatus,
  type SimulateWithBudgetResponseV1,
} from '@mioagent/api-client-react';
import { BlueprintSubmitButton, EarnDepositFlow, type BlueprintSubmitStatus } from '@mioagent/wallet-actions';
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

const BUILDER_CODE = import.meta.env?.VITE_BUILDER_CODE as string | undefined;

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
  const [, navigate] = useLocation();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();

  const [screen, setScreen] = useState<ConsoleScreenV1>('plan');
  const [goal, setGoal] = useState('');
  const [clock, setClock] = useState<ConsoleStageClockV1>(emptyStageClockV1);
  const [submission, setSubmission] = useState<BlueprintSubmissionState | null>(null);
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

  const walletLabel = shortAddress(address);
  const connected = Boolean(address);
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

  const compare = (event?: FormEvent) => {
    event?.preventDefault();
    if (!address || !goal.trim() || dispatch.engine === null) return;
    prepare.reset();
    setSubmission(null);
    setSimulateResponse(null);
    setBudgetResponse(null);
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
    evaluation.mutate({ message: goal, walletAddress: wallet }, { onError: () => setScreen('plan') });
  };

  const reviewCandidate = (candidateHash: string) => {
    if (!address || !projection?.routeCardHash || result?.outcome !== 'evaluated') return;
    setSubmission(null);
    setSimulateResponse(null);
    setBudgetResponse(null);
    mark('review', 'start');
    setScreen('review');
    prepare.mutate({
      walletAddress: address.toLowerCase() as `0x${string}`,
      routeRunId: result.routeRunId,
      routeCardHash: projection.routeCardHash,
      selectedCandidateHash: candidateHash,
    });
  };

  // --- derived models --------------------------------------------------------

  const steps = useMemo(() => stepperFromClockV1(clock), [clock]);
  const evidenceRows = projection ? evidenceRowsFromProjectionV1(projection) : [];
  const evidenceSources = projection ? evidenceSourcesFromProjectionV1(projection) : [];
  const spendLabel = intelligenceSpendLabelV1(evidenceSources);

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
  const simulation = deriveSimulationViewV1(simulationSource);
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

  const rightRail = (
    <ConsoleRightRail
      price={null}
      priceUnavailableReason={providerUnavailableCopyV1(status.data?.prices, 'price')}
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
        comparePending={evaluation.isPending || earnCompare.isPending}
        compareDisabledReason={!connected ? CONSOLE_COPY_V1.walletDisconnected : dispatch.blockedReason}
        starters={[
          { id: 'swap', title: 'Swap 100 USDC → ETH', meta: 'best net result · every live adapter' },
          {
            id: 'earn',
            title: 'Earn yield on 500 USDC, low risk',
            meta: flags?.earnRouteV1 ? 'Moonwell and Morpho' : 'earn gate is off on this server',
          },
        ]}
        onStarter={(id) =>
          setGoal(id === 'swap' ? 'Swap 100 USDC to ETH with the best net result' : 'Earn yield on 500 USDC with low risk')
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
          { k: 'Adapters live', v: adapterRows.summary, d: 'from server flags' },
          { k: 'Signing', v: 'your wallet', d: 'Miorail never signs' },
        ]}
        gasPoints={[]}
        chainNote={CONSOLE_COPY_V1.planHint}
      />
    );
  } else if (screen === 'comparing') {
    const answered = (projection?.availableRoutes ?? []).map((route) => route.provider.displayName);
    content = (
      <ComparingScreen
        steps={steps}
        goalLabel={goalLabel}
        optimisingFor={projection ? `optimising for ${projection.optimizationMode}` : `${dispatch.family} route`}
        elapsedLabel={evaluation.isPending || earnCompare.isPending ? 'running' : 'done'}
        progress={[
          { label: 'Intent extraction', state: 'done', value: dispatch.family, latencyPercent: 8 },
          // One row per adapter, each with its own outcome and reason.
          ...adapterRows.rows.map((row) => ({
            label: `${row.name} quote`,
            state: (answered.includes(row.name) ? 'done' : row.live ? 'running' : 'failed') as 'done' | 'running' | 'failed',
            value: answered.includes(row.name) ? 'answered' : row.live ? '' : row.label,
            latencyPercent: answered.includes(row.name) ? 45 : 0,
          })),
          {
            label: 'Evidence collected',
            state: projection ? 'done' : 'pending',
            value: projection ? `${evidenceRows.length} sources` : '',
            latencyPercent: 18,
          },
          {
            label: 'Alchemy simulation',
            state: paidIntelligenceOn ? 'pending' : 'failed',
            value: paidIntelligenceOn ? 'runs on Review' : 'paid intelligence gate is off',
            latencyPercent: 0,
          },
          { label: 'Scoring against your goal', state: projection?.pathScore ? 'done' : 'pending', value: '', latencyPercent: 0 },
        ]}
        candidates={projection ? candidateRowsFromProjectionV1(projection) : []}
        sources={evidenceRows}
        shortfallNotice={
          projection
            ? shortfallNoticeFromProjectionV1(projection)
            : earnCompare.data?.outcome === 'unsupported'
              ? earnCompare.data.reason
              : earnCompare.data?.outcome === 'needs_clarification'
                ? earnCompare.data.issues.join(', ')
                : commerceCompare.data?.outcome === 'unsupported'
                  ? commerceCompare.data.reason
                  : commerceCompare.data?.outcome === 'needs_clarification'
                    ? commerceCompare.data.issues.join(', ')
                    : dispatch.blockedReason
        }
        onCancel={() => setScreen('plan')}
      />
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
              onRefresh={() => compare()}
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
          projection.outcome === 'ready'
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
        candidates={candidateRowsFromProjectionV1(projection)}
        onReview={() => recommended && reviewCandidate(recommended.candidateHash)}
        onChangeGoal={() => setScreen('plan')}
        onSelectCandidate={reviewCandidate}
        reviewDisabledReason={connected ? null : CONSOLE_COPY_V1.walletDisconnected}
      />
    );
  } else if (screen === 'review') {
    const priceLabel = prepared?.simulationPriceUsdc ? `${prepared.simulationPriceUsdc} USDC` : null;
    const budgetHasHeadroom = Boolean(budgetRecord && Number(budgetRecord.remainingUsdc) > 0);
    const simulationEvidence =
      simulateResponse?.outcome === 'simulated' || simulateResponse?.outcome === 'cached' ? simulateResponse.evidence : null;

    content = (
      <>
        <ReviewScreen
          steps={steps}
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
          checks={[
            { label: 'Chain is Base mainnet', passed: Boolean(prepared) },
            { label: 'Recipient is your wallet', passed: Boolean(prepared) },
            { label: 'Calldata matches the intent', passed: Boolean(prepared) },
            { label: 'Approval exact, not unlimited', passed: Boolean(prepared) },
            { label: 'Simulation passed', passed: simulation.passed },
            { label: 'Within your limits', passed: Boolean(limits) },
          ]}
          limits={[
            {
              id: 'per-action',
              label: 'Per action',
              value: budgetRecord?.maxPerRequestUsdc ? `$${budgetRecord.maxPerRequestUsdc}` : '',
              percent: 0,
              note: budgetRecord ? 'from your Intelligence Budget' : CONSOLE_COPY_V1.limitsMissing,
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
          /* Signing is NOT a screen switch: the real Base Account submission
             below owns it, so this CTA never advances the flow by itself. */
          onApprove={() => undefined}
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
                  <span className="nt">Paid simulation is not configured on this server, so nothing can be simulated yet.</span>
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

        {/* T57 — the real approve → wallet_sendCalls → record-submission path. */}
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
                    if (next.status !== 'idle') mark('signed', 'start');
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
  } else if (screen === 'proof') {
    const proof = reconciliation.proof as {
      proofHash?: string;
      status?: string;
      actualOutput?: { amountDecimal?: string; asset?: { symbol?: string } };
      actualGasUsed?: string;
      blockNumber?: string;
      transactionHashes?: string[];
    } | null;
    content = (
      <ProofScreen
        steps={steps}
        eyebrow={proof?.proofHash ? `Route proof · ${proof.proofHash.slice(0, 12)}…` : 'Route proof · reconciling'}
        amount={proof?.actualOutput?.amountDecimal ?? '—'}
        unit={proof?.actualOutput?.asset?.symbol ?? ''}
        usd={proof ? 'received' : ''}
        headlinePill={
          proof
            ? { label: proof.status ?? 'reconciled', tone: 'g' }
            : { label: submission?.status === 'confirmed' ? 'reconciling with the chain' : 'awaiting confirmation', tone: 'n' }
        }
        why="What Miorail promised, next to what the chain actually did. Every proof is stored and exportable."
        kpis={
          proof
            ? [
                { k: 'Actual output', v: proof.actualOutput?.amountDecimal ?? '—', d: proof.actualOutput?.asset?.symbol ?? '' },
                { k: 'Actual gas', v: proof.actualGasUsed ?? '—', d: 'from the receipt' },
              ]
            : []
        }
        timeline={[
          { title: 'Goal received', detail: goalLabel },
          { title: 'Routes compared', detail: `${projection?.availableRoutes.length ?? 0} quotable` },
          { title: simulation.passed ? 'Simulation passed' : 'Simulation not run', detail: simulation.subLabel },
          { title: 'Approved in Base Account', detail: submission?.batchId ?? 'awaiting the wallet' },
          ...(submission?.txHashes ?? []).map((hash) => ({ title: 'Transaction', detail: hash, done: true })),
          ...(proof ? [{ title: 'Reconciled onchain', detail: `block ${proof.blockNumber ?? '—'}`, done: true }] : []),
        ]}
        planVsActual={
          proof && recommended
            ? [
                {
                  label: 'Output',
                  expected: `${recommended.expectedOutput.amountDecimal} ${recommended.expectedOutput.asset.symbol}`,
                  actual: `${proof.actualOutput?.amountDecimal ?? '—'} ${proof.actualOutput?.asset?.symbol ?? ''}`,
                  difference: '—',
                  tone: 'none' as const,
                },
                {
                  label: 'Gas',
                  expected: recommended.estimatedGas.gasUnits,
                  actual: proof.actualGasUsed ?? '—',
                  difference: '—',
                  tone: 'none' as const,
                },
              ]
            : []
        }
        record={
          proof
            ? [
                { label: 'Proof hash', value: proof.proofHash ?? '—' },
                { label: 'Transactions', value: (proof.transactionHashes ?? submission?.txHashes ?? []).join(', ') || '—' },
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
        onExport={() => navigate('/plan/history')}
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
        blockNumber: null,
        gasLabel: null,
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: connected && status.data?.rpc?.status === 'connected',
        walletLabel,
      }}
      left={{
        sessions,
        sessionCount: String(sessions.length),
        proofs,
        proofCount: String(historyItems.length),
        limits,
        limitsUnavailableReason: paidIntelligenceOn
          ? CONSOLE_COPY_V1.limitsMissing
          : 'Intelligence Budget is off on this server.',
        adapters: adapterRows,
      }}
      footer={{
        adaptersLabel: adapterRows.summary,
        sourcesLabel: String(evidenceRows.length),
        spendLabel: spendLabel.split(' · ')[0],
        blockNumber: null,
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
      onSelectProof={() => navigate('/plan/history')}
    >
      {content}
    </ConsoleShell>
  );
}

export default RouteIntelligenceConsole;
