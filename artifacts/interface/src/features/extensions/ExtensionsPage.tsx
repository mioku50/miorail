import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  BaseMcpConsoleCard,
  BaseMcpExtensionsCard,
  BaseMcpPluginsCard,
  BaseMcpSummaryRail,
  ConsoleShell,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  consoleSectionPathV1,
  useConsoleTheme,
  type BaseMcpToolRowV1,
} from '@mioagent/ui';
import { useAccount } from 'wagmi';
import { useBaseMcpConsole, useBaseMcpPlugins, useBaseMcpToolsProbe, useStatus } from '@mioagent/api-client-react';

import { BaseMcpConnectButton } from '../../components/BaseMcpConnectButton';
import { useConsoleNav } from '../console/useConsoleNav';

// ---------------------------------------------------------------------------
// Extensions — Base MCP, in its two layers.
//
//   * The PLUGINS: twenty specifications Base publishes, each a protocol with
//     its own hosts, auth and risks. Public knowledge, so the card renders
//     whether or not this browser has ever connected — the page used to go
//     blank the moment a session expired, which is how a user ends up looking
//     at a screen about Base MCP that mentions no plugin at all.
//
//   * The TOOLS: the calls mcp.base.org itself exposes, read live with the
//     user's own credentials.
//
// Read and classify, nothing else. The tool probe is a MUTATION rather than a
// query on purpose: it opens an authenticated session to a third-party server,
// and that is not something a page should do on mount, on focus, or on a
// timer. The user asks; then it reads. The plugin catalogue has no such cost,
// so it is an ordinary query.
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
  const catalogue = useBaseMcpPlugins();
  const consoleAsk = useBaseMcpConsole();
  const [question, setQuestion] = useState('');

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
      ? 'The tool catalogue could not be read. Nothing here is a statement about which tools exist.'
      : null,
    onRefresh: readCatalogue,
  };

  const plugins = {
    loading: catalogue.isPending,
    plugins: catalogue.data?.plugins ?? [],
    drift: catalogue.data?.drift ?? null,
    generatedAt: catalogue.data?.generatedAt ?? null,
    unavailableReason: catalogue.error
      ? 'The plugin catalogue could not be read from this server.'
      : null,
  };

  return (
    <ConsoleShell
      header={{
        crumb: ['Base MCP AI'],
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
        // The catalogue, not the session: this stays truthful when the Base
        // MCP token has expired and the tool count is legitimately zero.
        sourcesLabel: String(plugins.plugins.length),
        spendLabel: '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      // Not a repeat of the main column: counts and connection state, which is
      // what a reader wants while scrolling twenty plugins. All of it is
      // already loaded, so the rail costs no request.
      right={
        <BaseMcpSummaryRail
          connection={probe.data?.status ?? null}
          enabled={enabled}
          endpointHost={probe.data?.endpointHost ?? null}
          toolCounts={
            probe.data
              ? {
                  readOnly: probe.data.capabilities.readOnly,
                  userConfirmed: probe.data.capabilities.userConfirmedTransaction,
                  forbidden: probe.data.capabilities.forbidden,
                  unknown: probe.data.capabilities.unknown,
                }
              : null
          }
          plugins={plugins.plugins}
          drift={plugins.drift}
          generatedAt={plugins.generatedAt}
        />
      }
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => navigate(consoleSectionPathV1('routes'))}
      onSelectSession={() => navigate(consoleSectionPathV1('routes'))}
      onSelectProof={() => navigate(consoleSectionPathV1('activity'))}
    >
      {enabled && (
        // FIRST, because it is the only thing on this page you DO. It sat
        // below a twenty-row catalogue, so the one interactive control on the
        // surface was the one you had to scroll past everything to reach.
        //
        // Kept out of Routes on purpose: our routers are measured and carry a
        // Route Card, these tools are other people's and carry whatever they
        // returned. One window for both was one voice for two guarantees.
        <BaseMcpConsoleCard
          question={question}
          onQuestionChange={setQuestion}
          onAsk={() => {
            const message = question.trim();
            if (message) consoleAsk.mutate(message);
          }}
          pending={consoleAsk.isPending}
          answer={consoleAsk.data ?? null}
          unavailableReason={
            consoleAsk.error
              // Never the error's own message: a transport failure can carry
              // the endpoint, and the endpoint can carry a token.
              ? 'The console could not reach the server. Nothing here is a statement about Base MCP.'
              : null
          }
        />
      )}
      {/* Reference, below the thing you act with. */}
      <BaseMcpPluginsCard {...plugins} />
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
