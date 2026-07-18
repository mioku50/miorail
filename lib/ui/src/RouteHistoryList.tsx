// T58: pure presentational Route Run history list (wagmi-free). The surfaces
// feed it pages from useRouteHistory; pagination is driven by the caller via
// onLoadMore + nextCursor — this component never fetches.

import React from 'react';
import { Badge, type BadgeTone } from './Badge';

void React;

export interface RouteHistoryItemView {
  routeRunId: string;
  createdAt: string;
  runStatus: string;
  intentHash: string;
  intentSummary: string;
  blueprintId: string | null;
  blueprintStatus: string | null;
  proofId: string | null;
  proofFinalStatus: string | null;
  reconciliationState: string | null;
  provider: string | null;
}

export interface RouteHistoryListProps {
  items: RouteHistoryItemView[];
  nextCursor: string | null;
  onSelect?: (item: RouteHistoryItemView) => void;
  onLoadMore?: (cursor: string) => void;
  loadingMore?: boolean;
}

const PROOF_TONE: Record<string, BadgeTone> = {
  pending: 'neutral',
  completed: 'ok',
  partial_failure: 'warn',
  failed: 'risk',
  cancelled: 'neutral',
  reconciliation_required: 'warn',
};

export function routeHistoryProofTone(finalStatus: string | null): BadgeTone {
  if (!finalStatus) return 'neutral';
  return PROOF_TONE[finalStatus] ?? 'neutral';
}

export function RouteHistoryList({ items, nextCursor, onSelect, onLoadMore, loadingMore = false }: RouteHistoryListProps) {
  if (items.length === 0) {
    return (
      <section aria-label="Route history" className="rounded-xl border border-line bg-panel p-6 text-center">
        <p className="text-sm text-ink-2">No route runs yet.</p>
        <p className="mt-1 text-xs text-ink-3">Runs appear here after you compare routes on the plan page.</p>
      </section>
    );
  }
  return (
    <section aria-label="Route history" className="space-y-2">
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.routeRunId}>
            <button
              type="button"
              onClick={() => onSelect?.(item)}
              data-route-run-id={item.routeRunId}
              className="w-full rounded-xl border border-line bg-panel p-4 text-left transition-colors hover:border-accent/45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-ink-3">
                  {new Date(item.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="neutral">{item.runStatus}</Badge>
                  {item.blueprintStatus && <Badge tone="accent">{item.blueprintStatus}</Badge>}
                  {item.proofFinalStatus && (
                    <Badge tone={routeHistoryProofTone(item.proofFinalStatus)}>{item.proofFinalStatus}</Badge>
                  )}
                </div>
              </div>
              <p className="mt-2 truncate text-sm text-ink" title={item.intentSummary}>
                {item.intentSummary}
              </p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10px] text-ink-3">
                {item.provider && <span>{item.provider}</span>}
                {item.reconciliationState && <span>reconciliation {item.reconciliationState}</span>}
                <span title={item.intentHash}>{item.intentHash.slice(0, 10)}…</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {nextCursor && onLoadMore && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => onLoadMore(nextCursor)}
          className="w-full rounded-xl border border-line bg-panel-2 px-4 py-2 text-sm text-ink-2 transition-colors hover:border-accent/45 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
