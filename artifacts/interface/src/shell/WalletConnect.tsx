import { useEffect } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { useUiStore } from '../lib/state';
import { expectedChainId } from '../lib/chain';

export function WalletConnect() {
  const { address, isConnected, isConnecting, chainId } = useAccount();
  const { connect, connectors, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const showToast = useUiStore((s) => s.showToast);

  const isWrongNetwork = isConnected && chainId !== expectedChainId;
  const preferredConnector = connectors.find((connector) => connector.id === 'injected')
    ?? connectors.find((connector) => connector.id === 'baseAccount')
    ?? connectors[0];

  useEffect(() => {
    if (error) {
      showToast('Connection error: ' + error.message.split('\n')[0]);
    }
  }, [error, showToast]);

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
      onClick={() => preferredConnector && connect({ connector: preferredConnector })}
      disabled={!preferredConnector}
      className="bg-accent hover:bg-accent-2 text-white px-[12px] py-[7px] rounded-[10px] text-[13px] transition-colors font-medium shadow-sm"
    >
      Connect Wallet
    </button>
  );
}
