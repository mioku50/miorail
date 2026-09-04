import { useEffect } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { useUiStore } from '../lib/state';
import { expectedChainId } from '../lib/chain';
import { detectBaseAppEarly } from '../lib/detectBaseAppEarly';

export function WalletConnect() {
  const { address, isConnected, isConnecting, chainId } = useAccount();
  const { connect, connectors, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const showToast = useUiStore((s) => s.showToast);

  const isWrongNetwork = isConnected && chainId !== expectedChainId;

  // T48a.1: `main.tsx` already excludes `baseAccount()` from the wagmi config
  // whenever Base App is detected, so this component can never actually see
  // a baseAccount connector in that case. The `inBaseApp` check here is a
  // second, independent guard against relying on that alone — it also covers
  // the case where an unexpected host still exposes both connectors.
  // Any injected connector — the explicit `injected()` one (id `'injected'`)
  // or an EIP-6963-discovered one (id = provider `rdns`, e.g.
  // `'com.coinbase.wallet'`) — is tagged by wagmi with `type === 'injected'`.
  // Only `baseAccount()` has `type === 'baseAccount'`. Preferring by `type`
  // means a host-injected EIP-6963 provider is picked correctly even though
  // its `id` is not literally `'injected'`.
  const inBaseApp = detectBaseAppEarly({
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    ethereum: typeof window === 'undefined' ? undefined : (window as any).ethereum,
  });
  // AN INJECTED CONNECTOR IS NOT AN INJECTED PROVIDER.
  //
  // `injected()` is registered unconditionally in main.tsx, so this find always
  // succeeded and `baseAccount()` was never reached outside Base App. In a
  // plain mobile browser there is no injected provider at all, so connecting
  // threw `Provider not found` and the wallet could not be connected AT ALL —
  // on the surface a link shared from a phone lands on.
  //
  // Found 2026-09-05: a review link prepared by ChatGPT on a phone, opened in
  // mobile Safari. Base App works because its host injects a provider; a
  // browser extension works because EIP-6963 announces one. Mobile Safari has
  // neither, and that is exactly where `baseAccount()` — which needs no
  // injection and opens its own flow — is the right connector.
  //
  // So the preference is by what EXISTS, not by what is configured: a
  // provider announced through EIP-6963 (wagmi gives it the provider's rdns as
  // its id), else the generic injected connector only when a host actually put
  // an `ethereum` object on the page.
  const hasWindowProviderV1 =
    typeof window !== 'undefined' && Boolean((window as { ethereum?: unknown }).ethereum);
  const injectedConnector =
    connectors.find((connector) => connector.type === 'injected' && connector.id !== 'injected') ??
    (hasWindowProviderV1
      ? connectors.find((connector) => connector.type === 'injected')
      : undefined);
  const baseAccountConnector = inBaseApp
    ? undefined
    : connectors.find((connector) => connector.id === 'baseAccount' || connector.type === 'baseAccount');
  const preferredConnector = injectedConnector
    ?? baseAccountConnector
    ?? (inBaseApp ? undefined : connectors[0]);

  useEffect(() => {
    if (error) {
      showToast('Connection error: ' + error.message.split('\n')[0]);
    }
  }, [error, showToast]);

  const handleConnectClick = () => {
    if (preferredConnector) {
      connect({ connector: preferredConnector });
      return;
    }
    // No silent fallback to baseAccount inside Base App: tell the user what
    // to do instead of opening keys.coinbase.com in the embedded webview.
    if (inBaseApp) {
      showToast('Open Miorail inside Base App to connect your Base Account');
      return;
    }
    showToast('No wallet connector is available in this browser.');
  };

  if (isConnecting) {
    return (
      <button disabled className="bg-bg border border-line px-[12px] py-[7px] rounded-[10px] text-ink-3 text-[13px] opacity-50 cursor-wait">
        Connecting...
      </button>
    );
  }

  if (isConnected) {
    if (isWrongNetwork) {
      return (
        <button
          onClick={() => switchChain && switchChain({ chainId: expectedChainId })}
          className="bg-warn-soft text-warn border border-warn/20 px-[12px] py-[7px] rounded-[10px] text-[13px] hover:bg-warn-soft/80 transition-colors font-medium"
        >
          Switch to Base{expectedChainId === 84532 ? ' Sepolia' : ''}
        </button>
      );
    }

    return (
      <button
        onClick={() => disconnect()}
        className="bg-bg border border-line px-[12px] py-[7px] rounded-[10px] text-ink-3 text-[13px] hover:bg-line/50 transition-colors flex items-center gap-2"
        title="Disconnect Wallet"
      >
        <span className="w-2 h-2 rounded-full bg-ok"></span>
        {address?.slice(0, 6)}…{address?.slice(-4)}
      </button>
    );
  }

  return (
    <button
      onClick={handleConnectClick}
      className="bg-accent hover:bg-accent-2 text-white px-[12px] py-[7px] rounded-[10px] text-[13px] transition-colors font-medium shadow-sm"
    >
      Connect Wallet
    </button>
  );
}
