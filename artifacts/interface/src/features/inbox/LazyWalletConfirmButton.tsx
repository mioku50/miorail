// T19.1: code-split the wallet/crypto deps out of the main bundle. The real
// `WalletConfirmButton` (and its `ox`/wagmi/viem confirm-flow code) is loaded
// only when a confirmable action card renders. Callers pass the RAW builder
// code (a public env string) so `ox/erc8021` is never imported at module scope.
//
// Note: `wagmi`/`viem` still ship in the main bundle because `main.tsx` mounts
// `WagmiProvider` app-wide; this split removes `ox` + the confirm-flow code and
// keeps non-inbox routes from loading it.

import { lazy, Suspense } from 'react';
import { Button } from '@mioagent/ui';
import type { WalletConfirmButtonProps } from '@mioagent/wallet-actions';

const WalletConfirmButton = lazy(() =>
  import('@mioagent/wallet-actions').then((m) => ({ default: m.WalletConfirmButton })),
);

export function LazyWalletConfirmButton(props: WalletConfirmButtonProps) {
  return (
    <Suspense
      fallback={
        <Button variant="primary" className={props.className} disabled>
          ⚡ Preparing…
        </Button>
      }
    >
      <WalletConfirmButton {...props} />
    </Suspense>
  );
}
