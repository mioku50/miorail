import type { ReactNode } from 'react';
import { useAccount, useDisconnect, useSwitchChain } from 'wagmi';
import { useAuthGate } from './AuthProvider';
import { WalletPicker } from '../shell/WalletPicker';
import { detectBaseAppEarly } from '../lib/detectBaseAppEarly';
import { walletDisplayNameV1 } from '../lib/walletChoices';

// T48a: single gate for private surfaces (chats/actions/fuel/configure).
// Public/read-only routes (cockpit, diagnostics) never render this — they
// stay reachable without a wallet signature. This never shows a blank
// screen: it always renders a compact, actionable prompt instead of the
// gated content.
//
// 2026-09-24: the gate names the wallet it is about to sign in with and lets
// the person pick another. It used to say "Continue with current wallet" over
// whichever wallet the page had connected by itself — inside Base App that
// read as "Miorail needs a Base Account", and nothing offered a way out.

export function RequireSession({
  children,
  copy,
}: {
  children: ReactNode;
  /** What this gate is for, when it is not the private area. The sign-in door
   * says so: a reader who pressed "Connect wallet" is not entering one. */
  copy?: { eyebrow: string; body: string };
}) {
  const gate = useAuthGate();
  const { switchChainAsync, isPending: switchPending } = useSwitchChain();
  const { address, connector } = useAccount();
  // Every connection, not just the current one: wagmi reconnects each wallet
  // that already authorised this site, so dropping only the current one made
  // the next authorised wallet current — "Use another wallet" picked one.
  const { connectors: connectedConnectors, disconnectAsync } = useDisconnect();

  if (gate.showPrivateSurfaces) return <>{children}</>;

  const inBaseApp = detectBaseAppEarly({
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    ethereum: typeof window === 'undefined' ? undefined : (window as { ethereum?: unknown }).ethereum,
  });
  const walletName = walletDisplayNameV1(connector, inBaseApp);
  const connected = gate.phase === 'needs-signin' || gate.phase === 'wrong-chain';

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <section className="w-full max-w-sm border border-line bg-panel p-6 text-center rounded-xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">{copy?.eyebrow ?? 'Private area'}</p>
        <h2 className="mt-2 text-lg font-semibold text-ink">
          {gate.phase === 'disconnected' ? 'Choose a wallet' : 'Continue with your wallet'}
        </h2>
        <p className="mt-2 text-sm text-muted">
          {copy?.body ??
            'One signature binds chats, actions, fuel and safety limits to the wallet you use. It does not send a transaction.'}
        </p>

        {gate.phase === 'disconnected' && (
          <div className="mt-4"><WalletPicker /></div>
        )}

        {connected && address && (
          <p className="mt-4 text-sm text-ink">
            <span className="font-semibold">{walletName}</span>{' '}
            <span className="font-mono text-muted">{address.slice(0, 6)}…{address.slice(-4)}</span>
          </p>
        )}

        {gate.phase === 'wrong-chain' && (
          <button
            type="button"
            className="mt-3 w-full border border-accent px-4 py-3 text-sm text-accent disabled:opacity-50"
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
            className="mt-3 w-full bg-accent px-4 py-3 text-sm font-semibold text-bg disabled:opacity-50"
            disabled={gate.signing}
            onClick={() => void gate.continueWithWallet()}
          >
            {gate.signing ? 'Waiting for wallet…' : `Sign in with ${walletName}`}
          </button>
        )}

        {connected && (
          <button
            type="button"
            className="mt-2 w-full px-4 py-2 text-sm text-muted underline underline-offset-2"
            onClick={() =>
              void (async () => {
                for (const connected of connectedConnectors) {
                  try {
                    await disconnectAsync({ connector: connected });
                  } catch {
                    // Already gone; the next one still goes.
                  }
                }
              })()
            }
          >
            Use another wallet
          </button>
        )}

        {gate.error && <p className="mt-4 text-xs text-danger">{gate.error}</p>}
      </section>
    </div>
  );
}
