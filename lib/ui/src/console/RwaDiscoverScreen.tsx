import React from 'react';

import { TokenIdentityV1 } from './TokenIdentity';
import {
  RWA_DISCOVER_TABS_V1,
  RWA_DISCOVER_TAB_LABEL_V1,
  type FactViewV1,
  type LookalikeAliasFilterV1,
  type LookalikeFeedViewV1,
  type OfficialAssetCardViewV1,
  type OfficialAssetsViewV1,
  type RwaDiscoverTabV1,
  type SignalFeedViewV1,
  type ToneV1,
} from './rwaDiscoverView';

void React;

// ---------------------------------------------------------------------------
// Phase 6 — Discover, rebuilt around the official corpus.
//
// The screen this replaces opened on a launch feed: 22,000 contracts anybody
// could deploy, ranked by what Miorail had measured about them. This one opens
// on thirteen assets Coinbase issued, and the first thing it says about each is
// who says it is official — before any price, any depth, any cost.
//
// That order is the product. A reader who meets a number first has already
// decided the thing is real by the time they reach the identity, and the whole
// lookalike layer exists because that assumption is wrong 112 times over on
// this chain today.
//
// Three rules this component holds to and cannot be talked out of:
//
//   * every value it renders arrives as a string or null from the view module.
//     It performs no arithmetic, so it cannot turn an absent measurement into
//     a zero;
//   * a warning is never behind a control. The disclaimer on the Lookalikes tab
//     and the "no route" sentence on a card are in the body, not in a details;
//   * engineering vocabulary lives under Technical evidence. A reader should
//     never have to know what `no_route_at_measured_sizes` is to use the page.
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

export interface RwaDiscoverActionsV1 {
  /** Open the full dossier for one address. */
  onInvestigate: (tokenAddress: string) => void;
  /** Add to the watchlist. Absent when the surface is not wired. */
  onWatch?: (tokenAddress: string) => void;
  /** Hand the address to the route surface. Absent when not wired. */
  onFindRoute?: (tokenAddress: string) => void;
}

export interface RwaDiscoverScreenModelV1 {
  tab: RwaDiscoverTabV1;
  onTab: (tab: RwaDiscoverTabV1) => void;

  official: OfficialAssetsViewV1 | null;
  officialLoading: boolean;
  /** Why there is no overview. Never a claim about the assets. */
  officialError: string | null;

  lookalikes: LookalikeFeedViewV1 | null;
  lookalikesLoading: boolean;
  lookalikesError: string | null;
  aliasFilter: LookalikeAliasFilterV1;
  onAliasFilter: (filter: LookalikeAliasFilterV1) => void;

  signals: SignalFeedViewV1 | null;
  signalsLoading: boolean;
  signalsError: string | null;

  actions: RwaDiscoverActionsV1;
  /**
   * The launch feed this page replaced, still reachable.
   *
   * Two shapes because the two shells navigate differently: the web console
   * has a router and takes an href, Base App has no URL and takes a callback.
   * Both null means the feed is not mounted here, and then nothing is offered
   * — a link to a screen that does not exist reads as a broken product.
   */
  launchFeedHref?: string | null;
  onOpenLaunchFeed?: (() => void) | null;
}

function OfficialAssetCard({
  card,
  actions,
}: {
  card: OfficialAssetCardViewV1;
  actions: RwaDiscoverActionsV1;
}) {
  return (
    <article className="cardrow" aria-label={`${card.ticker} ${card.tokenAddress}`}>
      <div className="cr-top">
        <span className="cr-name">
          {/* Symbol and address travel together, always. Two different
              CHEESEBURGE contracts once shared a screen with contradicting
              numbers and no address between them. */}
          <TokenIdentityV1
            symbol={card.ticker}
            name={card.displayName}
            tokenAddress={card.tokenAddress}
          />
        </span>
        <span className="pill g cr-status">{card.trustRoot}</span>
        <span className="pill cr-status" data-tone={card.status.tone}>
          {card.status.chip}
        </span>
      </div>

      {/* Identity before price. `listedIn` is who says this is official, and it
          is the first sentence on the card by design. */}
      <p className="lnote">
        Listed by {card.listedIn}. Identity is this exact address; the ticker is
        display metadata.
      </p>

      <p className="cr-verdict">{card.status.body}</p>

      {card.notices.map((notice) => (
        <p key={notice} className="note warn">
          {notice}
        </p>
      ))}

      <FactList facts={card.facts} label={`${card.ticker} value`} />

      {card.ladder.length > 0 && (
        <>
          <p className="lnote">
            <strong>Cash exit</strong>
            {card.ladderNote ? ` — ${card.ladderNote}` : null}
          </p>
          <FactList facts={card.ladder} label={`${card.ticker} cash exit`} />
        </>
      )}

      <FactList facts={card.market} label={`${card.ticker} market`} />

      {card.lookalikeNote ? <p className="lnote">{card.lookalikeNote}</p> : null}

      <details className="card-evidence">
        <summary>Technical evidence</summary>
        <div className="card-evidence-body">
          <dl className="cr-facts">
            {card.technical.map((row) => (
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

      <div className="card-actions">
        <button type="button" className="btn" onClick={() => actions.onInvestigate(card.tokenAddress)}>
          Investigate
        </button>
        {/* A control that navigates nowhere is worse than an absent one: it
            looks like a broken product rather than an unfinished one. */}
        {actions.onWatch && (
          <button type="button" className="btn sec" onClick={() => actions.onWatch!(card.tokenAddress)}>
            Watch
          </button>
        )}
        {actions.onFindRoute && (
          <button
            type="button"
            className="btn sec"
            onClick={() => actions.onFindRoute!(card.tokenAddress)}
          >
            Find route
          </button>
        )}
      </div>
    </article>
  );
}

function OfficialTab({
  view,
  loading,
  error,
  actions,
}: {
  view: OfficialAssetsViewV1 | null;
  loading: boolean;
  error: string | null;
  actions: RwaDiscoverActionsV1;
}) {
  if (error) return <p className="note warn">{error}</p>;
  if (!view) return <p className="empty">{loading ? 'Reading the official corpus…' : 'No overview.'}</p>;

  return (
    <>
      {/* Blocks, not spans. `.kpi` styles its children but never declared their
          display, so inline elements ran the label, the number and the note
          together into one sentence — "Official issuance13Currently listed
          by…" — on every viewport. */}
      <div className="kpis" aria-label="Official corpus">
        {view.counters.map((counter) => (
          <div className="kpi" key={counter.label}>
            <div className="k">{counter.label}</div>
            <div className={factClassV1(counter.tone).replace('cr-v', 'v')}>{counter.value}</div>
            {counter.note ? <div className="d">{counter.note}</div> : null}
          </div>
        ))}
      </div>

      {/* A source that could not be read withdraws nothing, and the sentence
          saying so is in the body rather than the rail: the rail is where a
          reader looks for state, and this is a warning about what the cards
          below are worth. */}
      {view.sources
        .filter((source) => source.note !== null)
        .map((source) => (
          <p className="note warn" key={source.label}>
            {source.note}
          </p>
        ))}

      <div className="cardrows">
        {view.assets.map((card) => (
          <OfficialAssetCard key={card.tokenAddress} card={card} actions={actions} />
        ))}
      </div>
      {view.assets.length === 0 && (
        <p className="empty">
          No reviewed source currently lists an asset. That is a reading about our source checks, not
          about what Coinbase has issued.
        </p>
      )}
    </>
  );
}

function LookalikesTab({
  view,
  loading,
  error,
  filter,
  onFilter,
  actions,
}: {
  view: LookalikeFeedViewV1 | null;
  loading: boolean;
  error: string | null;
  filter: LookalikeAliasFilterV1;
  onFilter: (value: LookalikeAliasFilterV1) => void;
  actions: RwaDiscoverActionsV1;
}) {
  if (error) return <p className="note warn">{error}</p>;
  if (!view) return <p className="empty">{loading ? 'Reading the index…' : 'No lookalike feed.'}</p>;

  return (
    <>
      <p className="cr-verdict">{view.headline}</p>
      {/* In the body, not behind a control. A reader is here because something
          looked like something else, and the sentence that says a resemblance
          is not fraud has to be in front of them before any card is. */}
      <p className="note warn">{view.disclaimer}</p>
      {view.lastScan ? <p className="lnote">{view.lastScan}</p> : null}

      <div className="mcp-filters" role="group" aria-label="Which spelling">
        {view.filters.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`btn${filter === entry.id ? ' on' : ''}`}
            aria-pressed={filter === entry.id}
            onClick={() => onFilter(entry.id)}
          >
            {entry.label} {entry.count}
          </button>
        ))}
      </div>

      <div className="cardrows">
        {view.cards.map((card) => (
          <article className="cardrow" key={card.tokenAddress}>
            <div className="cr-top">
              <span className="cr-name">
                <TokenIdentityV1
                  symbol={card.declaredSymbol || null}
                  name={card.declaredName || null}
                  tokenAddress={card.tokenAddress}
                />
              </span>
              {/* Not a severity. `n` is the neutral chip; there is no `danger`
                  tone on this card and no column in the database to sort by. */}
              <span className="pill n cr-status">NOT THE OFFICIAL CONTRACT</span>
            </div>

            <p className="lnote">
              Resembles <strong>{card.official.ticker}</strong>
              {card.official.displayName ? ` (${card.official.displayName})` : ''} at{' '}
              <span className="mono">{card.official.address}</span>.
            </p>
            <p className="cr-verdict">{card.matchedLabel}</p>
            <p className="lnote">{card.matchedNote}</p>

            <FactList facts={card.facts} label={`${card.tokenAddress} resemblance`} />

            <div className="card-actions">
              <button
                type="button"
                className="btn sec"
                onClick={() => actions.onInvestigate(card.tokenAddress)}
              >
                Investigate this contract
              </button>
              <button
                type="button"
                className="btn sec"
                onClick={() => actions.onInvestigate(card.official.address)}
              >
                Open {card.official.ticker}
              </button>
            </div>
          </article>
        ))}
      </div>
      {view.cards.length === 0 && (
        <p className="empty">
          Nothing on file wears that spelling. This is a reading of the launch index Miorail has
          scanned, not of every contract on Base.
        </p>
      )}
    </>
  );
}

function SignalsTab({
  view,
  loading,
  error,
  actions,
}: {
  view: SignalFeedViewV1 | null;
  loading: boolean;
  error: string | null;
  actions: RwaDiscoverActionsV1;
}) {
  if (error) return <p className="note warn">{error}</p>;
  if (!view) return <p className="empty">{loading ? 'Reading recorded changes…' : 'No signal feed.'}</p>;

  return (
    <>
      {/* The date is the point. "No signals" and "nothing has been watched yet"
          are the same empty list and opposite facts. */}
      {view.watching ? <p className="lnote">{view.watching}</p> : null}

      {view.cards.length === 0 ? (
        <p className="empty">{view.emptyNote}</p>
      ) : (
        <ul className="feed" aria-label="Recorded changes">
          {view.cards.map((card) => (
            <li key={card.signalId}>
              <span className="tm">{card.occurred}</span>
              <div>
                <strong>{card.title}</strong>
                <p className="lnote">{card.detail}</p>
                {/* The address, always. A signal about a contract wearing
                    AAPLc that offered only the word "AAPLc" would be two
                    cards a reader cannot tell apart. */}
                <button
                  type="button"
                  className="btn sec"
                  onClick={() => actions.onInvestigate(card.subject.address)}
                >
                  Open {card.subject.label}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {view.notReported.length > 0 && (
        <details className="card-evidence">
          <summary>What this feed does not report</summary>
          <div className="card-evidence-body">
            <ul className="lsteps">
              {view.notReported.map((line) => (
                <li key={line}>
                  <span className="lb">{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </>
  );
}

/**
 * The right rail: where the corpus's own reading came from, and how far the
 * ledger has been read.
 *
 * Both are state rather than findings, which is what a rail is for — and
 * keeping them out of the centre column is what lets an asset's identity be
 * the first thing on the page.
 */
export function RwaDiscoverRail({ view }: { view: OfficialAssetsViewV1 | null }) {
  if (!view) return null;
  return (
    <>
      <div className="rp">
        <div className="rph">
          <span>Reviewed sources</span>
        </div>
        <div className="rpb">
          {view.sources.map((source) => (
            <div className="qrow" key={source.label}>
              <span>{source.label}</span>
              <span className={`v ${source.tone === 'good' ? 'ok' : TONE_CLASS_V1[source.tone]}`}>
                {source.value}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="rp">
        <div className="rph">
          <span>Observed market</span>
        </div>
        <div className="rpb">
          {/* Never behind a control. "No movement observed" and "we have not
              looked" are the same empty number and opposite facts. */}
          <p className="lnote">{view.marketObservation}</p>
        </div>
      </div>
    </>
  );
}

export function RwaDiscoverScreen({ model }: { model: RwaDiscoverScreenModelV1 }) {
  return (
    <section className="panel" aria-label="Discover">
      <div className="ph">
        <h3>Discover</h3>
        <span className="sub">
          Assets an issuer publishes, what it costs to get back out, and what has changed.
        </span>
      </div>
      <div className="pb">
        <div className="mcp-filters" role="tablist" aria-label="Discover sections">
          {RWA_DISCOVER_TABS_V1.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={model.tab === tab}
              className={`btn${model.tab === tab ? ' on' : ''}`}
              onClick={() => model.onTab(tab)}
            >
              {RWA_DISCOVER_TAB_LABEL_V1[tab]}
            </button>
          ))}
        </div>

        {model.tab === 'official' && (
          <OfficialTab
            view={model.official}
            loading={model.officialLoading}
            error={model.officialError}
            actions={model.actions}
          />
        )}
        {model.tab === 'lookalikes' && (
          <LookalikesTab
            view={model.lookalikes}
            loading={model.lookalikesLoading}
            error={model.lookalikesError}
            filter={model.aliasFilter}
            onFilter={model.onAliasFilter}
            actions={model.actions}
          />
        )}
        {model.tab === 'signals' && (
          <SignalsTab
            view={model.signals}
            loading={model.signalsLoading}
            error={model.signalsError}
            actions={model.actions}
          />
        )}

        {/* Demoted, not deleted. The launch feed is still the deepest thing
            Miorail has measured; it is no longer the first thing a reader
            meets, because a launch anybody can deploy is not an asset. */}
        {(model.launchFeedHref || model.onOpenLaunchFeed) && (
          <p className="lnote">
            The B20 launch feed moved off this page.{' '}
            {model.onOpenLaunchFeed ? (
              <button type="button" className="btn sec" onClick={model.onOpenLaunchFeed}>
                Open measured B20 launches
              </button>
            ) : (
              <a href={model.launchFeedHref!}>Open measured B20 launches</a>
            )}
          </p>
        )}
      </div>
    </section>
  );
}
