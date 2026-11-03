import { useEffect, useRef, useState } from 'react';
import { useConnect } from 'wagmi';
import { useUiStore } from '../lib/state';
import { detectBaseAppEarly } from '../lib/detectBaseAppEarly';
import { farcasterHostV1 } from '../lib/miniAppHost';
import { isMobileBrowserV1, metaMaskPairHrefV1, metaMaskPairSchemeV1, walletChoicesV1 } from '../lib/walletChoices';

// The person picks the wallet. What is offered is decided by
// `walletChoicesV1` from what this page can actually reach — announced
// wallets, Base Account outside Base App and Farcaster, and on a bare phone
// browser a link that reopens this page inside a wallet app. Connecting never signs anything;
// the one signature is the sign-in the gate asks for next.
//
// MetaMask by WalletConnect pairs from here: the pairing link opens the
// MetaMask app, the person approves there and comes back to this browser
// (iOS returns with ◀ Safari, top left), and the page is connected.

const ROW =
  'flex w-full items-center gap-3 rounded-lg border border-line px-3 py-3 text-left transition-colors hover:border-accent disabled:opacity-50';

export function WalletPicker() {
  const { connect, connectors, error, isPending } = useConnect();
  const showToast = useUiStore((s) => s.showToast);
  const [chosen, setChosen] = useState<string | null>(null);
  // The WalletConnect pairing MetaMask is asked to approve, while it waits.
  const [pairing, setPairing] = useState<string | null>(null);
  const stopListening = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (error) showToast('Connection error: ' + error.message.split('\n')[0]);
  }, [error, showToast]);

  useEffect(() => {
    if (!isPending) {
      setChosen(null);
      setPairing(null);
      stopListening.current?.();
      stopListening.current = null;
    }
  }, [isPending]);
  useEffect(() => () => stopListening.current?.(), []);

  const ethereum = typeof window === 'undefined' ? undefined : (window as { ethereum?: unknown }).ethereum;
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const { choices, note } = walletChoicesV1({
    connectors: connectors.map((connector) => ({
      id: connector.id,
      name: connector.name,
      type: connector.type,
      icon: connector.icon,
    })),
    inBaseApp: detectBaseAppEarly({ userAgent, ethereum }),
    inFarcaster: farcasterHostV1() !== null,
    hasWindowProvider: Boolean(ethereum),
    mobile: isMobileBrowserV1({
      userAgent,
      maxTouchPoints: typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
    }),
    pageUrl: typeof window === 'undefined' ? 'https://miorail.xyz/' : window.location.href,
  });

  return (
    <div className="flex flex-col gap-2 text-left" aria-label="Wallets you can connect here">
      {choices.map((choice) => {
        const icon =
          choice.kind === 'connector' && choice.icon ? (
            <img src={choice.icon} alt="" className="h-7 w-7 shrink-0 rounded" />
          ) : (
            // No icon was announced: the wallet's initial, never an empty box.
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-line text-xs font-semibold text-muted"
            >
              {choice.name.slice(0, 1)}
            </span>
          );
        if (choice.kind === 'open_in') {
          return (
            <a key={choice.key} className={ROW} href={choice.href} rel="noopener noreferrer">
              {icon}
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">Open in {choice.name}</span>
                <span className="block text-xs text-muted">{choice.detail}</span>
              </span>
            </a>
          );
        }
        const connecting = isPending && chosen === choice.key;
        return (
          <button
            key={choice.key}
            type="button"
            className={ROW}
            disabled={isPending}
            onClick={() => {
              const connector = connectors.find((candidate) => candidate.id === choice.connectorId);
              if (!connector) return;
              setChosen(choice.key);
              if (choice.pairWith === 'metamask') {
                // The pairing link comes a moment after the press; MetaMask is opened with it at once,
                // and the link stays on the page for a browser that did not open it.
                const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
                  if (type !== 'display_uri' || typeof data !== 'string' || !data.startsWith('wc:')) return;
                  setPairing(data);
                  try { window.location.href = metaMaskPairSchemeV1(data); } catch { /* the link stays */ }
                };
                stopListening.current?.();
                connector.emitter.on('message', onMessage);
                stopListening.current = () => connector.emitter.off('message', onMessage);
              }
              connect({ connector });
            }}
          >
            {icon}
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink">
                {connecting ? `Connecting ${choice.name}…` : choice.name}
              </span>
              <span className="block text-xs text-muted">{choice.detail}</span>
            </span>
          </button>
        );
      })}
      {pairing ? (
        <div className="mt-1 rounded-lg border border-accent px-3 py-3" role="status">
          <p className="text-sm text-ink">Approve the connection in MetaMask, then come back to this browser.</p>
          <p className="mt-1 text-xs text-muted">On an iPhone: ◀ Safari, top left. This page connects once MetaMask approves.</p>
          <a className="mt-2 inline-block rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-bg" href={metaMaskPairHrefV1(pairing)} rel="noopener noreferrer">
            Open MetaMask
          </a>
        </div>
      ) : null}
      {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}
    </div>
  );
}
