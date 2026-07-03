// F2 parity fixture — F3 (T12.3) replaces with an honest state reading
// useStatus().x402.status; F4 (T12.4) moves the full fuel meter into /fuel.
// Kept verbatim for behavioral parity during the structural refactor.
export function FuelCard() {
  return (
    <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
      <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-3">x402 budget <span className="lowercase font-normal tracking-normal text-ink-3/70 ml-1">(testnet-USDC)</span></div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-mono text-[20px] font-bold text-ink">$1.84</div>
        <span className="text-[12px] font-bold bg-accent-soft text-accent px-[8px] py-[3px] rounded-[8px]">today</span>
      </div>
      <div className="h-[7px] bg-line rounded-full overflow-hidden mb-[6px]"><div className="h-full bg-accent" style={{ width: '37%' }}></div></div>
      <div className="flex justify-between text-[12px] text-ink-2 mt-[6px] mb-[9px]"><span>inference · 142 calls</span><b className="font-mono text-ink">$1.12</b></div>
      <div className="flex justify-between text-[12px] text-ink-2"><span>tools · 38 calls</span><b className="font-mono text-ink">$0.72</b></div>
    </div>
  );
}
