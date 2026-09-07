import React, { useMemo, useState } from 'react';

import { shortAddressV1 } from './B20WatchScreen';
import { TokenIdentityV1 } from './TokenIdentity';
import {
  StocksAskPanel,
  type StocksAskPanelModelV1,
} from './StocksAskPanel';
import {
  MARKET_REALITY_DIRECTIONS_V1,
  MARKET_REALITY_SIZES_V1,
  STOCK_ISSUER_NOTICE_V1,
  partitionByIssuerRoleV1,
  partitionChoicesBySupplyV1,
  stockFiltersV1,
  useSectionsV1,
  type FactViewV1,
  type StockFilterViewV1,
  type StockScopeViewV1,
  type MarketRealityDirectionV1,
  type MarketRealityViewV1,
  type PoolSpotViewV1,
  type RepresentationViewV1,
  type ToneV1,
  type UnderlyingChoiceViewV1,
  stocksHeadlineV1,
  type StocksHeadlineViewV1,
} from './marketRealityView';
import type { RepresentationUseAccessV1 } from '@mioagent/rwa-issuer/useAccess';
import {
  MARKET_REALITY_HISTORY_PERIODS_V1,
  type ComparableMarketHistoryRepresentationV1,
  type ComparableMarketHistoryViewV1,
  type MarketRealityHistoryPeriodV1,
} from './marketRealityHistoryView';

void React;

// ---------------------------------------------------------------------------
// Phase 10B — Market Reality.
//
// One security, every reviewed way to hold it on Base, at one exact size.
//
// The layout is a board rather than a table on purpose. A table invites a
// reader to scan a column and pick the biggest number, and on this page most
// cells are empty for five different reasons — so the reasons have to be as
// prominent as the numbers, which a table cell cannot do.
//
// Rules this component holds to and cannot be talked out of:
//
//   * it performs no arithmetic. Every value arrives from the view module as a
//     formatted string or an em dash, so an absent measurement can never be
//     rendered as a zero;
//   * nothing is marked best while ranking is withheld, and the sentence
//     saying so is in the body, above the cards — not in a details, not in a
//     footnote. A reader who misses it will read the first card as the winner;
//   * every empty cell carries WHY, and the why names whose fact it is. Three
//     of the five outcomes on this page are about Miorail or the clock, and
//     only one is about the asset.
// ---------------------------------------------------------------------------

const TONE_CLASS_V1: Readonly<Record<ToneV1, string>> = {
  good: 'good',
  warn: 'warn',
  bad: 'bad',
  off: 'off',
  neutral: '',
};

function factClassV1(tone: ToneV1): string {
  const suffix = TONE_CLASS_V1[tone];
  return suffix ? `cr-v mono ${suffix}` : 'cr-v mono';
}

/**
 * A section heading that either stands over its body or folds it away.
 *
 * One component rather than two branches at the call site, so an open section
 * and a collapsed one render the same heading — the label and the verdict chip
 * — and differ only in whether the body is behind a press.
 */
function SectionHead({
  collapsed,
  label,
  chip,
  tone,
  children,
}: {
  collapsed: boolean;
  label: string;
  chip: string;
  tone: ToneV1;
  children: React.ReactNode;
}) {
  const head = (
    <>
      <strong>{label}</strong>
      <span className="pill cr-status" data-tone={tone}>
        {chip}
      </span>
    </>
  );
  if (!collapsed) {
    return (
      <>
        <div className="mr-utility-edge-head">{head}</div>
        {children}
      </>
    );
  }
  return (
    <details className="mr-use-fold">
      <summary className="mr-utility-edge-head">{head}</summary>
      {children}
    </details>
  );
}

function FactList({ facts, label }: { facts: readonly FactViewV1[]; label: string }) {
  if (facts.length === 0) return null;
  return (
    <dl className="cr-facts" aria-label={label}>
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>
            <strong className={factClassV1(fact.tone)}>{fact.value}</strong>
            {fact.note ? <span className="cr-fact-note"> · {fact.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface MarketRealityActionsV1 {
  /**
   * Phase 13.2 — ask about the exact question already on screen.
   *
   * Absent when the surface is not offered. The panel establishes nothing: it
   * renders an answer the server already checked, and the reader can follow
   * every citation to the row it stands on.
   */
  onAsk?: (question: string) => void;
  onUnderlying: (underlyingKey: string) => void;
  onDirection: (direction: MarketRealityDirectionV1) => void;
  onSize: (requestedCashAtomic: string) => void;
  onSurface: (surface: MarketRealitySurfaceV1) => void;
  onHistoryPeriod: (period: MarketRealityHistoryPeriodV1) => void;
  /** Open the full dossier for one address. Absent when not wired. */
  onInvestigate?: (tokenAddress: string) => void;
  /** Create one exact representation/size/direction/destination watch. */
  onWatch?: (tokenAddress: string) => void;
  /** Remove the tenant's matching exact watch. */
  onUnwatch?: (tokenAddress: string) => void;
  /**
   * Phase 13.1 — open advanced execution on THIS exact address.
   *
   * Optional, secondary, and an intent to look: it opens a route inspection
   * with the address prefilled and submits nothing. Absent when the handoff
   * refuses, and the reason is rendered instead of a dead control.
   */
  onInspectRoute?: (tokenAddress: string) => void;
  /**
   * Phase 17.4 — prepare one exact side on THIS exact address.
   *
   * The primary action on a priced card. It opens the prepare step, which
   * re-plans against fresh routes; it never submits, approves, or opens a
   * wallet, and the quote on the card is never carried into it as executable
   * state.
   *
   * The side is a parameter rather than the board's own direction, so choosing
   * to buy does not re-ask the question every other card on screen is
   * answering.
   */
  onPrepare?: (tokenAddress: string, direction: 'buy' | 'sell') => void;
  /** Open the tenant's Radar feed. */
  onOpenRadar?: () => void;
  /** Measure the exact question now. Absent when the server does not offer it,
   * because a control that answers with a refusal reads as a broken product. */
  onMeasure?: () => void;
}

export type MarketRealitySurfaceV1 = 'market' | 'utility';

export interface MarketRealityScreenModelV1 {
  /** Phase 13.2. Null until a reader has asked. */
  ask?: StocksAskPanelModelV1;
  /** Why advanced execution is unavailable for an exact address, when it is.
   * Keyed by token address; absence means the action is offered. */
  inspectRouteUnavailable?: Readonly<Record<string, string>>;
  /** Which corpus this grid is a slice of, and where the rest is. Null on an
   * older payload that does not carry the corpus totals — the panel is not
   * rendered rather than guessed at. */
  scope?: StockScopeViewV1 | null;
  onScope?: (scope: 'coinbase_b20' | 'all_representations') => void;
  choices: readonly UnderlyingChoiceViewV1[];
  choicesLoading: boolean;
  /** Why there is no chooser. Never a claim about the corpus. */
  choicesError: string | null;
  counters: readonly FactViewV1[];

  selectedKey: string | null;
  direction: MarketRealityDirectionV1;
  requestedCashAtomic: string;
  surface: MarketRealitySurfaceV1;
  historyPeriod: MarketRealityHistoryPeriodV1;

  view: MarketRealityViewV1 | null;
  viewLoading: boolean;
  viewError: string | null;

  /** Phase 12.1. The raw technical series is projected before it reaches the
   * screen, so a provider failure can only arrive as a gap. */
  history: ComparableMarketHistoryViewV1 | null;
  historyLoading: boolean;
  historyError: string | null;

  /** A measurement is running. */
  measuring: boolean;
  /** Phase 17.4 — onchain Use & access, by exact address. Absent until the tab
   * is opened; a missing entry is "not read", never "nothing there". */
  useAccess?: Readonly<Record<string, RepresentationUseAccessV1 | null>>;
  useAccessLoading?: boolean;
  /**
   * The question belongs to something else and the reader cannot change it.
   *
   * True on the stock-action review page, where the draft fixes the security,
   * the direction and the exact size. Two things went wrong there without it:
   *
   *   * the securities chooser had nothing to choose from — that page loads no
   *     index — and rendered its empty state, `No reviewed source has bound a
   *     Base contract to a security yet`, on a page showing five reviewed
   *     representations of NVDA. A sentence about OUR list, printed where a
   *     reader takes it for a fact about the security.
   *
   *   * Sell/Buy, the four sizes and the history periods all rendered as live
   *     controls wired to no-ops. Nothing broke — but a control that looks
   *     interactive and does nothing is a promise the page cannot keep, and one
   *     that appeared to offer changing the very question being confirmed.
   *
   * So neither is rendered. The question is stated in words above instead.
   */
  questionFixed?: boolean;
  /**
   * Phase 17.5 — one pool's own marginal price, by representation address.
   *
   * Corroboration, not measurement: it stands beside a number an aggregator
   * already produced and is never the source of one. Absent for every
   * representation whose quote named no pool, which is most of them.
   */
  poolSpot?: Readonly<Record<string, PoolSpotViewV1 | null>>;
  /** What the last measurement spent, in a reader's words. Null before one. */
  measurementNote: string | null;
  measurementError: string | null;

  /** Exact representations already watched for the question selected above. */
  watchedTokenAddresses: readonly string[];
  watchingTokenAddress: string | null;
  removingWatchTokenAddress: string | null;
  watchError: string | null;

  actions: MarketRealityActionsV1;
}

const DIRECTION_LABEL_V1: Readonly<Record<MarketRealityDirectionV1, string>> = {
  sell: 'Sell',
  buy: 'Buy',
};

function HistoryMetricList({
  metrics,
  label,
}: {
  metrics: ReadonlyArray<ComparableMarketHistoryRepresentationV1['metrics'][number]>;
  label: string;
}) {
  if (metrics.length === 0) return null;
  return (
    <dl className="cr-facts mr-history-facts" aria-label={label}>
      {metrics.map((metric) => (
        <div key={metric.label}>
          <dt>{metric.label}</dt>
          <dd>
            <strong className="cr-v mono">{metric.value}</strong>
            {metric.note ? <span className="cr-fact-note"> · {metric.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ComparableHistoryCard({
  representation,
  onInvestigate,
}: {
  representation: ComparableMarketHistoryRepresentationV1;
  onInvestigate?: (tokenAddress: string) => void;
}) {
  return (
    <article
      className="mr-rep mr-history-rep"
      data-history-state={representation.state}
      aria-label={`${representation.issuerName} comparable history ${representation.tokenAddress}`}
    >
      <div className="cr-top">
        <span className="cr-name">
          <TokenIdentityV1
            symbol={representation.issuerName}
            name={representation.structureLabel}
            tokenAddress={representation.tokenAddress}
          />
        </span>
        <span
          className="pill cr-status"
          data-tone={representation.state === 'quoted' ? 'neutral' : 'off'}
        >
          {representation.stateLabel}
        </span>
      </div>

      {representation.observedAge ? (
        <p className="mr-attribution">
          <span className="mr-attribution-k">Captured</span> {representation.observedAge}
          {representation.source ? <> · {representation.source}</> : null}
        </p>
      ) : null}
      <p className="cr-verdict">{representation.summary}</p>
      <HistoryMetricList
        metrics={representation.metrics}
        label={`${representation.issuerName} historical observation`}
      />

      {representation.changesToNow.length > 0 ? (
        <section className="mr-history-change" aria-label="Change to now">
          <h4>Change to now</h4>
          <HistoryMetricList
            metrics={representation.changesToNow}
            label={`${representation.issuerName} change to now`}
          />
        </section>
      ) : null}
      {representation.changeNote ? <p className="lnote">{representation.changeNote}</p> : null}

      {representation.observedAt ? (
        <details className="card-evidence">
          <summary>Technical evidence</summary>
          <div className="card-evidence-body">
            <dl className="cr-facts">
              <div>
                <dt>Exact observation</dt>
                <dd>
                  <strong className="cr-v mono">{representation.observedAt}</strong>
                </dd>
              </div>
              <div>
                <dt>Representation</dt>
                <dd>
                  <strong className="cr-v mono">{representation.tokenAddress}</strong>
                </dd>
              </div>
              {representation.source ? (
                <div>
                  <dt>Route source</dt>
                  <dd>
                    <strong className="cr-v mono">{representation.source}</strong>
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
        </details>
      ) : null}

      {onInvestigate ? (
        <div className="card-actions">
          <button
            type="button"
            className="btn sec"
            onClick={() => onInvestigate(representation.tokenAddress)}
          >
            Investigate
          </button>
        </div>
      ) : null}
    </article>
  );
}

function RepresentationCard({
  representation,
  actions,
  surface,
  watched,
  watching,
  removing,
  measuring,
  useAccess,
  useAccessLoading,
  inspectRouteUnavailable,
  poolSpot,
}: {
  representation: RepresentationViewV1;
  actions: MarketRealityActionsV1;
  surface: MarketRealitySurfaceV1;
  watched: boolean;
  watching: boolean;
  removing: boolean;
  /** A refresh of THIS exact question is in flight. */
  measuring: boolean;
  /** What this exact address answered on chain, or null when nothing read it. */
  useAccess: RepresentationUseAccessV1 | null;
  useAccessLoading: boolean;
  inspectRouteUnavailable: string | null;
  /** The routed-through pool's OWN price, when one was read. Null is ordinary:
   * no venue named, no reading taken, or the read did not complete. */
  poolSpot: PoolSpotViewV1 | null;
}) {
  if (surface === 'utility') {
    const sections = useSectionsV1({
      use: useAccess,
      issuerId: representation.issuerId,
      groups: representation.utility.groups,
      exit: representation.exit,
      exitBasis: representation.exitBasis,
      openQuote: representation.openQuote,
      lastMeasuredLabel: representation.lastMeasuredLabel,
      outcomeBody: representation.outcomeBody,
      caip10: representation.utility.caip10,
    });
    return (
      <article
        className="mr-rep mr-utility-rep"
        aria-label={`${representation.issuerName} use and access`}
      >
        <div className="cr-top">
          <span className="cr-name">
            <TokenIdentityV1
              symbol={representation.issuerName}
              name={representation.structureLabel}
              tokenAddress={representation.tokenAddress}
            />
          </span>
          <span className="pill cr-status" data-tone="neutral">
            Exact address
          </span>
        </div>

        {/* Four measured sections, then the issuer's processes, then the
            documents. The order is the order a person asks: can I trade it, can
            I move it, can I bridge it, does anything lend against it. */}
        {sections.map((section) => (
          <section
            className="mr-use-section"
            key={section.id}
            aria-label={section.label}
            data-collapsed={section.collapsed ? 'yes' : 'no'}
          >
            {/* The four measured sections are the answer and stay open. The two
                documentation sections keep their heading and their verdict chip
                and fold their prose away: a reader asking "can I trade this"
                was getting four short answers followed by several screens about
                authorized participants. */}
            <SectionHead
              collapsed={section.collapsed}
              label={section.label}
              chip={section.chip}
              tone={section.tone}
            >
            <p className="cr-verdict mr-use-headline">{section.headline}</p>
            {section.facts.length > 0 ? (
              <FactList facts={section.facts} label={`${section.label} facts`} />
            ) : null}

            {section.edges.length > 0 ? (
              <div className="mr-utility-edges">
                {section.edges.map((edge) => (
                  <article className="mr-utility-edge" key={edge.edgeId} data-state={edge.state}>
                    <div className="mr-utility-edge-head">
                      <strong>{edge.label}</strong>
                      <span
                        className="pill cr-status"
                        data-tone={
                          edge.state === 'stale'
                            ? 'warn'
                            : edge.state === 'not_established'
                              ? 'off'
                              : 'neutral'
                        }
                      >
                        {edge.stateLabel}
                      </span>
                    </div>
                    <p>{edge.note}</p>
                    {edge.edgeId === 'issuer_primary_market' ||
                    edge.edgeId === 'representation_eligibility' ? (
                      <p className="lnote">Eligibility: {edge.eligibilityNote}</p>
                    ) : null}
                    {edge.sources.length === 0 && edge.providerLabel === null ? (
                      <p className="mr-utility-meta">No reviewed exact-address evidence</p>
                    ) : (
                      <details className="mcp-tech">
                        <summary>
                          Evidence{edge.sources.length > 0 ? ` (${edge.sources.length})` : ''} ·
                          checked{' '}
                          <span className="mono" title={edge.checkedAt}>
                            {edge.checkedAgo ?? edge.checkedAt}
                          </span>
                        </summary>
                        <p className="mr-utility-meta">
                          {edge.providerLabel ? (
                            <>
                              Source <span className="mono">{edge.providerLabel}</span>
                            </>
                          ) : (
                            'No route source is named for this edge.'
                          )}
                        </p>
                        {edge.sources.length > 0 ? (
                          <div className="mr-utility-sources" aria-label={`${edge.label} sources`}>
                            {edge.sources.map((source, index) =>
                              source.href ? (
                                <a
                                  key={`${source.label}:${index}`}
                                  href={source.href}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {source.label}
                                </a>
                              ) : (
                                <span key={`${source.label}:${index}`}>{source.label}</span>
                              ),
                            )}
                          </div>
                        ) : null}
                      </details>
                    )}
                  </article>
                ))}
              </div>
            ) : null}

            {/* Ids, selectors, policy numbers and the block. Nothing above this
                line carries one: a reader deciding whether they can move a token
                is not helped by `policy 5`, and an operator checking the claim
                cannot do without it. */}
            {section.evidence.length > 0 ? (
              <details className="mcp-tech">
                <summary>Evidence ({section.evidence.length})</summary>
                <dl className="cr-facts">
                  {section.evidence.map((row) => (
                    <div key={`${section.id}:${row.label}`}>
                      <dt>{row.label}</dt>
                      <dd>
                        <strong className="cr-v mono">{row.value}</strong>
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
            </SectionHead>
          </section>
        ))}

        {useAccessLoading ? (
          <p className="lnote">Reading this contract on chain…</p>
        ) : useAccess === null ? (
          <p className="lnote">
            Miorail has not read this contract on chain for this view. The sections above show what
            the reviewed issuer material establishes; the onchain answers are missing, not negative.
          </p>
        ) : null}

        <p className="lnote">
          Every check on this page is an onchain address-policy read. It is not KYC, not
          jurisdiction eligibility, and not legal permission to trade a security.
        </p>
      </article>
    );
  }

  return (
    <article
      className="mr-rep"
      data-outcome={representation.outcome}
      aria-label={`${representation.issuerName} ${representation.tokenAddress}`}
    >
      <div className="cr-top">
        <span className="cr-name">
          {/* Issuer and the exact contract, together and always. Two different
              CHEESEBURGE contracts once shared a screen with contradicting
              numbers and no address between them; here three contracts share a
              screen and two of them are the same issuer. */}
          <TokenIdentityV1
            symbol={representation.issuerName}
            name={representation.structureLabel}
            tokenAddress={representation.tokenAddress}
          />
        </span>
        {/* Two chips, two questions. The first says whether Miorail has an
            answer at this exact size; the second says what the answer costs.
            They were one chip and it was green for both, which is how a card
            reading `$1,000 in → $0.94 back` looked like a healthy market. */}
        <span className="cr-chips">
          <span className="pill cr-status" data-tone={representation.outcomeTone}>
            {representation.outcomeChip}
          </span>
          {representation.exitCost ? (
            <span
              className="pill cr-status"
              data-tone={representation.exitCost.tone}
              title={representation.exitCost.note}
            >
              {representation.exitCost.chip}
            </span>
          ) : null}
        </span>
      </div>

      {/* Whose fact this is. The smallest thing on the card and the one that
          stops "not measured" from reading as "untradeable". */}
      <p className="mr-attribution">
        <span className="mr-attribution-k">Says</span> {representation.attribution}
      </p>

      {/* Where the money went, by exact pool. Base's product page says these
          stocks have deep liquidity on Aerodrome; every priced card here was
          already routing through an Aerodrome CL pool and reporting only the
          aggregator that answered. The pool address is on screen so the venue
          can be checked against the chain rather than believed. */}
      {representation.routedThrough ? (
        <div className="mr-routed">
          <p className="mr-routed-head">{representation.routedThrough.headline}</p>
          <div className="mr-routed-venues">
            {representation.routedThrough.venues.map((venue) => (
              <span className="pill cr-status" data-tone="neutral" key={venue.poolAddress}>
                {venue.label}
                <span className="mono"> {shortAddressV1(venue.poolAddress!)}</span>
              </span>
            ))}
          </div>
          <p className="lnote">{representation.routedThrough.note}</p>
          {/* Phase 17.5 — the second reading, under the venue it belongs to.
              Every `full` observation on this corpus comes from one source, so
              until now there was nothing to check the number against. This is
              the pool's own state, read and computed by us, standing beside the
              number the aggregator reported.
              It is deliberately NOT compact and NOT abbreviated: a price with
              no size attached, sitting next to prices that have one, reads as a
              quote unless it says otherwise every single time. */}
          {poolSpot ? (
            <div className="mr-spot">
              <p className="mr-spot-head">{poolSpot.headline}</p>
              {poolSpot.sqrtPriceX96 ? (
                <p className="mr-spot-raw mono">
                  slot0().sqrtPriceX96 = {poolSpot.sqrtPriceX96}
                  {poolSpot.blockTag ? ` @ ${poolSpot.blockTag}` : ''}
                </p>
              ) : null}
              <p className="lnote">{poolSpot.note}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The narrow strip. What is true only inside a twenty-second window
          belongs on one line, not in the body: for almost every reader it is
          empty, and a card whose body can only be filled in that window renders
          as a column of dashes over a measurement taken minutes ago. */}
      {/* NOW, then LAST MEASURED, in that order and never blended. The strip
          used to carry the twenty-second explanation as well, once per card —
          three cards taught the reader the window three times and the state
          none. The window is a property of router quotes, so the board says it
          once, above. */}
      {/* NOW, and only NOW. Three exclusive states: a live quote with its own
          countdown, a refresh in flight, or nothing open. None of them owns the
          durable answer below — when a quote lapses this line changes and the
          rest of the card does not, which is the whole point of keeping the two
          apart. */}
      {/* Only while something IS open, or a measure is in flight. The clocks
          row below already says the quote is closed, and "No live quote"
          directly above "LIVE QUOTE · Expired" was the same fact twice in two
          shapes. The strip carries the live NUMBER, which the clocks row does
          not; with no number there is nothing for it to carry. */}
      {representation.openQuote && (representation.openQuote.state === 'live' || measuring) ? (
        <p
          className="mr-openquote"
          data-state={
            representation.openQuote.state === 'live'
              ? 'live'
              : measuring
                ? 'checking'
                : 'none'
          }
        >
          <span className="mr-lastseen-k">Now</span>
          {representation.openQuote.state === 'live' ? (
            <>
              <span className="pill cr-status" data-tone="good">
                Live quote
              </span>
              <strong className="mr-lastseen-v mono">{representation.openQuote.value}</strong>
            </>
          ) : measuring ? (
            <strong className="mr-lastseen-v">Checking live market…</strong>
          ) : (
            <>
              <strong className="mr-lastseen-v mono">{representation.openQuote.value}</strong>
              {representation.openQuote.note ? (
                <span className="cr-fact-note"> · {representation.openQuote.note}</span>
              ) : null}
            </>
          )}
        </p>
      ) : null}

      {/* The four clocks, side by side, shortest-lived first.
          This row owns every time on the card, and the strip above it owns
          every value — which is why the countdown and the "Last measured"
          suffix left that strip. They were the same two facts said twice in
          two shapes, and neither shape let a reader compare them.
          Comparing them is the whole point. An expired quote beside
          "Round trip · measured 13 min ago" says what actually happened;
          an expired quote on its own reads as the card going dark. */}
      <ul className="mr-clocks" aria-label={`${representation.issuerName} timing`}>
        {representation.clocks.map((clock) => (
          <li key={clock.id} data-tone={clock.tone}>
            <span className="mr-clock-k">{clock.label}</span>
            <strong className="mr-clock-v">{clock.state}</strong>
            {clock.detail ? <span className="mr-clock-d">{clock.detail}</span> : null}
          </li>
        ))}
      </ul>

      <p className="cr-verdict">{representation.outcomeBody}</p>

      {/* Whether the money comes back, directly under the verdict and above
          every other number. A quote says a router answered; this says what it
          answered — and the two came apart badly enough on live representations
          that the audit which found it is the reason this line exists. */}
      {representation.exit ? (
        <div className="mr-durable">
          {representation.exitBasis === 'last_measured' && representation.lastMeasuredLabel ? (
            <p className="mr-attribution">
              <span className="mr-attribution-k">Last measured</span> this answer stays on the card
              after a live quote expires
            </p>
          ) : null}
          <FactList
            facts={[representation.exit]}
            label={`${representation.issuerName} round trip`}
          />
        </div>
      ) : null}

      <FactList facts={representation.numbers} label={`${representation.issuerName} outcome`} />

      {/* What is not established, once, without a value column. Four rows of a
          dash read as a broken card; the reasons are the honest part and they
          are kept — they simply stop pretending to be values. Every one of them
          is also stated in full under Technical evidence. */}
      {representation.withheldCause ? (
        /* One cause, not four consequences. Cash back, effective price,
           reference and basis all go dark together because a single upstream
           measurement did not land, and printing the four downstream absences
           told a reader four times that something was missing without once
           saying what. The four are still readable in full under Technical
           evidence. */
        <div className="mr-withheld" aria-label={`${representation.issuerName} not established`}>
          <p className="mr-attribution">
            <span className="mr-attribution-k">Not established</span> at this size
          </p>
          <p className="mr-withheld-cause">{representation.withheldCause.headline}</p>
          <p className="cr-fact-note">{representation.withheldCause.detail}</p>
        </div>
      ) : representation.withheld.length > 0 ? (
        <div className="mr-withheld" aria-label={`${representation.issuerName} not established`}>
          <p className="mr-attribution">
            <span className="mr-attribution-k">Not established</span> at this size
          </p>
          <ul>
            {representation.withheld.map((fact) => (
              <li key={fact.label}>
                <span className="mr-withheld-k">{fact.label}</span>
                <span className="cr-fact-note">{fact.note}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The ladder, from the same stored run. Discover has rendered this all
          along; the only reason Stocks did not was that it never read it. */}
      {representation.ladder.length > 0 ? (
        <div className="mr-ladder">
          <p className="mr-attribution">
            <span className="mr-attribution-k">Round trip</span> at each reviewed size
          </p>
          <FactList facts={representation.ladder} label={`${representation.issuerName} ladder`} />
          {representation.ladderNote ? <p className="lnote">{representation.ladderNote}</p> : null}
        </div>
      ) : null}

      {/* History, and marked as history. Never in the same list as the numbers
          above it, which carry open evidence only — a background sample sitting
          in that list, in that style, is the confusion the engine grew a second
          field to prevent. */}
      {representation.lastSeen ? (
        <p className="mr-lastseen">
          <span className="mr-lastseen-k">{representation.lastSeen.label}</span>
          <strong className="mr-lastseen-v mono">{representation.lastSeen.value}</strong>
          <span className="cr-fact-note"> · {representation.lastSeen.note}</span>
        </p>
      ) : null}

      {/* The issuer's restrictions, unexpanded. They were inside Terms, where
          every one of them rendered as the word "Reviewed" — a grade of our
          evidence, sitting where a reader looks for a grade of their access.
          Whether Miorail read the document and whether you may hold the token
          are two different questions and one of them was answering the other. */}
      {representation.accessNotices.length > 0 ? (
        <div className="mr-access" aria-label={`${representation.issuerName} access`}>
          <p className="mr-attribution">
            <span className="mr-attribution-k">Access</span> the issuer&rsquo;s own terms — not a
            check on your wallet
          </p>
          <ul>
            {representation.accessNotices.map((notice) => (
              <li key={notice.label}>
                <span className="mr-access-k">{notice.label}</span>
                <span className="cr-fact-note">{notice.note}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="lnote">{representation.structureNote}</p>

      <details className="card-evidence">
        <summary>Terms of this representation</summary>
        <div className="card-evidence-body">
          <FactList facts={representation.terms} label={`${representation.issuerName} terms`} />
        </div>
      </details>

      <details className="card-evidence">
        <summary>Technical evidence</summary>
        <div className="card-evidence-body">
          <dl className="cr-facts">
            {representation.technical.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  <strong className="cr-v mono">{row.value}</strong>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </details>

      {actions.onInvestigate || actions.onWatch || actions.onUnwatch || actions.onInspectRoute ? (
        <div className="card-actions">
          {actions.onWatch || actions.onUnwatch ? (
            <button
              type="button"
              className="btn sec"
              disabled={
                watching ||
                removing ||
                (watched ? !actions.onUnwatch : !actions.onWatch || !representation.watchable)
              }
              title={
                watched
                  ? 'Remove this exact market question from Radar'
                  : (representation.watchUnavailableReason ?? undefined)
              }
              onClick={() =>
                watched
                  ? actions.onUnwatch?.(representation.tokenAddress)
                  : actions.onWatch?.(representation.tokenAddress)
              }
            >
              {watching
                ? 'Adding watch…'
                : removing
                  ? 'Removing watch…'
                  : watched
                    ? 'Remove watch'
                    : 'Watch this market'}
            </button>
          ) : null}
          {actions.onInvestigate ? (
            /* The deepest reading on the product for this exact address, and
               the one thing in this row that is a READING rather than a move.
               It gets the accent filled.
               The previous arrangement gave the fill to whichever prepare
               button matched the board's toggle, which cost twice. Investigate
               and `Prepare buy` came out identical — same accent, same
               outline, no way to tell a reading from an action — and the
               loudest thing on a card that withholds ranking was a side. Which
               way the board is asking is already stated by the Sell/Buy toggle
               above it; spending the fill on saying it again is what left this
               row with no hierarchy at all. */
            <button
              type="button"
              className="btn"
              onClick={() => actions.onInvestigate!(representation.tokenAddress)}
            >
              Investigate
            </button>
          ) : null}
          {/* Phase 17.4 — the measurement becomes an action.
              Stocks answered what the market does and stopped at a number; the
              only way through was a button called `Advanced: inspect route`,
              third in this row, leading to another surface. A person who has
              just read what a $1,000 exit costs has one next move, and naming
              it `Advanced` said it was not for them.
              Both sides are offered so that choosing one does not re-ask the
              question the whole board is answering: pressing Buy used to mean
              flipping the page's direction toggle, which re-measured every
              other representation on screen.
              Neither button submits, approves, or opens a wallet. They open the
              prepare step, which re-plans against fresh routes — the quote on
              this card expires in about twenty seconds and is never spent as
              executable state. */}
          {/* ONE accent, never two sentiments, and the two sides at EQUAL
              weight.
              Green buy and red sell were proposed and are the wrong tool here:
              this board withholds ranking on purpose — it never says which side
              is better — and green/red says exactly that. Red also already has
              a job on this surface, on the transfer gate that reads "the token
              refuses this sale"; spending it on a routine button costs the one
              colour that must mean stop.
              Weighting one side by the board's toggle was the same mistake in
              quieter clothes: it made a side the loudest thing on the card. The
              toggle above already says which way the question runs. Both sides
              are outlined, identical, and neither is urged. */}
          {actions.onPrepare && !inspectRouteUnavailable ? (
            <>
              <button
                type="button"
                className="btn alt"
                title="Opens the prepare step for this exact address. Nothing is approved, submitted, or signed here."
                onClick={() => actions.onPrepare!(representation.tokenAddress, 'buy')}
              >
                Prepare buy
              </button>
              <button
                type="button"
                className="btn alt"
                title="Opens the prepare step for this exact address. Nothing is approved, submitted, or signed here."
                onClick={() => actions.onPrepare!(representation.tokenAddress, 'sell')}
              >
                Prepare sell
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {/* What a sale is sized by, said before the button is pressed.
          The reader is looking at dollars and a sale is sized in TOKENS, so
          the prepare step used to open on "what exact amount should be
          swapped?" — a question this card had already answered, put to someone
          with no way to convert by hand. The number now travels; this line
          says where it came from, and that the price is established again.
          It is about the SELL button, not about the board's direction: both
          buttons are offered on every card, so a reader on a buy board who
          presses sell is exactly the one who would otherwise never see it.
          A buy needs no such line — it spends an exact number of USDC atoms. */}
      {actions.onPrepare && !inspectRouteUnavailable && representation.prepareSellSizeNote ? (
        <p className="mr-prepare-size">{representation.prepareSellSizeNote}</p>
      ) : null}
      {/* The route inspector keeps its place and loses its prominence: a small
          line under the actions, for a reader who wants the candidates rather
          than the plan. And the refusal, when there is one, is stated here in
          full rather than as a dead chip in the action row. */}
      {actions.onInspectRoute ? (
        <p className="mr-inspect">
          {inspectRouteUnavailable ? (
            <span className="mr-inspect-off">{inspectRouteUnavailable}</span>
          ) : (
            <button
              type="button"
              className="mr-inspect-link"
              onClick={() => actions.onInspectRoute!(representation.tokenAddress)}
            >
              Inspect route candidates
            </button>
          )}
        </p>
      ) : null}
    </article>
  );
}

function ChoiceButton({
  choice,
  selectedKey,
  onUnderlying,
}: {
  choice: UnderlyingChoiceViewV1;
  selectedKey: string | null;
  onUnderlying: (underlyingKey: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={choice.underlyingKey === selectedKey}
      className={`mr-choice${choice.underlyingKey === selectedKey ? ' on' : ''}`}
      onClick={() => onUnderlying(choice.underlyingKey)}
    >
      <span className="mr-choice-name">{choice.title}</span>
      <span className="mr-choice-sub">
        {/* The issuer list is the part that may be shortened; the tag is not.
            As a bare text node it could not shrink, so "Backed · Coinbase ·
            Dinari" pushed the badge out of the card and it rendered as
            "MULTI-" — a clipped word that reads like a bug, on the one chip
            that carries the page's whole point. */}
        <span className="mr-choice-issuers">{choice.issuerLine}</span>
        {choice.multiIssuer ? <span className="pill mr-choice-tag">multi-issuer</span> : null}
        {/* Kept on the row as well as in the section, so a reader who opens one
            anyway does not read an empty contract as a broken product. */}
        {choice.emptyNote ? <span className="pill mr-choice-tag">{choice.emptyNote}</span> : null}
      </span>
    </button>
  );
}

export function Chooser({
  choices,
  selectedKey,
  loading,
  error,
  onUnderlying,
}: {
  choices: readonly UnderlyingChoiceViewV1[];
  selectedKey: string | null;
  loading: boolean;
  error: string | null;
  onUnderlying: (underlyingKey: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StockFilterViewV1['id']>('all');
  // Derived from what is actually bound, never a literal. See `stockFiltersV1`.
  const filters = useMemo(() => stockFiltersV1(choices), [choices]);
  // A chip can disappear when the corpus changes under a reader who is standing
  // on it. Falling back to `all` beats rendering an empty list with no chip lit.
  const active = filters.some((entry) => entry.id === filter) ? filter : 'all';
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return choices.filter((choice) => {
      if (active === 'multi' && !choice.multiIssuer) return false;
      if (active !== 'all' && active !== 'multi' && !choice.issuerIds.includes(active))
        return false;
      return (
        !query ||
        `${choice.title} ${choice.identifier ?? ''} ${choice.issuerLine}`
          .toLowerCase()
          .includes(query)
      );
    });
  }, [choices, active, search]);
  const partitioned = useMemo(() => partitionChoicesBySupplyV1(visible), [visible]);
  if (error) return <p className="note warn">{error}</p>;
  if (choices.length === 0) {
    return (
      <p className="empty">
        {loading
          ? 'Reading the reviewed securities…'
          : 'No reviewed source has bound a Base contract to a security yet, so there is nothing to compare.'}
      </p>
    );
  }
  return (
    <div className="mr-browser">
      <label className="mr-search">
        <span className="sr-only">Search stocks</span>
        <input
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="Search stocks, ticker or ISIN"
        />
      </label>
      <div className="mr-filters" role="group" aria-label="Stock filters">
        {filters.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`pill${active === entry.id ? ' on' : ''}`}
            aria-pressed={active === entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="mr-choices" role="listbox" aria-label="Markets with tokens outstanding">
        {partitioned.live.map((choice) => (
          <ChoiceButton
            key={choice.underlyingKey}
            choice={choice}
            selectedKey={selectedKey}
            onUnderlying={onUnderlying}
          />
        ))}
      </div>
      {/* Reviewed, and empty. Not hidden, not ranked, not a quality judgement:
          the same denominator separation the comparison already publishes,
          applied to the list a reader picks from. Nine of the thirteen Coinbase
          contracts hold zero, and interleaving them made a product with four
          working markets look like one that mostly does not work. */}
      {partitioned.empty.length > 0 ? (
        <details className="mcp-tech mr-choices-empty">
          <summary>Reviewed, no tokens outstanding · {partitioned.empty.length}</summary>
          <p className="lnote">
            Every exact address below is reviewed and keeps all of its evidence. Supply was read and
            came back zero, so there is nothing outstanding to buy or sell at any size.
          </p>
          <div className="mr-choices" role="listbox" aria-label="Reviewed, no tokens outstanding">
            {partitioned.empty.map((choice) => (
              <ChoiceButton
                key={choice.underlyingKey}
                choice={choice}
                selectedKey={selectedKey}
                onUnderlying={onUnderlying}
              />
            ))}
          </div>
        </details>
      ) : null}
      {visible.length === 0 ? (
        <p className="empty">No reviewed stock matches these filters.</p>
      ) : null}
    </div>
  );
}

/**
 * A demoted representation: one line, expandable to the whole card.
 *
 * The sections below the primary board — the other issuers' structures, and the
 * contracts with nothing outstanding — were rendering full cards. Three of them
 * side by side is half a screen, and on a Coinbase-primary page all three
 * usually say the same three things: not covered, sell not sized, nothing
 * outstanding. That is a finding worth one line each, not worth the tallest
 * block on the page.
 *
 * Nothing is removed. The summary carries the identity, the state and the cost
 * grade — the three things a reader scans for — and the card underneath is the
 * same card, complete, one press away.
 */
function CompactRepresentation({
  representation,
  children,
}: {
  representation: RepresentationViewV1;
  children: React.ReactNode;
}) {
  return (
    <details className="mr-compact" data-outcome={representation.outcome}>
      <summary>
        <span className="cr-name">
          <TokenIdentityV1
            symbol={representation.issuerName}
            name={representation.structureLabel}
            tokenAddress={representation.tokenAddress}
          />
        </span>
        <span className="cr-chips">
          <span className="pill cr-status" data-tone={representation.outcomeTone}>
            {representation.outcomeChip}
          </span>
          {representation.exitCost ? (
            <span className="pill cr-status" data-tone={representation.exitCost.tone}>
              {representation.exitCost.chip}
            </span>
          ) : null}
        </span>
      </summary>
      {children}
    </details>
  );
}

/**
 * The answer, before the machinery that produced it.
 *
 * Everything in here is read off the same view the board below renders, so
 * the summary cannot drift from the evidence. It states a MEASUREMENT and its
 * age -- never a ranking, and never a claim that the trade would succeed.
 */
function HeadlineAnswer({
  headline,
  measuring,
  onMeasure,
  onPrepare,
}: {
  headline: StocksHeadlineViewV1;
  measuring: boolean;
  onMeasure?: () => void;
  onPrepare?: (tokenAddress: string, direction: 'buy' | 'sell') => void;
}) {
  const lead = headline.representation;
  return (
    <section className="mr-headline" aria-label="What this security answers right now">
      <div className="mr-headline-top">
        <div className="mr-headline-id">
          <h3>{headline.title}</h3>
          {headline.identifier ? <span className="mono d">{headline.identifier}</span> : null}
        </div>
        {lead ? (
          <span className="pill cr-status" data-tone={lead.tone}>{lead.chip}</span>
        ) : null}
      </div>
      <p className="mr-headline-q">{headline.questionLine}</p>

      {lead ? (
        <>
          <p className="mr-headline-rep">
            <strong>{lead.issuerName}</strong> <span className="d">{lead.structureLabel}</span>
            <span className="mono d"> · {lead.shortAddress}</span>
          </p>
          {/* The measurement stays on the card whatever the twenty-second quote
              is doing. An expired quote does not un-measure a round trip. */}
          {/* Only when there IS a measurement. The first draft printed
              "nothing has been measured" beside a body reading "a router did
              quote $1,000 12 min ago, and that quote has since expired" --
              two sentences about one fact, contradicting each other, because
              `lastSeen` carries a round trip and the body carries every other
              way a measurement can exist. The body is the authority; this slot
              exists to give the round trip the size it deserves, not to
              narrate its absence. */}
          {lead.lastSeen ? (
            <dl className="mr-headline-measure">
              <dt>{lead.lastSeen.label}</dt>
              <dd>
                <span className="mono">{lead.lastSeen.value}</span>
                <span className="d"> {lead.lastSeen.note}</span>
              </dd>
            </dl>
          ) : null}
          <p className="mr-headline-body">
            {lead.body} <span className="d">— {lead.attribution}</span>
          </p>
        </>
      ) : (
        <p className="mr-headline-body">
          {headline.primaryAbsence?.shortAddress ? (
            <>
              <span className="mono d">{headline.primaryAbsence.shortAddress}</span>{' '}
            </>
          ) : null}
          {headline.primaryAbsence?.sentence}
        </p>
      )}

      <div className="mr-headline-actions">
        {onMeasure ? (
          <button type="button" className="btn" onClick={onMeasure} disabled={measuring}>
            {measuring ? 'Measuring…' : 'Measure now'}
          </button>
        ) : null}
        {/* Both sides, like every card below.
            This summary used to offer ONE button, the side the board's toggle
            happened to be on — so a reader looking at a sell board was shown
            `Prepare sell` and nothing else, while every representation beneath
            it offered both. A summary that silently drops one of two available
            actions reads as a recommendation of the one it kept, which is the
            single thing this board must never do. */}
        {lead && onPrepare ? (
          <>
            <button
              type="button"
              className="btn alt"
              onClick={() => onPrepare(lead.tokenAddress, 'buy')}
            >
              Prepare buy
            </button>
            <button
              type="button"
              className="btn alt"
              onClick={() => onPrepare(lead.tokenAddress, 'sell')}
            >
              Prepare sell
            </button>
          </>
        ) : null}
        <span className="d mr-headline-more">
          {headline.alternativeCount} representation{headline.alternativeCount === 1 ? '' : 's'} below,
          with the evidence for each
        </span>
      </div>
    </section>
  );
}

export function MarketRealityScreen({ model }: { model: MarketRealityScreenModelV1 }) {
  const { actions } = model;
  // Membership, not order. `inComparison` comes from the view, which reads it
  // off supply — the screen performs no selection of its own.
  const representations = model.view?.representations ?? [];
  const compared = representations.filter((representation) => representation.inComparison);
  const outside = representations.filter((representation) => !representation.inComparison);
  // Order and heading, not a filter: every compared representation is still
  // rendered. `others` is empty when there is no Coinbase card to be other
  // than, so a Backed-only security is a board, not a demotion.
  const { primary, others } = partitionByIssuerRoleV1(compared);
  const board = primary.length > 0 ? primary : compared;
  // The answer card replaces the loose Measure button rather than joining it:
  // two controls with one label on one screen is a question about which one
  // the reader just pressed.
  const headline =
    model.surface === 'market' && model.historyPeriod === 'now'
      ? stocksHeadlineV1(model.view ?? null)
      : null;
  return (
    <section className="mr" aria-label="Market Reality">
      {/* What this page is, before what it counts. Coinbase B20 is the standard
          Base documents for tokenized stocks on this chain, and it is the scope
          a reader lands in; the wider corpus is one press away and is named
          with its size, so nothing is hidden — only ordered. */}
      {model.scope ? (
        <div className="mr-scope" aria-label="Corpus scope">
          <div>
            <h3>{model.scope.title}</h3>
            <p className="lnote">{model.scope.body}</p>
            {model.scope.aside ? <p className="lnote">{model.scope.aside}</p> : null}
          </div>
          {/* Which corpus, as a switch. The issuer chips below the search
              field filter WITHIN it; these choose which "within" means. */}
          {model.scope.options.length > 1 && model.onScope ? (
            <div className="mr-scope-switch" role="group" aria-label="Corpus">
              {model.scope.options.map((option) => (
                <button
                  key={option.scope}
                  type="button"
                  aria-pressed={option.scope === model.scope!.selected}
                  className={option.scope === model.scope!.selected ? 'on' : ''}
                  onClick={() => model.onScope?.(option.scope)}
                >
                  {option.label}
                  <span className="d"> {option.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="kpis" aria-label="Reviewed securities on Base">
        {model.counters.map((counter) => (
          <div className="kpi" key={counter.label}>
            <div className="k">{counter.label}</div>
            <div className={factClassV1(counter.tone).replace('cr-v', 'v')}>{counter.value}</div>
            {counter.note ? <div className="d">{counter.note}</div> : null}
          </div>
        ))}
      </div>

      {model.questionFixed ? null : (
        <Chooser
          choices={model.choices}
          selectedKey={model.selectedKey}
          loading={model.choicesLoading}
          error={model.choicesError}
          onUnderlying={actions.onUnderlying}
        />
      )}

      <div className="mr-surface-tabs tabbar" role="tablist" aria-label="Stock views">
        <button
          type="button"
          role="tab"
          aria-selected={model.surface === 'market'}
          className={`item${model.surface === 'market' ? ' on' : ''}`}
          onClick={(event) => {
            actions.onSurface('market');
            event.currentTarget.parentElement?.scrollIntoView({ block: 'start' });
          }}
        >
          Market Reality
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={model.surface === 'utility'}
          className={`item${model.surface === 'utility' ? ' on' : ''}`}
          onClick={(event) => {
            actions.onSurface('utility');
            event.currentTarget.parentElement?.scrollIntoView({ block: 'start' });
          }}
        >
          Use & access
        </button>
      </div>

      {/* The answer, immediately under the control that chooses which answer.
          Pressing a security or a tab now changes what is UNDER the reader's
          eyes, instead of something a screen and a half further down. */}
      {model.surface === 'market' ? <div className="mr-question" aria-label="The question">
        {model.questionFixed ? null : (
        <>
        <div className="tabbar" role="tablist" aria-label="Direction">
          {MARKET_REALITY_DIRECTIONS_V1.map((direction) => (
            <button
              key={direction}
              type="button"
              role="tab"
              aria-selected={direction === model.direction}
              className={`item${direction === model.direction ? ' on' : ''}`}
              onClick={() => actions.onDirection(direction)}
            >
              {DIRECTION_LABEL_V1[direction]}
            </button>
          ))}
        </div>
        <div className="tabbar" role="tablist" aria-label="Size">
          {MARKET_REALITY_SIZES_V1.map((size) => (
            <button
              key={size.requestedCashAtomic}
              type="button"
              role="tab"
              aria-selected={size.requestedCashAtomic === model.requestedCashAtomic}
              className={`item${size.requestedCashAtomic === model.requestedCashAtomic ? ' on' : ''}`}
              onClick={() => actions.onSize(size.requestedCashAtomic)}
            >
              {size.label}
            </button>
          ))}
        </div>
        </>
        )}
        {/* The control that closes the twenty-second gap. Absent rather than
            disabled when the server does not offer it. */}
        {actions.onMeasure && !headline && (
          <button
            type="button"
            className="btn mr-measure"
            onClick={actions.onMeasure}
            disabled={model.measuring || !model.selectedKey}
          >
            {model.measuring ? 'Measuring…' : 'Measure now'}
          </button>
        )}
        {actions.onOpenRadar ? (
          <button type="button" className="btn sec" onClick={actions.onOpenRadar}>
            Open Radar
          </button>
        ) : null}
      </div> : (
        <p className="cr-verdict" role="status" aria-live="polite">
          {/* Names the sections that are actually below it. This line promised
              "DeFi" long after the section itself stopped claiming that word:
              the lending check was renamed "Lend and borrow" precisely because
              it reads four lending venues and nothing else, and a reader whose
              page is headed DeFi takes "Not on these venues" for a verdict on
              the token's whole onchain use. Trading through an AMM is DeFi, it
              is the largest use these tokens have, and it is measured under
              Trade — which this heading did not even mention. */}
          Use &amp; access{model.view?.title ? ` · ${model.view.title}` : ''} — Trade, Transfer,
          Bridge and Lending
        </p>
      )}

      {/* Question, then answer, then the tools that change it. The card sits
          directly under the rails that set the size and direction, so pressing
          either changes what is under the reader's eyes. */}
      {headline ? (
        <HeadlineAnswer
          headline={headline}
          measuring={model.measuring}
          onMeasure={actions.onMeasure}
          onPrepare={actions.onPrepare}
        />
      ) : null}

      {model.surface === 'market' && actions.onAsk && model.ask ? (
        <StocksAskPanel model={model.ask} actions={{ onAsk: actions.onAsk }} />
      ) : null}

      {model.surface === 'market' && !model.questionFixed ? (
        <div
          className="tabbar mr-history-tabs"
          role="tablist"
          aria-label="Comparable market history"
        >
          {MARKET_REALITY_HISTORY_PERIODS_V1.map((period) => (
            <button
              key={period.key}
              type="button"
              role="tab"
              aria-selected={period.key === model.historyPeriod}
              className={`item${period.key === model.historyPeriod ? ' on' : ''}`}
              onClick={() => actions.onHistoryPeriod(period.key)}
            >
              {period.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* The sizes are the ladder's own rungs. A free size field would ask the
          engine a question it answers exactly or not at all, and an exact miss
          returns an empty board that reads as a broken product. */}
      <p className="lnote">
        {model.surface === 'market'
          ? 'Sizes are the rungs the public ladder actually measures. An exact size is the whole question — a $10,000 answer is not a $100 answer multiplied. A router quote is good for about twenty seconds, so a board that has been open a while is history until you measure again.'
          : 'What can be done with each exact Base address, measured first and documented second. Onchain policy checks are not KYC, jurisdiction eligibility, or legal permission to trade.'}
      </p>

      {model.measurementError ? <p className="note warn">{model.measurementError}</p> : null}
      {model.watchError ? <p className="note warn">{model.watchError}</p> : null}
      {/* What the measurement actually spent. "Everything was already current"
          and "two routers answered" are different facts, and a reader who
          pressed a button deserves to know which one happened. */}
      {model.measurementNote ? <p className="lnote mr-spent">{model.measurementNote}</p> : null}

      {model.viewError ? <p className="note warn">{model.viewError}</p> : null}
      {model.historyError && model.historyPeriod !== 'now' ? (
        <p className="note warn">{model.historyError}</p>
      ) : null}

      {!model.view ? (
        <p className="empty">
          {model.viewLoading
            ? 'Reading every reviewed representation…'
            : model.selectedKey
              ? 'No answer for this security.'
              : 'Pick a security above.'}
        </p>
      ) : (
        <>
          <div className="mr-head">
            <div className="mr-head-l">
              <h3 className="mr-title">{model.view.title}</h3>
              {model.view.identifier ? (
                <p className="mr-identifier mono">{model.view.identifier}</p>
              ) : null}
              {model.surface === 'market' ? <p className="sub">{model.view.questionLine}</p> : null}
            </div>
            <div className="mr-head-r">
              <span
                className="pill cr-status"
                data-tone={
                  model.surface === 'market' && model.historyPeriod === 'now'
                    ? model.view.coverageTone
                    : 'neutral'
                }
              >
                {model.surface === 'utility'
                  ? `${model.view.representations.length} exact-address map${
                      model.view.representations.length === 1 ? '' : 's'
                    }`
                  : model.historyPeriod === 'now'
                    ? model.view.coverageChip
                    : model.history
                      ? `${model.history.comparableCount} of ${model.history.representations.length} comparable`
                      : 'Reading history'}
              </span>
              <span className="d">
                {model.surface === 'market' && model.historyPeriod !== 'now'
                  ? (model.history?.targetLabel ?? 'historical target')
                  : `assembled ${model.view.assembledAge}`}
              </span>
            </div>
          </div>

          {model.surface === 'market' && model.historyPeriod === 'now' ? (
            <>
              <p className="cr-verdict">{model.view.coverageBody}</p>
              <FactList facts={model.view.comparisonSummary} label="Market Reality coverage" />
              {model.view.rankingNote ? (
                <p className="lnote mr-ranking">{model.view.rankingNote}</p>
              ) : null}
            </>
          ) : model.surface === 'utility' ? (
            <p className="cr-verdict">
              What can be established for each representation, without treating documentation as
              availability or a quote as execution.
            </p>
          ) : model.history ? (
            <>
              <p className="cr-verdict">
                {model.history.exactQuestion} at the nearest successful captured observation to{' '}
                {model.history.targetLabel}.
              </p>
              <p className="lnote mr-history-scope">{model.history.scope}</p>
            </>
          ) : null}

          {model.surface === 'market' && model.historyPeriod !== 'now' ? (
            model.history ? (
              <div className="mr-board" aria-label="Comparable historical observations">
                {model.history.representations.map((representation) => (
                  <ComparableHistoryCard
                    key={representation.tokenAddress}
                    representation={representation}
                    onInvestigate={actions.onInvestigate}
                  />
                ))}
              </div>
            ) : (
              <p className="empty">
                {model.historyLoading
                  ? 'Reading comparable observations…'
                  : 'No comparable history response.'}
              </p>
            )
          ) : (
            <>
              {/* Said once for the board. */}
              {model.surface === 'market' ? (
                <p className="lnote mr-quote-note">
                  A router quote is open for about twenty seconds. Anything older is what the last
                  measurement found, with its age on the card.
                </p>
              ) : null}
              {primary.length > 0 ? (
                <p className="mr-attribution mr-role-head">
                  <span className="mr-attribution-k">Primary representation</span> Coinbase B20, the
                  standard Base documents for tokenized stocks on this chain
                </p>
              ) : null}
              <div className="mr-board" aria-label="Reviewed representations">
                {board.map((representation) => (
                  <RepresentationCard
                    key={representation.tokenAddress}
                    representation={representation}
                    actions={actions}
                    surface={model.surface}
                    watched={
                      model.watchedTokenAddresses?.includes(representation.tokenAddress) ?? false
                    }
                    watching={model.watchingTokenAddress === representation.tokenAddress}
                    removing={model.removingWatchTokenAddress === representation.tokenAddress}
                    measuring={model.measuring}
                    useAccess={model.useAccess?.[representation.tokenAddress] ?? null}
                    useAccessLoading={model.useAccessLoading === true}
                    poolSpot={model.poolSpot?.[representation.tokenAddress] ?? null}
                    inspectRouteUnavailable={
                      model.inspectRouteUnavailable?.[representation.tokenAddress] ?? null
                    }
                  />
                ))}
              </div>
              {/* Phase 17.5 — said once, directly under the buttons that made
                  it necessary.
                  A measurement carries no implication that the reader may act
                  on it. A primary `Prepare buy` does, so the two facts a reader
                  needs before pressing one belong on this page and not in a
                  document: Base did not issue this, and the issuer restricts
                  who may hold it.
                  Rendered ONLY when a prepare action is actually offered. A
                  read-only board has nothing to disclaim, and a notice that
                  appears everywhere is read nowhere. */}
              {actions.onPrepare ? (
                <p className="mr-issuer-note">{STOCK_ISSUER_NOTICE_V1}</p>
              ) : null}
              {/* The same security through a different issuer's structure. This
                  is the comparison the product exists for — kept on the page,
                  and kept after the representation a reader can act on. */}
              {others.length > 0 && !model.questionFixed ? (
                <section className="mr-outside" aria-label="Other representations on Base">
                  <h4>Other representations of this security on Base</h4>
                  <p className="lnote">
                    Backed bTokens and Dinari dShares are separate systems, not B20. Same underlying
                    company, different structure, supply and market access — which is exactly why
                    they are measured separately here.
                  </p>
                  <div className="mr-compact-list">
                    {others.map((representation) => (
                      <CompactRepresentation
                        key={representation.tokenAddress}
                        representation={representation}
                      >
                        <RepresentationCard
                          representation={representation}
                          actions={actions}
                          surface={model.surface}
                          watched={
                            model.watchedTokenAddresses?.includes(representation.tokenAddress) ??
                            false
                          }
                          watching={model.watchingTokenAddress === representation.tokenAddress}
                          removing={model.removingWatchTokenAddress === representation.tokenAddress}
                          measuring={model.measuring}
                          useAccess={model.useAccess?.[representation.tokenAddress] ?? null}
                          useAccessLoading={model.useAccessLoading === true}
                          poolSpot={model.poolSpot?.[representation.tokenAddress] ?? null}
                          inspectRouteUnavailable={
                            model.inspectRouteUnavailable?.[representation.tokenAddress] ?? null
                          }
                        />
                      </CompactRepresentation>
                    ))}
                  </div>
                </section>
              ) : null}

              {/* Visible, and out of the comparison. Not a ranking: there is no
                  order here, only membership — a representation with nothing
                  outstanding is not being read against anything. */}
              {outside.length > 0 && !model.questionFixed ? (
                <section className="mr-outside" aria-label="Reviewed but outside current comparison">
                  <h4>Reviewed, outside the current comparison</h4>
                  <div className="mr-compact-list">
                    {outside.map((representation) => (
                      <CompactRepresentation
                        key={representation.tokenAddress}
                        representation={representation}
                      >
                        <RepresentationCard
                          representation={representation}
                          actions={actions}
                          surface={model.surface}
                          watched={
                            model.watchedTokenAddresses?.includes(representation.tokenAddress) ??
                            false
                          }
                          watching={model.watchingTokenAddress === representation.tokenAddress}
                          removing={model.removingWatchTokenAddress === representation.tokenAddress}
                          measuring={model.measuring}
                          useAccess={model.useAccess?.[representation.tokenAddress] ?? null}
                          useAccessLoading={model.useAccessLoading === true}
                          poolSpot={model.poolSpot?.[representation.tokenAddress] ?? null}
                          inspectRouteUnavailable={
                            model.inspectRouteUnavailable?.[representation.tokenAddress] ?? null
                          }
                        />
                      </CompactRepresentation>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          )}

          {model.view.representations.length === 0 ? (
            <p className="empty">No reviewed source has bound a Base contract to this security.</p>
          ) : null}

          <p className="discover-scope">
            {model.surface === 'market'
              ? model.historyPeriod === 'now'
                ? model.view.scope
                : (model.history?.scope ?? model.view.scope)
              : 'Mapped to exact Base addresses. Documentation, observed route reachability and personal eligibility remain separate evidence.'}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The rail: what this comparison checked, and what it did not.
 *
 * The absence list is a CONSTANT, not a computed one. A list that shrank when
 * a check happened to run would let a reader infer that everything not shown
 * was covered — and the three things below are never covered by this surface at
 * any point, however good the evidence gets.
 */
export const MARKET_REALITY_NOT_CHECKED_V1: readonly string[] = [
  'Whether a quote would still fill when signed — nothing here is simulated.',
  'Anything off Base. A representation on another chain is not on this board.',
  'Whether you personally may hold or redeem a representation.',
];

export function MarketRealityRail({ view }: { view: MarketRealityViewV1 | null }) {
  return (
    <>
      <div className="rp">
        <div className="rph">
          <span>This comparison</span>
        </div>
        <div className="rpb">
          {view ? (
            <>
              <div className="qrow">
                <span>Market answers</span>
                <span className={`v ${view.coverageTone === 'good' ? 'ok' : 'warn'}`}>
                  {view.coverageChip}
                </span>
              </div>
              <div className="qrow">
                <span>Comparison</span>
                <span className="v off">not ranked</span>
              </div>
              <div className="qrow">
                <span>Assembled</span>
                <span className="v">{view.assembledAge}</span>
              </div>
              {/* The engine's own wording. The body carries a reader sentence;
                  an operator checking WHY the gate did not pass needs the
                  policy named, and discarding it would make the two surfaces
                  disagree about the same verdict. */}
              {view.coverageDetail ? <p className="lnote">{view.coverageDetail}</p> : null}
            </>
          ) : (
            <p className="lnote">Nothing read yet.</p>
          )}
        </div>
      </div>
      <div className="rp">
        <div className="rph">
          <span>Not checked</span>
        </div>
        <div className="rpb">
          {MARKET_REALITY_NOT_CHECKED_V1.map((line) => (
            <p className="lnote" key={line}>
              {line}
            </p>
          ))}
        </div>
      </div>
    </>
  );
}
