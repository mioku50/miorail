import { useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { useAccount, useDisconnect, useSwitchChain } from 'wagmi';
import { logoutWalletSession, useSession } from '@mioagent/api-client-react';
import { StillLink, StillWalletControlsContext } from '@mioagent/ui/still';
import { useAuthGate } from '../../app/AuthProvider';
import { clearTenantClientState } from '../../lib/tenantState';
import { runStillWalletActionV1, walletControlViewV1, type StillWalletActionV1 } from './walletControls';

function WalletIcon() {
  return <svg className="still-wallet-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 8V6a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v10H6a3 3 0 0 1-3-3V7m17 6h-5v4h5m-3-2h.01" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/** One wallet control for every Still frame; the connection and SIWE providers
 * are the app's existing ones, and signing always requires an explicit click. */
export function StillWalletControlsProvider({ children }: { children: ReactNode }) {
  return <StillWalletControlsContext.Provider value={<StillWalletControls />}>{children}</StillWalletControlsContext.Provider>;
}

export function StillWalletControls() {
  const [, navigate] = useLocation();
  const gate = useAuthGate();
  const account = useAccount();
  const session = useSession({ retry: false, staleTime: 60_000 });
  const { connectors, disconnectAsync } = useDisconnect();
  const { switchChainAsync, isPending: switchingChain } = useSwitchChain();
  const queryClient = useQueryClient();
  const menu = useRef<HTMLDetailsElement>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState<StillWalletActionV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = walletControlViewV1({
    connected: account.isConnected,
    address: account.address ?? null,
    chainId: account.chainId ?? null,
    session: session.data?.user ?? null,
    sessionPending: session.isPending,
    phase: gate.phase,
  });
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const signInHref = window.location.pathname === '/signin'
    ? `/signin${window.location.search}`
    : `/signin?next=${encodeURIComponent(here)}`;
  const disabled = Boolean(busy) || gate.signing || switchingChain;

  const changeWallet = async (action: StillWalletActionV1) => {
    if (running.current) return;
    running.current = true;
    setBusy(action);
    setError(null);
    try {
      // Snapshot all connections before clearing tenant state. Disconnecting
      // only the active one can activate another previously authorised wallet.
      const connected = connectors.length ? [...connectors] : account.connector ? [account.connector] : [];
      const result = await runStillWalletActionV1({
        action,
        connectors: connected,
        logout: logoutWalletSession,
        clearSession: () => {
          clearTenantClientState(queryClient);
          queryClient.setQueryData(['session'], { user: null });
        },
        disconnect: (connector) => disconnectAsync({ connector }),
        // The existing sign-in page opens WalletPicker. Selecting another
        // wallet connects it; its SIWE signature still needs a separate click.
        openWalletPicker: () => navigate(signInHref),
      });
      if (result === 'disconnect_incomplete') {
        setError('Signed out, but a wallet could not be disconnected. Try Disconnect again.');
      } else if (menu.current) {
        menu.current.open = false;
      }
    } catch {
      setError('Your account could not be signed out. Your wallet connection was not changed. Try again.');
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  if (view.kind === 'checking') {
    return <div className="still-wallet-controls"><span className="still-wallet-trigger" role="status" aria-label={view.label} aria-busy="true"><WalletIcon /><span>{view.label}</span></span></div>;
  }
  if (view.kind === 'connect') {
    return <div className="still-wallet-controls"><StillLink href={signInHref} className="still-wallet-trigger" aria-label="Connect wallet" title="Connect wallet"><WalletIcon /><span>Connect wallet</span></StillLink></div>;
  }
  return (
    <div className="still-wallet-controls">
      <details ref={menu}>
        <summary className="still-wallet-trigger" aria-label={`Wallet account ${view.label}`}>
          <WalletIcon />
          <span>{view.label}</span>
          <span className="still-wallet-caption">{view.status}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </summary>
        <div className="still-wallet-menu" aria-label="Wallet account actions">
          <p className="still-wallet-status">{view.status}</p>
          {view.walletAddress ? <p className="still-wallet-address">Connected wallet <code>{view.walletAddress}</code></p> : null}
          {view.sessionAddress ? <p className="still-wallet-address">Signed-in account <code>{view.sessionAddress}</code></p> : null}
          {view.warning ? <p className="still-wallet-warning">{view.warning}</p> : null}
          {!view.walletAddress ? <StillLink href={signInHref} className="still-wallet-action">Connect wallet</StillLink> : null}
          {view.signIn ? (
            <button type="button" className="still-wallet-action" disabled={disabled} onClick={() => void gate.continueWithWallet()}>
              {gate.signing ? 'Waiting for wallet…' : 'Sign in with this wallet'}
            </button>
          ) : null}
          {view.switchChain ? (
            <button type="button" className="still-wallet-action" disabled={disabled} onClick={() => {
              setError(null);
              void switchChainAsync({ chainId: 8453 }).catch(() => setError('The network could not be switched. Choose Base in your wallet and try again.'));
            }}>
              {switchingChain ? 'Switching…' : 'Switch to Base Mainnet'}
            </button>
          ) : null}
          {view.disconnect ? (
            <>
              <button type="button" className="still-wallet-action" disabled={disabled} onClick={() => void changeWallet('switch')}>
                {busy === 'switch' ? 'Switching…' : 'Switch wallet'}
              </button>
              <button type="button" className="still-wallet-action" disabled={disabled} onClick={() => void changeWallet('disconnect')}>
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </>
          ) : null}
          {view.signOut ? (
            <button type="button" className="still-wallet-action" disabled={disabled} onClick={() => void changeWallet('signout')}>
              {busy === 'signout' ? 'Signing out…' : 'Sign out'}
            </button>
          ) : null}
          {error || gate.error ? <p className="still-wallet-warning" role="alert">{error ?? 'The wallet sign-in did not finish. Try again when you are ready.'}</p> : null}
        </div>
      </details>
    </div>
  );
}
