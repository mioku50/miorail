import { useEffect, useState } from 'react';
import { useUiStore } from '../lib/state';
import { CHAIN_ENV } from '../lib/chain';
import { TabBar } from './TabBar';
import { WalletConnect } from './WalletConnect';

export function TopBar() {
  const [tick, setTick] = useState(42);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => (t <= 0 ? 59 : t - 1)), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="h-[56px] flex items-center px-[18px] bg-panel border-b border-line gap-4">
      <div className="flex items-center gap-2 font-bold text-ink">
        <div className="w-[26px] h-[26px] rounded-lg bg-accent text-white flex items-center justify-center text-sm">◆</div>
        <span>Base Agent</span>
        {CHAIN_ENV === 'sepolia' ? (
          <span className="text-[10px] bg-accent-soft text-accent px-1.5 py-0.5 rounded ml-1">Base Sepolia</span>
        ) : CHAIN_ENV === 'mainnet-readonly' ? (
          <span className="text-[10px] bg-amber-soft text-amber px-1.5 py-0.5 rounded ml-1 text-[#d97706] bg-[#fef3c7]">Base Mainnet · Read-only</span>
        ) : CHAIN_ENV === 'mainnet' && import.meta.env.VITE_MAINNET_EXECUTION_ENABLED === 'true' ? (
          <span className="text-[10px] bg-accent-soft text-accent px-1.5 py-0.5 rounded ml-1">Base Mainnet</span>
        ) : (
          <span className="text-[10px] bg-red-soft text-red px-1.5 py-0.5 rounded ml-1">Invalid Env</span>
        )}
      </div>

      <TabBar />

      <div className="flex-1"></div>

      <div className="flex items-center gap-[9px] bg-green-soft text-green px-3 py-1.5 rounded-full text-xs font-medium">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green opacity-40"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green"></span>
        </span>
        4 scanners active · tick in <span className="font-mono ml-1">{`0:${String(tick).padStart(2, '0')}`}</span>
      </div>

      <button
        onClick={() => setPaletteOpen(true)}
        className="flex items-center gap-2 bg-bg border border-line px-[12px] py-[7px] rounded-[10px] text-ink-3 text-[13px] hover:bg-line/50 transition-colors"
      >
        Command
        <kbd className="font-mono bg-white border border-line rounded-[6px] px-[6px] py-[1px] text-[11px] text-ink-2 shadow-sm">⌘K</kbd>
      </button>

      <WalletConnect />
    </header>
  );
}
