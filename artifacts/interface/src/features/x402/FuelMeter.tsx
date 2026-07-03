import { useStatus } from '@mioagent/api-client-react';
import { StateBadge } from '@mioagent/ui';

function Metric({ label, amount, sub }: { label: string; amount: string; sub: string }) {
  return (
    <div className="bg-panel-2 border border-line rounded-lg p-2.5">
      <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="text-[15px] font-mono font-bold text-ink">{amount}</span>
        <span className="text-[11px] text-ink-3 font-mono">{sub}</span>
      </div>
    </div>
  );
}

// x402 Fuel Meter — the pay-per-action differentiator. The only real datum is
// useStatus().x402.status. USDC balance, per-action pricing, the inference/tools
// breakdown, and history have no backend yet, so they render honest empty states
// (em-dashes + explanations), never fabricated numbers.
export function FuelMeter() {
  const { data: statusData } = useStatus();
  const status = statusData?.x402?.status;
  const badgeState = status === 'configured' ? 'live' : status === 'missing' ? 'missing' : 'mock';
  const badgeLabel = status === 'configured' ? 'configured' : status === 'missing' ? 'not configured' : 'simulated';

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-[16px] font-bold text-ink">x402 Fuel Meter</h2>
        <StateBadge state={badgeState} label={badgeLabel} title="Source: /api/status x402.status" />
      </div>

      {/* USDC budget (onchain agent balance) */}
      <section className="bg-panel border border-line rounded-xl p-4">
        <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-2">USDC budget</div>
        <div className="text-[28px] font-mono font-bold text-ink">
          — <span className="text-[14px] font-normal text-ink-3">USDC</span>
        </div>
        <div className="text-[11px] text-ink-3 mt-1">Onchain agent USDC balance — no balance source is wired.</div>
      </section>

      {/* Spend breakdown today */}
      <section className="bg-panel border border-line rounded-xl p-4">
        <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-3">Spend today</div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Metric label="Inference" amount="—" sub="— calls" />
          <Metric label="Tools" amount="—" sub="— calls" />
        </div>
        <div className="text-[11px] text-ink-3 mt-3">
          No live spend data — the backend doesn't expose per-action pricing or spend yet.
        </div>
      </section>

      {/* Per-action price (next action) */}
      <section className="bg-panel border border-line rounded-xl p-4">
        <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-2">Next action price</div>
        <div className="text-[15px] font-mono text-ink">—</div>
        <div className="text-[11px] text-ink-3 mt-1">
          Each agent/scanner action will show its micro-price before execution once pricing is wired.
        </div>
      </section>

      {/* Spend history */}
      <section className="bg-panel border border-line rounded-xl p-4">
        <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-3">Spend history</div>
        <div className="text-sm text-ink-3 italic">No spend history — no x402 spend has been recorded yet.</div>
      </section>
    </main>
  );
}
