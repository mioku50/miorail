import { useEffect, useMemo, useRef, useState } from 'react';
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
  useRwaUseAccess,
  useAerodromePoolSpot,
} from '@mioagent/api-client-react';
import {
  stockExecutionGoalSentenceV1,
  stockExecutionHandoffV1,
} from '@mioagent/rwa-market-reality/execution-handoff';

import type { RepresentationUseAccessV1 } from '@mioagent/rwa-issuer/useAccess';

import { cashExitLadderRungsV1 } from './rwaDiscoverView';
import { swapProviderDisplayNameV1 } from './providerDiagnostics';
import {
  MARKET_REALITY_SIZES_V1,
  marketRealityViewV1,
  partitionByIssuerRoleV1,
  poolSpotViewV1,
  quoteAgeLabelV1,
  underlyingChoicesV1,
  stockScopeViewV1,
  underlyingCountersV1,
  type MarketRealityDirectionV1,
  type RepresentationExitEvidenceV1,
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
  /**
   * Phase 17.4 — prepare one exact side, from the card.
   *
   * Same handoff, same refusals, same surface: the only difference from
   * `onInspectRoute` is that the reader named a side, so the goal sentence
   * carries it instead of inheriting the board's direction toggle.
   */
  onPrepare?: (input: { tokenAddress: string; goal: string; direction: 'buy' | 'sell' }) => void;
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

/**
 * The round trip at the exact size being asked, out of the stored run.
 *
 * Written after the Market Route Coverage Audit found two reviewed
 * representations quoting happily while returning almost nothing on the way
 * back out. Both legs were already in the ladder and the cost between them was
 * already computed; no surface asked for it, because every surface asked the
 * ladder whether a quote EXISTED.
 *
 * Open evidence is preferred and history is the fallback — never merged, and
 * the basis travels with the number so the card can say which it is holding.
 * A quote lives about twenty seconds, so history is what a reader almost always
 * gets, and dropping it would hide this fact exactly when it is most useful.
 */
export function exitEvidenceV1(
  rungs: readonly {
    destination: 'USDC' | 'ETH';
    requestedCashAtomic: string | null;
    roundTripCostBps: string | null;
    returnedAtomic: string | null;
    observedAt: string | null;
    lastMeasured?: {
      roundTripCostBps: string | null;
      returnedAtomic: string | null;
      observedAt: string;
    } | null;
  }[],
  question: Pick<StocksConsoleQuestionV1, 'requestedCashAtomic' | 'destination'>,
): RepresentationExitEvidenceV1 | null {
  const rung = rungs.find(
    (row) =>
      row.destination === question.destination &&
      row.requestedCashAtomic === question.requestedCashAtomic,
  );
  if (!rung) return null;
  // The money on both sides travels with the cost, so the card can say
  // "$1,000 in → $342.80 back" from the measurement instead of rebuilding one
  // side out of the other. Open evidence and history are never mixed: an
  // amount always comes from the same run as the percentage beside it.
  if (rung.roundTripCostBps !== null && rung.observedAt !== null) {
    return {
      roundTripCostBps: rung.roundTripCostBps,
      requestedCashAtomic: rung.requestedCashAtomic,
      returnedCashAtomic: rung.returnedAtomic,
      basis: 'open',
      observedAt: rung.observedAt,
    };
  }
  const last = rung.lastMeasured ?? null;
  if (last && last.roundTripCostBps !== null) {
    return {
      roundTripCostBps: last.roundTripCostBps,
      requestedCashAtomic: rung.requestedCashAtomic,
      returnedCashAtomic: last.returnedAtomic,
      basis: 'last_measured',
      observedAt: last.observedAt,
    };
  }
  return null;
}

/**
 * Whether an automatic measurement is worth a router call — named, not implied.
 *
 * The trigger is a question a person chose; this is the second half, which
 * decides whether that question needs asking at all. Every refusal is a saving
 * with a reason, and the reasons are different enough that collapsing them into
 * one boolean would hide which one fired.
 */
export type AutoMeasureDecisionV1 =
  | 'measure'
  /** Already current: asking again buys evidence that expires with what we hold. */
  | 'already_open'
  /** Nothing is outstanding anywhere, so there is nothing for a router to route. */
  | 'no_supply_outstanding'
  /** A measurement of this same question is already running. */
  | 'in_flight';

export function autoMeasureDecisionV1(input: {
  hasOpenQuote: boolean;
  anySupplyOutstanding: boolean;
  measurementInFlight: boolean;
}): AutoMeasureDecisionV1 {
  if (input.hasOpenQuote) return 'already_open';
  if (!input.anySupplyOutstanding) return 'no_supply_outstanding';
  if (input.measurementInFlight) return 'in_flight';
  return 'measure';
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

  // The corpus this page opens on.
  //
  // `null` means "whatever the server defaults to", which is the documented
  // Coinbase B20 standard. A reader who widens it is asking a different
  // question — not filtering this one — so the scope is state here and a cache
  // key in the hook.
  const [scope, setScope] = useState<'coinbase_b20' | 'all_representations' | null>(null);
  const index = useRwaUnderlyings({ enabled, scope: scope ?? undefined });
  const choices = useMemo(() => underlyingChoicesV1(index.data ?? null), [index.data]);
  const counters = useMemo(() => underlyingCountersV1(index.data ?? null), [index.data]);
  const scopeView = useMemo(() => stockScopeViewV1(index.data ?? null), [index.data]);

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

  // The exact question, as one key. Every field the answer depends on is in it
  // and nothing else — a surface change or a re-render is not a new question.
  const questionKey = selectedKey
    ? [selectedKey, question.direction, question.requestedCashAtomic, question.destination].join('|')
    : null;

  // Is anything open right now, and when does the first one lapse?
  const openQuote = useMemo(() => {
    let open = false;
    let earliestExpiry: number | null = null;
    for (const representation of reality.data?.representations ?? []) {
      if (representation.status !== 'full' || !representation.returnedCashAtomic) continue;
      open = true;
      for (const source of representation.sources) {
        const expiresAt = source.quoteEvidence?.expiresAt;
        if (!expiresAt) continue;
        const at = Date.parse(expiresAt);
        if (Number.isFinite(at) && (earliestExpiry === null || at < earliestExpiry)) {
          earliestExpiry = at;
        }
      }
    }
    return { open, earliestExpiry };
  }, [reality.data]);

  // A one-second tick, and ONLY while something is open.
  //
  // "Expires in 17s" is the one number on this page worth watching move, and it
  // is also the only reason to re-render on a timer. When nothing is open the
  // interval does not exist, so an idle Stocks tab costs nothing.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const expiry = openQuote.earliestExpiry;
    if (!openQuote.open || expiry === null) return undefined;
    const timer = setInterval(() => {
      setTick((value) => value + 1);
      if (Date.now() >= expiry) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [openQuote.open, openQuote.earliestExpiry]);

  // One clock for the whole render, so two ages on the same screen cannot be
  // computed a few milliseconds apart and disagree.
  const nowIso = useMemo(
    () => new Date().toISOString(),
    [reality.dataUpdatedAt, history.dataUpdatedAt, index.dataUpdatedAt, tick],
  );

  // The round-trip ladder, per representation, out of the stored cash-exit run
  // Discover has rendered all along. FIVE fixed hooks rather than a loop,
  // because a hook cannot be called conditionally.
  //
  // Three was the reviewed maximum while the corpus was Coinbase, Backed and
  // Backed's wrapper. Binding Dinari's dShares took it to five — NVDA now has
  // Coinbase, Backed, Backed's wrapper, Dinari and Dinari's `.dw` variant — and
  // three underlyings sit at five, two at four. A sixth still shows no ladder
  // rather than a wrong one, which is the same honest fallback; the real fix is
  // one query over the address list, and this is not it.
  const representationAddresses = useMemo(
    () => (reality.data?.representations ?? []).map((row) => row.tokenAddress),
    [reality.data],
  );
  const dossierA = useOfficialAssetDossier(representationAddresses[0] ?? null);
  const dossierB = useOfficialAssetDossier(representationAddresses[1] ?? null);
  const dossierC = useOfficialAssetDossier(representationAddresses[2] ?? null);
  const dossierD = useOfficialAssetDossier(representationAddresses[3] ?? null);
  const dossierE = useOfficialAssetDossier(representationAddresses[4] ?? null);

  const ladders = useMemo(() => {
    const built: Record<
      string,
      {
        rungs: ReturnType<typeof cashExitLadderRungsV1>;
        note: string | null;
        exit: RepresentationExitEvidenceV1 | null;
      }
    > = {};
    for (const response of [dossierA.data, dossierB.data, dossierC.data, dossierD.data, dossierE.data]) {
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
        // The router's NAME, not its adapter id. This line read "quoted
        // through kyberswap" on a consumer card — an internal identifier, in
        // the one place a reader looks to find out who answered.
        note: `Exact sizes only, quoted through ${
          ladder.approvedSources.map((source) => swapProviderDisplayNameV1(source)).join(', ') ||
          'no approved router'
        }. Nothing here was executed.`,
        // The round trip AT THE SIZE BEING ASKED, from the same run the rungs
        // come from. The open quote first, the last completed measurement
        // second — never merged, because one is now and the other is history
        // and the card prints which it got.
        exit: exitEvidenceV1(ladder.rungs, question),
      };
    }
    return built;
  }, [
    dossierA.data,
    dossierB.data,
    dossierC.data,
    nowIso,
    question.requestedCashAtomic,
    question.destination,
  ]);

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

  // -------------------------------------------------------------------------
  // Phase 17.5 — a second, independent reading of the price.
  //
  // Every `full` observation on this corpus comes from one source. That is a
  // structural weakness of the evidence, not a criticism of the source, and it
  // has never had a cross-check. The router names the exact pool it went
  // through; that pool's own `slot0()` is a price anybody can recompute from
  // one word at the same block.
  //
  // ONE hook, for the representation the reader is actually acting on. It is a
  // corroboration of a number the board already has — paying seven chain reads
  // per card, on every size and direction press, to annotate cards nobody
  // pressed would make the board slower at the question it exists for.
  //
  // The pool comes out of the VIEW rather than the wire: the view is already
  // the thing that decides which venue references are named and checkable, and
  // deriving the address twice is how two surfaces come to disagree about which
  // pool a number went through.
  // -------------------------------------------------------------------------
  const spotToken = useMemo(
    () =>
      partitionByIssuerRoleV1(view?.representations ?? []).primary.find(
        (row) => row.routedThrough,
      ) ?? null,
    [view],
  );
  const poolSpotQuery = useAerodromePoolSpot(
    spotToken?.routedThrough?.venues[0]?.poolAddress ?? null,
    { enabled: enabled && question.surface !== 'utility' },
  );
  const poolSpotByAddress = useMemo(() => {
    if (!spotToken) return {};
    const spot = poolSpotViewV1({
      wire: (poolSpotQuery.data ?? null) as never,
      tokenAddress: spotToken.tokenAddress,
    });
    return spot ? { [spotToken.tokenAddress]: spot } : {};
  }, [poolSpotQuery.data, spotToken]);

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

  // -------------------------------------------------------------------------
  // Phase 17.2 — the page measures on interest, not on render.
  //
  // A router quote lives about twenty seconds and the background sampler runs
  // on a timer measured in tens of minutes, so a reader has essentially never
  // arrived to an open quote. Measuring on every render would close that gap by
  // turning the page into the sampler 10B.5 deliberately did not build, so the
  // trigger is a question a person actually chose: the first open of a
  // selection, a different stock, a different direction, a different size, a
  // different destination. A surface switch is not one of them — the answer
  // does not depend on which tab is showing.
  //
  // Four guards before a call is made, and three of them exist to spend
  // nothing:
  //   * the read has to have arrived, because it is what says whether anything
  //     is open;
  //   * a question that already holds an open quote is current, and asking
  //     again would buy an answer that expires at the same instant;
  //   * a security with no supply anywhere has nothing to route, and nine of
  //     the thirteen Coinbase contracts are exactly that;
  //   * one automatic attempt per question per session, so a refetch, a tab
  //     change or a re-render never becomes a second call.
  // The server's own single-flight, cooldown and open-evidence reuse still sit
  // behind all of it; this is the layer that decides not to ask at all.
  // -------------------------------------------------------------------------
  const autoMeasuredQuestion = useRef<string | null>(null);
  const measureMutate = measure.mutate;
  useEffect(() => {
    if (!enabled || !selectedKey || !questionKey) return;
    if (autoMeasuredQuestion.current === questionKey) return;
    const representations = reality.data?.representations;
    if (!representations) return;
    // Marked done whatever the decision below: this question has been
    // considered, and reconsidering it on the next render is the loop.
    autoMeasuredQuestion.current = questionKey;
    const decision = autoMeasureDecisionV1({
      hasOpenQuote: openQuote.open,
      anySupplyOutstanding: representations.some((row) => row.supply.state === 'positive_supply'),
      measurementInFlight: measure.isPending,
    });
    if (decision !== 'measure') return;
    measureMutate({
      underlyingKey: selectedKey,
      direction: question.direction,
      requestedCashAtomic: question.requestedCashAtomic,
      destination: question.destination,
    });
  }, [
    enabled,
    selectedKey,
    questionKey,
    reality.data,
    openQuote.open,
    measure.isPending,
    measureMutate,
    question.direction,
    question.requestedCashAtomic,
    question.destination,
  ]);

  // -------------------------------------------------------------------------
  // Phase 17.4 — Use & access reads the chain, and only when the tab is open.
  //
  // Five fixed hooks rather than a loop, for the same reason the ladders are:
  // a hook cannot be called conditionally, and five is the measured maximum for
  // one security since Dinari's dShares were bound. A sixth shows the documented
  // sections with its onchain answers missing, which the card says out loud
  // rather than rendering as negative.
  // -------------------------------------------------------------------------
  const useAccessEnabled = enabled && question.surface === 'utility';
  const useAccess0 = useRwaUseAccess(representationAddresses[0] ?? null, { enabled: useAccessEnabled });
  const useAccess1 = useRwaUseAccess(representationAddresses[1] ?? null, { enabled: useAccessEnabled });
  const useAccess2 = useRwaUseAccess(representationAddresses[2] ?? null, { enabled: useAccessEnabled });
  const useAccess3 = useRwaUseAccess(representationAddresses[3] ?? null, { enabled: useAccessEnabled });
  const useAccess4 = useRwaUseAccess(representationAddresses[4] ?? null, { enabled: useAccessEnabled });
  const useAccessByAddress = useMemo(() => {
    const entries: [string, RepresentationUseAccessV1 | null][] = [];
    for (const [index, query] of [useAccess0, useAccess1, useAccess2, useAccess3, useAccess4].entries()) {
      const address = representationAddresses[index];
      if (address) entries.push([address, query.data ?? null]);
    }
    return Object.fromEntries(entries);
  }, [representationAddresses, useAccess0.data, useAccess1.data, useAccess2.data, useAccess3.data, useAccess4.data]);
  const useAccessLoading =
    useAccess0.isLoading ||
    useAccess1.isLoading ||
    useAccess2.isLoading ||
    useAccess3.isLoading ||
    useAccess4.isLoading;

  const disabledNotice = stocksUnavailableNoticeV1({
    enabled,
    configurationRead: input.configurationRead !== false,
  });

  const model: MarketRealityScreenModelV1 = {
    scope: scopeView,
    // The selected key belongs to the scope it was chosen in. Widening keeps it
    // — every scoped key is in the wide corpus — and narrowing lets the default
    // pick again rather than stranding the board on a security the grid above
    // it no longer lists.
    onScope: (next) => {
      setScope(next);
      // The selection belongs to the scope it was made in. Clearing it lets
      // `defaultKey` pick again from the corpus now on screen, rather than
      // leaving the board on a security the grid above it no longer lists.
      input.onQuestion({ underlyingKey: null });
    },
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
    useAccess: useAccessByAddress,
    useAccessLoading,
    poolSpot: poolSpotByAddress,
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
        // A LABEL may not take the page down. This calls a strict parse, and a
        // response carrying one key it did not expect threw inside render and
        // hit the error boundary — over a caption on a secondary button. The
        // shape is fixed at the source; this is the seatbelt, and it fails to
        // "unavailable", which is the honest reading of a handoff that could
        // not be built.
        let built: ReturnType<typeof stockExecutionHandoffV1>;
        try {
          built = stockExecutionHandoffV1({
            response: reality.data as never,
            tokenAddress: representation.tokenAddress,
            now: new Date(),
          });
        } catch {
          return [
            [
              representation.tokenAddress,
              'Miorail could not build a route inspection from this answer.',
            ] as const,
          ];
        }
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
      // The same handoff with the side the reader pressed. Every refusal above
      // still applies: naming a side is not permission to execute one.
      ...(reality.data && input.onPrepare
        ? {
            onPrepare: (tokenAddress: string, direction: 'buy' | 'sell') => {
              const built = stockExecutionHandoffV1({
                response: reality.data as never,
                tokenAddress,
                direction,
                now: new Date(),
              });
              if (built.status !== 'ready') return;
              input.onPrepare?.({
                tokenAddress: built.handoff.tokenAddress,
                goal: stockExecutionGoalSentenceV1(built.handoff),
                direction,
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
