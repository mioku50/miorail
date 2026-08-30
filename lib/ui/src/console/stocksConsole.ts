import { useMemo } from 'react';
import {
  useAddMarketRealityRadarWatch,
  useAskRwaMarketReality,
  useMarketRealityRadar,
  useMeasureRwaMarketReality,
  useOfficialAssetDossier,
  useRemoveMarketRealityRadarWatch,
  useRwaMarketReality,
  useRwaMarketRealityHistory,
  useRwaUnderlyings,
} from '@mioagent/api-client-react';
import {
  stockExecutionGoalSentenceV1,
  stockExecutionHandoffV1,
} from '@mioagent/rwa-market-reality/execution-handoff';

import { cashExitLadderRungsV1 } from './rwaDiscoverView';
import {
  MARKET_REALITY_SIZES_V1,
  marketRealityViewV1,
  quoteAgeLabelV1,
  underlyingChoicesV1,
  underlyingCountersV1,
  type MarketRealityDirectionV1,
} from './marketRealityView';
import {
  comparableMarketHistoryViewV1,
  type MarketRealityHistoryPeriodV1,
} from './marketRealityHistoryView';
import { marketRealityRadarViewV1 } from './marketRealityRadarView';
import type { MarketRealityRadarScreenModelV1 } from './MarketRealityRadarScreen';
import type { MarketRealityScreenModelV1, MarketRealitySurfaceV1 } from './MarketRealityScreen';

// ---------------------------------------------------------------------------
// Phase 15.1 — the Stocks console, once, for both surfaces.
//
// The web page held all of this and the Base App held none of it, so the
// MiniApp's tab bar was the product Miorail used to be. Porting the page would
// have produced a second copy of the reads, the watch matching, the ladder and
// the handoff — four places for the two surfaces to disagree about what a
// measurement means.
//
// What lives here is everything between the question and the screen model.
// What does NOT live here is routing and layout: the caller owns where the
// question is stored (a URL on the web, component state in the Base App) and
// what a header looks like. That is the whole of the interface-only part, and
// it is the only part each surface still writes for itself.
//
// Read-only, like the page it came from: no clearance, no plan, no wallet.
// ---------------------------------------------------------------------------

export const STOCKS_CONSOLE_DEFAULT_SIZE_V1 = MARKET_REALITY_SIZES_V1[1]!.requestedCashAtomic;

/** The exact market question, and the only state either surface holds. */
export interface StocksConsoleQuestionV1 {
  underlyingKey: string | null;
  direction: MarketRealityDirectionV1;
  requestedCashAtomic: string;
  destination: 'USDC' | 'ETH';
  surface: MarketRealitySurfaceV1;
  historyPeriod: MarketRealityHistoryPeriodV1;
}

/** What the caller is asked to change when a control is pressed. Deliberately
 * partial: a size press must not also re-assert a direction. */
export type StocksConsoleQuestionPatchV1 = Partial<StocksConsoleQuestionV1>;

/**
 * Why a read failed, in the reader's terms.
 *
 * Never the raw message: a server error can carry an endpoint and an endpoint
 * can carry a key. Every branch refuses to describe the securities — the
 * sentence is about our request, which is what it actually knows.
 */
export function stocksConsoleFailureCopyV1(error: unknown, subject: string): string {
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

export interface StocksConsoleInputV1 {
  question: StocksConsoleQuestionV1;
  /** Apply a change to the question. The caller decides where it is stored. */
  onQuestion: (patch: StocksConsoleQuestionPatchV1) => void;
  /** `routeIntelligenceV1` on this deployment. */
  enabled: boolean;
  /**
   * Whether the server's configuration was actually read.
   *
   * `/status` sits behind the tenant gate, so a signed-out reader gets a 401
   * and every flag reads false. That made the surface say "route intelligence
   * is switched off on this server" to visitors who had simply not signed in —
   * a true-sounding sentence about the server that the client had no evidence
   * for. False means we do not know, and the copy says so instead.
   */
  configurationRead?: boolean;
  /** Open the full dossier for one address. Omitted where there is no surface. */
  onInvestigate?: (tokenAddress: string) => void;
  /** Open the tenant's Radar feed. */
  onOpenRadar?: () => void;
  /**
   * Open advanced route inspection for ONE exact address, with the goal
   * sentence this console built. Omitted where the surface mounts no advanced
   * path — which is not the same as the handoff refusing, and the two stay
   * apart: a refusal is reported per address in `inspectRouteUnavailable`.
   */
  onInspectRoute?: (input: { tokenAddress: string; goal: string }) => void;
}

/**
 * Why nothing is being read, when nothing is.
 *
 * Two different facts, and only one of them is about the server. Shared by
 * Stocks and Radar so a reader cannot be told one on one screen and the other
 * on the next.
 */
export function stocksUnavailableNoticeV1(input: {
  enabled: boolean;
  configurationRead: boolean;
  subject?: string;
}): string | null {
  if (input.enabled) return null;
  const subject = input.subject ?? 'no representation is being read';
  if (!input.configurationRead) {
    return `You are not signed in, so this server's configuration was not read and ${subject}. That is about this session, not about what the server serves.`;
  }
  return `Route intelligence is switched off on this server, so ${subject}. This says nothing about what is issued.`;
}

export interface StocksConsoleResultV1 {
  model: MarketRealityScreenModelV1;
  /** The security actually on screen: the question's, or the first comparable
   * one the graph has. The caller persists it if its surface can. */
  selectedKey: string | null;
  /** How many representations this read put on the board. */
  representationCount: number;
}

/**
 * Everything between the exact question and the Stocks screen model.
 */
export function useStocksConsoleV1(input: StocksConsoleInputV1): StocksConsoleResultV1 {
  const { question, enabled } = input;

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
    { enabled: enabled && question.surface === 'market' && question.historyPeriod !== 'now' },
  );
  const radar = useMarketRealityRadar({ enabled });
  const addWatch = useAddMarketRealityRadarWatch();
  const removeWatch = useRemoveMarketRealityRadarWatch();
  const measure = useMeasureRwaMarketReality();
  // Phase 13.2 — Ask Miorail. Nothing is cached: the same words asked twice
  // against a market that moved are two different answers.
  const ask = useAskRwaMarketReality();

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
          return sources.join(' ') === [...watch.approvedSources].sort().join(' ');
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

  // The round-trip ladder, per representation, out of the stored cash-exit run
  // Discover has rendered all along. Three fixed hooks rather than a loop,
  // because a hook cannot be called conditionally. Three is the reviewed
  // maximum for one security today (Coinbase, Backed, and Backed's wrapper); a
  // fourth shows no ladder rather than a wrong one.
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
      // The card's own wording for an age, so the ladder does not say "46m ago"
      // beside a row saying "46 min ago" about the same measurement.
      const rungs = cashExitLadderRungsV1(ladder.rungs, new Date(nowIso), (iso, at) =>
        quoteAgeLabelV1(iso, at.toISOString()),
      );
      if (rungs.length === 0) continue;
      built[response.dossier.tokenAddress.toLowerCase()] = {
        rungs,
        note: `Exact sizes only, quoted through ${
          ladder.approvedSources.join(', ') || 'no approved router'
        }. Nothing here was executed.`,
      };
    }
    return built;
  }, [dossierA.data, dossierB.data, dossierC.data, nowIso]);

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

  const disabledNotice = stocksUnavailableNoticeV1({
    enabled,
    configurationRead: input.configurationRead !== false,
  });

  const model: MarketRealityScreenModelV1 = {
    choices,
    choicesLoading: index.isLoading,
    choicesError:
      disabledNotice ??
      (index.error ? stocksConsoleFailureCopyV1(index.error, 'the reviewed securities') : null),
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
      (reality.error ? stocksConsoleFailureCopyV1(reality.error, 'this comparison') : null),
    history: historyView,
    historyLoading: history.isLoading,
    historyError:
      disabledNotice ??
      (history.error ? stocksConsoleFailureCopyV1(history.error, 'comparable history') : null),

    measuring: measure.isPending,
    measurementNote,
    measurementError: measure.error
      ? stocksConsoleFailureCopyV1(measure.error, 'this measurement')
      : null,
    watchedTokenAddresses,
    watchingTokenAddress: addWatch.isPending ? (addWatch.variables?.tokenAddress ?? null) : null,
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
        ? stocksConsoleFailureCopyV1(addWatch.error ?? removeWatch.error, 'this exact watch')
        : null,

    // Phase 13.2. Offered only once a security is chosen and the surface is
    // enabled: an answer needs a question to be about.
    ask: {
      answer: ask.data ?? null,
      asking: ask.isPending,
      error: ask.error ? stocksConsoleFailureCopyV1(ask.error, 'this question') : null,
      available: Boolean(enabled && selectedKey),
    },

    actions: {
      onUnderlying: (underlyingKey) => input.onQuestion({ underlyingKey }),
      ...(enabled && selectedKey
        ? {
            onMeasure: () =>
              measure.mutate({
                underlyingKey: selectedKey,
                direction: question.direction,
                requestedCashAtomic: question.requestedCashAtomic,
                destination: question.destination,
              }),
            // The question on screen travels with the words asked, so an answer
            // can never be about a size the reader is not looking at. The
            // server echoes both back and the screen renders the echo.
            onAsk: (asked: string) =>
              ask.mutate({
                underlyingKey: selectedKey,
                direction: question.direction,
                requestedCashAtomic: question.requestedCashAtomic,
                destination: question.destination,
                question: asked,
              }),
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
      onDirection: (direction) => input.onQuestion({ direction }),
      onSize: (requestedCashAtomic) => input.onQuestion({ requestedCashAtomic }),
      onSurface: (surface) => input.onQuestion({ surface }),
      onHistoryPeriod: (historyPeriod) => input.onQuestion({ historyPeriod }),
      ...(input.onInvestigate ? { onInvestigate: input.onInvestigate } : {}),
      ...(input.onOpenRadar ? { onOpenRadar: input.onOpenRadar } : {}),
      // Phase 13.1. The handoff is built HERE, from the exact typed answer this
      // console is rendering, and it carries an address — never a ticker.
      // Navigation prefills the advanced surface and submits nothing: opening a
      // route inspection is not approval.
      ...(reality.data && input.onInspectRoute
        ? {
            onInspectRoute: (tokenAddress: string) => {
              const built = stockExecutionHandoffV1({
                response: reality.data as never,
                tokenAddress,
                now: new Date(),
              });
              if (built.status !== 'ready') return;
              input.onInspectRoute?.({
                tokenAddress: built.handoff.tokenAddress,
                goal: stockExecutionGoalSentenceV1(built.handoff),
              });
            },
          }
        : {}),
    },
  };

  return { model, selectedKey, representationCount: reality.data?.representations.length ?? 0 };
}

/** Why Radar could not be read. Same rule as above: about our request. */
export function radarConsoleFailureCopyV1(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('authentication_required') || /\b401\b/.test(message)) {
    return 'Your session is not valid for this server, so no watches were read.';
  }
  if (message.includes('storage_unavailable')) {
    return 'The evidence database did not answer. No market state is inferred from that failure.';
  }
  return 'Radar could not be read on this server. Nothing here is a statement about a watched market.';
}

export interface RadarConsoleInputV1 {
  enabled: boolean;
  /** See `StocksConsoleInputV1.configurationRead`. */
  configurationRead?: boolean;
  /** Open the exact question one watch describes. */
  onOpenMarket: (question: StocksConsoleQuestionV1) => void;
}

export interface RadarConsoleResultV1 {
  model: MarketRealityRadarScreenModelV1;
  watchCount: number;
}

/** The Radar feed, for whichever surface mounts it. */
export function useRadarConsoleV1(input: RadarConsoleInputV1): RadarConsoleResultV1 {
  const { enabled } = input;
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

  const disabledNotice = stocksUnavailableNoticeV1({
    enabled,
    configurationRead: input.configurationRead !== false,
    subject: 'Radar is not reading watches',
  });

  return {
    watchCount: radar.data?.watches.length ?? 0,
    model: {
      view,
      loading: radar.isLoading,
      error:
        disabledNotice ??
        (radar.error
          ? radarConsoleFailureCopyV1(radar.error)
          : remove.error
            ? radarConsoleFailureCopyV1(remove.error)
            : null),
      removingWatchId: remove.isPending ? (remove.variables?.watchId ?? null) : null,
      onRemove: (watchId: string) => remove.mutate({ watchId }),
      onOpenMarket: (watchId: string) => {
        const watch = radar.data?.watches.find((row) => row.watchId === watchId);
        if (!watch) return;
        input.onOpenMarket({
          underlyingKey: watch.underlyingKey,
          direction: watch.direction,
          requestedCashAtomic: watch.requestedCashAtomic,
          destination: watch.destination,
          surface: 'market',
          historyPeriod: 'now',
        });
      },
    },
  };
}
