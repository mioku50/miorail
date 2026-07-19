import React, { useState } from 'react';
import type { RoutePlanEvidenceSummaryV1, RoutePlanProjectionV1, RoutePlanRouteV1 } from '@mioagent/route-card/contracts';
import {
  ROUTE_SCORE_LABELS,
  canReviewTransaction,
  defaultSelectedCandidateHash,
  formatEvidenceType,
  isRoutePlanExpired,
  routeDisplayLabel,
  routePlanOutcomeCopy,
  selectableSwapCandidates,
  swapPrepareErrorMessage,
} from './routePlanState';
import { TransactionReviewOutcome, type TransactionPrepareOutcomeV1 } from './TransactionReview';

void React;

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const amount = (value: RoutePlanRouteV1['expectedOutput']) => `${value.amountDecimal} ${value.asset.symbol}`;

export function PathScorePanel({ score }: { score: RoutePlanRouteV1['pathScore'] }) {
  return (
    <section aria-label="Path Score" className="border-t border-line pt-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-sm font-semibold text-ink">Path Score</h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">No overall score</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {score.dimensions.map((dimension) => (
          <div key={dimension.dimension} className="rounded-lg border border-line bg-bg/45 px-3 py-3">
            <p className="text-xs text-ink-2">{ROUTE_SCORE_LABELS[dimension.dimension]}</p>
            {dimension.status === 'scored' ? (
              <p className="mt-1 font-mono text-sm font-semibold text-ink">
                {dimension.score}/100 <span className="font-sans font-normal text-ink-3">· {titleCase(dimension.confidence!.label)} confidence</span>
              </p>
            ) : (
              <div className="mt-1">
                <p className="font-mono text-sm text-warn">Not scored</p>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                  {dimension.notScoredReason === 'not_requested'
                    ? 'Safety evidence was not requested at standard depth.'
                    : dimension.missingEvidence.length > 0
                      ? `${dimension.missingEvidence.map(formatEvidenceType).join(' and ')} evidence unavailable.`
                      : formatEvidenceType(dimension.notScoredReason ?? 'insufficient evidence')}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function EvidencePanel({ evidence, confidenceReasons = [] }: { evidence: RoutePlanEvidenceSummaryV1; confidenceReasons?: string[] }) {
  return (
    <section aria-label="Evidence" className="rounded-xl border border-line bg-panel-2/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-sm font-semibold text-ink">Evidence ledger</h3>
        <span className="rounded-full bg-accent-soft px-2 py-1 font-mono text-[10px] uppercase text-accent-2">{evidence.status}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <div><dt className="text-ink-3">Records</dt><dd className="mt-1 font-mono text-ink">{evidence.recordCount}</dd></div>
        <div><dt className="text-ink-3">Intelligence cost</dt><dd className="mt-1 font-mono text-ink">${evidence.paidCostUsd}</dd></div>
        <div><dt className="text-ink-3">Free / paid</dt><dd className="mt-1 font-mono text-ink">{evidence.freeEvidenceCount} / {evidence.paidEvidenceCount}</dd></div>
        <div><dt className="text-ink-3">Sources</dt><dd className="mt-1 font-mono text-ink">{evidence.sourceIndependence}</dd></div>
        <div><dt className="text-ink-3">Freshness</dt><dd className="mt-1 font-mono text-ink">{evidence.status}</dd></div>
      </dl>
      {evidence.missingEvidence.length > 0 && (
        <div className="mt-4 border-l-2 border-warn pl-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-warn">Missing evidence</p>
          <p className="mt-1 text-xs text-ink-2">{evidence.missingEvidence.map(formatEvidenceType).join(' · ')}</p>
        </div>
      )}
      {confidenceReasons.length > 0 && <p className="mt-4 text-[11px] leading-relaxed text-ink-3">Confidence: {confidenceReasons.map(formatEvidenceType).join(' · ')}</p>}
    </section>
  );
}

export function OverlapNotice({ overlaps }: { overlaps: RoutePlanProjectionV1['crossCandidateOverlaps'] }) {
  if (overlaps.length === 0) return null;
  return (
    <aside className="rounded-xl border border-warn/40 bg-warn-soft p-4 text-sm text-warn" role="note">
      <p className="font-semibold">Shared liquidity detected</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-2">These routes touch the same underlying pool or upstream source. They are not independent liquidity confirmations.</p>
    </aside>
  );
}

export function ProviderFailureNotice({ failures }: { failures: RoutePlanProjectionV1['providerFailures'] }) {
  if (failures.length === 0) return null;
  return (
    <aside className="rounded-xl border border-risk/35 bg-risk-soft p-4" role="status">
      <p className="text-sm font-semibold text-risk">Provider notices</p>
      <ul className="mt-2 space-y-1 font-mono text-[11px] text-ink-2">
        {failures.map((failure) => <li key={`${failure.provider}:${failure.errorCode}`}>{failure.provider} · {failure.errorCode}</li>)}
      </ul>
    </aside>
  );
}

export function RouteCandidateSummary({ route, label, muted = false }: { route: RoutePlanRouteV1; label: string; muted?: boolean }) {
  return (
    <article className={`relative rounded-2xl border p-5 ${muted ? 'border-line bg-panel/70' : 'border-accent/45 bg-panel shadow-[0_0_0_1px_rgba(70,80,240,.12)]'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent-2">{label}</p><h2 className="mt-1 font-display text-xl font-semibold text-ink">{route.provider.displayName}</h2></div>
        <div className="text-right"><p className="text-[11px] text-ink-3">Expected output</p><p className="font-mono text-lg font-semibold text-ink">{amount(route.expectedOutput)}</p></div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 border-y border-line py-4 sm:grid-cols-4">
        <div><p className="text-[11px] text-ink-3">Minimum</p><p className="mt-1 font-mono text-xs text-ink">{amount(route.minimumOutput)}</p></div>
        <div><p className="text-[11px] text-ink-3">Gas estimate</p><p className="mt-1 font-mono text-xs text-ink">{route.estimatedGas.estimatedCostUsd ? `$${route.estimatedGas.estimatedCostUsd}` : 'USD unavailable'}</p></div>
        <div><p className="text-[11px] text-ink-3">Impact / slippage</p><p className="mt-1 font-mono text-xs text-ink">{route.priceImpact.percent}% / {route.slippage.percent}%</p></div>
        <div><p className="text-[11px] text-ink-3">Calls / approvals</p><p className="mt-1 font-mono text-xs text-ink">{route.callCount} / {route.approvalCount}</p></div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-ink-3"><span>quote age {route.quoteAgeSeconds}s</span><span>expires {new Date(route.quoteExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
      <div className="mt-4"><PathScorePanel score={route.pathScore} /></div>
    </article>
  );
}

export interface RoutePlanViewProps {
  projection: RoutePlanProjectionV1;
  now?: Date;
  onRefresh?: () => void;
  /** Explicit candidate selection is presentational-only here; the server
   * re-validates the hash independently and never trusts client state. */
  selectedCandidateHash?: string | null;
  onSelectCandidate?: (candidateHash: string) => void;
  onReviewTransaction?: (candidateHash: string) => void;
  reviewPending?: boolean;
  transactionReview?: TransactionPrepareOutcomeV1 | null;
  /** Failed prepare mutation error (prepare.error). Rendered as an honest
   * "nothing was prepared" notice via swapPrepareErrorMessage — never
   * silently swallowed, never auto-retried. */
  transactionReviewError?: unknown;
  /** T57: surface-provided submission block (e.g. BlueprintSubmitButton +
   * SubmissionStatus wired in the surface). Rendered ONLY under a `prepared`
   * review, so no submit control can ever appear without a reviewed
   * blueprint. lib/ui stays wagmi-free — this is an opaque slot. */
  transactionSubmission?: React.ReactNode;
  /** T59: surface-provided <DeepVerification> + paid SimulateButton,
   * forwarded straight through to TransactionReviewOutcome/TransactionReview
   * — rendered inside the Simulation section, only under a `prepared`
   * review (see TransactionReview's own deepVerification prop). */
  deepVerification?: React.ReactNode;
}

export function RoutePlanView({
  projection,
  now = new Date(),
  onRefresh,
  selectedCandidateHash,
  onSelectCandidate,
  onReviewTransaction,
  reviewPending = false,
  transactionReview = null,
  transactionReviewError = null,
  transactionSubmission = null,
  deepVerification = null,
}: RoutePlanViewProps) {
  const expired = isRoutePlanExpired(projection, now);
  const copy = routePlanOutcomeCopy(projection);
  const primary = projection.recommendedRoute ?? projection.availableRoutes[0] ?? null;
  const candidates = selectableSwapCandidates(projection);
  const [internalSelected, setInternalSelected] = useState<string | null>(() => defaultSelectedCandidateHash(projection));
  const selected = selectedCandidateHash ?? internalSelected;
  const selectCandidate = (hash: string) => {
    setInternalSelected(hash);
    onSelectCandidate?.(hash);
  };
  const reviewable = !expired && canReviewTransaction({ projection, now }) && candidates.length > 0;
  return (
    <div className="space-y-4" data-route-plan-outcome={projection.outcome}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-pop">{expired ? 'Comparison expired' : copy.eyebrow}</p>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">{expired ? 'Refresh routes before relying on this plan' : copy.title}</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-2">{expired ? 'Quote expiry removed the recommendation. No provider was called automatically.' : copy.detail}</p>
        </div>
        <div className="rounded-full border border-accent/35 bg-accent-soft px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-accent-2">Read-only route comparison</div>
      </header>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,.7fr)]">
        <div className="relative space-y-4 pl-7 before:absolute before:bottom-8 before:left-[9px] before:top-8 before:w-px before:bg-accent">
          {primary && <RouteCandidateSummary route={primary} label={routeDisplayLabel({ projection, route: primary, expired })} muted={expired || projection.outcome === 'degraded'} />}
          {!primary && <div className="rounded-2xl border border-risk/35 bg-risk-soft p-6 text-sm text-ink-2">No valid route candidates were returned.</div>}
          {!expired && projection.alternatives.map((route) => <RouteCandidateSummary key={route.candidateHash} route={route} label="Alternative" muted />)}
        </div>
        <div className="space-y-4">
          <EvidencePanel evidence={projection.evidenceSummary} confidenceReasons={projection.comparisonConfidence.reasons} />
          <OverlapNotice overlaps={projection.crossCandidateOverlaps} />
          <ProviderFailureNotice failures={projection.providerFailures} />
          <section className="rounded-xl border border-line bg-panel p-4">
            <p className="text-xs text-ink-3">Optimization mode</p><p className="mt-1 font-mono text-sm text-ink">{formatEvidenceType(projection.optimizationMode)}</p>
            <p className="mt-3 text-xs text-ink-3">Comparison confidence</p><p className="mt-1 font-mono text-sm text-ink">{titleCase(projection.comparisonConfidence.label)} · {Math.round(projection.comparisonConfidence.value * 100)}%</p>
          </section>
        </div>
      </div>
      {reviewable && (
        <section aria-label="Candidate selection" className="rounded-xl border border-line bg-panel p-4">
          <h3 className="font-display text-sm font-semibold text-ink">Select a route to review</h3>
          <p className="mt-1 text-xs text-ink-2">Choose the recommended route or an alternative, then request a read-only review of the exact unsigned calls.</p>
          <fieldset className="mt-3 space-y-2">
            <legend className="sr-only">Swap candidate</legend>
            {candidates.map((candidate) => (
              <label key={candidate.candidateHash} className="flex items-center gap-2 text-sm text-ink-2">
                <input
                  type="radio"
                  name="swap-candidate"
                  value={candidate.candidateHash}
                  checked={selected === candidate.candidateHash}
                  onChange={() => selectCandidate(candidate.candidateHash)}
                />
                {candidate.providerLabel}
                {candidate.isRecommended && <span className="font-mono text-[10px] uppercase text-accent-2">recommended</span>}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={!selected || reviewPending}
            onClick={() => selected && onReviewTransaction?.(selected)}
            className="mt-4 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-2 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {reviewPending ? 'Preparing review…' : 'Review transaction'}
          </button>
        </section>
      )}
      {!reviewable && !expired && projection.outcome !== 'failed' && (
        <p className="text-xs text-ink-3">This comparison does not currently have a preparable Route Card.</p>
      )}
      {transactionReview && (
        <div className="mt-2">
          <TransactionReviewOutcome result={transactionReview} deepVerification={deepVerification} />
          {transactionReview.outcome === 'prepared' && transactionSubmission && (
            <div className="mt-4" data-transaction-submission-slot="prepared">
              {transactionSubmission}
            </div>
          )}
        </div>
      )}
      {transactionReviewError != null && (
        <div className="rounded-2xl border border-risk/35 bg-risk-soft p-6" role="alert">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-risk">Preparation failed</p>
          <p className="mt-2 text-sm text-ink-2">{swapPrepareErrorMessage(transactionReviewError)}</p>
        </div>
      )}
      {(expired || projection.outcome === 'failed') && onRefresh && <button type="button" onClick={onRefresh} className="rounded-full border border-accent px-4 py-2 text-sm font-semibold text-accent-2 hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">{expired ? 'Refresh routes' : 'Retry comparison'}</button>}
    </div>
  );
}
