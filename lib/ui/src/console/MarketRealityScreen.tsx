import React, { useMemo, useState } from 'react';

import { TokenIdentityV1 } from './TokenIdentity';
import {
  StocksAskPanel,
  type StocksAskPanelModelV1,
} from './StocksAskPanel';
import {
  MARKET_REALITY_DIRECTIONS_V1,
  MARKET_REALITY_SIZES_V1,
  stockFiltersV1,
  type FactViewV1,
  type StockFilterViewV1,
  type MarketRealityDirectionV1,
  type MarketRealityViewV1,
  type RepresentationViewV1,
  type ToneV1,
  type UnderlyingChoiceViewV1,
} from './marketRealityView';
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
  off: 'off',
  neutral: '',
};

function factClassV1(tone: ToneV1): string {
  const suffix = TONE_CLASS_V1[tone];
  return suffix ? `cr-v mono ${suffix}` : 'cr-v mono';
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
  inspectRouteUnavailable,
}: {
  representation: RepresentationViewV1;
  actions: MarketRealityActionsV1;
  surface: MarketRealitySurfaceV1;
  watched: boolean;
  watching: boolean;
  removing: boolean;
  inspectRouteUnavailable: string | null;
}) {
  if (surface === 'utility') {
    return (
      <article
        className="mr-rep mr-utility-rep"
        aria-label={`${representation.issuerName} utility map`}
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
        <p className="mr-caip mono">{representation.utility.caip10}</p>
        <p className="lnote">{representation.structureNote}</p>

        {/* The answer, before any document. The panel exists to say what a
            reader can do with THIS address; it used to open on a wall of
            citations and make them assemble that themselves. Same edges, same
            states — read in the order the question is asked. */}
        <div className="mr-utility-answer">
          <p className="cr-verdict">{representation.utility.answer.headline}</p>
          {representation.utility.answer.buckets.map((bucket) => (
            <div className="mr-utility-bucket" key={bucket.label}>
              <p className="mr-attribution">
                <span className="mr-attribution-k">{bucket.label}</span> {bucket.note}
              </p>
              <ul>
                {bucket.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {representation.utility.groups.map((group) => (
          <section className="mr-utility-group" key={group.label} aria-label={group.label}>
            <h4>{group.label}</h4>
            <div className="mr-utility-edges">
              {group.edges.map((edge) => (
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
                  {edge.edgeId === 'market_trade' ||
                  edge.edgeId === 'defi_reviewed_integrations' ||
                  edge.edgeId === 'issuer_primary_market' ||
                  edge.edgeId === 'representation_eligibility' ? (
                    <p className="lnote">Eligibility: {edge.eligibilityNote}</p>
                  ) : null}
                  {/* Evidence, on disclosure. The documents are what make the
                      line above trustworthy, not what a reader came for — and a
                      prospectus link rendered at the same weight as the answer
                      made every card read as a bibliography. The freshness stays
                      in the summary, because a reader deciding whether to trust
                      the line needs the age without opening anything. */}
                  {edge.sources.length === 0 && edge.providerLabel === null ? (
                    <p className="mr-utility-meta">No reviewed exact-address evidence</p>
                  ) : (
                    <details className="mcp-tech">
                      <summary>
                        {/* An age, with the exact instant one hover away. An ISO
                            string in UTC is a conversion, not an answer. */}
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
          </section>
        ))}
        {actions.onInvestigate ? (
          <div className="card-actions">
            <button
              type="button"
              className="btn sec"
              onClick={() => actions.onInvestigate!(representation.tokenAddress)}
            >
              Technical evidence
            </button>
          </div>
        ) : null}
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
        <span className="pill cr-status" data-tone={representation.outcomeTone}>
          {representation.outcomeChip}
        </span>
      </div>

      {/* Whose fact this is. The smallest thing on the card and the one that
          stops "not measured" from reading as "untradeable". */}
      <p className="mr-attribution">
        <span className="mr-attribution-k">Says</span> {representation.attribution}
      </p>

      {/* The narrow strip. What is true only inside a twenty-second window
          belongs on one line, not in the body: for almost every reader it is
          empty, and a card whose body can only be filled in that window renders
          as a column of dashes over a measurement taken minutes ago. */}
      {/* NOW, then LAST MEASURED, in that order and never blended. The strip
          used to carry the twenty-second explanation as well, once per card —
          three cards taught the reader the window three times and the state
          none. The window is a property of router quotes, so the board says it
          once, above. */}
      {representation.openQuote ? (
        <p className="mr-openquote">
          <span className="mr-lastseen-k">Now</span>
          <strong className="mr-lastseen-v mono">{representation.openQuote.value}</strong>
          {representation.openQuote.note ? (
            <span className="cr-fact-note"> · {representation.openQuote.note}</span>
          ) : null}
          {representation.lastMeasuredLabel ? (
            <span className="mr-openquote-last">{representation.lastMeasuredLabel}</span>
          ) : null}
        </p>
      ) : null}

      <p className="cr-verdict">{representation.outcomeBody}</p>

      {/* Whether the money comes back, directly under the verdict and above
          every other number. A quote says a router answered; this says what it
          answered — and the two came apart badly enough on live representations
          that the audit which found it is the reason this line exists. */}
      {representation.exit ? (
        <FactList
          facts={[representation.exit]}
          label={`${representation.issuerName} round trip`}
        />
      ) : null}

      <FactList facts={representation.numbers} label={`${representation.issuerName} outcome`} />

      {/* What is not established, once, without a value column. Four rows of a
          dash read as a broken card; the reasons are the honest part and they
          are kept — they simply stop pretending to be values. Every one of them
          is also stated in full under Technical evidence. */}
      {representation.withheld.length > 0 ? (
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
            <button
              type="button"
              className="btn sec"
              onClick={() => actions.onInvestigate!(representation.tokenAddress)}
            >
              Investigate
            </button>
          ) : null}
          {/* Phase 13.1. Secondary and last: Stocks answers what the market
              does, and execution is an optional capability a reader opts into.
              Pressing this opens a route inspection with this exact address
              prefilled; it submits nothing and approves nothing. */}
          {actions.onInspectRoute ? (
            inspectRouteUnavailable ? (
              <span className="pill cr-status" data-tone="off" title={inspectRouteUnavailable}>
                Advanced route unavailable
              </span>
            ) : (
              <button
                type="button"
                className="btn sec"
                title="Opens a route inspection for this exact address. Nothing is approved or submitted."
                onClick={() => actions.onInspectRoute!(representation.tokenAddress)}
              >
                Advanced: inspect route
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Chooser({
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
      <div className="mr-choices" role="listbox" aria-label="Reviewed stocks">
        {visible.map((choice) => (
          <button
            key={choice.underlyingKey}
            type="button"
            role="option"
            aria-selected={choice.underlyingKey === selectedKey}
            className={`mr-choice${choice.underlyingKey === selectedKey ? ' on' : ''}`}
            onClick={() => onUnderlying(choice.underlyingKey)}
          >
            <span className="mr-choice-name">{choice.title}</span>
            <span className="mr-choice-sub">
              {choice.issuerLine}
              {choice.multiIssuer ? <span className="pill mr-choice-tag">multi-issuer</span> : null}
              {/* Ordering puts these last; this is what stops a reader who
                  opens one anyway from reading an empty contract as a broken
                  product. */}
              {choice.emptyNote ? (
                <span className="pill mr-choice-tag">{choice.emptyNote}</span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="empty">No reviewed stock matches these filters.</p>
      ) : null}
    </div>
  );
}

export function MarketRealityScreen({ model }: { model: MarketRealityScreenModelV1 }) {
  const { actions } = model;
  // Membership, not order. `inComparison` comes from the view, which reads it
  // off supply — the screen performs no selection of its own.
  const representations = model.view?.representations ?? [];
  const compared = representations.filter((representation) => representation.inComparison);
  const outside = representations.filter((representation) => !representation.inComparison);
  return (
    <section className="mr" aria-label="Market Reality">
      <div className="kpis" aria-label="Reviewed securities on Base">
        {model.counters.map((counter) => (
          <div className="kpi" key={counter.label}>
            <div className="k">{counter.label}</div>
            <div className={factClassV1(counter.tone).replace('cr-v', 'v')}>{counter.value}</div>
            {counter.note ? <div className="d">{counter.note}</div> : null}
          </div>
        ))}
      </div>

      <Chooser
        choices={model.choices}
        selectedKey={model.selectedKey}
        loading={model.choicesLoading}
        error={model.choicesError}
        onUnderlying={actions.onUnderlying}
      />

      <div className="mr-surface-tabs tabbar" role="tablist" aria-label="Stock views">
        <button
          type="button"
          role="tab"
          aria-selected={model.surface === 'market'}
          className={`item${model.surface === 'market' ? ' on' : ''}`}
          onClick={() => actions.onSurface('market')}
        >
          Market Reality
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={model.surface === 'utility'}
          className={`item${model.surface === 'utility' ? ' on' : ''}`}
          onClick={() => actions.onSurface('utility')}
        >
          Utility + eligibility
        </button>
      </div>

      <div className="mr-question" aria-label="The question">
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
        {/* The control that closes the twenty-second gap. Absent rather than
            disabled when the server does not offer it. */}
        {actions.onMeasure && (
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
      </div>

      {actions.onAsk && model.ask ? (
        <StocksAskPanel model={model.ask} actions={{ onAsk: actions.onAsk }} />
      ) : null}

      {model.surface === 'market' ? (
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
          : 'Every utility edge belongs to the exact Base address shown on its card. Documented issuer processes, observed router reachability and personal eligibility are separate facts.'}
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
              <p className="sub">{model.view.questionLine}</p>
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
              <div className="mr-board" aria-label="Reviewed representations">
                {compared.map((representation) => (
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
                    inspectRouteUnavailable={
                      model.inspectRouteUnavailable?.[representation.tokenAddress] ?? null
                    }
                  />
                ))}
              </div>
              {/* Visible, and out of the comparison. Not a ranking: there is no
                  order here, only membership — a representation with nothing
                  outstanding is not being read against anything. */}
              {outside.length > 0 ? (
                <section className="mr-outside" aria-label="Reviewed but outside current comparison">
                  <h4>Reviewed, outside the current comparison</h4>
                  <div className="mr-board">
                    {outside.map((representation) => (
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
                        inspectRouteUnavailable={
                          model.inspectRouteUnavailable?.[representation.tokenAddress] ?? null
                        }
                      />
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
