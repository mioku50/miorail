import { useEffect, useMemo } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useAccount } from 'wagmi';
import {
  ConsoleShell,
  MARKET_REALITY_DIRECTIONS_V1,
  MARKET_REALITY_SIZES_V1,
  MarketRealityScreen,
  comparableMarketHistoryViewV1,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  chainUnavailableReasonV1,
  consoleSectionPathV1,
  cashExitLadderRungsV1,
  marketRealityViewV1,
  MARKET_REALITY_HISTORY_PERIODS_V1,
  underlyingChoicesV1,
  underlyingCountersV1,
  useConsoleTheme,
  type MarketRealityDirectionV1,
  type MarketRealityHistoryPeriodV1,
  type MarketRealitySurfaceV1,
} from '@mioagent/ui';
import {
  useAddMarketRealityRadarWatch,
  useAskRwaMarketReality,
  useMarketRealityRadar,
  useRemoveMarketRealityRadarWatch,
  useMeasureRwaMarketReality,
  useOfficialAssetDossier,
  useRwaMarketReality,
  useRwaMarketRealityHistory,
  useRwaUnderlyings,
  useStatus,
} from '@mioagent/api-client-react';
import {
  stockExecutionGoalSentenceV1,
  stockExecutionHandoffV1,
} from '@mioagent/rwa-market-reality/execution-handoff';
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
  destination: 'USDC' | 'ETH';
  surface: MarketRealitySurfaceV1;
  historyPeriod: MarketRealityHistoryPeriodV1;
} {
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
      : DEFAULT_SIZE_V1,
    destination: destination === 'ETH' ? 'ETH' : 'USDC',
    historyPeriod: MARKET_REALITY_HISTORY_PERIODS_V1.some((period) => period.key === historyPeriod)
      ? (historyPeriod as MarketRealityHistoryPeriodV1)
      : 'now',
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
      destination: question.destination,
    },
    { enabled },
  );
  const history = useRwaMarketRealityHistory(
    {
      underlyingKey: selectedKey,
      direction: question.direction,
      requestedCashAtomic: question.requestedCashAtomic,
      destination: question.destination,
      // One lazy seven-day read supplies all four historical targets. The view
      // selects the nearest exact captured point and never interpolates it.
      window: '7d',
    },
    {
      enabled: enabled && question.surface === 'market' && question.historyPeriod !== 'now',
    },
  );
  const radar = useMarketRealityRadar({ enabled });
  const addWatch = useAddMarketRealityRadarWatch();
  const removeWatch = useRemoveMarketRealityRadarWatch();

  const watchIdByTokenAddress = useMemo(() => {
    const representationByAddress = new Map(
      (reality.data?.representations ?? []).map((representation) => [
        representation.tokenAddress,
        representation,
      ]),
    );
    return new Map(
      (radar.data?.watches ?? [])
        .filter((watch) => {
          if (
            watch.underlyingKey !== selectedKey ||
            watch.direction !== question.direction ||
            watch.requestedCashAtomic !== question.requestedCashAtomic ||
            watch.destination !== question.destination
          ) {
            return false;
          }
          const representation = representationByAddress.get(watch.tokenAddress);
          if (!representation || representation.routePolicyKey !== watch.routePolicyKey) {
            return false;
          }
          const sources = [...new Set(representation.sources.map((row) => row.source))].sort();
          return sources.join('\u0000') === [...watch.approvedSources].sort().join('\u0000');
        })
        .map((watch) => [watch.tokenAddress, watch.watchId] as const),
    );
  }, [
    radar.data,
    reality.data,
    selectedKey,
    question.direction,
    question.requestedCashAtomic,
    question.destination,
  ]);
  const watchedTokenAddresses = useMemo(
    () => [...watchIdByTokenAddress.keys()],
    [watchIdByTokenAddress],
  );

  // One clock for the whole render, so two ages on the same screen cannot be
  // computed a few milliseconds apart and disagree.
  const nowIso = useMemo(
    () => new Date().toISOString(),
    [reality.dataUpdatedAt, history.dataUpdatedAt, index.dataUpdatedAt],
  );

  // Phase 13.2 — Ask Miorail.
  //
  // The mutation carries the question the page is ALREADY showing, so an
  // answer can only be about what the reader is looking at. Nothing is cached:
  // the same words asked twice against a market that moved are two different
  // answers.
  const ask = useAskRwaMarketReality();

  // ---------------------------------------------------------------------------
  // The round-trip ladder, per representation.
  //
  // Market Reality answers ONE exact question — one size, one direction — and
  // that is the right shape for comparing issuers. It is the wrong shape for
  // the reader's first question, which is what this costs at the size they
  // actually hold. Discover has answered that all along out of the stored
  // cash-exit run; this reads the same run, through the dossier, for each
  // exact address on the page.
  //
  // Three fixed hooks rather than a loop, because a hook cannot be called
  // conditionally. Three is the reviewed maximum for one security today
  // (Coinbase, Backed, and Backed's wrapper); a fourth shows no ladder rather
  // than a wrong one, and the count is asserted in the UI test.
  // ---------------------------------------------------------------------------
  const representationAddresses = useMemo(
    () => (reality.data?.representations ?? []).map((row) => row.tokenAddress),
    [reality.data],
  );
  const dossierA = useOfficialAssetDossier(representationAddresses[0] ?? null);
  const dossierB = useOfficialAssetDossier(representationAddresses[1] ?? null);
  const dossierC = useOfficialAssetDossier(representationAddresses[2] ?? null);

  const ladders = useMemo(() => {
    const built: Record<
      string,
      { rungs: ReturnType<typeof cashExitLadderRungsV1>; note: string | null }
    > = {};
    for (const response of [dossierA.data, dossierB.data, dossierC.data]) {
      // `not_in_reviewed_corpus` is a legible answer, not an error. It simply
      // has no ladder to show.
      if (!response || response.outcome !== 'dossier') continue;
      const ladder = response.dossier.cashExitLadder;
      const rungs = cashExitLadderRungsV1(ladder.rungs);
      if (rungs.length === 0) continue;
      built[response.dossier.tokenAddress.toLowerCase()] = {
        rungs,
        note: `Exact sizes only, quoted through ${
          ladder.approvedSources.join(', ') || 'no approved router'
        }. Nothing here was executed.`,
      };
    }
    return built;
  }, [dossierA.data, dossierB.data, dossierC.data]);

  const view = useMemo(
    () =>
      marketRealityViewV1({
        wire: reality.data ?? null,
        choice: choices.find((choice) => choice.underlyingKey === selectedKey) ?? null,
        now: nowIso,
        ladders,
      }),
    [reality.data, choices, selectedKey, nowIso, ladders],
  );

  const historyView = useMemo(
    () =>
      question.historyPeriod === 'now'
        ? null
        : comparableMarketHistoryViewV1({
            wire: reality.data ?? null,
            history: history.data ?? null,
            period: question.historyPeriod,
            // The API stamps the read. Use that clock for target selection so
            // a skewed browser clock cannot move an observation into a slot.
            now: history.data?.assembledAt ?? nowIso,
          }),
    [question.historyPeriod, reality.data, history.data, nowIso],
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
          historyPeriod: question.historyPeriod,

          view,
          viewLoading: reality.isLoading,
          viewError:
            disabledNotice ??
            (reality.error ? failureCopyV1(reality.error, 'this comparison') : null),
          history: historyView,
          historyLoading: history.isLoading,
          historyError:
            disabledNotice ??
            (history.error ? failureCopyV1(history.error, 'comparable history') : null),

          measuring: measure.isPending,
          measurementNote,
          measurementError: measure.error ? failureCopyV1(measure.error, 'this measurement') : null,
          watchedTokenAddresses,
          watchingTokenAddress: addWatch.isPending
            ? (addWatch.variables?.tokenAddress ?? null)
            : null,
          removingWatchTokenAddress: removeWatch.isPending
            ? ([...watchIdByTokenAddress.entries()].find(
                ([, watchId]) => watchId === removeWatch.variables?.watchId,
              )?.[0] ?? null)
            : null,
          inspectRouteUnavailable: Object.fromEntries(
            (reality.data?.representations ?? []).flatMap((representation) => {
              if (!reality.data) return [];
              const built = stockExecutionHandoffV1({
                response: reality.data as never,
                tokenAddress: representation.tokenAddress,
                now: new Date(),
              });
              return built.status === 'refused'
                ? [[representation.tokenAddress, built.detail] as const]
                : [];
            }),
          ),
          watchError:
            addWatch.error || removeWatch.error
              ? failureCopyV1(addWatch.error ?? removeWatch.error, 'this exact watch')
              : null,

          // Phase 13.2. Offered only once a security is chosen and the surface
          // is enabled: an answer needs a question to be about.
          ask: {
            answer: ask.data ?? null,
            asking: ask.isPending,
            error: ask.error ? failureCopyV1(ask.error, 'this question') : null,
            available: Boolean(enabled && selectedKey),
          },

          actions: {
            onUnderlying: (underlyingKey) => setQuestion({ key: underlyingKey }),
            ...(enabled && selectedKey
              ? {
                  onMeasure: () =>
                    measure.mutate({
                      underlyingKey: selectedKey,
                      direction: question.direction,
                      requestedCashAtomic: question.requestedCashAtomic,
                      destination: question.destination,
                    }),
                }
              : {}),
            ...(enabled && selectedKey
              ? {
                  // The question on screen travels with the words asked, so an
                  // answer can never be about a size the reader is not looking
                  // at. The server echoes both back and the screen renders the
                  // echo.
                  onAsk: (asked: string) =>
                    ask.mutate({
                      underlyingKey: selectedKey,
                      direction: question.direction,
                      requestedCashAtomic: question.requestedCashAtomic,
                      destination: question.destination,
                      question: asked,
                    }),
                }
              : {}),
            onDirection: (direction) => setQuestion({ direction }),
            onSize: (requestedCashAtomic) => setQuestion({ size: requestedCashAtomic }),
            onSurface: (surface) => setQuestion({ view: surface }),
            onHistoryPeriod: (historyPeriod) => setQuestion({ history: historyPeriod }),
            onInvestigate: (tokenAddress) => navigate(`/investigate?token=${tokenAddress}`),
            onOpenRadar: () => navigate('/radar'),
            // Phase 13.1. The handoff is built HERE, from the exact typed
            // answer this page is rendering, and it carries an address — never
            // a ticker. Navigation prefills the advanced surface and submits
            // nothing: opening a route inspection is not approval.
            ...(reality.data
              ? {
                  onInspectRoute: (tokenAddress: string) => {
                    const built = stockExecutionHandoffV1({
                      response: reality.data as never,
                      tokenAddress,
                      now: new Date(),
                    });
                    if (built.status !== 'ready') return;
                    const params = new URLSearchParams({
                      goal: stockExecutionGoalSentenceV1(built.handoff),
                      from: 'stocks',
                      token: built.handoff.tokenAddress,
                    });
                    navigate(`/routes?${params.toString()}`);
                  },
                }
              : {}),
            ...(enabled && selectedKey
              ? {
                  onWatch: (tokenAddress: string) => {
                    const representation = reality.data?.representations.find(
                      (row) => row.tokenAddress === tokenAddress,
                    );
                    if (
                      !representation ||
                      representation.supply.state !== 'positive_supply' ||
                      representation.routePolicyKey === null
                    ) {
                      return;
                    }
                    const approvedSources = [
                      ...new Set(representation.sources.map((source) => source.source)),
                    ].sort();
                    if (approvedSources.length === 0) return;
                    addWatch.mutate({
                      underlyingKey: selectedKey,
                      tokenAddress,
                      direction: question.direction,
                      requestedCashAtomic: question.requestedCashAtomic,
                      destination: question.destination,
                      routePolicyKey: representation.routePolicyKey,
                      approvedSources,
                    });
                  },
                  onUnwatch: (tokenAddress: string) => {
                    const watchId = watchIdByTokenAddress.get(tokenAddress);
                    if (watchId) removeWatch.mutate({ watchId });
                  },
                }
              : {}),
          },
        }}
      />
    </ConsoleShell>
  );
}
