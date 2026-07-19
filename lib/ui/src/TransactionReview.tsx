import React from 'react';
import type { TransactionReviewProjectionV1 } from '@mioagent/route-card/transactionReview';

void React;

type SafetyResult = TransactionReviewProjectionV1['safety'];
type ContractSecurity = TransactionReviewProjectionV1['contractSecurity'];
type ExecutionCall = TransactionReviewProjectionV1['calls'][number];

const amount = (value: { amountDecimal: string; asset: { symbol: string } }) => `${value.amountDecimal} ${value.asset.symbol}`;
const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

function SafetyKernelPanel({ safety }: { safety: SafetyResult }) {
  return (
    <section aria-label="Safety Kernel" className="rounded-xl border border-line bg-panel-2/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-sm font-semibold text-ink">Safety Kernel</h3>
        <span className={`rounded-full px-2 py-1 font-mono text-[10px] uppercase ${safety.verdict === 'allowed' ? 'bg-accent-soft text-accent-2' : 'bg-risk-soft text-risk'}`}>
          {safety.verdict}
        </span>
      </div>
      <ul className="mt-3 space-y-2 text-xs">
        {safety.checks.map((check) => (
          <li key={check.id} className="flex items-start justify-between gap-3 border-b border-line/60 pb-2 last:border-b-0 last:pb-0">
            <div>
              <p className="text-ink">{check.description}</p>
              {check.detail && <p className="mt-0.5 text-[11px] text-ink-3">{check.detail}</p>}
            </div>
            <span className={`shrink-0 font-mono text-[10px] uppercase ${check.status === 'passed' ? 'text-accent-2' : check.status === 'failed' ? 'text-risk' : 'text-ink-3'}`}>
              {check.status}
            </span>
          </li>
        ))}
      </ul>
      {safety.blockedReason && <p className="mt-3 text-xs text-risk">{safety.blockedReason}</p>}
    </section>
  );
}

function ContractSecurityPanel({ contractSecurity }: { contractSecurity: ContractSecurity }) {
  return (
    <section aria-label="Contract and token security" className="rounded-xl border border-line bg-panel-2/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-sm font-semibold text-ink">Contract &amp; token security</h3>
        <span className="rounded-full bg-accent-soft px-2 py-1 font-mono text-[10px] uppercase text-accent-2">{contractSecurity.provider}</span>
      </div>
      <p className="mt-2 font-mono text-xs text-ink">{contractSecurity.status}</p>
      {contractSecurity.verdicts.length > 0 && (
        <ul className="mt-3 space-y-1 font-mono text-[11px] text-ink-2">
          {contractSecurity.verdicts.map((verdict) => (
            <li key={verdict.address}>{verdict.address} · {verdict.status}{verdict.summary ? ` — ${verdict.summary}` : ''}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CallRow({ call }: { call: ExecutionCall }) {
  return (
    <li className="rounded-lg border border-line bg-bg/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] uppercase text-accent-2">{call.index}. {call.callType}</span>
        <span className="font-mono text-[11px] text-ink-3">value {call.valueWei}</span>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-1 font-mono text-[11px] text-ink-2 sm:grid-cols-2">
        <div><dt className="text-ink-3">to</dt><dd>{call.to}</dd></div>
        {call.spender && <div><dt className="text-ink-3">spender</dt><dd>{call.spender}</dd></div>}
        {call.recipient && <div><dt className="text-ink-3">recipient</dt><dd>{call.recipient}</dd></div>}
        {call.amountAtomic && <div><dt className="text-ink-3">amount (atomic)</dt><dd>{call.amountAtomic}</dd></div>}
      </dl>
      <details className="mt-2">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wide text-ink-3">Calldata</summary>
        <p className="mt-1 break-all rounded bg-bg/70 p-2 font-mono text-[10px] text-ink-2">{call.data}</p>
      </details>
    </li>
  );
}

export interface TransactionReviewProps {
  projection: TransactionReviewProjectionV1;
  /** T59: opaque slot rendered inside the Simulation section — the surface
   * (interface/miniapp) renders <DeepVerification> + its own paid
   * SimulateButton here, only for a 'prepared' outcome and only behind the
   * paidIntelligence flag. Follows the SAME opaque-slot pattern as
   * RoutePlan.tsx's `transactionSubmission` — lib/ui stays wagmi-free. */
  deepVerification?: React.ReactNode;
}

export function TransactionReview({ projection, deepVerification = null }: TransactionReviewProps) {
  return (
    <div className="space-y-4" data-transaction-review-blueprint-status={projection.blueprintStatus}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-pop">Read-only · never signed or broadcast</p>
          <h2 className="mt-2 font-display text-xl font-semibold tracking-tight text-ink">Unsigned transaction review</h2>
          <p className="mt-2 max-w-2xl text-sm text-ink-2">
            {projection.provider.displayName} · {amount(projection.input)} → {amount(projection.expectedOutput)}
          </p>
        </div>
        <div className="rounded-full border border-accent/35 bg-accent-soft px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-accent-2">
          {projection.blueprintStatus}
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-panel p-4">
          <p className="text-xs text-ink-3">Exact input</p>
          <p className="mt-1 font-mono text-sm text-ink">{amount(projection.input)}</p>
        </div>
        <div className="rounded-xl border border-line bg-panel p-4">
          <p className="text-xs text-ink-3">Expires</p>
          <p className="mt-1 font-mono text-sm text-ink">{new Date(projection.quoteExpiry).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
        </div>
        <div className="rounded-xl border border-line bg-panel p-4">
          <p className="text-xs text-ink-3">Fresh expected / minimum output</p>
          <p className="mt-1 font-mono text-sm text-ink">{amount(projection.expectedOutput)} / {amount(projection.minimumOutput)}</p>
        </div>
        <div className="rounded-xl border border-line bg-panel p-4">
          <p className="text-xs text-ink-3">Route Card expected / minimum output</p>
          <p className="mt-1 font-mono text-sm text-ink">{amount(projection.cardExpectedOutput)} / {amount(projection.cardMinimumOutput)}</p>
        </div>
      </div>

      <section aria-label="Calls" className="rounded-xl border border-line bg-panel p-4">
        <h3 className="font-display text-sm font-semibold text-ink">Calls ({projection.calls.length})</h3>
        <ul className="mt-3 space-y-2">
          {projection.calls.map((call) => <CallRow key={call.index} call={call} />)}
        </ul>
        <p className="mt-3 font-mono text-[11px] text-ink-3">Attached native value: {projection.attachedNativeValueWei} wei</p>
      </section>

      {projection.requiredApprovals.length > 0 && (
        <section aria-label="Required approvals" className="rounded-xl border border-line bg-panel p-4">
          <h3 className="font-display text-sm font-semibold text-ink">Required approvals</h3>
          <ul className="mt-3 space-y-1 font-mono text-[11px] text-ink-2">
            {projection.requiredApprovals.map((approval, index) => (
              <li key={`${approval.spender}:${index}`}>{approval.asset.symbol} · spender {approval.spender} · exact {approval.amountAtomic} · {approval.state}</li>
            ))}
          </ul>
        </section>
      )}

      <SafetyKernelPanel safety={projection.safety} />
      <ContractSecurityPanel contractSecurity={projection.contractSecurity} />

      <section aria-label="Simulation" className="rounded-xl border border-line bg-panel p-4">
        <h3 className="font-display text-sm font-semibold text-ink">Simulation</h3>
        <p className="mt-1 font-mono text-xs text-ink">{projection.simulationState.status}</p>
        {projection.simulationWarning && <p className="mt-2 text-xs text-warn">{projection.simulationWarning}</p>}
        {deepVerification}
      </section>

      <section aria-label="Blueprint identifiers" className="rounded-xl border border-line bg-panel p-4 font-mono text-[11px] text-ink-3">
        <p>Blueprint hash: {shortHash(projection.blueprintHash)}</p>
        <p>Calls hash: {shortHash(projection.callsHash)}</p>
      </section>

      <div role="note" aria-label="No execution control" className="rounded-xl border border-line bg-panel-2/60 p-4 text-xs text-ink-3">
        This is a read-only preview of unsigned calls. There is no Confirm, Approve, Execute, or Swap-now control here — nothing is signed or sent from this screen.
      </div>
    </div>
  );
}

export type TransactionPrepareOutcomeV1 =
  | { outcome: 'prepared'; review: TransactionReviewProjectionV1 }
  | { outcome: 'refresh_required'; reason: string; detail: string }
  | { outcome: 'unsupported'; reason: string; detail: string }
  | { outcome: 'blocked'; safety: SafetyResult };

export function TransactionReviewOutcome({
  result,
  deepVerification = null,
}: {
  result: TransactionPrepareOutcomeV1;
  deepVerification?: React.ReactNode;
}) {
  if (result.outcome === 'prepared') {
    return <TransactionReview projection={result.review} deepVerification={deepVerification} />;
  }
  if (result.outcome === 'refresh_required') {
    return (
      <div className="rounded-2xl border border-warn/35 bg-warn-soft p-6" role="status">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-warn">Refresh required</p>
        <p className="mt-2 text-sm text-ink-2">{result.detail}</p>
      </div>
    );
  }
  if (result.outcome === 'unsupported') {
    return (
      <div className="rounded-2xl border border-line bg-panel p-6" role="status">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">Not supported</p>
        <p className="mt-2 text-sm text-ink-2">{result.detail}</p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-risk/35 bg-risk-soft p-6" role="status">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-risk">Blocked</p>
      <div className="mt-3">
        <SafetyKernelPanel safety={result.safety} />
      </div>
    </div>
  );
}
