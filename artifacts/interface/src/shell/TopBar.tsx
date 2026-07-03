import { useUiStore } from '../lib/state';
import { useNetworkLabel } from '../lib/useNetworkLabel';
import { TabBar } from './TabBar';
import { WalletConnect } from './WalletConnect';

export function TopBar() {
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const { label: networkLabel, readOnly } = useNetworkLabel();

  return (
    <header className="h-[56px] flex items-center px-[18px] bg-panel border-b border-line gap-4">
      <div className="flex items-center gap-2 font-bold text-ink">
        <div className="w-[26px] h-[26px] rounded-lg bg-accent text-white flex items-center justify-center text-sm font-bold">M</div>
        <span>MioAgent</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ml-1 font-mono normal-case tracking-normal border ${readOnly ? 'bg-warn-soft text-warn border-warn/30' : 'bg-accent-soft text-accent border-accent/30'}`}>
          {networkLabel}
        </span>
      </div>

      <TabBar />

      <div className="flex-1"></div>

      {/* No scanner backend is wired — honest state, no fake countdown. */}
      <div className="flex items-center gap-[9px] bg-panel-2 text-ink-3 border border-line px-3 py-1.5 rounded-full text-xs font-medium">
        <span className="w-2 h-2 rounded-full bg-ink-3"></span>
        scanners off
      </div>

      <button
        onClick={() => setPaletteOpen(true)}
        className="flex items-center gap-2 bg-bg border border-line px-[12px] py-[7px] rounded-[10px] text-ink-3 text-[13px] hover:bg-line/50 transition-colors"
      >
        Command
        <kbd className="font-mono bg-panel-2 border border-line rounded-[6px] px-[6px] py-[1px] text-[11px] text-ink-2 shadow-sm">⌘K</kbd>
      </button>

      <WalletConnect />
    </header>
  );
}
