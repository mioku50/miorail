"use client";

// T58: miniapp Route Run history. Gated exactly like the root page: the
// server-derived routeIntelligenceV1 flag, a signed session, and Base
// mainnet. Read-only — selecting a run with a proof shows its reconciled
// Execution Proof via a pure GET; nothing here reconciles or signs.

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useRouteHistory, useRouteProof, useSession, useStatus } from "@mioagent/api-client-react";
import { ExecutionProofPanel, RouteHistoryList, type RouteHistoryItemView } from "@mioagent/ui";
import { WalletConnect } from "../components/WalletConnect";

export default function HistoryPage() {
  const { data: statusData, isPending: statusPending } = useStatus();
  const { address, isConnected, chainId } = useAccount();
  const session = useSession({ retry: false, staleTime: 0 });

  const flagEnabled = statusData?.productMigration.routeIntelligenceV1 === true;
  const sessionReady = Boolean(
    session.data?.user?.address &&
      address &&
      chainId === 8453 &&
      session.data.user.address.toLowerCase() === address.toLowerCase(),
  );

  const [items, setItems] = useState<RouteHistoryItemView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<RouteHistoryItemView | null>(null);
  const history = useRouteHistory({ limit: 20, cursor }, { enabled: flagEnabled && sessionReady });
  const proof = useRouteProof(selected?.proofId ?? null, { enabled: Boolean(selected?.proofId && sessionReady) });

  useEffect(() => {
    if (!history.data) return;
    setItems((current) => {
      const known = new Set(current.map((item) => item.routeRunId));
      return [...current, ...history.data.items.filter((item) => !known.has(item.routeRunId))];
    });
  }, [history.data]);

  if (statusPending) {
    return (
      <div className="min-h-screen bg-bg text-ink flex items-center justify-center text-sm text-ink-3">
        Checking product mode…
      </div>
    );
  }
  if (!flagEnabled) {
    return (
      <div className="min-h-screen bg-bg text-ink flex flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-ink-2">Route intelligence is not enabled.</p>
        <Link href="/" className="text-sm text-accent-2 underline">Back to home</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-ink">
      <header
        className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line px-4"
        style={{
          background: "rgba(14,18,38,0.82)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-pop">Miorail · Base</p>
          <p className="font-display text-base font-semibold">Route history</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="rounded-full border border-line bg-panel-2 px-3 py-1.5 text-xs text-ink-2"
            style={{ textDecoration: "none" }}
          >
            Plan
          </Link>
          <WalletConnect />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-4 py-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        {!isConnected && (
          <section className="rounded-2xl border border-line bg-panel p-5 text-center">
            <h1 className="font-display text-xl font-semibold">Connect a wallet to see your history</h1>
            <div className="mt-4 flex justify-center"><WalletConnect /></div>
          </section>
        )}
        {isConnected && chainId !== 8453 && (
          <section className="rounded-2xl border border-warn/40 bg-warn-soft p-5 text-center">
            <h1 className="font-display text-xl font-semibold">Base Mainnet required</h1>
          </section>
        )}
        {isConnected && chainId === 8453 && !sessionReady && (
          <section className="rounded-2xl border border-line bg-panel p-5 text-center">
            <p className="text-sm text-ink-2">
              Sign in on the <Link href="/" className="text-accent-2 underline">plan page</Link> first — history is
              private to your wallet session.
            </p>
          </section>
        )}

        {sessionReady && (
          <section aria-live="polite" className="space-y-4">
            {history.isPending && items.length === 0 && (
              <div className="rounded-2xl border border-line bg-panel p-5">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent-2">Loading history…</p>
              </div>
            )}
            {history.isError && (
              <div className="rounded-2xl border border-risk/35 bg-risk-soft p-5" role="alert">
                <p className="text-sm text-ink-2">History could not be loaded: {history.error?.message}</p>
              </div>
            )}
            {(items.length > 0 || (!history.isPending && !history.isError)) && (
              <RouteHistoryList
                items={items}
                nextCursor={history.data?.nextCursor ?? null}
                loadingMore={history.isPending}
                onSelect={setSelected}
                onLoadMore={setCursor}
              />
            )}
            {selected && !selected.proofId && (
              <p className="text-xs text-ink-3">This run has no execution proof yet.</p>
            )}
            {selected?.proofId && proof.data && (
              <ExecutionProofPanel proof={proof.data.proof} lifecycle={proof.data.lifecycle} />
            )}
            {selected?.proofId && proof.isError && (
              <p className="text-xs text-risk">Execution proof could not be loaded: {proof.error?.message}</p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
