import { useLocation } from 'wouter';
import { useAccount } from 'wagmi';
import {
  ConsoleShell,
  MarketRealityRadarScreen,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  chainUnavailableReasonV1,
  consoleSectionPathV1,
  useConsoleTheme,
  useRadarConsoleV1,
} from '@mioagent/ui';
import { useStatus } from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';

// Phase 12.2 — Radar, on the web. Phase 15.1 moved the reads and the view into
// `useRadarConsoleV1`, which the Base App mounts too; a URL, a shell and a
// header are what is left that is genuinely the web's.

function shortAddressV1(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

export function MarketRealityRadarPage() {
  const [, navigate] = useLocation();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('radar');
  const enabled = status.data?.productMigration?.routeIntelligenceV1 === true;

  const radar = useRadarConsoleV1({
    enabled,
    configurationRead: status.isSuccess,
    onOpenMarket: (question) => {
      const query = new URLSearchParams({
        key: question.underlyingKey ?? '',
        direction: question.direction,
        size: question.requestedCashAtomic,
        destination: question.destination,
      });
      navigate(`/market?${query.toString()}`);
    },
  });

  return (
    <ConsoleShell
      header={{
        crumb: ['Radar'],
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
        sourcesLabel: String(radar.watchCount),
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
      <MarketRealityRadarScreen model={radar.model} />
    </ConsoleShell>
  );
}
