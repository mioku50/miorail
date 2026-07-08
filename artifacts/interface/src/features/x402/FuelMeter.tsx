import { useStatus, useX402Ledger, useX402Pricing } from '@mioagent/api-client-react';
import { StateBadge } from '@mioagent/ui';

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

// x402 Fuel Meter — the pay-per-action differentiator.
// Shows honest empty states and operator guidance without fabricated numbers.
export function FuelMeter() {
  const { data: statusData } = useStatus();
  const { data: ledger } = useX402Ledger();
  const { data: pricing } = useX402Pricing();

  const status = statusData?.x402?.status;
  const badgeState = status === 'configured' ? 'live' : status === 'missing' ? 'missing' : 'mock';
  const badgeLabel = status === 'configured' ? 'configured' : status === 'missing' ? 'not configured' : 'simulated';
  const providerLabel = status === 'configured' ? 'Live Facilitator' : status === 'missing' ? 'Missing Config' : 'Simulated Gateway';
  const providerDot = status === 'configured' ? 'text-ok' : status === 'missing' ? 'text-risk' : 'text-warn';
  const statusCopy =
    status === 'configured'
      ? 'Real x402 settlement records are read from x402_receipts.'
      : status === 'missing'
        ? 'x402 env is partial or invalid. Paid routes fail closed until facilitator, payTo, and CAIP-2 network are configured.'
        : 'No real facilitator is configured. Paid routes do not claim settlement.';
  const modeLabel = status === 'configured' ? 'Mode: real settlement' : status === 'missing' ? 'Mode: missing config' : 'Mode: simulated';

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
