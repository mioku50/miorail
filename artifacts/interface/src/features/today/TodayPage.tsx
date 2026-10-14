import { useLocation } from 'wouter';
import { useAccount } from 'wagmi';
import {
  ConsoleShell,
  TodayScreen,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  chainUnavailableReasonV1,
  consoleSectionPathV1,
  useConsoleTheme,
  useTodayConsoleV1,
} from '@mioagent/ui';
import { useStatus } from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';
import { useAuthGate } from '../../app/AuthProvider';

function shortAddressV1(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

// ---------------------------------------------------------------------------
// Today, on the web: the shared reads, and where each question goes by path.
// ---------------------------------------------------------------------------

export function TodayPage() {
  const [location, navigate] = useLocation();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const gate = useAuthGate();
  const nav = useConsoleNav('today');
  const signedIn = gate.showPrivateSurfaces;
  const signIn = () => navigate(`/signin?next=${encodeURIComponent(location)}`);
  const askWallet = (question: string) =>
    navigate(`${consoleSectionPathV1('extensions')}?ask=${encodeURIComponent(question)}`);
  const investigate = (tokenAddress: string) =>
    // A reader with no session gets the public answer to the same question.
    navigate(signedIn ? `/investigate?token=${tokenAddress}` : `/is-it-real/${tokenAddress}`);
  const openStock = (symbol: string) => navigate(`/stocks/${symbol.toLowerCase()}`);

  const model = useTodayConsoleV1({
    signedIn,
    address: address ?? null,
    stocksOn: status.data?.productMigration?.routeIntelligenceV1 === true,
    b20On: status.data?.productMigration?.b20ControlV1 === true,
    actions: {
      onRoute: (route) => {
        if (route.kind === 'investigate') return investigate(route.tokenAddress);
        if (route.kind === 'stock') return openStock(route.symbol);
        if (!signedIn) return signIn();
        if (route.kind === 'wallet') return askWallet(route.question);
        // Filled into Swap AI's box and left there: a `?goal=` is never run
        // for the reader, who presses Compare themselves.
        navigate(`${consoleSectionPathV1('routes')}?goal=${encodeURIComponent(route.goal)}`);
      },
      onInvestigate: investigate,
      onOpenRadar: () => navigate(consoleSectionPathV1('radar')),
      onOpenB20: () => navigate(consoleSectionPathV1('portfolio')),
      onAskWallet: askWallet,
      onOpenStock: openStock,
      onOpenDividends: () => navigate('/stocks/dividends'),
      onSignIn: signIn,
    },
  });

  return (
    <ConsoleShell
      header={{
        crumb: ['Today'],
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
        sourcesLabel: '—',
        spendLabel: '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      // No right rail: Today is one column of answers, like the Stocks board.
      right={null}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => navigate(consoleSectionPathV1('routes'))}
      onSelectSession={() => navigate(consoleSectionPathV1('routes'))}
      onSelectProof={() => navigate(consoleSectionPathV1('activity'))}
    >
      <TodayScreen model={model} />
    </ConsoleShell>
  );
}
