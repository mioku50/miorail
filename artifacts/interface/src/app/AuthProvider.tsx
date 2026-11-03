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
  /** The wallet has said nothing about the sign-in request for a while. */
  stalled: boolean;
  /** Asks the wallet again with a fresh request, when it stalled: the first is let go. */
  askAgain: () => void;
}

/** How long a wallet may stay silent about the sign-in request before the page
 * offers to ask again. MetaMask's app sometimes never shows a personal_sign
 * (2026-11-03: the challenge was issued, no signature came back, and the
 * button said "Waiting for wallet…" for good). */
export const SIGN_IN_STALL_MS_V1 = 20_000;

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
  // Each press is one attempt; an answer to an attempt that was let go is not used.
  const attemptSeq = useRef(0);
  const [stalled, setStalled] = useState(false);
  const previousAddress = useRef<string | null>(null);
  const previousConnected = useRef<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // The wallet's own signature sheet is part of signing too. Without it the
  // button read "Continue" while a request sat open in the wallet, and every
  // press was dropped by the single-flight guard below — silently.
  const [awaitingSignature, setAwaitingSignature] = useState(false);

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
      attemptSeq.current++;
      setAwaitingSignature(false);
      setStalled(false);
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
    const seq = ++attemptSeq.current;
    const current = () => attemptSeq.current === seq;
    setError(null);
    setStalled(false);
    let stall: ReturnType<typeof setTimeout> | undefined;
    try {
      if (session.data?.user) await logoutWalletSession();
      clearTenantClientState(queryClient);
      const nextChallenge = await challenge.mutateAsync({ address });
      if (!current()) return;
      setAwaitingSignature(true);
      stall = setTimeout(() => { if (current()) setStalled(true); }, SIGN_IN_STALL_MS_V1);
      let signature: `0x${string}`;
      try {
        signature = await signMessageAsync({ message: nextChallenge.message });
      } finally {
        clearTimeout(stall);
        if (current()) {
          setAwaitingSignature(false);
          setStalled(false);
        }
      }
      // Asked again meanwhile: this signature answers a challenge the server no longer holds.
      if (!current()) return;
      const result = await verify.mutateAsync({ message: nextChallenge.message, signature });
      if (!current()) return;
      queryClient.setQueryData(['session'], { user: result.user });
    } catch (cause) {
      if (!current()) return;
      setError(cause instanceof Error ? cause.message : 'Wallet authentication failed');
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    } finally {
      if (current()) attemptAddress.current = null;
    }
  }, [address, chainId, challenge, queryClient, session.data?.user, signMessageAsync, verify]);

  const askAgain = useCallback(() => {
    if (!stalled) return;
    // The first request stays open in the wallet; whatever it answers is not used.
    attemptSeq.current++;
    attemptAddress.current = null;
    setAwaitingSignature(false);
    setStalled(false);
    void continueWithWallet();
  }, [continueWithWallet, stalled]);

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
    signing: challenge.isPending || awaitingSignature || verify.isPending,
    error,
    stalled,
    askAgain,
  };

  return <AuthGateContext.Provider value={value}>{children}</AuthGateContext.Provider>;
}
