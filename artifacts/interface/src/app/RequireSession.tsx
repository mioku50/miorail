import type { ReactNode } from 'react';
import { useSwitchChain } from 'wagmi';
import { useAuthGate } from './AuthProvider';
import { WalletConnect } from '../shell/WalletConnect';

// T48a: single gate for private surfaces (chats/actions/fuel/configure).
// Public/read-only routes (cockpit, diagnostics) never render this — they
// stay reachable without a wallet signature. This never shows a blank
// screen: it always renders a compact, actionable prompt instead of the
// gated content.

export function RequireSession({ children }: { children: ReactNode }) {
  const gate = useAuthGate();
  const { switchChainAsync, isPending: switchPending } = useSwitchChain();

  if (gate.showPrivateSurfaces) return <>{children}</>;

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <section className="w-full max-w-sm border border-line bg-panel p-6 text-center rounded-xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Private area</p>
        <h2 className="mt-2 text-lg font-semibold text-ink">Continue with your wallet</h2>
        <p className="mt-2 text-sm text-muted">
          One signature binds chats, actions, fuel and safety limits to this wallet. It does not send a transaction.
        </p>

        {gate.phase === 'disconnected' && (
          <div className="mt-4"><WalletConnect /></div>
        )}

        {gate.phase === 'wrong-chain' && (
          <button
            type="button"
            className="mt-4 w-full border border-accent px-4 py-3 text-sm text-accent disabled:opacity-50"
            disabled={switchPending}
            onClick={() => void switchChainAsync({ chainId: 8453 })}
          >
            {switchPending ? 'Switching…' : 'Switch to Base Mainnet'}
          </button>
        )}

        {gate.phase === 'booting' && (
          <p className="mt-4 text-xs text-muted">Checking your session…</p>
        )}

        {gate.phase === 'needs-signin' && (
          <button
            type="button"
            className="mt-4 w-full bg-accent px-4 py-3 text-sm font-semibold text-bg disabled:opacity-50"
            disabled={gate.signing}
            onClick={() => void gate.continueWithWallet()}
          >
            {gate.signing ? 'Waiting for wallet…' : 'Continue with current wallet'}
          </button>
        )}

        {gate.error && <p className="mt-4 text-xs text-danger">{gate.error}</p>}
      </section>
    </div>
  );
}
