"use client";
import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Button, Card } from "@mioagent/ui";

// Standard web-app wallet connect. Base Account ("Sign in with Base") is the
// primary option — passkey sign-in, automatic context inside Base App, popup
// connect in a normal browser. Coinbase Wallet and injected browser wallets are
// fallbacks. No-custody: this only establishes wallet context / identity — no
// signing or transaction execution happens from this UI.

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Friendly labels keyed by connector id (see app/wagmi.ts). Unknown connectors
// fall back to the connector's own name.
const LABELS: Record<string, string> = {
  baseAccount: "Sign in with Base",
  coinbaseWalletSDK: "Coinbase Wallet",
  injected: "Browser wallet",
};

export function WalletConnect() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        {/* Pill chip — address + disconnect */}
        <button
          type="button"
          onClick={() => disconnect()}
          className="flex items-center gap-1.5 bg-panel-2 border border-line rounded-full pl-3 pr-2 py-1 hover:border-ink-3 transition-colors"
          title="Disconnect wallet"
        >
          <span
            className="text-[11px] text-ink-2"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {truncateAddress(address)}
          </span>
          <span className="text-[10px] text-ink-3">✕</span>
        </button>
      </div>
    );
  }

  // De-dup by id (wagmi can surface the same connector twice) and drop the
  // primary Base Account connector to render it first.
  const seen = new Set<string>();
  const deduped = connectors.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  const options = [
    ...deduped.filter((c) => c.id === "baseAccount"),
    ...deduped.filter((c) => c.id !== "baseAccount"),
  ];

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} className="rounded-full px-4">
        Connect
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Connect wallet"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <Card className="p-4 w-full max-w-xs">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-mono uppercase tracking-wider text-ink-3">
                Connect wallet
              </span>
              <button
                type="button"
                className="text-ink-3 hover:text-ink text-sm leading-none"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {options.map((c) => (
                <Button
                  key={c.id}
                  variant={c.id === "baseAccount" ? "primary" : "secondary"}
                  className="w-full justify-start"
                  onClick={() => {
                    connect({ connector: c });
                    setOpen(false);
                  }}
                >
                  {LABELS[c.id] ?? c.name}
                </Button>
              ))}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
