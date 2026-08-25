import React from 'react';

import { TokenIdentityV1 } from './TokenIdentity';
import type { FactViewV1, ToneV1 } from './rwaDiscoverView';
import type { InvestigateViewV1 } from './investigateView';

void React;

// ---------------------------------------------------------------------------
// Phase 7 — the deepest surface in the product, and the most careful.
//
// A reader arrives here with an address and no context. The order of the page
// is therefore the order of the questions: WHO is this, WHAT is established,
// WHAT is not, and only then any number.
//
// Two things it will not do, whatever the evidence looks like:
//
//   * call a movement a trade. The evidence layer establishes venue transfers,
//     and confirming one as a swap is a read against the venue's own event
//     that is not built. The section says so in its own body;
//   * show a relayed sender as a deployer. On a relayed transaction `tx.from`
//     is whoever paid to include it — for 458 stored launches, one of eight
//     bundlers — and the dossier's schema refuses to carry that address at all.
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

function Panel({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="ph">
        <h3>{title}</h3>
        {sub ? <span className="sub">{sub}</span> : null}
      </div>
      <div className="pb">{children}</div>
    </section>
  );
}

export interface InvestigateScreenModelV1 {
  /** What the reader typed, as they typed it. Never resolved from a symbol. */
  query: string;
  onQuery: (value: string) => void;
  onSubmit: () => void;
  /** Set when the input is not an address. The read never starts. */
  inputRefusal: string | null;
  loading: boolean;
  view: InvestigateViewV1 | null;
  /** Why there is no dossier. Never a claim about the address. */
  error: string | null;
  /** The unverified public-context card, rendered only on explicit request. */
  publicContext?: React.ReactNode;
  onFindRoute?: ((tokenAddress: string) => void) | null;
  onWatch?: ((tokenAddress: string) => void) | null;
}

export function InvestigateScreen({ model }: { model: InvestigateScreenModelV1 }) {
  const view = model.view;
  return (
    <>
      <Panel
        title="Investigate"
        sub="One Base address, read as deeply as the evidence allows."
      >
        <form
          className="b20-ask-form"
          onSubmit={(event) => {
            event.preventDefault();
            model.onSubmit();
          }}
        >
          <label htmlFor="investigate-address">Contract address</label>
          <div>
            <input
              id="investigate-address"
              name="investigate-address"
              value={model.query}
              maxLength={42}
              placeholder="0x…"
              onChange={(event) => model.onQuery(event.target.value)}
            />
            <button type="submit" className="btn">
              Read
            </button>
          </div>
        </form>
        {/* Stated before anyone types, not after they are refused. A symbol is
            exactly what an impostor supplies. */}
        <p className="lnote">
          An address, not a symbol. 61.7% of indexed launches share a symbol with another launch, so
          a name identifies nothing on this chain.
        </p>
        {model.inputRefusal ? <p className="note warn">{model.inputRefusal}</p> : null}
        {model.error ? <p className="note warn">{model.error}</p> : null}
        {model.loading ? <p className="empty">Reading the chain and the stored evidence…</p> : null}
      </Panel>

      {view && (
        <>
          <Panel title="Identity" sub={`Read ${view.readAt}`}>
            <div className="cr-top">
              <span className="cr-name">
                <TokenIdentityV1
                  symbol={view.displaySymbol}
                  name={view.displayName}
                  tokenAddress={view.tokenAddress}
                />
              </span>
              <span className="pill cr-status" data-tone={view.standing.tone}>
                {view.standing.chip}
              </span>
            </div>
            <p className="cr-verdict">{view.standing.body}</p>
            <FactList facts={view.identityFacts} label="Identity" />

            <p className="lnote">
              <strong>{view.origin.label}</strong> — {view.origin.detail}
            </p>
            {/* Rendered only when the launch went straight to the factory. */}
            {view.origin.address && (
              <p className="lnote mono">{view.origin.address}</p>
            )}
          </Panel>

          {/* The acceptance criterion, as a panel: a reader must be able to see
              what this read settled and what it did not. */}
          <Panel title="What this read established">
            {view.established.length === 0 ? (
              <p className="empty">
                Nothing on this address is established beyond what the chain itself answered.
              </p>
            ) : (
              <ul className="lsteps">
                {view.established.map((row) => (
                  <li key={row.claim}>
                    <span className="lb">{row.claim}</span>
                    <span className="vl">{row.evidence}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="What is not established"
            sub="Absences, not findings — almost none of these is a negative."
          >
            <ul className="lsteps">
              {view.unknown.map((row) => (
                <li key={row.claim} className="pending">
                  <span className="lb">{row.claim}</span>
                  <span className="vl">{row.reason}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Reference value">
            <FactList facts={view.reference} label="Reference value" />
          </Panel>

          <Panel title="Controls">
            <p className="lnote">{view.controls.note}</p>
            <FactList facts={view.controls.rows} label="Controls" />
          </Panel>

          <Panel title="Cash exit" sub={view.ladderNote ?? undefined}>
            {view.ladder.length === 0 ? (
              <p className="empty">
                Nothing has measured a cash route for this address. That is a gap in Miorail, not a
                finding about the token.
              </p>
            ) : (
              <FactList facts={view.ladder} label="Cash exit" />
            )}
          </Panel>

          <Panel title="Changes since the previous comparable reading">
            <p className="lnote">{view.change.headline}</p>
            <FactList facts={view.change.rows} label="Changes" />
          </Panel>

          <Panel title="Market topology">
            <FactList facts={view.topology} label="Market topology" />
          </Panel>

          <Panel title={view.activity.title}>
            {/* In the body, never behind a control. Without this sentence the
                counts above read as trades, and 2 of 34 measured movements
                through the v4 singleton carried no swap at all. */}
            <p className="note warn">{view.activity.semantics}</p>
            <p className="cr-verdict">{view.activity.headline}</p>
            <FactList facts={view.activity.facts} label="Observed market activity" />
            {view.activity.movements.length > 0 && (
              <ul className="feed" aria-label="Recent movements">
                {view.activity.movements.map((row) => (
                  <li key={`${row.venue}-${row.when}-${row.amount}`}>
                    <span className="tm">{row.when}</span>
                    <div>
                      <strong>{row.direction}</strong>
                      <p className="lnote mono">{row.amount}</p>
                      <p className="lnote">
                        Venue <span className="mono">{row.venue}</span> · other side{' '}
                        <span className="mono">{row.counterparty}</span> — a router as often as a
                        person, and never established as either.
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {model.publicContext}

          <div className="card-actions">
            {model.onFindRoute && (
              <button
                type="button"
                className="btn"
                onClick={() => model.onFindRoute!(view.tokenAddress)}
              >
                Find route
              </button>
            )}
            {model.onWatch && (
              <button
                type="button"
                className="btn sec"
                onClick={() => model.onWatch!(view.tokenAddress)}
              >
                Watch
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
