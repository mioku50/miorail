import { useUiStore } from '../../lib/state';

// F2 parity fixture — F3 (T12.3) replaces with an honest "not configured"
// state and F4 (T12.4) moves autonomy into the /autonomy route. Kept verbatim
// for behavioral parity during the structural refactor.
export function AutonomyCard() {
  const showToast = useUiStore((s) => s.showToast);
  return (
    <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3">Autonomy <span className="lowercase font-normal tracking-normal text-ink-3/70 ml-1">(demo fixture)</span></div>
        <span className="text-[10px] font-bold text-accent bg-accent-soft px-[7px] py-[2px] rounded-[6px] tracking-[.05em]">SESSION KEY</span>
      </div>
      <div className="flex justify-between text-[12px] text-ink-2 mb-2"><span>Daily limit</span><span><b className="font-mono text-ink">$28</b> / $100</span></div>
      <div className="h-[7px] bg-line rounded-full overflow-hidden mb-1"><div className="h-full bg-accent" style={{ width: '28%' }}></div></div>
      <div className="flex justify-between text-[12px] text-ink-2 mt-[8px] mb-[9px]"><span>Whitelist</span><b className="font-mono text-ink">USDC · BNKR · NOCK</b></div>
      <div className="flex justify-between text-[12px] text-ink-2 mb-[9px]"><span>Expires in</span><b className="font-mono text-ink">5:59:42</b></div>
      <button onClick={() => showToast('Autonomy stopped. Agent is waiting for manual confirmation.')} className="w-full py-[9px] rounded-[10px] bg-red-soft text-red font-bold text-[13px] flex items-center justify-center gap-[7px] hover:bg-red hover:text-white transition-colors">⏻ Kill switch</button>
    </div>
  );
}
