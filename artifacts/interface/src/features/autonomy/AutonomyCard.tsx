import { Link } from 'wouter';

// Honest state: no session key is configured (no backend autonomy data exists).
// The rail card points to the /autonomy route, which F4 (T12.4) expands into
// the full cockpit. No fixture numbers.
export function AutonomyCard() {
  return (
    <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3">Autonomy</div>
        <span className="text-[10px] font-bold text-ink-3 bg-panel-2 border border-line px-[7px] py-[2px] rounded-[6px] tracking-[.05em]">OFF</span>
      </div>
      <div className="text-[12px] text-ink-2 mb-3 leading-relaxed">
        No session key active. The agent waits for manual confirmation on every action.
      </div>
      <Link
        href="/autonomy"
        className="block text-center text-[12px] font-semibold text-accent border border-accent/30 bg-accent-soft rounded-[10px] py-[9px] hover:bg-accent hover:text-white transition-colors"
      >
        Configure autonomy →
      </Link>
    </div>
  );
}
