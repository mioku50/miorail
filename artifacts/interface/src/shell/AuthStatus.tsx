import { useSwitchChain } from 'wagmi';
import { useAuthGate } from '../app/AuthProvider';

// T48a: always-visible auth status in the shell — never a full-screen gate.
// Only shows something actionable when there's an action to take; stays
// silent once authenticated (WalletConnect already shows the address).

export function AuthStatus() {
  const gate = useAuthGate();
  const { switchChainAsync, isPending: switchPending } = useSwitchChain();

  if (gate.phase === 'wrong-chain') {
    return (
      <button
        type="button"
        onClick={() => void switchChainAsync({ chainId: 8453 })}
        disabled={switchPending}
        className="bg-warn-soft text-warn border border-warn/20 px-[10px] py-[6px] rounded-[10px] text-[12px] hover:bg-warn-soft/80 transition-colors font-medium disabled:opacity-50"
      >
        {switchPending ? 'Switching…' : 'Switch to Base Mainnet'}
      </button>
    );
  }

  if (gate.phase === 'booting') {
    return <span className="text-[11px] text-ink-3 font-mono">Checking session…</span>;
  }

  if (gate.phase === 'needs-signin') {
    return (
      <button
        type="button"
        onClick={() => void gate.continueWithWallet()}
        disabled={gate.signing}
        className="bg-accent hover:bg-accent-2 text-white px-[10px] py-[6px] rounded-[10px] text-[12px] transition-colors font-medium disabled:opacity-60 disabled:cursor-wait"
        title="Sign in to unlock chats, actions, fuel and safety limits"
      >
        {gate.signing ? 'Waiting for wallet…' : 'Continue with wallet'}
      </button>
    );
  }

  return null;
}
