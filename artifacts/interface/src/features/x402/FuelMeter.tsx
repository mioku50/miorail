import { useStatus, useX402Ledger, useX402Pricing } from '@mioagent/api-client-react';
import { StateBadge } from '@mioagent/ui';
import { useState } from 'react';
import { PaidActionButton } from './PaidActionButton';
import type { PaidActionError, PaidActionResult } from '../../lib/x402PaidFetch';

function Metric({ label, amount, sub }: { label: string; amount: string; sub: string }) {
  return (
    <div className="bg-panel-2 border border-line rounded-[var(--radius-md)] p-2.5">
      <div className="text-[10px] font-sans uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="text-[14px] font-mono font-bold text-ink truncate">{amount}</span>
        <span className="text-[11px] text-ink-3 font-mono">{sub}</span>
      </div>
    </div>
  );
}

function shortHash(value?: string | null): string {
  if (!value) return '';
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function baseScanTxUrl(network?: string, txHash?: string | null): string | null {
  if (!txHash) return null;
  if (network === 'eip155:84532') return `https://sepolia.basescan.org/tx/${txHash}`;
  if (network === 'eip155:8453') return `https://basescan.org/tx/${txHash}`;
  return null;
}

// x402 Fuel Meter — the pay-per-action differentiator.
// Shows honest empty states and operator guidance without fabricated numbers.
export function FuelMeter() {
  const { data: statusData } = useStatus();
  const { data: ledger, refetch: refetchLedger } = useX402Ledger();
  const { data: pricing } = useX402Pricing();
  const [smokeResult, setSmokeResult] = useState<PaidActionResult | null>(null);
  const [smokeError, setSmokeError] = useState<string | null>(null);
  const [ledgerRefreshWarning, setLedgerRefreshWarning] = useState<string | null>(null);

  const x402 = statusData?.x402;
  const status = x402?.status;
  const isLive = status === 'connected' || status === 'configured';
  const isMissing = status === 'missing';
  const isUnavailable = status === 'facilitator_auth_required' || status === 'facilitator_auth_invalid' || status === 'facilitator_rate_limited' || status === 'facilitator_unreachable' || status === 'degraded';
  const badgeState = isLive ? 'live' : isMissing ? 'missing' : 'mock';
  const badgeLabel =
    isLive ? 'connected' :
    status === 'facilitator_auth_required' ? 'auth required' :
    status === 'facilitator_auth_invalid' ? 'auth invalid' :
    status === 'facilitator_rate_limited' ? 'rate limited' :
    status === 'facilitator_unreachable' ? 'unreachable' :
    status === 'degraded' ? 'degraded' :
    isMissing ? 'not configured' :
    'simulated';
  const providerLabel = isLive ? 'Live Facilitator' : isMissing ? 'Missing Config' : isUnavailable ? 'Facilitator Unavailable' : 'Simulated Gateway';
  const providerDot = isLive ? 'text-ok' : isMissing ? 'text-risk' : 'text-warn';
  const statusCopy =
    isLive
      ? 'Real x402 settlement records are read from x402_receipts.'
      : status === 'facilitator_auth_required'
        ? 'x402 facilitator rejected /supported. Configure facilitator auth; paid routes fail closed without crashing the API.'
      : status === 'facilitator_auth_invalid'
        ? 'x402 facilitator auth could not be generated. Check CDP API key ID/secret formatting; paid routes fail closed.'
      : status === 'facilitator_rate_limited'
        ? 'x402 facilitator is rate-limited. Paid routes fail closed until the facilitator recovers.'
      : status === 'facilitator_unreachable' || status === 'degraded'
        ? 'x402 facilitator is unavailable or degraded. Paid routes return a controlled unavailable response.'
      : status === 'missing'
        ? 'x402 env is partial or invalid. Paid routes fail closed until facilitator, payTo, and CAIP-2 network are configured.'
      : 'No real facilitator is configured. Paid routes do not claim settlement.';
  const modeLabel = isLive ? 'Mode: real settlement' : isMissing ? 'Mode: missing config' : isUnavailable ? `Mode: ${badgeLabel}` : 'Mode: simulated';
  const networkLabel =
    x402?.network === 'eip155:8453' ? 'Base Mainnet' :
    x402?.network === 'eip155:84532' ? 'Base Sepolia' :
    'Not configured';
  const payToLabel = x402?.payToConfigured ? 'configured' : 'missing';
  const builderLabel = x402?.builderCodeConfigured ? 'configured' : 'missing';
  const attributionLabel = x402?.builderCodeAttribution === 'attached' ? 'attached' : 'unavailable';
  const smokeLabel = x402?.smokeRouteAvailable ? 'available' : 'unavailable';
  const smokeReceiptTx = smokeResult?.receipt?.transaction || null;
  const smokeLedgerEntry = smokeResult && smokeReceiptTx
    ? ledger?.entries?.find((entry) => entry.txHash === smokeReceiptTx)
    : undefined;
  const smokeTxHash = smokeLedgerEntry?.txHash || smokeReceiptTx;
  const smokeNetwork = smokeLedgerEntry?.network || smokeResult?.receipt?.network || x402?.network;
  const smokePayer = smokeLedgerEntry?.details?.payer || smokeResult?.receipt?.payer || null;
  const smokeBaseScanUrl = baseScanTxUrl(smokeNetwork, smokeTxHash);
  const smokeCost = smokeLedgerEntry?.cost ? `${smokeLedgerEntry.cost} USDC` : '0.001 USDC';
  const smokeSettledAt = smokeLedgerEntry?.createdAt || smokeResult?.completedAt || null;

  async function handleSmokeSuccess(result: PaidActionResult) {
    setSmokeResult(result);
    setSmokeError(null);
    setLedgerRefreshWarning(null);
    const refreshed = await refetchLedger();
    if (refreshed.isError) {
      setLedgerRefreshWarning('Payment settled, but Fuel history refresh failed.');
    }
  }

  function handleSmokeFailure(error: PaidActionError) {
    setSmokeError(error.message);
  }

  return (
    <main className="flex-1 bg-bg p-5 flex flex-col gap-4 overflow-y-auto select-none pb-16 md:pb-5">
      <div className="flex items-center justify-between border-b border-line pb-4">
        <div>
          <h1 className="text-[20px] font-display font-bold text-ink tracking-[-0.02em]">x402 Fuel Meter</h1>
          <p className="text-xs text-ink-3 mt-0.5 font-sans">
            Micropayment metering gateway, onchain USDC budget ledger, and per-action pricing.
          </p>
        </div>
        <StateBadge state={badgeState} label={badgeLabel} title="Source: /api/status x402.status" />
      </div>

      {/* Architecture & Wiring Status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div className="bg-panel border border-line rounded-[var(--radius-lg)] p-3.5 flex flex-col justify-between gap-2 shadow-[var(--shadow-card)]">
          <div>
            <div className="text-[10px] font-sans font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1">Provider Status</div>
            <div className="text-sm font-sans font-bold text-ink flex items-center gap-1.5">
              <span className={providerDot}>●</span>
              <span>{providerLabel}</span>
            </div>
          </div>
          <div className="text-[11px] text-ink-3 leading-relaxed border-t border-line/50 pt-2 font-sans">
            HTTP 402 + Payment Requirements gateway status comes from /api/status.
          </div>
        </div>

        <div className="bg-panel border border-line rounded-[var(--radius-lg)] p-3.5 flex flex-col justify-between gap-2 shadow-[var(--shadow-card)]">
          <div>
            <div className="text-[10px] font-sans font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1">Settlement Status</div>
            <div className="text-[11px] text-ink-2 leading-relaxed font-sans">
              {statusCopy}
            </div>
          </div>
          <div className="text-[10px] font-mono text-warn bg-warn-soft px-2 py-0.5 rounded-full w-fit">
            {modeLabel}
          </div>
        </div>

        <div className="bg-panel border border-line rounded-[var(--radius-lg)] p-3.5 flex flex-col justify-between gap-2 shadow-[var(--shadow-card)]">
          <div>
            <div className="text-[10px] font-sans font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1">Attribution</div>
            <div className="text-[11px] text-ink-2 leading-relaxed font-sans">
              Builder Code attribution is attached to paid x402 requirements when BUILDER_CODE is configured.
            </div>
          </div>
          <div className="text-[10px] font-mono text-accent-2 bg-accent-soft px-2 py-0.5 rounded-full w-fit">
            Public, non-secret
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <Metric label="PayTo" amount={payToLabel} sub="recipient" />
        <Metric label="Network" amount={networkLabel} sub={x402?.network || 'none'} />
        <Metric label="Builder Code" amount={builderLabel} sub={attributionLabel} />
        <Metric label="Smoke route" amount={smokeLabel} sub={x402?.smokeRoute || '/api/x402/smoke-paid'} />
      </div>

      <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-card)]">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">x402 Smoke Paid Test</div>
              <span className="text-[10px] font-mono bg-panel-2 border border-line px-2 py-0.5 rounded-full text-ink-3">diagnostic</span>
            </div>
            <div className="text-[12px] text-ink-2 leading-relaxed font-sans">
              Runs the production browser x402 flow against <span className="font-mono text-ink">/api/x402/smoke-paid</span>. The wallet signs the USDC authorization; the server never asks for a key and never broadcasts from Miorail.
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
              <Metric label="Route" amount="/api/x402/smoke-paid" sub="protected" />
              <Metric label="Cost" amount="0.001 USDC" sub="Base USDC" />
              <Metric label="Middleware" amount={x402?.middlewareMode || 'unknown'} sub={x402?.mockFacilitatorEnabled ? 'mock' : 'official'} />
              <Metric label="Browser flow" amount={isLive ? 'available' : 'blocked'} sub={x402?.smokeRouteAvailable ? 'smoke ready' : 'no route'} />
            </div>
          </div>
          <div className="w-full lg:w-[260px] shrink-0">
            <PaidActionButton
              label="x402 Smoke Paid Test"
              route="/api/x402/smoke-paid"
              actionType="x402_smoke_paid"
              category="tools"
              costLabel="0.001 USDC"
              disabled={!isLive || !x402?.smokeRouteAvailable}
              onSuccess={handleSmokeSuccess}
              onFailure={handleSmokeFailure}
            />
          </div>
        </div>

        {(smokeResult || smokeError || ledgerRefreshWarning) && (
          <div className="mt-4 border-t border-line/50 pt-3">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2 text-xs">
              <Metric label="Status" amount={smokeError ? 'failed' : smokeLedgerEntry?.settlement || 'settled'} sub={smokeError || 'Receipt saved'} />
              <Metric label="Payer" amount={smokePayer ? shortHash(smokePayer) : 'unknown'} sub="wallet" />
              <Metric label="Amount" amount={smokeCost} sub="settled" />
              <Metric label="Network" amount={smokeNetwork === 'eip155:8453' ? 'Base Mainnet' : smokeNetwork === 'eip155:84532' ? 'Base Sepolia' : 'unknown'} sub={smokeNetwork || 'none'} />
              <div className="bg-panel-2 border border-line rounded-[var(--radius-md)] p-2.5">
                <div className="text-[10px] font-sans uppercase tracking-[0.06em] text-ink-3">Tx proof</div>
                {smokeTxHash && smokeBaseScanUrl ? (
                  <a className="block mt-0.5 text-[12px] font-mono font-bold text-accent-2 hover:text-accent truncate" href={smokeBaseScanUrl} target="_blank" rel="noreferrer">
                    {shortHash(smokeTxHash)}
                  </a>
                ) : (
                  <div className="mt-0.5 text-[12px] text-warn font-sans">settled, tx proof unavailable</div>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
              {smokeSettledAt && <span className="font-mono">{new Date(smokeSettledAt).toLocaleString()}</span>}
              {ledgerRefreshWarning && <span className="text-warn">{ledgerRefreshWarning}</span>}
            </div>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* USDC budget (onchain agent balance) */}
        <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 flex flex-col justify-between shadow-[var(--shadow-card)]">
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">USDC budget</div>
              <span className="text-[10px] font-sans bg-panel-2 px-2 py-0.5 rounded-full text-ink-3">unconfigured</span>
            </div>
            <div className="text-[26px] font-mono font-bold text-ink">
              — <span className="text-[14px] font-normal text-ink-3">USDC</span>
            </div>
          </div>
          <div className="text-[11px] text-ink-3 mt-3 border-t border-line/50 pt-2 font-sans">
            Onchain agent USDC balance — no balance source is wired.
          </div>
        </section>

        {/* Spend breakdown today */}
        <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 flex flex-col justify-between shadow-[var(--shadow-card)]">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">Spend today</div>
              <span className="text-[10px] font-mono bg-panel-2 px-2 py-0.5 rounded-full text-ink-3">{ledger?.entries?.length || 0} calls recorded</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <Metric label="Inference" amount={ledger?.summary?.inferenceSpentUsdc ? `${ledger.summary.inferenceSpentUsdc} USDC` : "0.0000 USDC"} sub={`${ledger?.summary?.inferenceCallsCount || 0} calls`} />
              <Metric label="Tools" amount={ledger?.summary?.toolsSpentUsdc ? `${ledger.summary.toolsSpentUsdc} USDC` : "0.0000 USDC"} sub={`${ledger?.summary?.toolsCallsCount || 0} calls`} />
            </div>
          </div>
          <div className="text-[11px] text-warn font-mono mt-3 border-t border-line/50 pt-2 flex items-center justify-between">
            <span className="font-sans text-ink-3">Settlement mode:</span>
            <span className="font-bold bg-warn-soft px-2 py-0.5 rounded-full border border-warn/20 text-warn">{ledger?.summary?.settlement || 'none'}</span>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Per-action price (next action) */}
        <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 flex flex-col justify-between shadow-[var(--shadow-card)]">
          <div>
            <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3 mb-2">Per-Action Pricing Schedule</div>
            <div className="space-y-2">
              {pricing?.pricing && pricing.pricing.length > 0 ? (
                pricing.pricing.map(p => (
                  <div key={p.actionType} className="flex items-center justify-between bg-panel-2 p-2 rounded-[var(--radius-md)] border border-line text-xs">
                    <span className="text-ink font-sans font-medium">{p.label}</span>
                    <span className="text-accent-2 font-mono font-bold">{p.priceUsdc} USDC <span className="text-[10px] text-ink-3 font-normal">(est.)</span></span>
                  </div>
                ))
              ) : (
                <div className="text-[15px] font-mono text-ink font-semibold">Not priced</div>
              )}
            </div>
          </div>
          <div className="text-[11px] text-ink-3 mt-2 border-t border-line/50 pt-2 font-sans">
            Pricing is configured separately from the settlement ledger.
          </div>
        </section>

        {/* Spend history */}
        <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 flex flex-col justify-between shadow-[var(--shadow-card)]">
          <div>
            <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3 mb-3">Spend history</div>
            {ledger?.entries && ledger.entries.length > 0 ? (
              <div className="space-y-1.5 max-h-[140px] overflow-y-auto">
                {ledger.entries.map(e => (
                  <div key={e.id} className="flex items-center justify-between bg-panel-2 p-2 rounded-[var(--radius-md)] border border-line text-xs">
                    <div>
                      <span className="text-ink font-sans font-semibold">{e.actionType}</span>
                      <div className="text-[10px] text-ink-3 font-mono">{new Date(e.createdAt).toLocaleTimeString()}</div>
                    </div>
                    <div className="text-right">
                      <span className="text-ink font-mono font-bold">{e.cost || '0'} USDC</span>
                      <div className="text-[9px] text-warn font-mono">{e.settlement || 'none'}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-ink-3 italic bg-panel-2 p-3 rounded-[var(--radius-md)] border border-line font-sans">
                No spend history — no x402 micropayments have been recorded yet.
              </div>
            )}
          </div>
          <div className="text-[11px] text-ink-3 mt-2 border-t border-line/50 pt-2 font-sans">
            Ledger entries come from x402_receipts. Empty history means no paid settlements have been recorded.
          </div>
        </section>
      </div>
    </main>
  );
}
