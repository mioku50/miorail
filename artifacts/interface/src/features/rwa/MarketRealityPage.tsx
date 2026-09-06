import { useEffect, useMemo } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useAccount } from 'wagmi';
import {
  ConsoleShell,
  MARKET_REALITY_DIRECTIONS_V1,
  MARKET_REALITY_SIZES_V1,
  MARKET_REALITY_HISTORY_PERIODS_V1,
  MarketRealityScreen,
  STOCKS_CONSOLE_DEFAULT_SIZE_V1,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  chainUnavailableReasonV1,
  consoleSectionPathV1,
  useConsoleTheme,
  useStocksConsoleV1,
  VERIFICATION_FLOOR_PARAM_V1,
  type MarketRealityDirectionV1,
  type MarketRealityHistoryPeriodV1,
  type MarketRealitySurfaceV1,
  type StocksConsoleQuestionV1,
} from '@mioagent/ui';
import { useStatus } from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';

// ---------------------------------------------------------------------------
// Phase 10B — Market Reality, on the web.
//
// The question lives entirely in the URL: which security, which direction,
// which size. Three reasons, and all three are about a reader rather than
// about the code:
//
//   * a refresh and a Back press restore the same question. A comparison you
//     cannot return to is a comparison you cannot check;
//   * a link carries the question. "Look at NVIDIA at $10k" is one URL;
//   * the query cache keys off the question, so switching size does not show a
//     $100 answer under a $10,000 heading while the new one loads.
//
// Phase 15.1 moved everything BETWEEN the question and the screen into
// `useStocksConsoleV1`, which the Base App mounts too. What is left here is
// the part that is genuinely the web's: a URL, a shell and a header.
//
// This page holds no clearance, prepares no plan and opens no wallet.
// ---------------------------------------------------------------------------

function shortAddressV1(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

function questionFromSearchV1(search: string): StocksConsoleQuestionV1 {
  const params = new URLSearchParams(search);
  const direction = params.get('direction');
  const size = params.get('size');
  const historyPeriod = params.get('history');
  const destination = params.get('destination');
  return {
    underlyingKey: params.get('key'),
    surface: params.get('view') === 'utility' ? 'utility' : 'market',
    direction: MARKET_REALITY_DIRECTIONS_V1.includes(direction as MarketRealityDirectionV1)
      ? (direction as MarketRealityDirectionV1)
      : 'sell',
    // An unmeasured size returns an empty board that reads as a broken page,
    // so a size the ladder does not carry falls back rather than being asked.
    requestedCashAtomic: MARKET_REALITY_SIZES_V1.some((rung) => rung.requestedCashAtomic === size)
      ? size!
      : STOCKS_CONSOLE_DEFAULT_SIZE_V1,
    destination: destination === 'ETH' ? 'ETH' : 'USDC',
    historyPeriod: MARKET_REALITY_HISTORY_PERIODS_V1.some((period) => period.key === historyPeriod)
      ? (historyPeriod as MarketRealityHistoryPeriodV1)
      : 'now',
  };
}

/** The question, as the query string spells it. One place, so a control and a
 * link cannot disagree about which parameter carries a size. */
function searchFromPatchV1(
  search: string,
  selectedKey: string | null,
  patch: Partial<StocksConsoleQuestionV1>,
): string {
  const params = new URLSearchParams(search);
  if (selectedKey) params.set('key', selectedKey);
  if (patch.underlyingKey) params.set('key', patch.underlyingKey);
  if (patch.direction) params.set('direction', patch.direction);
  if (patch.requestedCashAtomic) params.set('size', patch.requestedCashAtomic);
  if (patch.destination) params.set('destination', patch.destination);
  if (patch.surface) params.set('view', patch.surface);
  if (patch.historyPeriod) params.set('history', patch.historyPeriod);
  return params.toString();
}

export function MarketRealityPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('market');

  const question = useMemo(() => questionFromSearchV1(search), [search]);
  const enabled = status.data?.productMigration?.routeIntelligenceV1 === true;

  const stocks = useStocksConsoleV1({
    question,
    enabled,
    // `/status` is behind the tenant gate: signed out, every flag reads false.
    // Saying "switched off on this server" then is a claim we cannot support.
    configurationRead: status.isSuccess,
    onQuestion: (patch) =>
      navigate(`/market?${searchFromPatchV1(search, stocks.selectedKey, patch)}`),
    onInvestigate: (tokenAddress) => navigate(`/investigate?token=${tokenAddress}`),
    onOpenRadar: () => navigate('/radar'),
    onInspectRoute: ({ tokenAddress, goal, minimumVerification }) => {
      const params = new URLSearchParams({
        goal,
        from: 'stocks',
        token: tokenAddress,
        [VERIFICATION_FLOOR_PARAM_V1]: minimumVerification,
      });
      navigate(`/routes?${params.toString()}`);
    },
    // Phase 17.4 — the same surface, reached from the primary action. The goal
    // sentence already carries the side the reader pressed, so nothing here
    // has to re-derive it; `side` travels only so the destination can say which
    // button was pressed if it needs to.
    onPrepare: ({ tokenAddress, goal, direction, minimumVerification }) => {
      const params = new URLSearchParams({
        goal,
        from: 'stocks',
        token: tokenAddress,
        side: direction,
        // The floor travels in the URL because the goal does. It can only ask
        // the destination to check harder, so a link a stranger writes with it
        // is a link that gets MORE verification, never less.
        [VERIFICATION_FLOOR_PARAM_V1]: minimumVerification,
      });
      navigate(`/routes?${params.toString()}`);
    },
  });

  // Written into the URL once the chooser has loaded, so a refresh keeps the
  // security a reader is looking at instead of silently re-picking.
  useEffect(() => {
    if (question.underlyingKey || !stocks.selectedKey) return;
    const params = new URLSearchParams(search);
    params.set('key', stocks.selectedKey);
    navigate(`/market?${params.toString()}`, { replace: true });
  }, [stocks.selectedKey, question.underlyingKey, navigate, search]);

  return (
    <ConsoleShell
      header={{
        crumb: ['Stocks'],
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
        // What this page read: the representations on the board, never a
        // universe count.
        sourcesLabel: String(stocks.representationCount),
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
      <MarketRealityScreen model={stocks.model} />
    </ConsoleShell>
  );
}

export type { MarketRealitySurfaceV1 };
