import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useSignMessage } from 'wagmi';
import {
  logoutWalletSession,
  useSession,
  useVerifyWallet,
  useWalletChallenge,
  setWalletEnvironment,
} from '@mioagent/api-client-react';
import { clearTenantClientState } from '../lib/tenantState';
import { isBaseAppEnvironment } from '../lib/baseAppEnvironment';
import { deriveAuthGate, type AuthGateState } from '../lib/authGateState';

// T48a: the app shell (TopBar/nav/cockpit) always renders — this provider no
// longer swaps the whole tree for a full-screen login screen, and it never
// signs a message on its own. SIWE (challenge -> signMessageAsync -> verify)
// only runs from `continueWithWallet()`, which callers must invoke from a
// click handler (shell auth-status button, RequireSession prompt).

export interface AuthGateContextValue extends AuthGateState {
  continueWithWallet: () => Promise<void>;
  signing: boolean;
  error: string | null;
}

const AuthGateContext = createContext<AuthGateContextValue | null>(null);

export function useAuthGate(): AuthGateContextValue {
  const ctx = useContext(AuthGateContext);
  if (!ctx) throw new Error('useAuthGate must be used within <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { address, isConnected, chainId, connector } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const session = useSession({ retry: false, staleTime: 0 });
  const challenge = useWalletChallenge();
  const verify = useVerifyWallet();
  const attemptAddress = useRef<string | null>(null);
  const previousAddress = useRef<string | null>(null);
  const previousConnected = useRef<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // T47: detect BaseApp vs normal-web wallet context so the backend can tune
  // provider-specific behavior. Unrelated to SIWE.
  // T48a.2: hardened against hostile/broken injected providers. When multiple
  // wallet extensions fight over `window.ethereum`, `connector.getProvider`
  // can be missing or throw synchronously; the old `connector?.getProvider()`
  // only guarded a null connector, so it threw "getProvider is not a function"
  // and — with no error boundary — blanked the whole app. Fall back to 'web'
  // on any failure instead of crashing.
  useEffect(() => {
    let cancelled = false;
    const applyEnvironment = (environment: 'baseapp' | 'web') => {
      if (cancelled) return;
      setWalletEnvironment(environment);
      void queryClient.invalidateQueries({ queryKey: ['status'] });
    };
    if (!connector || typeof connector.getProvider !== 'function') {
      applyEnvironment('web');
      return () => { cancelled = true; };
    }
    try {
      void Promise.resolve(connector.getProvider())
        .then((provider) => {
          applyEnvironment(isBaseAppEnvironment({
            connectorId: connector.id,
            connectorName: connector.name,
            userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
            provider,
          }) ? 'baseapp' : 'web');
        })
        .catch(() => applyEnvironment('web'));
    } catch {
      applyEnvironment('web');
    }
    return () => { cancelled = true; };
  }, [connector, queryClient]);

  // T48a: wallet switch / disconnect teardown. Never signs — only tears down
  // the (now stale) server session + client cache so a subsequent explicit
  // "Continue with wallet" click starts clean. Skipped on the very first
  // connect (previousAddress is still null, nothing to tear down).
  useEffect(() => {
    const current = address?.toLowerCase() || null;
    const addressChanged = previousAddress.current !== null && previousAddress.current !== current;
    const justDisconnected = previousConnected.current && !isConnected;

    if (addressChanged || justDisconnected) {
      attemptAddress.current = null;
      setError(null);
      void (async () => {
        try {
          await logoutWalletSession();
        } catch {
          // Best-effort: the server session may already be gone/expired.
        }
        // Wipes ALL client query cache (session, chats, actions, prepared
        // actions, portfolio, autonomy, ...) plus ephemeral UI state, so no
        // stale tenant data survives the wallet switch.
        clearTenantClientState(queryClient);
        void queryClient.invalidateQueries({ queryKey: ['session'] });
      })();
    }

    previousAddress.current = current;
    previousConnected.current = isConnected;
  }, [address, isConnected, queryClient]);

  const continueWithWallet = useCallback(async () => {
    if (!address || chainId !== 8453) return;
    if (attemptAddress.current === address.toLowerCase()) return;
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
      setError(cause instanceof Error ? cause.message : 'Wallet authentication failed');
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    } finally {
      attemptAddress.current = null;
    }
  }, [address, chainId, challenge, queryClient, session.data?.user, signMessageAsync, verify]);

  const gate = deriveAuthGate({
    isConnected,
    address,
    chainId,
    sessionPending: session.isPending,
    sessionUser: session.data?.user ?? null,
  });

  const value: AuthGateContextValue = {
    ...gate,
    continueWithWallet,
    signing: challenge.isPending || verify.isPending,
    error,
  };

  return <AuthGateContext.Provider value={value}>{children}</AuthGateContext.Provider>;
}
