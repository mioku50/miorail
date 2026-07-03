// F2 stub — honest empty state. F4 (T12.4) expands this into the full cockpit
// (session-key status, kill switch, spend limits, autonomous-action feed). No
// backend data for autonomy exists yet, so this shows no fake numbers.
export function AutonomyCockpit() {
  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">Autonomy Cockpit</h2>
      <div className="bg-panel border border-line rounded-xl p-8 flex flex-col items-center gap-3 text-center">
        <div className="w-10 h-10 rounded-full bg-panel-2 text-ink-3 flex items-center justify-center text-lg">⏻</div>
        <div className="text-base font-bold text-ink">Autonomy is not configured</div>
        <div className="text-xs text-ink-2 max-w-md leading-relaxed">
          No session key is active. Configure a session key with a daily spend limit, token whitelist, and TTL to let the agent act autonomously within bounds.
        </div>
      </div>
    </main>
  );
}
