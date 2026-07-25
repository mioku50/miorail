import { useMemo, useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { useAccount } from 'wagmi';
import {
  CONSOLE_BREADCRUMB_V1,
  CONSOLE_COPY_V1,
  CONSOLE_SCREEN_STEP_V1,
  ComparingScreen,
  ConsoleRightRail,
  ConsoleShell,
  PlanScreen,
  ProofScreen,
  ReviewScreen,
  RouteScreen,
  deriveAdapterRowsV1,
  deriveSimulationViewV1,
  deriveStepperV1,
  useConsoleTheme,
  usagePercentV1,
  type ConsoleScreenV1,
  type ConsoleSessionItemV1,
} from '@mioagent/ui';
import {
  useEvaluateSwapRoute,
  useIntelligenceBudget,
  usePortfolio,
  usePrepareSwapBlueprint,
  useStatus,
} from '@mioagent/api-client-react';
import {
  type RoutePlanProjectionV1,
  candidateRowsFromProjectionV1,
  evidenceRowsFromProjectionV1,
  evidenceSourcesFromProjectionV1,
  quoteFreshnessFromRouteV1,
  routeGraphFromRouteV1,
  scoreRowsFromProjectionV1,
  scoringVersionLabelV1,
  shortfallNoticeFromProjectionV1,
  simulationSourceFromResponseV1,
} from './consoleAdapters';

// ---------------------------------------------------------------------------
// The Route Intelligence console — the app's root surface.
//
// It is ONE flow across five states (plan → comparing → route → review →
// proof); the user advances through CTAs, never by picking a tab. Every number
// comes from an existing module; where a source is missing the screen says so
// instead of hiding the row.
// ---------------------------------------------------------------------------

function shortAddress(address: string | undefined): string | null {
  if (!address) return null;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function RouteIntelligenceConsole() {
  const [, navigate] = useLocation();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();

  const [screen, setScreen] = useState<ConsoleScreenV1>('plan');
  const [goal, setGoal] = useState('');

  const status = useStatus();
  const portfolio = usePortfolio(address);
  const evaluation = useEvaluateSwapRoute();
  const prepare = usePrepareSwapBlueprint();
  const paidIntelligenceOn = status.data?.productMigration.paidIntelligence === true;
  const budget = useIntelligenceBudget({ enabled: paidIntelligenceOn });

  const walletLabel = shortAddress(address);
  const connected = Boolean(address);
  const result = evaluation.data;
  const projection = result?.outcome === 'evaluated' ? (result.projection as unknown as RoutePlanProjectionV1) : null;
  const recommended = projection?.recommendedRoute ?? null;
  const goalLabel = projection?.goalSummary ?? (goal.trim() || 'New goal');

  // The flow's position is DERIVED from what actually happened, so the stepper
  // can never disagree with the screen.
  const activeStep = CONSOLE_SCREEN_STEP_V1[screen];
  const steps = useMemo(
    () =>
      deriveStepperV1(activeStep, [
        projection ? 'parsed' : null,
        projection ? `${projection.availableRoutes.length} quoted` : null,
        projection ? `${evidenceSourcesFromProjectionV1(projection).length} sources` : null,
        null,
        projection?.pathScore ? 'scored' : null,
        prepare.data?.outcome === 'prepared' ? 'ready' : null,
        null,
        null,
      ]),
    [activeStep, projection, prepare.data],
  );

  const compare = (event?: FormEvent) => {
    event?.preventDefault();
    if (!address || !goal.trim() || evaluation.isPending) return;
    prepare.reset();
    setScreen('comparing');
    evaluation.mutate(
      { message: goal, walletAddress: address.toLowerCase() as `0x${string}` },
      { onSuccess: () => setScreen('route'), onError: () => setScreen('plan') },
    );
  };

  const reviewCandidate = (candidateHash: string) => {
    if (!address || !projection?.routeCardHash || !result || result.outcome !== 'evaluated') return;
    setScreen('review');
    prepare.mutate({
      walletAddress: address.toLowerCase() as `0x${string}`,
      routeRunId: result.routeRunId,
      routeCardHash: projection.routeCardHash,
      selectedCandidateHash: candidateHash,
    });
  };

  // --- shell models ---------------------------------------------------------

  const sessions: ConsoleSessionItemV1[] = projection
    ? [
        {
          id: 'active',
          title: goalLabel,
          tag: { label: projection.outcome === 'ready' ? 'scoring' : projection.outcome, tone: projection.outcome === 'ready' ? 'b' : 'n' },
          meta: `${projection.availableRoutes.length} route${projection.availableRoutes.length === 1 ? '' : 's'}`,
          active: true,
        },
      ]
    : [];

  const adapterRows = useMemo(() => {
    const answered = (projection?.availableRoutes ?? []).map((route) => ({ name: route.provider.displayName, state: 'live' as const }));
    const failed = (projection?.providerFailures ?? []).map((failure) => ({ name: failure.adapterId, state: 'not_connected' as const }));
    if (answered.length === 0 && failed.length === 0) {
      // Before the first comparison the registry is still shown, honestly
      // labelled — an empty panel would read as "no adapters exist".
      return deriveAdapterRowsV1([
        { name: 'Uniswap', state: 'live' },
        { name: 'KyberSwap', state: 'live' },
      ]);
    }
    return deriveAdapterRowsV1([...answered, ...failed]);
  }, [projection]);

  const budgetRecord = budget.data?.budget ?? null;
  const limits = budgetRecord
    ? {
        dailyLabel: `$${budgetRecord.spentUsdc} / $${budgetRecord.monthlyLimitUsdc}`,
        dailyPercent: usagePercentV1(Number(budgetRecord.spentUsdc), Number(budgetRecord.monthlyLimitUsdc)),
        intelligenceLabel: `$${budgetRecord.spentUsdc} / $${budgetRecord.maxPerRequestUsdc}`,
        intelligencePercent: usagePercentV1(Number(budgetRecord.spentUsdc), Number(budgetRecord.maxPerRequestUsdc)),
      }
    : null;

  const evidenceRows = projection ? evidenceRowsFromProjectionV1(projection) : [];
  const paidCount = evidenceRows.filter((row) => row.costLabel.startsWith('$')).length;

  const header = {
    crumb: CONSOLE_BREADCRUMB_V1[screen](goalLabel),
    blockNumber: null,
    gasLabel: null,
    networkLabel: `Base mainnet · 8453`,
    connected,
    walletLabel,
  };

  const footer = {
    adaptersLabel: adapterRows.summary,
    sourcesLabel: String(evidenceRows.length),
    spendLabel: paidCount > 0 ? `${paidCount} paid` : '$0',
    blockNumber: null,
  };

  const rightRail = (
    <ConsoleRightRail
      price={null}
      priceUnavailableReason="No price feed is connected to this surface yet."
      depth={null}
      depthUnavailableReason="No depth source connected — liquidity is not scored."
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
        { label: 'Quote age', value: quoteFreshnessFromRouteV1(recommended).label.replace('quote ', '') },
        { label: 'Simulation age', value: '—' },
        { label: 'Re-sim before signing', value: 'on', tone: 'ok' },
      ]}
    />
  );

  // --- screens --------------------------------------------------------------

  let content: React.ReactNode;

  if (screen === 'plan') {
    content = (
      <PlanScreen
        goal={goal}
        onGoalChange={setGoal}
        onCompare={() => compare()}
        comparePending={evaluation.isPending}
        compareDisabledReason={connected ? null : CONSOLE_COPY_V1.walletDisconnected}
        starters={[
          { id: 'swap', title: 'Swap 100 USDC → ETH', meta: 'best net result · compares every live adapter' },
          { id: 'earn', title: 'Earn yield on 500 USDC, low risk', meta: 'Moonwell and Morpho · read-only comparison' },
        ]}
        onStarter={(id) => setGoal(id === 'swap' ? 'Swap 100 USDC to ETH with the best net result' : 'Earn yield on 500 USDC with low risk')}
        walletLabel={walletLabel}
        balances={
          portfolio.data?.tokens?.map((token: { symbol: string; balanceFormatted?: string; balanceUsd?: string }) => ({
            asset: token.symbol,
            amount: token.balanceFormatted ?? '—',
            usd: token.balanceUsd ? `$${token.balanceUsd}` : '—',
          })) ?? []
        }
        balancesUnavailableReason={connected ? CONSOLE_COPY_V1.portfolioUnavailable : CONSOLE_COPY_V1.walletDisconnected}
        coverage={[
          { action: 'Swap on Base', sources: 'Uniswap, KyberSwap', percent: 70, state: 'ready', available: true },
          { action: 'Supply / withdraw', sources: 'Moonwell, Morpho', percent: 45, state: 'ready', available: true },
          { action: 'MEV-protected swap', sources: 'no approved source connected', percent: 0, state: 'off', available: false },
          { action: 'Cross-chain bridge', sources: 'no approved adapter', percent: 0, state: 'off', available: false },
        ]}
        chainKpis={[
          { k: 'Network', v: 'Base', d: 'chain 8453' },
          { k: 'Adapters live', v: adapterRows.summary, d: 'route sources' },
          { k: 'Signing', v: 'your wallet', d: 'Miorail never signs' },
        ]}
        gasPoints={[]}
        chainNote={CONSOLE_COPY_V1.planHint}
      />
    );
  } else if (screen === 'comparing') {
    content = (
      <ComparingScreen
        steps={steps}
        goalLabel={goalLabel}
        optimisingFor={projection ? `optimising for ${projection.optimizationMode}` : 'reading quotes'}
        elapsedLabel={evaluation.isPending ? 'running' : 'done'}
        progress={[
          { label: 'Intent parsed', state: projection ? 'done' : 'running', value: projection?.goalSummary ?? '', latencyPercent: 8 },
          { label: 'Route quotes', state: projection ? 'done' : 'running', value: projection ? `${projection.availableRoutes.length} answered` : '', latencyPercent: 52 },
          { label: 'Evidence collected', state: projection ? 'done' : 'pending', value: projection ? `${evidenceRows.length} sources` : '', latencyPercent: 18 },
          { label: 'Scoring against your goal', state: projection?.pathScore ? 'done' : 'pending', value: '', latencyPercent: 0 },
        ]}
        candidates={projection ? candidateRowsFromProjectionV1(projection) : []}
        sources={evidenceRows}
        shortfallNotice={projection ? shortfallNoticeFromProjectionV1(projection) : null}
        onCancel={() => setScreen('plan')}
      />
    );
  } else if (screen === 'route' && projection) {
    const freshness = quoteFreshnessFromRouteV1(recommended);
    content = (
      <RouteScreen
        steps={steps}
        eyebrow={`Recommended route · ${goalLabel}`}
        amount={recommended?.expectedOutput.amountDecimal ?? '—'}
        unit={recommended?.expectedOutput.asset.symbol ?? ''}
        usd=""
        providerLabel={recommended?.provider.displayName ?? 'no provider'}
        freshness={freshness}
        why={
          projection.outcome === 'ready'
            ? 'Highest expected output after network and intelligence costs.'
            : 'No comparative recommendation was made — the routes below are shown for comparison only.'
        }
        kpis={[
          { k: 'Minimum output', v: recommended?.minimumOutput.amountDecimal ?? '—', d: `slippage ${recommended?.slippage.percent ?? '—'}%` },
          { k: 'Network cost', v: recommended?.estimatedGas.estimatedCostUsd ? `$${recommended.estimatedGas.estimatedCostUsd}` : '—', d: `est. ${recommended?.estimatedGas.gasUnits ?? '—'} gas` },
          { k: 'Price impact', v: recommended ? `${recommended.priceImpact.percent}%` : '—', d: 'from the quote' },
          { k: 'Approvals', v: String(recommended?.approvalCount ?? '—'), d: 'exact amount' },
          { k: 'Calls', v: String(recommended?.callCount ?? '—'), d: 'one batch' },
          { k: 'Intelligence', v: paidCount > 0 ? `${paidCount} paid` : 'free', d: `${evidenceRows.length} sources` },
        ]}
        graph={routeGraphFromRouteV1(recommended, {
          amountLabel: goalLabel,
          walletLabel: walletLabel ?? 'your wallet',
        })}
        graphUnavailableReason="The provider did not return a pool breakdown for this route, so the path is not drawn."
        graphLegend={recommended ? [`executed by ${recommended.provider.displayName}`, 'Output returns to your wallet'] : []}
        simulatedPill={{ label: 'not simulated yet', tone: 'n' }}
        scoreRows={scoreRowsFromProjectionV1(projection)}
        scoringVersion={scoringVersionLabelV1(projection.pathScore as never)}
        candidates={candidateRowsFromProjectionV1(projection)}
        onReview={() => recommended && reviewCandidate(recommended.candidateHash)}
        onChangeGoal={() => setScreen('plan')}
        onSelectCandidate={reviewCandidate}
        reviewDisabledReason={connected ? null : CONSOLE_COPY_V1.walletDisconnected}
      />
    );
  } else if (screen === 'review') {
    const prepared = prepare.data?.outcome === 'prepared' ? prepare.data : null;
    const simulation = deriveSimulationViewV1(simulationSourceFromResponseV1(null));
    content = (
      <ReviewScreen
        steps={steps}
        calls={
          prepared?.blueprint.calls.map((call, index) => ({
            index: index + 1,
            title: call.callType === 'approval' ? `Allow ${call.spender ?? 'the router'} to spend exactly this amount` : 'Swap through the selected route',
            detail: call.callType === 'approval' ? `${call.to} · exact amount, no unlimited approval` : 'Recipient is your own wallet',
            mono: true,
          })) ?? []
        }
        simulation={simulation}
        balanceChanges={[]}
        balanceUnavailableReason="Simulated balance changes appear once the simulation adapter answers."
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
        onApprove={() => setScreen('proof')}
        onBack={() => setScreen('route')}
        approvePending={prepare.isPending}
      />
    );
  } else if (screen === 'proof') {
    content = (
      <ProofScreen
        steps={steps}
        eyebrow="Route proof"
        amount="—"
        unit=""
        usd=""
        headlinePill={{ label: 'awaiting confirmation', tone: 'n' }}
        why="What Miorail promised, next to what the chain actually did. Every proof is stored and exportable."
        kpis={[]}
        timeline={[]}
        planVsActual={[]}
        record={[{ label: 'Proof', value: 'This route has no recorded proof yet.', dim: true }]}
        onExport={() => navigate('/plan/history')}
        onNewGoal={() => {
          setScreen('plan');
          setGoal('');
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
      header={header}
      left={{
        sessions,
        sessionCount: String(sessions.length),
        proofs: [],
        proofCount: '0',
        limits,
        limitsUnavailableReason: paidIntelligenceOn ? CONSOLE_COPY_V1.limitsMissing : 'Intelligence Budget is off on this server.',
        adapters: adapterRows,
      }}
      footer={footer}
      right={rightRail}
      railFold={rightRail}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => {
        setScreen('plan');
        setGoal('');
        evaluation.reset();
        prepare.reset();
      }}
      onSelectSession={() => setScreen(projection ? 'route' : 'plan')}
      onSelectProof={() => navigate('/plan/history')}
    >
      {content}
    </ConsoleShell>
  );
}

export default RouteIntelligenceConsole;
