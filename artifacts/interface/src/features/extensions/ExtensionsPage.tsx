import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  BaseMcpExtensionsCard,
  ConsoleShell,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  consoleSectionPathV1,
  useConsoleTheme,
  type BaseMcpToolRowV1,
} from '@mioagent/ui';
import { useAccount } from 'wagmi';
import { useBaseMcpToolsProbe, useStatus } from '@mioagent/api-client-react';

import { BaseMcpConnectButton } from '../../components/BaseMcpConnectButton';
import { useConsoleNav } from '../console/useConsoleNav';

// ---------------------------------------------------------------------------
// Extensions — the Base MCP plugin catalogue.
//
// Read and classify, nothing else. The probe is a MUTATION rather than a query
// on purpose: it opens an authenticated session to a third-party server, and
// that is not something a page should do on mount, on focus, or on a timer.
// The user asks; then it reads.
// ---------------------------------------------------------------------------

/** `0x1234…abcd`, or nothing when no wallet is connected. */
function shortAddress(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

export function ExtensionsPage() {
  const [, navigate] = useLocation();
  const consoleNav = useConsoleNav('extensions');
  const { theme, setTheme } = useConsoleTheme();
  const { address } = useAccount();
  const status = useStatus();
  const probe = useBaseMcpToolsProbe();

  const enabled = status.data?.baseMcp?.enabled === true;
  const [askedOnce, setAskedOnce] = useState(false);

  const readCatalogue = useCallback(() => {
    if (!enabled) return;
    setAskedOnce(true);
    probe.mutate();
  }, [enabled, probe]);

  // One read when the surface opens and the server says the feature is on.
  // Not a poll: every call is a round trip to somebody else's server with the
  // user's credentials attached.
  useEffect(() => {
    if (enabled && !askedOnce) readCatalogue();
  }, [enabled, askedOnce, readCatalogue]);

  const model = {
    enabled,
    loading: probe.isPending,
    status: probe.data?.status ?? null,
    endpointHost: probe.data?.endpointHost ?? null,
    tools: (probe.data?.tools ?? []) as readonly BaseMcpToolRowV1[],
    unavailableReason: probe.error
      // Never the error's own message: a transport failure can carry the
      // endpoint, and the endpoint can carry a token.
      ? 'The plugin catalogue could not be read. Nothing here is a statement about which plugins exist.'
      : null,
    onRefresh: readCatalogue,
  };

  return (
    <ConsoleShell
      header={{
        crumb: ['Extensions'],
        nav: consoleNav.header,
        onNavigate: consoleNav.navigate,
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: Boolean(address) && status.data?.rpc?.status === 'connected',
        walletLabel: shortAddress(address),
      }}
      left={{
        nav: consoleNav.rail,
        sessions: [],
        sessionCount: '0',
        proofs: [],
        proofCount: '0',
        onOpenSettings: () => consoleNav.navigate('settings'),
      }}
      footer={{
        adaptersLabel: '—',
        sourcesLabel: String(probe.data?.toolsCount ?? 0),
        spendLabel: '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      // The catalogue IS the content, so the rail carries nothing rather than
      // repeating it in a narrower column.
      right={null}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => navigate(consoleSectionPathV1('routes'))}
      onSelectSession={() => navigate(consoleSectionPathV1('routes'))}
      onSelectProof={() => navigate(consoleSectionPathV1('proofs'))}
    >
      <BaseMcpExtensionsCard {...model} />
      {enabled && (
        // The connect control is its own component because OAuth must open
        // synchronously from the click to keep `window.opener` — Base Account
        // requires it, and an embedded Base App must not navigate its own
        // frame to keys.coinbase.com.
        <div className="ctarow">
          <BaseMcpConnectButton className="btn" returnTo={consoleSectionPathV1('extensions')}>
            {probe.data?.status === 'connected' ? 'Reconnect Base Account' : 'Connect Base Account'}
          </BaseMcpConnectButton>
        </div>
      )}
    </ConsoleShell>
  );
}
