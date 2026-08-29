import React from 'react';

import { TokenIdentityV1 } from './TokenIdentity';
import type { MarketRealityRadarViewV1 } from './marketRealityRadarView';

void React;

export interface MarketRealityRadarScreenModelV1 {
  view: MarketRealityRadarViewV1 | null;
  loading: boolean;
  error: string | null;
  removingWatchId: string | null;
  onRemove: (watchId: string) => void;
  onOpenMarket: (watchId: string) => void;
}

export function MarketRealityRadarScreen({
  model,
}: {
  model: MarketRealityRadarScreenModelV1;
}) {
  return (
    <section className="radar" aria-label="Market Reality Radar">
      <header className="radar-hero">
        <div>
          <p className="eyebrow">Exact-market monitoring</p>
          <h2>Market Reality Radar</h2>
          <p>
            Come back to the changes in the exact tokenized-stock market you chose — not a
            generic ticker price alert.
          </p>
        </div>
        <div className="radar-counts" aria-label="Radar totals">
          <span><strong>{model.view?.watches.length ?? 0}</strong> watched markets</span>
          <span><strong>{model.view?.events.length ?? 0}</strong> established changes</span>
        </div>
      </header>

      {model.error ? <p className="note warn">{model.error}</p> : null}
      {!model.view ? (
        <p className="empty">{model.loading ? 'Reading your exact market watches…' : 'Radar did not answer.'}</p>
      ) : (
        <>
          <section className="radar-section" aria-labelledby="radar-watches-title">
            <div className="radar-section-head">
              <h3 id="radar-watches-title">Watched markets</h3>
              <span>assembled {model.view.assembledAge}</span>
            </div>
            {model.view.watches.length === 0 ? (
              <div className="radar-empty">
                <strong>No exact market is under watch.</strong>
                <p>Open Stocks, choose one representation and use “Watch this market”.</p>
              </div>
            ) : (
              <div className="radar-watch-grid">
                {model.view.watches.map((watch) => (
                  <article className="radar-watch" key={watch.watchId}>
                    <div className="cr-top">
                      <span className="cr-name">
                        <TokenIdentityV1
                          symbol={watch.title}
                          name={`${watch.issuerName} · ${watch.structureLabel}`}
                          tokenAddress={watch.tokenAddress}
                        />
                      </span>
                      <span className="pill cr-status" data-tone="neutral">{watch.statusLabel}</span>
                    </div>
                    <p className="radar-question mono">{watch.question}</p>
                    <p className="lnote">{watch.statusNote}</p>
                    {watch.lastComparableAge ? (
                      <p className="radar-clock">Last comparable point <strong>{watch.lastComparableAge}</strong></p>
                    ) : null}
                    {watch.technicalOutcome ? (
                      <p className="radar-technical">Technical state: {watch.technicalOutcome}</p>
                    ) : null}
                    <details className="card-evidence">
                      <summary>Exact watch key</summary>
                      <dl className="cr-facts card-evidence-body">
                        <div><dt>Route policy</dt><dd className="mono">{watch.routePolicyKey}</dd></div>
                        <div><dt>Approved sources</dt><dd className="mono">{watch.approvedSources}</dd></div>
                        <div><dt>Evaluation outcome</dt><dd className="mono">{watch.lastEvaluationOutcome ?? 'not_evaluated'}</dd></div>
                      </dl>
                    </details>
                    <div className="card-actions">
                      <button type="button" className="btn sec" onClick={() => model.onOpenMarket(watch.watchId)}>
                        Open market
                      </button>
                      <button
                        type="button"
                        className="btn sec"
                        disabled={model.removingWatchId === watch.watchId}
                        onClick={() => model.onRemove(watch.watchId)}
                      >
                        {model.removingWatchId === watch.watchId ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="radar-section" aria-labelledby="radar-events-title">
            <div className="radar-section-head">
              <h3 id="radar-events-title">Established changes</h3>
              <span>newest first</span>
            </div>
            {model.view.events.length === 0 ? (
              <div className="radar-empty">
                <strong>No comparable change has been established yet.</strong>
                <p>The first successful observation is a baseline. Failed reads create no event.</p>
              </div>
            ) : (
              <div className="radar-rail">
                {model.view.events.map((event) => (
                  <article className="radar-event" key={event.eventId}>
                    <div className="radar-node" aria-hidden="true" />
                    <div className="radar-event-body">
                      <div className="radar-event-meta">
                        <span>{event.title} · {event.issuerName}</span>
                        <time dateTime={event.occurredAt}>{event.occurredAge}</time>
                      </div>
                      <p className="radar-question mono">{event.question}</p>
                      <h4>{event.headline}</h4>
                      <p className="radar-primary">{event.primary}</p>
                      {event.secondary ? <p className="lnote">{event.secondary}</p> : null}
                      {event.delta ? <p className="radar-delta mono">{event.delta}</p> : null}
                      <details className="card-evidence">
                        <summary>Comparable evidence pair</summary>
                        <dl className="cr-facts card-evidence-body">
                          <div><dt>Previous snapshot</dt><dd className="mono">{event.previousSnapshotHash}</dd></div>
                          <div><dt>Next snapshot</dt><dd className="mono">{event.snapshotHash}</dd></div>
                          <div><dt>Approved sources</dt><dd className="mono">{event.approvedSources}</dd></div>
                          <div><dt>Event kind</dt><dd className="mono">{event.technicalKind}</dd></div>
                          <div><dt>Event facts</dt><dd className="mono">{event.technicalFacts}</dd></div>
                        </dl>
                      </details>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
          <p className="discover-scope">{model.view.scope}</p>
        </>
      )}
    </section>
  );
}
