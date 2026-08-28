import React, { useMemo, useState } from 'react';

import { TokenIdentityV1 } from './TokenIdentity';
import {
  MARKET_REALITY_DIRECTIONS_V1,
  MARKET_REALITY_SIZES_V1,
  type FactViewV1,
  type MarketRealityDirectionV1,
  type MarketRealityViewV1,
  type RepresentationViewV1,
  type ToneV1,
  type UnderlyingChoiceViewV1,
} from './marketRealityView';

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
  onUnderlying: (underlyingKey: string) => void;
  onDirection: (direction: MarketRealityDirectionV1) => void;
  onSize: (requestedCashAtomic: string) => void;
  onSurface: (surface: MarketRealitySurfaceV1) => void;
  /** Open the full dossier for one address. Absent when not wired. */
  onInvestigate?: (tokenAddress: string) => void;
  /** Measure the exact question now. Absent when the server does not offer it,
   * because a control that answers with a refusal reads as a broken product. */
  onMeasure?: () => void;
}

export type MarketRealitySurfaceV1 = 'market' | 'utility';

export interface MarketRealityScreenModelV1 {
  choices: readonly UnderlyingChoiceViewV1[];
  choicesLoading: boolean;
  /** Why there is no chooser. Never a claim about the corpus. */
  choicesError: string | null;
  counters: readonly FactViewV1[];

  selectedKey: string | null;
  direction: MarketRealityDirectionV1;
  requestedCashAtomic: string;
  surface: MarketRealitySurfaceV1;

  view: MarketRealityViewV1 | null;
  viewLoading: boolean;
  viewError: string | null;

  /** A measurement is running. */
  measuring: boolean;
  /** What the last measurement spent, in a reader's words. Null before one. */
  measurementNote: string | null;
  measurementError: string | null;

  actions: MarketRealityActionsV1;
}

const DIRECTION_LABEL_V1: Readonly<Record<MarketRealityDirectionV1, string>> = {
  sell: 'Sell',
  buy: 'Buy',
};

function RepresentationCard({
  representation,
  actions,
  surface,
}: {
  representation: RepresentationViewV1;
  actions: MarketRealityActionsV1;
  surface: MarketRealitySurfaceV1;
}) {
  if (surface === 'utility') {
    return (
      <article className="mr-rep mr-utility-rep" aria-label={`${representation.issuerName} utility map`}>
        <div className="cr-top">
          <span className="cr-name">
            <TokenIdentityV1
              symbol={representation.issuerName}
              name={representation.structureLabel}
              tokenAddress={representation.tokenAddress}
            />
          </span>
          <span className="pill cr-status" data-tone="neutral">Exact address</span>
        </div>
        <p className="mr-caip mono">{representation.utility.caip10}</p>
        <p className="lnote">{representation.structureNote}</p>
        {representation.utility.groups.map((group) => (
          <section className="mr-utility-group" key={group.label} aria-label={group.label}>
            <h4>{group.label}</h4>
            <div className="mr-utility-edges">
              {group.edges.map((edge) => (
                <article className="mr-utility-edge" key={edge.edgeId} data-state={edge.state}>
                  <div className="mr-utility-edge-head">
                    <strong>{edge.label}</strong>
                    <span className="pill cr-status" data-tone={edge.state === 'stale' ? 'warn' : edge.state === 'not_established' ? 'off' : 'neutral'}>
                      {edge.stateLabel}
                    </span>
                  </div>
                  <p>{edge.note}</p>
                  <p className="lnote">Eligibility: {edge.eligibilityNote}</p>
                  <p className="mr-utility-meta">
                    Checked <span className="mono">{edge.checkedAt}</span>
                    {edge.providerLabel ? <> · source <span className="mono">{edge.providerLabel}</span></> : null}
                  </p>
                  {edge.sources.length > 0 ? (
                    <div className="mr-utility-sources" aria-label={`${edge.label} sources`}>
                      {edge.sources.map((source, index) =>
                        source.href ? (
                          <a key={`${source.label}:${index}`} href={source.href} target="_blank" rel="noreferrer">
                            {source.label}
                          </a>
                        ) : (
                          <span key={`${source.label}:${index}`}>{source.label}</span>
                        ),
                      )}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ))}
        {actions.onInvestigate ? (
          <div className="card-actions">
            <button type="button" className="btn sec" onClick={() => actions.onInvestigate!(representation.tokenAddress)}>
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

      <p className="cr-verdict">{representation.outcomeBody}</p>

      <FactList facts={representation.numbers} label={`${representation.issuerName} outcome`} />

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

      {actions.onInvestigate && (
        <div className="card-actions">
          <button
            type="button"
            className="btn sec"
            onClick={() => actions.onInvestigate!(representation.tokenAddress)}
          >
            Investigate
          </button>
        </div>
      )}
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
  const [filter, setFilter] = useState<'all' | 'multi' | 'coinbase' | 'dinari' | 'backed'>('all');
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return choices.filter((choice) => {
      if (filter === 'multi' && !choice.multiIssuer) return false;
      if (filter !== 'all' && filter !== 'multi' && !choice.issuerIds.includes(filter)) return false;
      return !query || `${choice.title} ${choice.identifier ?? ''} ${choice.issuerLine}`.toLowerCase().includes(query);
    });
  }, [choices, filter, search]);
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
        <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search stocks, ticker or ISIN" />
      </label>
      <div className="mr-filters" role="group" aria-label="Stock filters">
        {([
          ['all', 'All'],
          ['multi', 'Multi-issuer'],
          ['coinbase', 'Coinbase'],
          ['dinari', 'Dinari'],
          ['backed', 'Backed'],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" className={`pill${filter === id ? ' on' : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {label}
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
            </span>
          </button>
        ))}
      </div>
      {visible.length === 0 ? <p className="empty">No reviewed stock matches these filters.</p> : null}
    </div>
  );
}

export function MarketRealityScreen({ model }: { model: MarketRealityScreenModelV1 }) {
  const { actions } = model;
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
        <button type="button" role="tab" aria-selected={model.surface === 'market'} className={`item${model.surface === 'market' ? ' on' : ''}`} onClick={() => actions.onSurface('market')}>
          Market Reality
        </button>
        <button type="button" role="tab" aria-selected={model.surface === 'utility'} className={`item${model.surface === 'utility' ? ' on' : ''}`} onClick={() => actions.onSurface('utility')}>
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
      </div>

      {/* The sizes are the ladder's own rungs. A free size field would ask the
          engine a question it answers exactly or not at all, and an exact miss
          returns an empty board that reads as a broken product. */}
      <p className="lnote">
        {model.surface === 'market'
          ? 'Sizes are the rungs the public ladder actually measures. An exact size is the whole question — a $10,000 answer is not a $100 answer multiplied. A router quote is good for about twenty seconds, so a board that has been open a while is history until you measure again.'
          : 'Every utility edge belongs to the exact Base address shown on its card. Documented issuer processes, observed router reachability and personal eligibility are separate facts.'}
      </p>

      {model.measurementError ? <p className="note warn">{model.measurementError}</p> : null}
      {/* What the measurement actually spent. "Everything was already current"
          and "two routers answered" are different facts, and a reader who
          pressed a button deserves to know which one happened. */}
      {model.measurementNote ? <p className="lnote mr-spent">{model.measurementNote}</p> : null}

      {model.viewError ? <p className="note warn">{model.viewError}</p> : null}

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
              <span className="pill cr-status" data-tone={model.surface === 'market' ? model.view.coverageTone : 'neutral'}>
                {model.surface === 'market' ? model.view.coverageChip : `${model.view.representations.length} exact-address maps`}
              </span>
              <span className="d">assembled {model.view.assembledAge}</span>
            </div>
          </div>

          {model.surface === 'market' ? (
            <>
              <p className="cr-verdict">{model.view.coverageBody}</p>
              <FactList facts={model.view.comparisonSummary} label="Market Reality coverage" />
              {model.view.rankingNote ? <p className="lnote mr-ranking">{model.view.rankingNote}</p> : null}
            </>
          ) : (
            <p className="cr-verdict">What can be established for each representation, without treating documentation as availability or a quote as execution.</p>
          )}

          <div className="mr-board" aria-label="Reviewed representations">
            {model.view.representations.map((representation) => (
              <RepresentationCard
                key={representation.tokenAddress}
                representation={representation}
                actions={actions}
                surface={model.surface}
              />
            ))}
          </div>

          {model.view.representations.length === 0 ? (
            <p className="empty">No reviewed source has bound a Base contract to this security.</p>
          ) : null}

          <p className="discover-scope">
            {model.surface === 'market'
              ? model.view.scope
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
 * was covered — and the four things below are never covered by this surface at
 * any point, however good the evidence gets.
 */
export const MARKET_REALITY_NOT_CHECKED_V1: readonly string[] = [
  'Whether a quote would still fill when signed — nothing here is simulated.',
  'Anything off Base. A representation on another chain is not on this board.',
  'Whether you personally may hold or redeem a representation.',
  'History. This is the latest measurement, not a series.',
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
