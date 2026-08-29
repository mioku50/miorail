import { useMemo } from 'react';
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
  marketRealityRadarViewV1,
  underlyingChoicesV1,
  useConsoleTheme,
} from '@mioagent/ui';
import {
  useMarketRealityRadar,
  useRemoveMarketRealityRadarWatch,
  useRwaUnderlyings,
  useStatus,
} from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';

function shortAddressV1(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

function failureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('authentication_required') || /\b401\b/.test(message)) {
    return 'Your session is not valid for this server, so no watches were read.';
  }
  if (message.includes('storage_unavailable')) {
    return 'The evidence database did not answer. No market state is inferred from that failure.';
  }
  return 'Radar could not be read on this server. Nothing here is a statement about a watched market.';
}

export function MarketRealityRadarPage() {
  const [, navigate] = useLocation();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('radar');
  const enabled = status.data?.productMigration?.routeIntelligenceV1 === true;
  const index = useRwaUnderlyings({ enabled });
  const radar = useMarketRealityRadar({ enabled });
  const remove = useRemoveMarketRealityRadarWatch();
  const choices = useMemo(() => underlyingChoicesV1(index.data ?? null), [index.data]);
  const nowIso = useMemo(
    () => new Date().toISOString(),
    [radar.dataUpdatedAt, index.dataUpdatedAt],
  );
  const view = useMemo(
    () =>
      marketRealityRadarViewV1({
        wire: radar.data ?? null,
        choices,
        now: radar.data?.assembledAt ?? nowIso,
      }),
    [radar.data, choices, nowIso],
  );

  const openMarket = (watchId: string) => {
    const watch = radar.data?.watches.find((row) => row.watchId === watchId);
    if (!watch) return;
    const query = new URLSearchParams({
      key: watch.underlyingKey,
      direction: watch.direction,
      size: watch.requestedCashAtomic,
      destination: watch.destination,
    });
    navigate(`/market?${query.toString()}`);
  };

  const disabledNotice = enabled
    ? null
    : 'Route intelligence is switched off on this server, so Radar is not reading watches.';

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
        sourcesLabel: String(radar.data?.watches.length ?? 0),
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
      <MarketRealityRadarScreen
        model={{
          view,
          loading: radar.isLoading,
          error:
            disabledNotice ??
            (radar.error ? failureCopyV1(radar.error) : remove.error ? failureCopyV1(remove.error) : null),
          removingWatchId: remove.isPending ? (remove.variables?.watchId ?? null) : null,
          onRemove: (watchId) => remove.mutate({ watchId }),
          onOpenMarket: openMarket,
        }}
      />
    </ConsoleShell>
  );
}
