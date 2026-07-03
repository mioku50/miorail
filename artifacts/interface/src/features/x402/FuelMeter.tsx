import { useStatus } from '@mioagent/api-client-react';
import { StateBadge } from '@mioagent/ui';

function Metric({ label, amount, sub }: { label: string; amount: string; sub: string }) {
  return (
    <div className="bg-panel-2 border border-line rounded-lg p-2.5">
      <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-ink-3">{label}</div>
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
  const status = statusData?.x402?.status;
  const badgeState = status === 'configured' ? 'live' : status === 'missing' ? 'missing' : 'mock';
  const badgeLabel = status === 'configured' ? 'configured' : status === 'missing' ? 'not configured' : 'simulated';

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto select-none">
      <div className="flex items-center justify-between border-b border-line pb-3">
        <div>
          <h2 className="text-[18px] font-bold text-ink tracking-[-0.02em]">x402 Fuel Meter</h2>
          <p className="text-[12px] text-ink-3 mt-0.5">
            Micropayment metering gateway, onchain USDC budget ledger, and per-action pricing.
          </p>
        </div>
        <StateBadge state={badgeState} label={badgeLabel} title="Source: /api/status x402.status" />
      </div>

      {/* Architecture & Wiring Status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div className="bg-panel border border-line rounded-xl p-3.5 flex flex-col justify-between gap-2">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3 mb-1">Provider Status</div>
            <div className="text-sm font-bold text-ink flex items-center gap-1.5">
              <span className={status === 'configured' ? 'text-ok' : 'text-warn'}>●</span>
              <span>{status === 'configured' ? 'Live Facilitator' : 'Simulated Gateway'}</span>
            </div>
          </div>
          <div className="text-[11px] text-ink-3 leading-relaxed border-t border-line/50 pt-2">
            HTTP 402 + Payment Requirements gateway active.
          </div>
        </div>

        <div className="bg-panel border border-line rounded-xl p-3.5 flex flex-col justify-between gap-2">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3 mb-1">Why Spend is Simulated</div>
            <div className="text-[11px] text-ink-2 leading-relaxed">
              The HTTP 402 gateway and anti-replay guards are implemented, but live USDC micropayments require a connected session key and facilitator contract.
            </div>
          </div>
          <div className="text-[10px] font-mono text-warn bg-warn-soft px-2 py-0.5 rounded border border-warn/20 w-fit">
            Mode: read-only simulation
          </div>
        </div>

        <div className="bg-panel border border-line rounded-xl p-3.5 flex flex-col justify-between gap-2">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3 mb-1">Next Backend Wiring Task</div>
            <div className="text-[11px] text-ink-2 leading-relaxed">
              1) Wire the Drizzle budget ledger in lib/db, 2) Connect the testnet-USDC facilitator contract, and 3) Enable live settlement.
            </div>
          </div>
          <div className="text-[10px] font-mono text-accent bg-accent-soft px-2 py-0.5 rounded border border-accent/20 w-fit">
            Roadmap: Phase 7.4
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* USDC budget (onchain agent balance) */}
        <section className="bg-panel border border-line rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3">USDC budget</div>
              <span className="text-[10px] font-mono bg-panel-2 px-2 py-0.5 rounded border border-line text-ink-3">unconfigured</span>
            </div>
            <div className="text-[26px] font-mono font-bold text-ink">
              — <span className="text-[14px] font-normal text-ink-3">USDC</span>
            </div>
          </div>
          <div className="text-[11px] text-ink-3 mt-3 border-t border-line/50 pt-2">
            Onchain agent USDC balance — no balance source is wired.
          </div>
        </section>

        {/* Spend breakdown today */}
        <section className="bg-panel border border-line rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3">Spend today</div>
              <span className="text-[10px] font-mono bg-panel-2 px-2 py-0.5 rounded border border-line text-ink-3">0 calls recorded</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <Metric label="Inference" amount="Not set" sub="0 calls" />
              <Metric label="Tools" amount="Not set" sub="0 calls" />
            </div>
          </div>
          <div className="text-[11px] text-ink-3 mt-3 border-t border-line/50 pt-2">
            No live spend data — per-action pricing and ledger deduction unconfigured.
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Per-action price (next action) */}
        <section className="bg-panel border border-line rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-2">Next action price</div>
            <div className="text-[15px] font-mono text-ink font-semibold">Not priced</div>
          </div>
          <div className="text-[11px] text-ink-3 mt-2 border-t border-line/50 pt-2">
            Each agent/scanner action will show its micro-price before execution once pricing is wired.
          </div>
        </section>

        {/* Spend history */}
        <section className="bg-panel border border-line rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-3">Spend history</div>
            <div className="text-xs text-ink-3 italic bg-panel-2 p-3 rounded border border-line">
              No spend history — no x402 micropayments have been recorded yet.
            </div>
          </div>
          <div className="text-[11px] text-ink-3 mt-2 border-t border-line/50 pt-2">
            Ledger export will unlock after Phase 7.4 x402 integration.
          </div>
        </section>
      </div>
    </main>
  );
}
