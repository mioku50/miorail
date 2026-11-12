import { useState } from 'react';
import { useLocation } from 'wouter';
import { useAccount, useConnect } from 'wagmi';
import { isWalletRejectionError } from '@mioagent/wallet-actions';
import type { StillCreateWalletV1 } from '@mioagent/ui/still';
import { createWalletConnectorIdV1 } from '../../lib/walletChoices';

// ---------------------------------------------------------------------------
// "Create a wallet" on Still's Home (2026-11-12): a visitor with no wallet had
// only "Sign in", which led to a list of wallets they did not have.
//
// The press asks wagmi's Base Account connector to connect, from the press
// itself: a browser lets a page open a window only from a press, and Base
// Account's window is where a passkey makes the wallet, or opens the one a
// person already has. Connecting signs nothing. Once the wallet is connected
// the sign-in page asks for the one signature every wallet gives, and then
// returns to `next`.
// ---------------------------------------------------------------------------

export function useCreateWalletV1(next: string): StillCreateWalletV1 | null {
  const { connectAsync, connectors } = useConnect();
  const { isConnected } = useAccount();
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<'idle' | 'opening' | 'failed'>('idle');
  const connectorId = createWalletConnectorIdV1({ connectors, connected: isConnected });
  const connector = connectorId ? connectors.find((candidate) => candidate.id === connectorId) : undefined;
  if (!connector) return null;
  return {
    opening: phase === 'opening',
    error: phase === 'failed' ? 'Base Account did not open. Try again, or sign in with the wallet you have.' : null,
    onCreate: () => {
      if (phase === 'opening') return;
      setPhase('opening');
      connectAsync({ connector }).then(
        () => {
          setPhase('idle');
          navigate(`/signin?next=${encodeURIComponent(next)}`);
        },
        // Closing the window is a choice, not a failure: the button simply comes back.
        (cause: unknown) => setPhase(isWalletRejectionError(cause) ? 'idle' : 'failed'),
      );
    },
  };
}
