// ---------------------------------------------------------------------------
// Activity — route runs, paid intelligence, and proofs once there are any.
//
// Two things were wrong with this page, and only one of them was the name.
//
// It rendered OUTSIDE ConsoleShell, wrapped in the bare `DeepLink` div. Opening
// the tab therefore removed the tab bar: the only way back was one "← Back to
// plan" link, and the page arrived in pre-console styling so it read as a
// different product. A primary navigation entry that drops you out of the
// navigation is a bug regardless of what the entry is called.
//
// And it showed only route runs. In production all of them sit at `ready` —
// prepared, compared, never signed — while thirteen settled USDC payments, the
// one provably completed thing this product has done, appeared nowhere. So the
// paid ledger is here too.
//
// Read-only, as before: the page never reconciles and never re-runs.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  useRevokeProofShare,
  useBaseMcpActionReceipts,
  useRouteHistory,
  useRouteProof,
  useShareProof,
  useStatus,
  useX402Ledger,
} from '@mioagent/api-client-react';
import {
  ActivityProofCard,
  ActivityRunsCard,
  ActivitySpendCard,
  BaseMcpActionReceiptsCard,
  ConsoleShell,
  ShareProofPanel,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  consoleSectionPathV1,
  useConsoleTheme,
  type ActivityRunRowV1,
} from '@mioagent/ui';
import { useAccount } from 'wagmi';

import { useConsoleNav } from '../console/useConsoleNav';

/** `0x1234…abcd`, or nothing when no wallet is connected. */
function shortAddress(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

export function RouteHistoryPage() {
  const [, navigate] = useLocation();
  const consoleNav = useConsoleNav('activity');
  const { theme, setTheme } = useConsoleTheme();
  const { address } = useAccount();

  const [runs, setRuns] = useState<ActivityRunRowV1[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<ActivityRunRowV1 | null>(null);

  const status = useStatus();
  const history = useRouteHistory({ limit: 20, cursor });
  const proof = useRouteProof(selected?.proofId ?? null);
  const ledger = useX402Ledger();
  const extensionActions = useBaseMcpActionReceipts();

  // T67C.2: publishing is an explicit owner action. The link lives in local
  // state rather than being fetched, because a proof with no share has no link
  // to fetch — and the absence of one is exactly what "private" means.
  const share = useShareProof();
  const revoke = useRevokeProofShare();
  const [publicUrl, setPublicUrl] = useState<string | null>(null);

  // Selecting a different proof drops the link: it belonged to the other one.
  useEffect(() => {
    setPublicUrl(null);
  }, [selected?.proofId]);

  useEffect(() => {
    if (!history.data) return;
    setRuns((current) => {
      const known = new Set(current.map((item) => item.routeRunId));
      return [...current, ...history.data.items.filter((item) => !known.has(item.routeRunId))];
    });
  }, [history.data]);

  const spend = useMemo(
    () => ({
      loading: ledger.isPending,
      entries: ledger.data?.entries ?? [],
      summary: ledger.data?.summary ?? null,
      unavailableReason: ledger.error
        // Never the error's own message: a transport failure can carry the
        // endpoint, and the endpoint can carry a key.
        ? 'The payment ledger could not be read. This says nothing about what was paid.'
        : null,
    }),
    [ledger.data, ledger.error, ledger.isPending],
  );

  const publishable =
    selected?.proofId &&
    proof.data &&
    status.data?.productMigration?.publicProofV1 &&
    // A pending proof describes a question Miorail has not answered, and
    // publishing it would put a claim on the internet Miorail is not making.
    proof.data.proof.finalStatus !== 'pending';

  return (
    <ConsoleShell
      header={{
        crumb: ['Activity'],
        nav: consoleNav.header,
        onNavigate: consoleNav.navigate,
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: Boolean(address) && status.data?.rpc?.status === 'connected',
        walletLabel: shortAddress(address),
      }}
      left={{
        nav: consoleNav.rail,
        sessions: [],
        sessionCount: '0',
        proofs: [],
        proofCount: String(runs.filter((run) => run.proofId).length),
        onOpenSettings: () => consoleNav.navigate('settings'),
      }}
      footer={{
        adaptersLabel: '—',
        sourcesLabel: String(runs.length),
        spendLabel: ledger.data?.summary?.totalSpentUsdc
          ? `$${ledger.data.summary.totalSpentUsdc}`
          : '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      right={null}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => navigate(consoleSectionPathV1('routes'))}
      onSelectSession={() => navigate(consoleSectionPathV1('routes'))}
      onSelectProof={() => undefined}
    >
      {/* The ledger first: it is the part of this page that currently has
          content, and burying it under twenty unsigned runs was the old
          ordering's mistake. */}
      <ActivitySpendCard {...spend} />

      <BaseMcpActionReceiptsCard
        loading={extensionActions.isPending}
        receipts={extensionActions.data?.receipts ?? []}
        unavailableReason={
          extensionActions.error
            ? 'Base MCP action receipts could not be read. This says nothing about whether an action completed.'
            : null
        }
      />

      <ActivityRunsCard
        loading={history.isPending}
        runs={runs}
        selectedRunId={selected?.routeRunId ?? null}
        onSelect={setSelected}
        hasMore={Boolean(history.data?.nextCursor)}
        onLoadMore={() => setCursor(history.data?.nextCursor ?? undefined)}
        unavailableReason={
          history.isError
            ? 'Route history could not be read on this server. This says nothing about what you have run.'
            : null
        }
      />

      {selected && (
        <ActivityProofCard
          runLabel={selected.intentSummary || selected.routeRunId}
          loading={Boolean(selected.proofId) && proof.isPending}
          proof={selected.proofId && proof.data ? proof.data.proof : null}
          lifecycle={proof.data?.lifecycle ?? null}
          unavailableReason={
            selected.proofId && proof.isError
              ? 'That execution proof could not be read. It exists; this server did not return it.'
              : null
          }
        />
      )}

      {publishable && (
        <ShareProofPanel
          publicUrl={publicUrl}
          pending={share.isPending || revoke.isPending}
          onShare={() => {
            const proofId = selected?.proofId;
            if (!proofId) return;
            share.mutate({ proofId }, { onSuccess: (result) => setPublicUrl(result.url) });
          }}
          onRevoke={() => {
            const proofId = selected?.proofId;
            if (!proofId) return;
            revoke.mutate({ proofId }, { onSuccess: () => setPublicUrl(null) });
          }}
          onCopy={() => {
            if (publicUrl) void navigator.clipboard?.writeText(new URL(publicUrl, location.origin).toString());
          }}
          onDownload={() => {
            // The public id is in the URL the server returned; the download
            // route serves the canonical bundle under it.
            if (publicUrl) location.href = `/api/public/proofs/${publicUrl.split('/').pop()}/bundle`;
          }}
        />
      )}
    </ConsoleShell>
  );
}
