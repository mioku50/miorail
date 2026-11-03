import { useEffect, useSyncExternalStore } from 'react';
import { useAccount } from 'wagmi';
import { METAMASK_OPEN_HREF_V1 } from '../lib/walletChoices';
import { subscribeWalletAppPendingV1, trackWalletAppRequestsV1, walletAppPendingV1, type WalletAppProviderV1 } from '../lib/walletAppRequests';

// MetaMask paired by WalletConnect, on a phone: every request waits in the
// MetaMask app. While one does, the page says so and offers to bring MetaMask
// forward; it also tries once as the request goes, which a browser may allow
// or ask about. iOS does not bring the browser back afterwards: the person
// returns with ◀ Safari, top left, and the page reads the answer then.

function bringMetaMaskForwardV1(): void {
  try {
    window.location.href = METAMASK_OPEN_HREF_V1;
  } catch {
    // The link below stays.
  }
}

export function WalletAppPrompt() {
  const { connector, isConnected } = useAccount();
  const pending = useSyncExternalStore(subscribeWalletAppPendingV1, walletAppPendingV1, () => 0);
  const paired = isConnected && connector?.type === 'walletConnect';

  useEffect(() => {
    if (!paired || !connector) return;
    let cancelled = false;
    void Promise.resolve(connector.getProvider())
      .then((provider) => {
        if (!cancelled && provider && typeof (provider as WalletAppProviderV1).request === 'function') {
          trackWalletAppRequestsV1(provider as WalletAppProviderV1, bringMetaMaskForwardV1);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [connector, paired]);

  if (!paired || pending === 0) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-24 z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl border border-accent bg-panel px-4 py-3 text-sm text-ink shadow-lg"
    >
      <span>MetaMask has a request for you to approve. Then come back here.</span>
      <a className="shrink-0 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-bg" href={METAMASK_OPEN_HREF_V1}>
        Open MetaMask
      </a>
    </div>
  );
}
