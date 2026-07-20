// T60: pure presentational Intelligence Budget panel (wagmi-free by design,
// and — like DeepVerification — it MUST NOT import @mioagent/api-zod or
// @mioagent/api-spec: surfaces pass their already-fetched projection straight
// in). It renders only what it is told; it never fetches, signs, or charges.
// Money is shown as the decimal USDC strings the projection already carries
// (never re-derived from atomic amounts).

import React from 'react';
import { StateBadge, type StateKind } from './StateBadge';

void React;

/** Structural mirror of the API's IntelligenceBudgetProjectionV1 so lib/ui
 * stays free of any api-zod/api-spec dependency (the same boundary
 * DeepVerification keeps). Surfaces pass their api-spec object directly. */
export interface IntelligenceBudgetView {
  budgetId: string;
  status: 'active' | 'paused' | 'revoked' | 'expired';
  periodType: 'monthly';
  monthlyLimitUsdc: string;
  spentUsdc: string;
  reservedUsdc: string;
  remainingUsdc: string;
  maxPerRequestUsdc: string;
  allowedCategories: string[];
  linkedSpendPermissionId: string;
  periodStartedAt: string | null;
  periodEndsAt: string | null;
  chainId: number;
  walletAddress: string;
}

export interface IntelligenceBudgetPanelProps {
  /** null when the caller has no Intelligence Budget yet. */
  budget: IntelligenceBudgetView | null;
  /** Freshness/source of the projection (defaults to 'live' when a budget is
   * present, 'missing' when it is null). */
  status?: StateKind;
}

const STATUS_STATE: Record<IntelligenceBudgetView['status'], StateKind> = {
  active: 'live',
  paused: 'stale',
  revoked: 'disabled',
  expired: 'stale',
};

function truncatedId(id: string): string {
  return id.length > 22 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id;
}

function usd(amount: string): string {
  return `${amount} USDC`;
}

function formatWindow(startedAt: string | null, endsAt: string | null): string {
  if (!startedAt && !endsAt) return 'No fixed period';
  const start = startedAt ? startedAt.slice(0, 10) : '—';
  const end = endsAt ? endsAt.slice(0, 10) : '—';
  return `${start} → ${end}`;
}

export function IntelligenceBudgetPanel({ budget, status }: IntelligenceBudgetPanelProps) {
  if (!budget) {
    return (
      <section
        aria-label="Intelligence Budget"
        data-budget-status="none"
        className="rounded-xl border border-line bg-panel p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-sm font-semibold text-ink">Intelligence Budget</h3>
          <StateBadge state={status ?? 'missing'} label="none" />
        </div>
        <p className="mt-2 text-xs text-ink-2">
          No Intelligence Budget is linked yet. Link an active Spend Permission to pay for simulations without signing
          each time — bounded by monthly and per-request limits.
        </p>
      </section>
    );
  }

  const state = status ?? STATUS_STATE[budget.status];
  const window = formatWindow(budget.periodStartedAt, budget.periodEndsAt);

  return (
    <section
      aria-label="Intelligence Budget"
      data-budget-status={budget.status}
      className="rounded-xl border border-line bg-panel p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-sm font-semibold text-ink">Intelligence Budget</h3>
        <StateBadge state={state} label={budget.status} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-ink-3">Monthly limit</dt>
          <dd className="mt-0.5 font-mono text-ink">{usd(budget.monthlyLimitUsdc)}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Spent</dt>
          <dd className="mt-0.5 font-mono text-ink">{usd(budget.spentUsdc)}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Reserved</dt>
          <dd className="mt-0.5 font-mono text-ink">{usd(budget.reservedUsdc)}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Remaining</dt>
          <dd className="mt-0.5 font-mono text-ink" data-budget-field="remaining">
            {usd(budget.remainingUsdc)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Maximum per request</dt>
          <dd className="mt-0.5 font-mono text-ink">{usd(budget.maxPerRequestUsdc)}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Period window</dt>
          <dd className="mt-0.5 font-mono text-ink">{window}</dd>
        </div>
      </dl>

      <div className="mt-3 border-t border-line pt-3 text-xs">
        <dt className="text-ink-3">Allowed categories</dt>
        <dd className="mt-1 flex flex-wrap gap-1.5">
          {budget.allowedCategories.map((category) => (
            <span
              key={category}
              className="rounded-full bg-panel-2 px-2 py-0.5 font-mono text-[10px] text-ink-2"
            >
              {category}
            </span>
          ))}
        </dd>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 font-mono text-[10px] text-ink-3">
        <span title={budget.linkedSpendPermissionId}>
          Spend Permission {truncatedId(budget.linkedSpendPermissionId)}
        </span>
        <span>chain {budget.chainId}</span>
      </div>
    </section>
  );
}
