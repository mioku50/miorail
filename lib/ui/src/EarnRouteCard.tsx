import React from 'react';
import type { EarnCandidateRowViewV1, EarnRouteCardViewV1 } from './earnRouteCardState';

void React;

function ApyComposition({ row }: { row: EarnCandidateRowViewV1 }) {
  return (
    <div className="mt-4 grid grid-cols-3 gap-2 border-y border-line py-3 text-center">
      <div>
        <p className="text-[11px] text-ink-3">Base APY</p>
        <p className="mt-1 font-mono text-xs text-ink">{row.baseApyLabel}</p>
      </div>
      <div>
        <p className="text-[11px] text-ink-3">Reward APY</p>
        <p className="mt-1 font-mono text-xs text-ink">{row.rewardApyLabel}</p>
      </div>
      <div>
        <p className="text-[11px] text-ink-3">Net APY</p>
        <p className="mt-1 font-mono text-xs font-semibold text-ink">{row.netApyLabel}</p>
      </div>
    </div>
  );
}

function ScoreDimensions({ row }: { row: EarnCandidateRowViewV1 }) {
  return (
    <section aria-label="Earn score" className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="font-display text-xs font-semibold text-ink">Earn score</h4>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">No overall score</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {row.dimensions.map((dimension) => (
          <div key={dimension.key} className="rounded-lg border border-line bg-bg/45 px-3 py-2" data-earn-dimension={dimension.key}>
            <p className="text-[11px] text-ink-2">{dimension.label}</p>
            {dimension.scored ? (
              <p className="mt-1 font-mono text-sm font-semibold text-ink">{dimension.scoreLabel}</p>
            ) : (
              <div className="mt-1">
                <p className="font-mono text-sm text-warn">Not scored</p>
                {dimension.note && <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{dimension.note}</p>}
              </div>
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
      className={`relative rounded-2xl border p-5 ${
        row.isRecommended ? 'border-accent/45 bg-panel shadow-[0_0_0_1px_rgba(70,80,240,.12)]' : 'border-line bg-panel/70'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent-2">
            {row.isRecommended ? 'Recommended' : 'Alternative'}
          </p>
          <h3 className="mt-1 font-display text-xl font-semibold text-ink">{row.protocolLabel}</h3>
          <p className="mt-0.5 text-xs text-ink-3">{row.venueLabel}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-ink-3">Net APY</p>
          <p className="font-mono text-lg font-semibold text-ink">{row.netApyLabel}</p>
        </div>
      </div>

      <ApyComposition row={row} />

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-ink-3">Liquidity</dt>
          <dd className="mt-1 font-mono text-ink" data-earn-liquidity-amount={row.liquidityAmountLabel}>
            {row.liquidityAmountLabel}
          </dd>
          <dd className="mt-0.5 text-[11px] text-ink-3">Depth: {row.liquidityLabel}</dd>
          {row.tvlAmountLabel !== '—' && (
            <dd className="mt-0.5 text-[11px] text-ink-3">TVL: {row.tvlAmountLabel}</dd>
          )}
        </div>
        <div>
          <dt className="text-ink-3">Withdrawal</dt>
          <dd className="mt-1 font-mono text-ink">{row.withdrawalLabel}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Calls</dt>
          <dd className="mt-1 font-mono text-ink">{row.callsLabel}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Est. gas</dt>
          <dd className="mt-1 font-mono text-ink">{row.gasLabel}</dd>
        </div>
      </dl>

      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-3" data-earn-provenance="live">
        <div>
          <dt className="text-ink-3">Source</dt>
          <dd className="mt-0.5 font-mono text-ink-2">{row.sourceLabel}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Updated</dt>
          <dd className="mt-0.5 font-mono text-ink-2">{row.observedAtLabel}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Contract</dt>
          <dd className="mt-0.5 font-mono text-ink-2">{row.contractLabel}</dd>
        </div>
      </dl>

      <p className="mt-2 font-mono text-[11px] text-ink-3">Evidence freshness: {row.freshnessLabel}</p>

      {row.dataWarning && (
        <p className="mt-2 border-l-2 border-warn pl-3 text-[11px] leading-relaxed text-warn" data-earn-stale={row.isStale ? 'true' : 'false'}>
          {row.dataWarning}
        </p>
      )}

      {row.missingEvidenceLabels.length > 0 && (
        <div className="mt-3 border-l-2 border-warn pl-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-warn">Missing evidence</p>
          <p className="mt-1 text-xs text-ink-2">{row.missingEvidenceLabels.join(' · ')}</p>
        </div>
      )}

      <ScoreDimensions row={row} />

      {selectable && onSelect && (
        <label className="mt-4 flex items-center gap-2 text-sm text-ink-2">
          <input
            type="radio"
            name="earn-candidate"
            value={row.candidateHash}
            checked={selected}
            onChange={() => onSelect(row.candidateHash)}
          />
          Select {row.protocolLabel} to review the deposit
        </label>
      )}
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
    <div className="space-y-4" data-earn-card-status={view.status}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-pop">Earn Route Card</p>
          <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
            Deposit {view.amountLabel} for yield
          </h2>
          <p className="mt-2 text-sm text-ink-2">Optimization: {view.optimizationLabel}</p>
          <p className="mt-1 font-mono text-[11px] text-ink-3" data-earn-data-source={view.dataSourceLabel}>
            Live data: {view.dataSourceLabel} · updated {view.lastUpdatedLabel}
          </p>
        </div>
        <div className="rounded-full border border-accent/35 bg-accent-soft px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-accent-2">
          Read-only comparison
        </div>
      </header>

      {view.staleWarning && (
        <aside className="rounded-xl border border-warn/40 bg-warn-soft p-4" role="note" data-earn-stale-warning="true">
          <p className="text-sm font-semibold text-warn">Some readings are not fresh</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-2">{view.staleWarning}</p>
        </aside>
      )}

      {view.status === 'recommendation' && view.recommendation ? (
        <aside className="rounded-xl border border-accent/40 bg-accent-soft p-4" role="note">
          <p className="text-sm font-semibold text-accent-2">Recommended: {view.recommendation.protocolLabel}</p>
          {view.recommendation.reason && <p className="mt-1 text-xs leading-relaxed text-ink-2">{view.recommendation.reason}</p>}
        </aside>
      ) : (
        <aside className="rounded-xl border border-warn/40 bg-warn-soft p-4" role="note" data-earn-degraded="true">
          <p className="text-sm font-semibold text-warn">No confident recommendation</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-2">
            {view.degradedReason ?? 'The available evidence does not support recommending a route. Compare the options below.'}
          </p>
        </aside>
      )}

      <div className="space-y-4">
        {view.rows.map((row) => (
          <EarnCandidateCard
            key={row.candidateHash}
            row={row}
            selected={selected === row.candidateHash}
            onSelect={onSelectCandidate}
            selectable={selectable}
          />
        ))}
        {view.rows.length === 0 && (
          <div className="rounded-2xl border border-risk/35 bg-risk-soft p-6 text-sm text-ink-2">
            No earn candidates were returned.
          </div>
        )}
      </div>

      {selectable && onReviewDeposit && (
        <button
          type="button"
          disabled={!selected || reviewPending}
          onClick={() => selected && onReviewDeposit(selected)}
          className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-2 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {reviewPending ? 'Preparing deposit…' : 'Review deposit'}
        </button>
      )}

      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-full border border-accent px-4 py-2 text-sm font-semibold text-accent-2 hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Refresh comparison
        </button>
      )}
    </div>
  );
}
