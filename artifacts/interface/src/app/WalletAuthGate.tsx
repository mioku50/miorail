import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useSignMessage, useSwitchChain } from 'wagmi';
import {
  logoutWalletSession,
  useSession,
  useVerifyWallet,
  useWalletChallenge,
  setWalletEnvironment,
} from '@mioagent/api-client-react';
import { WalletConnect } from '../shell/WalletConnect';
import { clearTenantClientState } from '../lib/tenantState';
import { isBaseAppEnvironment } from '../lib/baseAppEnvironment';

export function WalletAuthGate({ children }: { children: ReactNode }) {
  const { address, isConnected, chainId, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const session = useSession({ retry: false, staleTime: 0 });
  const challenge = useWalletChallenge();
  const verify = useVerifyWallet();
  const attemptAddress = useRef<string | null>(null);
  const previousAddress = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void connector?.getProvider().then((provider) => {
      if (cancelled) return;
      const environment = isBaseAppEnvironment({
        connectorId: connector.id,
        connectorName: connector.name,
        userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
        provider,
      }) ? 'baseapp' : 'web';
      setWalletEnvironment(environment);
      void queryClient.invalidateQueries({ queryKey: ['status'] });
    }).catch(() => {
      setWalletEnvironment('web');
      void queryClient.invalidateQueries({ queryKey: ['status'] });
    });
    if (!connector) {
      setWalletEnvironment('web');
      void queryClient.invalidateQueries({ queryKey: ['status'] });
    }
    return () => { cancelled = true; };
  }, [connector, queryClient]);

  const authenticate = useCallback(async () => {
    if (!address || chainId !== 8453 || attemptAddress.current === address.toLowerCase()) return;
    attemptAddress.current = address.toLowerCase();
    setError(null);
    try {
      if (session.data?.user) await logoutWalletSession();
      clearTenantClientState(queryClient);
      const nextChallenge = await challenge.mutateAsync({ address });
      const signature = await signMessageAsync({ message: nextChallenge.message });
      const result = await verify.mutateAsync({ message: nextChallenge.message, signature });
      queryClient.setQueryData(['session'], { user: result.user });
    } catch (cause) {
      attemptAddress.current = null;
      setError(cause instanceof Error ? cause.message : 'Wallet authentication failed');
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    }
  }, [address, chainId, challenge, queryClient, session.data?.user, signMessageAsync, verify]);

  useEffect(() => {
    const current = address?.toLowerCase() || null;
    if (previousAddress.current && previousAddress.current !== current) {
      attemptAddress.current = null;
      clearTenantClientState(queryClient);
    }
    previousAddress.current = current;
  }, [address, queryClient]);

  const authenticated = Boolean(
    address
    && session.data?.user?.chainId === 8453
    && session.data.user.address.toLowerCase() === address.toLowerCase(),
  );

  useEffect(() => {
    if (authenticated) {
      attemptAddress.current = null;
      return;
    }
    if (!session.isPending && isConnected && address && chainId === 8453) void authenticate();
  }, [address, authenticate, authenticated, chainId, isConnected, session.isPending]);

  if (authenticated) return <>{children}</>;

  return (
    <main className="min-h-screen bg-bg text-text flex items-center justify-center p-6">
      <section className="w-full max-w-md border border-line bg-panel p-6 shadow-2xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Miorail tenant access</p>
        <h1 className="mt-3 text-2xl font-semibold">Authenticate your Base Account</h1>
        <p className="mt-3 text-sm text-muted">
          One wallet signature binds chats, actions, fuel, policies and Base MCP credentials to this address. Signing does not send a transaction.
        </p>
        <div className="mt-6"><WalletConnect /></div>
        {isConnected && chainId !== 8453 && (
          <button className="mt-4 w-full border border-accent px-4 py-3 text-sm text-accent" onClick={() => void switchChainAsync({ chainId: 8453 })}>
            Switch to Base Mainnet
          </button>
        )}
        {isConnected && chainId === 8453 && !authenticated && (
          <button className="mt-4 w-full bg-accent px-4 py-3 text-sm font-semibold text-bg disabled:opacity-50" disabled={challenge.isPending || verify.isPending} onClick={() => void authenticate()}>
            {challenge.isPending || verify.isPending ? 'Waiting for wallet…' : 'Sign in with wallet'}
          </button>
        )}
        {error && <p className="mt-4 text-xs text-danger">{error}</p>}
      </section>
    </main>
  );
}
