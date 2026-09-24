import { useEffect, useState } from 'react';
import { useConnect } from 'wagmi';
import { useUiStore } from '../lib/state';
import { detectBaseAppEarly } from '../lib/detectBaseAppEarly';
import { isMobileBrowserV1, walletChoicesV1 } from '../lib/walletChoices';

// The person picks the wallet. What is offered is decided by
// `walletChoicesV1` from what this page can actually reach — announced
// wallets, Base Account outside Base App, and on a bare phone browser a link
// that reopens this page inside a wallet app. Connecting never signs anything;
// the one signature is the sign-in the gate asks for next.

const ROW =
  'flex w-full items-center gap-3 rounded-lg border border-line px-3 py-3 text-left transition-colors hover:border-accent disabled:opacity-50';

export function WalletPicker() {
  const { connect, connectors, error, isPending } = useConnect();
  const showToast = useUiStore((s) => s.showToast);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    if (error) showToast('Connection error: ' + error.message.split('\n')[0]);
  }, [error, showToast]);

  useEffect(() => {
    if (!isPending) setChosen(null);
  }, [isPending]);

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
      {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}
    </div>
  );
}
