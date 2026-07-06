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
  actionId?: string;
  actionType?: string;
}

interface EBState {
  hasError: boolean;
  errorMsg?: string;
}

class WalletConfirmErrorBoundary extends Component<EBProps, EBState> {
  constructor(props: EBProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: unknown): EBState {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { hasError: true, errorMsg };
  }

  componentDidCatch(error: unknown) {
    const aid = this.props.actionId || 'unknown';
    const atype = this.props.actionType || 'unknown';
    console.error(`[Miorail] WalletConfirmButton failed for action.id=${aid}, actionType=${atype}:`, error);
  }

  render() {
    if (this.state.hasError) {
      const shortErr = this.state.errorMsg ? ` (${this.state.errorMsg.slice(0, 40)})` : '';
      const aid = this.props.actionId ? ` [id: ${this.props.actionId.slice(0, 8)}…]` : '';
      return (
        <Button
          variant="secondary"
          className={this.props.className}
          disabled
          title={`Action ID: ${this.props.actionId || 'unknown'}, Type: ${this.props.actionType || 'unknown'}, Error: ${this.state.errorMsg || 'unknown'}`}
        >
          Wallet confirm unavailable — check console/config{shortErr}{aid}
        </Button>
      );
    }
    return this.props.children;
  }
}

export function LazyWalletConfirmButton(props: WalletConfirmButtonProps) {
  const rawPayload = props.action?.executionPayload;
  const payload =
    typeof rawPayload === 'string'
      ? (() => {
          try {
            return JSON.parse(rawPayload);
          } catch {
            return null;
          }
        })()
      : rawPayload && typeof rawPayload === 'object'
        ? rawPayload
        : null;
  const actionType = (payload as { actionType?: string } | null)?.actionType ?? (props.action?.metadata as { actionType?: string } | undefined)?.actionType ?? 'unknown';
  const actionId = props.action?.id ?? 'unknown';

  return (
    <WalletConfirmErrorBoundary className={props.className} actionId={actionId} actionType={actionType}>
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
