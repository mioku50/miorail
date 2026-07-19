import React from 'react';

void React;

// T59 decision 11 — presentational block for the Simulation section of
// TransactionReview. Deliberately does NOT import from @mioagent/api-zod /
// @mioagent/api-spec (lib/ui stays decoupled from the wire schema package,
// matching how the rest of this file only knows @mioagent/route-card's
// TransactionReviewProjectionV1); the shape below is structurally
// compatible with SimulateBlueprintResponseV1's 'simulated'/'cached'
// branches, and the surface (interface/miniapp) adapts the real response
// into it. lib/ui stays wagmi-free — payment itself is an opaque ReactNode
// slot, exactly like RoutePlan.tsx's transactionSubmission slot.

export interface DeepVerificationStateChangeV1 {
  address: string;
  kind: 'balance' | 'storage' | 'token';
  summary: string;
}

export interface DeepVerificationResultV1 {
  outcome: 'simulated' | 'cached' | 'paid_service_failed' | 'invalid_response';
  provider?: { displayName: string } | null;
  blockNumber?: string | null;
  simulationStatus?: 'passed' | 'failed' | 'unavailable' | null;
  gasUsed?: string | null;
  stateChanges?: DeepVerificationStateChangeV1[];
  paidCostUsdc?: string | null;
  /** Full 32-byte tx hash; the component renders a shortened form + a
   * basescan.org link. null when unavailable (e.g. a cached replay — see
   * the paid-intelligence route's documented replay limitation). */
  x402TxHash?: string | null;
  evidenceHash?: string | null;
  /** Always 'not_scored' — T59 never invents a numeric transaction_safety
   * score ("No data — no score"). */
  transactionSafety: 'not_scored';
  missingEvidence: string[];
  /** Present for paid_service_failed / invalid_response — an honest,
   * non-internal reason string. */
  reason?: string | null;
}

export interface DeepVerificationProps {
  /** Pre-payment state: the price + the surface's own pay control (e.g.
   * @mioagent/x402-actions's SimulateButton) rendered as an opaque slot. */
  pending?: { priceLabel: string; payButton: React.ReactNode } | null;
  /** Post-payment result, once available. */
  result?: DeepVerificationResultV1 | null;
}

function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

function basescanTxUrl(txHash: string): string {
  return `https://basescan.org/tx/${txHash}`;
}

function formatEvidenceType(type: string): string {
  return type.replace(/_/g, ' ');
}

// A plain function (NOT a JSX component) called directly and inlined as a
// value — calling it via `<SimulationOutcomeLine .../>` would create an
// opaque React element whose `type` is the function itself, which
// JSON.stringify (this package's "no renderer" test technique) cannot see
// into; calling it as `simulationOutcomeLine(result)` returns the already
// -built <p> element, whose text children DO serialize.
function simulationOutcomeLine(result: DeepVerificationResultV1) {
  if (result.outcome === 'paid_service_failed') {
    return <p className="mt-1 font-mono text-xs text-risk">Simulation: Paid, but service failed{result.reason ? ` (${result.reason})` : ''}</p>;
  }
  if (result.outcome === 'invalid_response') {
    return <p className="mt-1 font-mono text-xs text-risk">Simulation: Invalid response from provider{result.reason ? ` (${result.reason})` : ''}</p>;
  }
  if (result.simulationStatus === 'passed') {
    return <p className="mt-1 font-mono text-xs text-accent-2">Simulation: Passed</p>;
  }
  if (result.simulationStatus === 'failed') {
    return <p className="mt-1 font-mono text-xs text-warn">Simulation: Reverted</p>;
  }
  return <p className="mt-1 font-mono text-xs text-ink-3">Simulation: Unavailable</p>;
}

export function DeepVerification({ pending, result }: DeepVerificationProps) {
  if (result) {
    return (
      <div className="mt-3 space-y-2 border-t border-line/60 pt-3" data-deep-verification-outcome={result.outcome}>
        {simulationOutcomeLine(result)}
        <p className="font-mono text-[11px] text-ink-3">Transaction safety: Not scored</p>
        {result.missingEvidence.length > 0 && (
          <p className="font-mono text-[11px] text-ink-3">
            Missing evidence: {result.missingEvidence.map(formatEvidenceType).join(', ')}
          </p>
        )}
        <dl className="mt-2 grid grid-cols-1 gap-1 font-mono text-[11px] text-ink-2 sm:grid-cols-2">
          {result.provider && (
            <div><dt className="text-ink-3">Provider</dt><dd>{result.provider.displayName}</dd></div>
          )}
          {result.blockNumber && (
            <div><dt className="text-ink-3">Block</dt><dd>{result.blockNumber}</dd></div>
          )}
          {result.gasUsed && (
            <div><dt className="text-ink-3">Gas used</dt><dd>{result.gasUsed}</dd></div>
          )}
          {result.paidCostUsdc && (
            <div><dt className="text-ink-3">Paid cost</dt><dd>{result.paidCostUsdc} USDC</dd></div>
          )}
          {result.x402TxHash && (
            <div>
              <dt className="text-ink-3">x402 tx</dt>
              <dd>
                <a href={basescanTxUrl(result.x402TxHash)} target="_blank" rel="noreferrer" className="text-accent-2 underline">
                  {shortHash(result.x402TxHash)}
                </a>
              </dd>
            </div>
          )}
          {result.evidenceHash && (
            <div><dt className="text-ink-3">Evidence hash</dt><dd>{shortHash(result.evidenceHash)}</dd></div>
          )}
        </dl>
        {result.stateChanges && result.stateChanges.length > 0 && (
          <div>
            <p className="mt-2 text-[11px] text-ink-3">Detected state changes</p>
            <ul className="mt-1 space-y-1 font-mono text-[11px] text-ink-2">
              {result.stateChanges.map((change, index) => (
                <li key={`${change.address}:${index}`}>{change.address} · {change.kind} · {change.summary}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  if (pending) {
    return (
      <div className="mt-3 flex flex-col gap-2 border-t border-line/60 pt-3" data-deep-verification-pending="true">
        <p className="text-xs text-ink-2">
          Run a real transaction simulation against an env-configured provider for {pending.priceLabel}.
        </p>
        {pending.payButton}
      </div>
    );
  }

  return null;
}
