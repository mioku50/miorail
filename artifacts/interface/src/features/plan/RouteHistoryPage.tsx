// T58: tenant Route Run history at /plan/history (the legacy /history page —
// chat + action inbox — is untouched). Cursor-paginated, read-only: the page
// never reconciles; selecting an item with a proof shows its reconciled
// Execution Proof via a pure GET.

import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import {
  useRevokeProofShare,
  useRouteHistory,
  useRouteProof,
  useShareProof,
  useStatus,
} from '@mioagent/api-client-react';
import { ExecutionProofPanel, RouteHistoryList, ShareProofPanel, type RouteHistoryItemView } from '@mioagent/ui';

export function RouteHistoryPage() {
  const [items, setItems] = useState<RouteHistoryItemView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<RouteHistoryItemView | null>(null);
  const history = useRouteHistory({ limit: 20, cursor });
  const proof = useRouteProof(selected?.proofId ?? null);
  // T67C.2: publishing is an explicit owner action. The link lives in local
  // state rather than being fetched, because a proof with no share has no
  // link to fetch — and the absence of one is exactly what "private" means.
  const status = useStatus();
  const share = useShareProof();
  const revoke = useRevokeProofShare();
  const [publicUrl, setPublicUrl] = useState<string | null>(null);

  // Selecting a different proof drops the link: it belonged to the other one.
  useEffect(() => {
    setPublicUrl(null);
  }, [selected?.proofId]);

  useEffect(() => {
    if (!history.data) return;
    setItems((current) => {
      const known = new Set(current.map((item) => item.routeRunId));
      return [...current, ...history.data.items.filter((item) => !known.has(item.routeRunId))];
    });
  }, [history.data]);

  return (
    <main className="flex-1 overflow-y-auto bg-bg px-4 pb-24 pt-6 sm:px-7 lg:px-10 lg:pb-10">
      <div className="mx-auto w-full max-w-[880px]">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-pop">Route intelligence · Base</p>
            <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">Route history</h1>
            <p className="mt-1 text-sm text-ink-2">
              Your past route runs with their blueprint and independently verified execution proofs.
            </p>
          </div>
          <Link
            href="/plan"
            className="rounded-full border border-line bg-panel-2 px-4 py-2 text-sm text-ink-2 transition-colors hover:border-accent/45 hover:text-ink"
          >
            ← Back to plan
          </Link>
        </header>

        <section className="mt-6 space-y-4" aria-live="polite">
          {history.isPending && items.length === 0 && (
            <div className="rounded-xl border border-line bg-panel p-6">
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent-2">Loading history…</p>
            </div>
          )}
          {history.isError && (
            <div className="rounded-xl border border-risk/35 bg-risk-soft p-6" role="alert">
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
            <p className="text-xs text-ink-3">
              This run has no execution proof yet — it never reached an approved submission.
            </p>
          )}
          {selected?.proofId && proof.isPending && (
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent-2">Loading execution proof…</p>
          )}
          {selected?.proofId && proof.isError && (
            <p className="text-xs text-risk">Execution proof could not be loaded: {proof.error?.message}</p>
          )}
          {selected?.proofId && proof.data && (
            <ExecutionProofPanel proof={proof.data.proof} lifecycle={proof.data.lifecycle} />
          )}
          {/* Only for a proof that has finished. A pending proof describes a
              question Miorail has not answered, and publishing it would put a
              claim on the internet that Miorail itself is not making. */}
          {selected?.proofId &&
            proof.data &&
            status.data?.productMigration?.publicProofV1 &&
            proof.data.proof.finalStatus !== 'pending' && (
              <ShareProofPanel
                publicUrl={publicUrl}
                pending={share.isPending || revoke.isPending}
                onShare={() => {
                  const proofId = selected.proofId;
                  if (!proofId) return;
                  share.mutate({ proofId }, { onSuccess: (result) => setPublicUrl(result.url) });
                }}
                onRevoke={() => {
                  const proofId = selected.proofId;
                  if (!proofId) return;
                  revoke.mutate({ proofId }, { onSuccess: () => setPublicUrl(null) });
                }}
                onCopy={() => {
                  if (publicUrl) void navigator.clipboard?.writeText(new URL(publicUrl, location.origin).toString());
                }}
                onDownload={() => {
                  // The public id is in the URL the server returned; the
                  // download route serves the canonical bundle under it.
                  if (publicUrl) location.href = `/api/public/proofs/${publicUrl.split('/').pop()}/bundle`;
                }}
              />
            )}
        </section>
      </div>
    </main>
  );
}
