import type { AuthPhase } from '../../lib/authGateState';

interface WalletControlInputV1 {
  connected: boolean;
  address: string | null;
  chainId: number | null;
  session: { address: string; chainId: number } | null;
  sessionPending: boolean;
  phase: AuthPhase;
}

export interface WalletControlViewV1 {
  kind: 'checking' | 'connect' | 'account';
  label: string;
  status: string;
  walletAddress: string | null;
  sessionAddress: string | null;
  warning: string | null;
  signIn: boolean;
  switchChain: boolean;
  disconnect: boolean;
  signOut: boolean;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A browser connection and a signed-in account are separate facts. */
export function walletControlViewV1(input: WalletControlInputV1): WalletControlViewV1 {
  const walletAddress = input.connected ? input.address : null;
  const sessionAddress = input.session?.address ?? null;
  const mismatch = Boolean(walletAddress && sessionAddress && walletAddress.toLowerCase() !== sessionAddress.toLowerCase());
  const switchChain = Boolean(walletAddress && input.chainId !== 8453);
  const authenticated = Boolean(
    walletAddress && sessionAddress && !mismatch && !switchChain
    && input.session?.chainId === 8453 && input.phase === 'authenticated',
  );
  const address = walletAddress ?? sessionAddress;
  const checking = input.phase === 'booting' || (input.sessionPending && !address);
  return {
    kind: address ? 'account' : checking ? 'checking' : 'connect',
    label: address ? shortAddress(address) : checking ? 'Checking wallet…' : 'Connect wallet',
    status: checking ? 'Checking session…'
      : !walletAddress ? (sessionAddress ? 'Wallet disconnected' : 'Not connected')
        : switchChain ? 'Switch to Base'
          : authenticated ? 'Signed in on Base'
            : 'Sign in required',
    walletAddress,
    sessionAddress,
    warning: mismatch
      ? 'The connected wallet differs from your signed-in account. Sign in with this wallet before using private actions.'
      : sessionAddress && !walletAddress
        ? 'Your account is still signed in, but no wallet is connected in this browser.'
        : null,
    signIn: Boolean(walletAddress && !authenticated && !switchChain && !checking),
    switchChain,
    disconnect: Boolean(walletAddress),
    signOut: Boolean(sessionAddress),
  };
}

export type StillWalletActionV1 = 'signout' | 'disconnect' | 'switch';

/** Invalidate prepared actions and the server session before changing wallets.
 * A failed logout must never silently leave a valid signing session behind. */
export async function runStillWalletActionV1<Connector>(input: {
  action: StillWalletActionV1;
  connectors: readonly Connector[];
  logout: () => Promise<void>;
  clearSession: () => void;
  disconnect: (connector: Connector) => Promise<void>;
  openWalletPicker: () => void;
}): Promise<'done' | 'disconnect_incomplete'> {
  await input.logout();
  input.clearSession();
  if (input.action === 'signout') return 'done';
  let failed = false;
  for (const connector of input.connectors) {
    try {
      await input.disconnect(connector);
    } catch {
      // Another authorised connection must not become current accidentally.
      // Attempt every connection even if one provider refuses to disconnect.
      failed = true;
    }
  }
  input.clearSession();
  if (failed) return 'disconnect_incomplete';
  if (input.action === 'switch') input.openWalletPicker();
  return 'done';
}
