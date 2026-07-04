import { useUiStore } from '../lib/state';
import { useNetworkLabel } from '../lib/useNetworkLabel';
import { TabBar } from './TabBar';
import { WalletConnect } from './WalletConnect';
import { Menu, X } from 'lucide-react';

interface TopBarProps {
  onHamburgerClick?: () => void;
  drawerOpen?: boolean;
}

export function TopBar({ onHamburgerClick, drawerOpen }: TopBarProps) {
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const { label: networkLabel, readOnly } = useNetworkLabel();

  return (
    <header className="h-[60px] flex items-center px-4 bg-panel/70 backdrop-blur-md border-b border-line gap-3 shrink-0 sticky top-0 z-30">
      {/* Hamburger — visible only on <lg */}
      <button
        onClick={onHamburgerClick}
        className="lg:hidden flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] text-ink-2 hover:text-ink hover:bg-panel-2 transition-colors shrink-0"
        aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
      >
        {drawerOpen ? <X size={18} /> : <Menu size={18} />}
      </button>

      {/* Logo + brand */}
      <div className="flex items-center gap-2 font-bold text-ink shrink-0">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="26" height="26" fill="none" aria-hidden="true">
          <path d="M 10 50 L 10 14" stroke="#4650F0" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 10 14 L 32 36" stroke="#4650F0" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 32 36 L 54 14" stroke="#4650F0" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M 54 14 L 54 50" stroke="#4650F0" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
          <line x1="10" y1="22" x2="2"  y2="18" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round"/>
          <line x1="10" y1="30" x2="1"  y2="30" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round"/>
          <line x1="10" y1="38" x2="2"  y2="42" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round"/>
          <line x1="54" y1="22" x2="62" y2="18" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round"/>
          <line x1="54" y1="30" x2="63" y2="30" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round"/>
          <line x1="54" y1="38" x2="62" y2="42" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round"/>
        </svg>
        {/* Brand name — hidden on small mobile to save space */}
        <span className="hidden sm:inline font-display text-[15px]">Miorail</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ml-0.5 font-sans font-medium ${readOnly ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent-2'}`}>
          {networkLabel}
        </span>
      </div>

      {/* TabBar — hidden on <md (moves to bottom nav) */}
      <div className="hidden md:flex">
        <TabBar />
      </div>

      <div className="flex-1" />

      {/* Scanners indicator */}
      <div className="hidden sm:flex items-center gap-[7px] bg-panel-2 text-ink-3 border border-line px-2.5 py-1 rounded-full text-xs font-medium">
        <span className="w-1.5 h-1.5 rounded-full bg-ink-3" />
        <span className="hidden lg:inline">scanners off</span>
        <span className="lg:hidden">off</span>
      </div>

      {/* Command palette button */}
      <button
        onClick={() => setPaletteOpen(true)}
        className="hidden sm:flex items-center gap-2 bg-bg border border-line px-3 py-[6px] rounded-[var(--radius-md)] text-ink-3 text-[13px] hover:bg-panel-2 transition-colors"
        aria-label="Open command palette"
      >
        <span className="hidden md:inline">Command</span>
        <kbd className="font-mono bg-panel-2 border border-line rounded-[var(--radius-sm)] px-[5px] py-[1px] text-[11px] text-ink-2">⌘K</kbd>
      </button>

      {/* Mobile: just the ⌘K icon */}
      <button
        onClick={() => setPaletteOpen(true)}
        className="sm:hidden flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] text-ink-3 hover:text-ink hover:bg-panel-2 transition-colors"
        aria-label="Open command palette"
      >
        <kbd className="font-mono text-[11px]">⌘K</kbd>
      </button>

      <WalletConnect />
    </header>
  );
}
