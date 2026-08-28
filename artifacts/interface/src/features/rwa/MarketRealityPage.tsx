import { useEffect, useMemo } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useAccount } from 'wagmi';
import {
  ConsoleShell,
  MARKET_REALITY_DIRECTIONS_V1,
  MARKET_REALITY_SIZES_V1,
  MarketRealityScreen,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  chainUnavailableReasonV1,
  consoleSectionPathV1,
  marketRealityViewV1,
  underlyingChoicesV1,
  underlyingCountersV1,
  useConsoleTheme,
  type MarketRealityDirectionV1,
  type MarketRealitySurfaceV1,
} from '@mioagent/ui';
import {
  useMeasureRwaMarketReality,
  useRwaMarketReality,
  useRwaUnderlyings,
  useStatus,
} from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';

// ---------------------------------------------------------------------------
// Phase 10B — Market Reality.
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
// This page holds no clearance, prepares no plan and opens no wallet.
// ---------------------------------------------------------------------------

const DEFAULT_SIZE_V1 = MARKET_REALITY_SIZES_V1[1]!.requestedCashAtomic;

function shortAddressV1(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

/**
 * Why a read failed, in the reader's terms.
 *
 * Never the raw message: a server error can carry an endpoint and an endpoint
 * can carry a key. Every branch refuses to describe the securities — the
 * sentence is about our request, which is what it actually knows.
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
    return `The evidence database did not answer, so ${subject} could not be read. Nothing here is a statement about the securities.`;
  }
  if (message.includes('invalid_type') || message.includes('unrecognized_keys')) {
    return 'This server answered with a shape this build does not understand. The API and this interface are on different versions.';
  }
  return `${subject} could not be read on this server. Nothing here is a statement about the securities.`;
}

function questionFromSearchV1(search: string): {
  underlyingKey: string | null;
  direction: MarketRealityDirectionV1;
  requestedCashAtomic: string;
  surface: MarketRealitySurfaceV1;
} {
  const params = new URLSearchParams(search);
  const direction = params.get('direction');
  const size = params.get('size');
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
      : DEFAULT_SIZE_V1,
  };
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

  const index = useRwaUnderlyings({ enabled });
  const choices = useMemo(() => underlyingChoicesV1(index.data ?? null), [index.data]);
  const counters = useMemo(() => underlyingCountersV1(index.data ?? null), [index.data]);

  // The first security that can actually be COMPARED, falling back to the
  // first the graph has at all. Landing on a single-representation security
  // would open the page on a board with one card and nothing to weigh it
  // against, which is the one thing this surface is for.
  const defaultKey = useMemo(
    () =>
      choices.find((choice) => choice.multiIssuer)?.underlyingKey ??
      choices[0]?.underlyingKey ??
      null,
    [choices],
  );
  const selectedKey = question.underlyingKey ?? defaultKey;

  // Written into the URL once the chooser has loaded, so a refresh keeps the
  // security a reader is looking at instead of silently re-picking.
  useEffect(() => {
    if (question.underlyingKey || !defaultKey) return;
    const params = new URLSearchParams(search);
    params.set('key', defaultKey);
    navigate(`/market?${params.toString()}`, { replace: true });
  }, [defaultKey, question.underlyingKey, navigate, search]);

  const reality = useRwaMarketReality(
    {
      underlyingKey: selectedKey,
      direction: question.direction,
      requestedCashAtomic: question.requestedCashAtomic,
    },
    { enabled },
  );

  // One clock for the whole render, so two ages on the same screen cannot be
  // computed a few milliseconds apart and disagree.
  const nowIso = useMemo(
    () => new Date().toISOString(),
    [reality.dataUpdatedAt, index.dataUpdatedAt],
  );

  const view = useMemo(
    () =>
      marketRealityViewV1({
        wire: reality.data ?? null,
        choice: choices.find((choice) => choice.underlyingKey === selectedKey) ?? null,
        now: nowIso,
      }),
    [reality.data, choices, selectedKey, nowIso],
  );

  const measure = useMeasureRwaMarketReality();

  /**
   * What the measurement spent, in a reader's words.
   *
   * "Nothing needed measuring" is the honest answer when every representation
   * was already inside its quote window, and a button that silently did nothing
   * reads as a button that does not work.
   */
  const measurementNote = useMemo(() => {
    const spent = measure.data?.measurement;
    if (!spent) return null;
    const parts: string[] = [];
    if (spent.measured.length > 0) {
      parts.push(
        `${spent.measured.length} representation${spent.measured.length === 1 ? '' : 's'} measured just now`,
      );
    }
    if (spent.reusedOpen.length > 0) {
      parts.push(`${spent.reusedOpen.length} already had an open quote`);
    }
    if (spent.reusedCooldown.length > 0) {
      parts.push(`${spent.reusedCooldown.length} measured moments ago`);
    }
    if (spent.excludedZeroSupply.length > 0) {
      parts.push(
        `${spent.excludedZeroSupply.length} zero-supply representation${spent.excludedZeroSupply.length === 1 ? '' : 's'} kept visible without a router call`,
      );
    }
    for (const row of spent.unresolved) {
      parts.push(`${row.tokenAddress.slice(0, 8)}… could not be measured (${row.reason})`);
    }
    if (parts.length === 0) return 'Nothing needed measuring.';
    return `${parts.join(' · ')}.${spent.joinedInFlight ? ' Shared with a measurement already running.' : ''}`;
  }, [measure.data]);

  const setQuestion = (patch: Record<string, string>) => {
    const params = new URLSearchParams(search);
    if (selectedKey) params.set('key', selectedKey);
    for (const [key, value] of Object.entries(patch)) params.set(key, value);
    navigate(`/market?${params.toString()}`);
  };

  const disabledNotice = enabled
    ? null
    : 'Route intelligence is switched off on this server, so no representation is being read. This says nothing about what is issued.';

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
        sourcesLabel: String(reality.data?.representations.length ?? 0),
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
      <MarketRealityScreen
        model={{
          choices,
          choicesLoading: index.isLoading,
          choicesError:
            disabledNotice ??
            (index.error ? failureCopyV1(index.error, 'the reviewed securities') : null),
          counters,

          selectedKey,
          direction: question.direction,
          requestedCashAtomic: question.requestedCashAtomic,
          surface: question.surface,

          view,
          viewLoading: reality.isLoading,
          viewError:
            disabledNotice ??
            (reality.error ? failureCopyV1(reality.error, 'this comparison') : null),

          measuring: measure.isPending,
          measurementNote,
          measurementError: measure.error ? failureCopyV1(measure.error, 'this measurement') : null,

          actions: {
            onUnderlying: (underlyingKey) => setQuestion({ key: underlyingKey }),
            ...(enabled && selectedKey
              ? {
                  onMeasure: () =>
                    measure.mutate({
                      underlyingKey: selectedKey,
                      direction: question.direction,
                      requestedCashAtomic: question.requestedCashAtomic,
                    }),
                }
              : {}),
            onDirection: (direction) => setQuestion({ direction }),
            onSize: (requestedCashAtomic) => setQuestion({ size: requestedCashAtomic }),
            onSurface: (surface) => setQuestion({ view: surface }),
            onInvestigate: (tokenAddress) => navigate(`/investigate?token=${tokenAddress}`),
          },
        }}
      />
    </ConsoleShell>
  );
}
