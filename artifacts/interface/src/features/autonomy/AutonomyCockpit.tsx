import { useUiStore } from '../../lib/state';
import { StateBadge } from '../../ui';

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel-2 border border-line rounded-lg p-2.5">
      <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <div className="text-[15px] font-mono font-bold text-ink mt-0.5">{value}</div>
    </div>
  );
}

// Autonomy Cockpit — the differentiator screen a read-only terminal (OrbitLab)
// structurally cannot have. No backend autonomy data exists today (lib/autonomy
// is orphaned, no endpoint), so every value is an honest empty state — ZERO
// stub numbers. The structural components (metrics, kill switch, feed, bounds)
// are built and ready to consume real session-key data when a backend exposes it.
export function AutonomyCockpit() {
  const showToast = useUiStore((s) => s.showToast);

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-[16px] font-bold text-ink">Autonomy Cockpit</h2>
        <StateBadge state="missing" label="not configured" title="No session key is active" />
      </div>

      {/* Session key status */}
      <section className="bg-panel border border-line rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3">Session Key</div>
          <span className="text-[10px] font-mono text-ink-3">inactive</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <Metric label="Daily limit" value="—" />
          <Metric label="Spent today" value="—" />
          <Metric label="Max / action" value="—" />
          <Metric label="TTL" value="—" />
        </div>
        <div className="mt-3 text-[11px] text-ink-3">
          Whitelist: <span className="text-ink-2">—</span>
        </div>
      </section>

      {/* Kill switch — always accessible; honest when no key is active */}
      <section className="bg-panel border border-line rounded-xl p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-bold text-ink">Kill switch</div>
            <div className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
              Revokes the session key; the agent reverts to manual confirmation on every action.
            </div>
          </div>
          <button
            onClick={() => showToast('No active session key to revoke.')}
            className="shrink-0 px-4 py-2 rounded-lg bg-risk-soft text-risk font-bold text-sm border border-risk/30 hover:bg-risk hover:text-white transition-colors"
          >
            ⏻ Kill
          </button>
        </div>
      </section>

      {/* Autonomy boundaries */}
      <section className="bg-panel border border-line rounded-xl p-4">
        <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-3">Autonomy boundaries</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          <Metric label="Daily spend limit" value="—" />
          <Metric label="Max per action" value="—" />
          <Metric label="Allowed protocols" value="—" />
        </div>
      </section>

      {/* Autonomous action feed */}
      <section className="bg-panel border border-line rounded-xl p-4">
        <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-3">Autonomous actions</div>
        <div className="text-sm text-ink-3 italic">No autonomous actions yet — no scanner/autonomy backend is wired.</div>
      </section>

      {/* Setup steps */}
      <section className="bg-panel-2 border border-line rounded-xl p-4">
        <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-ink-3 mb-3">To enable autonomy</div>
        <ol className="list-decimal list-inside text-xs text-ink-2 space-y-1.5 leading-relaxed">
          <li>Configure a session key with a daily spend limit, token/contract whitelist, and TTL (requires a backend autonomy endpoint — follow-up task).</li>
          <li>Set per-action and per-protocol spend thresholds.</li>
          <li>Wire a scanner/autonomy engine to emit actions within the session-key bounds.</li>
        </ol>
      </section>
    </main>
  );
}
