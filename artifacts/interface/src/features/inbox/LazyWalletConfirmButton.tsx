// T19.1: code-split the wallet/crypto deps out of the main bundle. The real
// `WalletConfirmButton` (and its `ox`/wagmi/viem confirm-flow code) is loaded
// only when a confirmable action card renders. Callers pass the RAW builder
// code (a public env string) so `ox/erc8021` is never imported at module scope.
//
// Note: `wagmi`/`viem` still ship in the main bundle because `main.tsx` mounts
// `WagmiProvider` app-wide; this split removes `ox` + the confirm-flow code and
// keeps non-inbox routes from loading it.

import { lazy, Suspense, Component, type ReactNode } from 'react';
import { Button } from '@mioagent/ui';
import type { WalletConfirmButtonProps } from '@mioagent/wallet-actions';

const WalletConfirmButton = lazy(() =>
  import('@mioagent/wallet-actions').then((m) => ({ default: m.WalletConfirmButton })),
);

interface EBProps {
  children: ReactNode;
  className?: string;
}

interface EBState {
  hasError: boolean;
}

class WalletConfirmErrorBoundary extends Component<EBProps, EBState> {
  constructor(props: EBProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[Miorail] WalletConfirmButton render or chunk load failed:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Button variant="secondary" className={this.props.className} disabled>
          Wallet confirm unavailable — check console/config
        </Button>
      );
    }
    return this.props.children;
  }
}

export function LazyWalletConfirmButton(props: WalletConfirmButtonProps) {
  return (
    <WalletConfirmErrorBoundary className={props.className}>
      <Suspense
        fallback={
          <Button variant="primary" className={props.className} disabled>
            ⚡ Preparing…
          </Button>
        }
      >
        <WalletConfirmButton {...props} />
      </Suspense>
    </WalletConfirmErrorBoundary>
  );
}
