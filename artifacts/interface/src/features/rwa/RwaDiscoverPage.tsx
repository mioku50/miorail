import { useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useAccount } from 'wagmi';
import {
  ConsoleShell,
  RwaDiscoverRail,
  RwaDiscoverScreen,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainUnavailableReasonV1,
  chainLabelV1,
  consoleSectionPathV1,
  lookalikeFeedViewV1,
  officialAssetsViewV1,
  signalFeedViewV1,
  useConsoleTheme,
  type LookalikeAliasFilterV1,
  type RwaDiscoverTabV1,
} from '@mioagent/ui';
import {
  useAddB20Watch,
  useRwaLookalikes,
  useRwaOfficialAssets,
  useRwaSignals,
  useStatus,
} from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';
import { useUiStore } from '../../lib/state';

// ---------------------------------------------------------------------------
// Phase 6 — Discover, and what it replaced.
//
// This page reads three endpoints and draws what they returned. It holds no
// clearance, prepares no plan and opens no wallet: "Investigate" hands an
// address to the Phase 7 dossier surface and "Find route" hands it to the goal
// flow, both of which already own those boundaries.
//
// The launch feed is not deleted. It moved to /opportunities/launches and is
// linked from the bottom of this page — it is still the deepest thing Miorail
// has measured, and it is no longer the first thing a reader meets, because a
// contract anybody can deploy is not an asset an issuer publishes.
// ---------------------------------------------------------------------------

const TABS_V1: readonly RwaDiscoverTabV1[] = ['official', 'signals', 'lookalikes'];

function shortAddressV1(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

function tabFromSearchV1(search: string): RwaDiscoverTabV1 {
  const value = new URLSearchParams(search).get('tab');
  return TABS_V1.includes(value as RwaDiscoverTabV1) ? (value as RwaDiscoverTabV1) : 'official';
}

/**
 * Why a read failed, in the reader's terms.
 *
 * Never the raw message: a server error can carry an endpoint and an endpoint
 * can carry a key. Every branch here also refuses to describe the assets —
 * the sentence is about our request, which is what it actually knows.
 */
function failureCopyV1(error: unknown, subject: string): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/\b404\b/.test(message) || message.includes('route_intelligence_disabled')) {
    return `This server does not serve ${subject} yet. The endpoint is part of a newer build than the one deployed here.`;
  }
  if (message.includes('authentication_required') || /\b401\b/.test(message)) {
    return 'Your session is not valid for this server, so nothing was read. Signing in again is the fix.';
  }
  if (message.includes('storage_unavailable')) {
    return `The evidence database did not answer, so ${subject} could not be read. Nothing here is a statement about the assets.`;
  }
  if (message.includes('invalid_type') || message.includes('unrecognized_keys')) {
    return `This server answered with a shape this build does not understand. The API and this interface are on different versions.`;
  }
  return `${subject} could not be read on this server. Nothing here is a statement about the assets.`;
}

export function RwaDiscoverPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('opportunities');

  const tab = useMemo(() => tabFromSearchV1(search), [search]);
  const [aliasFilter, setAliasFilter] = useState<LookalikeAliasFilterV1>('all');

  const showToast = useUiStore((state) => state.showToast);
  const enabled = status.data?.productMigration?.routeIntelligenceV1 === true;
  // The watchlist lives behind the B20 flag and its own migration, which is a
  // different switch from the one the corpus is behind. Offered only when the
  // server says it is there: a control that answers with a refusal is worse
  // than an absent one, because it looks like a broken product.
  const watchAvailable = status.data?.productMigration?.b20ControlV1 === true;
  const addWatch = useAddB20Watch({
    onSuccess: () => showToast('Added to your watchlist. The background sweep reads it from here.'),
    // Never the server's message: it can carry an endpoint, and an endpoint can
    // carry a key.
    onError: () => showToast('Miorail could not add this token to your watchlist.'),
  });
  const official = useRwaOfficialAssets({ enabled });
  // Only fetched when the tab is open. The Official tab is the default and the
  // other two cost a database read each; a reader who never opens them should
  // not pay for them.
  const lookalikes = useRwaLookalikes(
    { alias: aliasFilter === 'all' ? null : aliasFilter },
    { enabled: enabled && tab === 'lookalikes' },
  );
  const signals = useRwaSignals({ enabled: enabled && tab === 'signals' });

  // One clock for the whole render, so two ages on the same screen cannot be
  // computed a few milliseconds apart and disagree.
  const now = useMemo(
    () => new Date(),
    [official.dataUpdatedAt, lookalikes.dataUpdatedAt, signals.dataUpdatedAt],
  );

  const officialView = useMemo(
    () => (official.data ? officialAssetsViewV1(official.data, now) : null),
    [official.data, now],
  );
  const lookalikeView = useMemo(
    () => (lookalikes.data ? lookalikeFeedViewV1(lookalikes.data, now) : null),
    [lookalikes.data, now],
  );
  const signalView = useMemo(
    () => (signals.data ? signalFeedViewV1(signals.data, now) : null),
    [signals.data, now],
  );

  const disabledNotice = enabled
    ? null
    : 'Route intelligence is switched off on this server, so the official corpus is not being read. This says nothing about what is issued.';

  return (
    <ConsoleShell
      header={{
        crumb: ['Discover'],
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
        // What this page actually read, not a universe count. The old Discover
        // put 22,265 at the bottom of every screen, which is a number about
        // the index rather than about anything on the page.
        sourcesLabel: String(official.data?.assets.length ?? 0),
        spendLabel: '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      // Where the corpus's reading came from, and how far the ledger has been
      // read. `railFold` repeats it in the centre column on a narrow screen,
      // so a phone loses the layout and not the state.
      right={<RwaDiscoverRail view={officialView} />}
      railFold={<RwaDiscoverRail view={officialView} />}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => navigate(consoleSectionPathV1('routes'))}
      onSelectSession={() => navigate(consoleSectionPathV1('routes'))}
      onSelectProof={() => navigate(consoleSectionPathV1('activity'))}
    >
      <RwaDiscoverScreen
        model={{
          tab,
          onTab: (next) =>
            // The tab lives in the URL so a refresh and a Back press both
            // restore it, and a link to Lookalikes opens Lookalikes.
            navigate(next === 'official' ? '/opportunities' : `/opportunities?tab=${next}`),

          official: officialView,
          officialLoading: official.isLoading,
          officialError:
            disabledNotice ??
            (official.error ? failureCopyV1(official.error, 'the official corpus') : null),

          lookalikes: lookalikeView,
          lookalikesLoading: lookalikes.isLoading,
          lookalikesError:
            disabledNotice ??
            (lookalikes.error ? failureCopyV1(lookalikes.error, 'the lookalike index') : null),
          aliasFilter,
          onAliasFilter: setAliasFilter,

          signals: signalView,
          signalsLoading: signals.isLoading,
          signalsError:
            disabledNotice ?? (signals.error ? failureCopyV1(signals.error, 'recorded changes') : null),

          actions: {
            onInvestigate: (tokenAddress) => navigate(`/investigate?token=${tokenAddress}`),
            onFindRoute: (tokenAddress) => navigate(`/routes?token=${tokenAddress}`),
            ...(watchAvailable
              ? { onWatch: (tokenAddress: string) => addWatch.mutate({ tokenAddress }) }
              : {}),
          },
          launchFeedHref: '/opportunities/launches',
        }}
      />
    </ConsoleShell>
  );
}
