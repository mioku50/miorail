// T48a: pure boot/auth-phase derivation, shared by AuthProvider and
// RequireSession. Keeping this outside React makes the phase transitions
// (booting -> disconnected/wrong-chain/needs-signin/authenticated)
// unit-testable without a DOM or wagmi/react-query mocks.
//
// `showAppShell` is always true: the app shell renders regardless of auth
// state (T48a boot fix). Private surfaces (chats/actions/fuel/configure) are
// gated separately via `showPrivateSurfaces`, never by hiding the whole tree.

export type AuthPhase = 'booting' | 'disconnected' | 'wrong-chain' | 'needs-signin' | 'authenticated';

export interface AuthGateInput {
  isConnected: boolean;
  address?: string;
  chainId?: number;
  /** useSession().isPending */
  sessionPending: boolean;
  /** session.data?.user ?? null */
  sessionUser?: { address: string; chainId: number } | null;
}

export interface AuthGateState {
  walletConnected: boolean;
  /** session.user matches the currently connected address on Base Mainnet (8453). */
  sessionAuthenticated: boolean;
  /** = sessionAuthenticated today (tenant data loads from the session); kept
   * as its own field so a future tenant-load step can diverge from auth. */
  tenantLoaded: boolean;
  /** Connected to a wallet, but not on Base Mainnet (8453). */
  needsChainSwitch: boolean;
  phase: AuthPhase;
  /** The app shell renders unconditionally — never gated by auth. */
  showAppShell: true;
  /** Private surfaces (chats/actions/fuel/configure) may render. */
  showPrivateSurfaces: boolean;
}

export function deriveAuthGate(input: AuthGateInput): AuthGateState {
  const sessionAuthenticated = Boolean(
    input.address
    && input.sessionUser
    && input.sessionUser.chainId === 8453
    && input.sessionUser.address.toLowerCase() === input.address.toLowerCase(),
  );
  const needsChainSwitch = input.isConnected && input.chainId !== 8453;

  let phase: AuthPhase;
  if (!input.isConnected) {
    phase = 'disconnected';
  } else if (needsChainSwitch) {
    phase = 'wrong-chain';
  } else if (input.sessionPending && !sessionAuthenticated) {
    phase = 'booting';
  } else if (sessionAuthenticated) {
    phase = 'authenticated';
  } else {
    phase = 'needs-signin';
  }

  return {
    walletConnected: input.isConnected,
    sessionAuthenticated,
    tenantLoaded: sessionAuthenticated,
    needsChainSwitch,
    phase,
    showAppShell: true,
    showPrivateSurfaces: sessionAuthenticated,
  };
}
