// T61 §6 — the Earn Route Card, shared by the web console and Base App.
//
// Styling: console.css classes, NOT Tailwind. Neither build generates Tailwind
// utilities for `lib/*` sources, so this card shipped with none of its grids
// (`grid-cols-3`, `sm:grid-cols-4`, `sm:grid-cols-2`), none of its card
// surfaces (`rounded-2xl`, `rounded-xl`, `rounded-lg`) and neither of its
// action buttons — every `<dl>` collapsed into a stack of run-together words
// and "Review deposit" rendered as plain text. The vocabulary below is the one
// every other console panel uses, and consoleStyles.test.ts sweeps this file.
//
// Presentational only: the view model is derived in earnRouteCardState.ts and
// the server re-derives and re-validates every hash.

import React from 'react';
import type { EarnCandidateRowViewV1, EarnRouteCardViewV1 } from './earnRouteCardState';

void React;

function ApyComposition({ row }: { row: EarnCandidateRowViewV1 }) {
  return (
    <div className="kpis">
      <div className="kpi">
        <div className="k">Base APY</div>
        <div className="v mono">{row.baseApyLabel}</div>
      </div>
      <div className="kpi">
        <div className="k">Reward APY</div>
        <div className="v mono">{row.rewardApyLabel}</div>
      </div>
      <div className="kpi">
        <div className="k">Net APY</div>
        <div className="v mono">{row.netApyLabel}</div>
      </div>
    </div>
  );
}

function ScoreDimensions({ row }: { row: EarnCandidateRowViewV1 }) {
  return (
    <section aria-label="Earn score">
      <div className="sechead">
        <span>Earn score</span>
        <span>No overall score</span>
      </div>
      <div className="kpis two">
        {row.dimensions.map((dimension) => (
          <div key={dimension.key} className="kpi" data-earn-dimension={dimension.key}>
            <div className="k">{dimension.label}</div>
            {dimension.scored ? (
              <div className="v mono">{dimension.scoreLabel}</div>
            ) : (
              <>
                <div className="v mono warn">Not scored</div>
                {dimension.note && <div className="d">{dimension.note}</div>}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function EarnCandidateCard({
  row,
  selected,
  onSelect,
  selectable,
}: {
  row: EarnCandidateRowViewV1;
  selected: boolean;
  onSelect?: (hash: string) => void;
  selectable: boolean;
}) {
  return (
    <article
      data-earn-candidate={row.candidateHash}
      data-recommended={row.isRecommended ? 'true' : 'false'}
      className="panel"
    >
      <div className="ph">
        <h3>{row.protocolLabel}</h3>
        <span className="sub">{row.venueLabel}</span>
        <span className="rt">
          <span className={`pill ${row.isRecommended ? 'g' : 'n'}`}>
            {row.isRecommended ? 'Recommended' : 'Alternative'}
          </span>
        </span>
      </div>
      <div className="pb">
        <ApyComposition row={row} />

        <div className="sechead">
          <span>Position</span>
        </div>
        <div className="kpis">
          <div className="kpi">
            <div className="k">Liquidity</div>
            <div className="v mono" data-earn-liquidity-amount={row.liquidityAmountLabel}>
              {row.liquidityAmountLabel}
            </div>
            <div className="d">
              Depth: {row.liquidityLabel}
              {row.tvlAmountLabel !== '—' && ` · TVL: ${row.tvlAmountLabel}`}
            </div>
          </div>
          <div className="kpi">
            <div className="k">Withdrawal</div>
            <div className="v mono">{row.withdrawalLabel}</div>
          </div>
          <div className="kpi">
            <div className="k">Calls · est. gas</div>
            <div className="v mono">{row.callsLabel}</div>
            <div className="d">{row.gasLabel}</div>
          </div>
        </div>

        <div className="sechead">
          <span>Evidence</span>
          <span>{row.freshnessLabel}</span>
        </div>
        <div className="kpis" data-earn-provenance="live">
          <div className="kpi">
            <div className="k">Source</div>
            <div className="v mono">{row.sourceLabel}</div>
          </div>
          <div className="kpi">
            <div className="k">Updated</div>
            <div className="v mono">{row.observedAtLabel}</div>
          </div>
          <div className="kpi">
            <div className="k">Contract</div>
            <div className="v mono">{row.contractLabel}</div>
          </div>
        </div>

        {row.dataWarning && (
          <p className="note warn" data-earn-stale={row.isStale ? 'true' : 'false'}>
            {row.dataWarning}
          </p>
        )}

        {row.missingEvidenceLabels.length > 0 && (
          <p className="note warn">Missing evidence: {row.missingEvidenceLabels.join(' · ')}</p>
        )}

        <ScoreDimensions row={row} />

        {selectable && onSelect && (
          <label className="note">
            <input
              type="radio"
              name="earn-candidate"
              value={row.candidateHash}
              checked={selected}
              onChange={() => onSelect(row.candidateHash)}
            />{' '}
            Select {row.protocolLabel} to review the deposit
          </label>
        )}
      </div>
    </article>
  );
}

export interface EarnRouteCardViewProps {
  view: EarnRouteCardViewV1;
  onRefresh?: () => void;
  /** Presentational-only; the server re-derives and re-validates every hash. */
  selectedCandidateHash?: string | null;
  onSelectCandidate?: (candidateHash: string) => void;
  onReviewDeposit?: (candidateHash: string) => void;
  reviewPending?: boolean;
}

export function EarnRouteCardView({
  view,
  onRefresh,
  selectedCandidateHash = null,
  onSelectCandidate,
  onReviewDeposit,
  reviewPending = false,
}: EarnRouteCardViewProps) {
  const selectable = Boolean(onSelectCandidate);
  const selected = selectedCandidateHash;
  return (
    <div data-earn-card-status={view.status}>
      <div className="sechead">
        <span>Earn Route Card</span>
        <span>Read-only comparison</span>
      </div>
      <div className="panel">
        <div className="ph">
          <h3>Deposit {view.amountLabel} for yield</h3>
          <span className="rt">
            <span className="pill n" data-earn-route-coverage={view.routeCoverageLabel}>
              {view.routeCoverageLabel}
            </span>
          </span>
        </div>
        <div className="pb">
          <div className="kv">
            <span className="k">Optimization</span>
            <span className="v">{view.optimizationLabel}</span>
          </div>
          <div className="kv">
            <span className="k">Live data</span>
            <span className="v mono" data-earn-data-source={view.dataSourceLabel}>
              {view.dataSourceLabel}
            </span>
          </div>
          <div className="kv">
            <span className="k">Updated</span>
            <span className="v mono">{view.lastUpdatedLabel}</span>
          </div>
        </div>
      </div>

      {view.staleWarning && (
        <aside className="panel" role="note" data-earn-stale-warning="true">
          <div className="ph">
            <h3>Some readings are not fresh</h3>
            <span className="rt">
              <span className="pill a">Stale</span>
            </span>
          </div>
          <div className="pb">
            <p className="note warn">{view.staleWarning}</p>
          </div>
        </aside>
      )}

      {view.status === 'recommendation' && view.recommendation ? (
        <aside className="panel" role="note">
          <div className="ph">
            <h3>Recommended: {view.recommendation.protocolLabel}</h3>
          </div>
          {view.recommendation.reason && (
            <div className="pb">
              <p className="note">{view.recommendation.reason}</p>
            </div>
          )}
        </aside>
      ) : (
        <aside className="panel" role="note" data-earn-degraded="true">
          <div className="ph">
            <h3>No confident recommendation</h3>
            <span className="rt">
              <span className="pill a">Degraded</span>
            </span>
          </div>
          <div className="pb">
            <p className="note warn">
              {view.degradedReason ?? 'The available evidence does not support recommending a route. Compare the options below.'}
            </p>
          </div>
        </aside>
      )}

      {view.rows.map((row) => (
        <EarnCandidateCard
          key={row.candidateHash}
          row={row}
          selected={selected === row.candidateHash}
          onSelect={onSelectCandidate}
          selectable={selectable}
        />
      ))}
      {view.rows.length === 0 && <p className="empty">No earn candidates were returned.</p>}

      <div className="card-actions">
        {selectable && onReviewDeposit && (
          <button
            type="button"
            className="btn lg"
            disabled={!selected || reviewPending}
            onClick={() => selected && onReviewDeposit(selected)}
          >
            {reviewPending ? 'Preparing deposit…' : 'Review deposit'}
          </button>
        )}
        {onRefresh && (
          <button type="button" className="btn sec" onClick={onRefresh}>
            Refresh comparison
          </button>
        )}
      </div>
    </div>
  );
}
