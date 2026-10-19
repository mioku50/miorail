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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useHistoryState } from 'wouter/use-browser-location';
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
  activityProofCountV1,
  activityProofItemsV1,
  ActivitySpendCard,
  BaseMcpActionReceiptsCard,
  ConsoleShell,
  ShareProofPanel,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainUnavailableReasonV1,
  chainLabelV1,
  consoleSectionPathV1,
  mergeActivityRunsV1,
  useConsoleTheme,
  type ActivityRunRowV1,
} from '@mioagent/ui';
import { useAccount } from 'wagmi';

import { useConsoleNav, type ActivityNavStateV1 } from '../console/useConsoleNav';
import { downloadRouteProofV1, routeProofExportV1 } from '../proof/exportProof';

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
  // By id, so the open run is always the latest reading of it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = runs.find((run) => run.routeRunId === selectedId) ?? null;
  const navState = useHistoryState<ActivityNavStateV1 | null>();

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
    setRuns((current) => mergeActivityRunsV1(current, history.data.items));
  }, [history.data]);

  // A run opened from a rail, here or on another page, is scrolled to once it
  // is among the runs read; one the page has not read yet waits for them.
  const scrollToRef = useRef<string | null>(null);
  const openRun = (routeRunId: string) => {
    setSelectedId(routeRunId);
    scrollToRef.current = routeRunId;
  };
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    const asked = navState?.activityRun;
    if (!asked || askedRef.current === asked || !runs.some((run) => run.routeRunId === asked)) return;
    askedRef.current = asked;
    setSelectedId(asked);
    scrollToRef.current = asked;
  }, [navState?.activityRun, runs]);
  useEffect(() => {
    const id = scrollToRef.current;
    if (!id || !selected || selected.routeRunId !== id) return;
    scrollToRef.current = null;
    document.querySelector(`[data-run-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [selected]);

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
        chainUnavailableReason: chainUnavailableReasonV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: Boolean(address) && status.data?.rpc?.status === 'connected',
        walletLabel: shortAddress(address),
      }}
      left={{
        nav: consoleNav.rail,
        sessions: [],
        sessionCount: '0',
        proofs: activityProofItemsV1(runs),
        proofCount: String(activityProofCountV1(runs)),
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
      onSelectProof={openRun}
    >
      {/* Wallet actions first. The ledger used to open this page, on the rule
          that it was the only part with content — true when it was written and
          not true now: Base App action receipts exist, and the first thing a
          reader met was six of our own $0.001 test transactions, five of them
          failed, above the result of a real one.
          The ledger keeps every number it had; it moved below the actions and
          its receipt lists fold. */}
      <BaseMcpActionReceiptsCard
        loading={extensionActions.isPending}
        receipts={extensionActions.data?.receipts ?? []}
        unavailableReason={
          extensionActions.error
            ? 'Wallet MCP action receipts could not be read. This says nothing about whether an action completed.'
            : null
        }
      />

      <ActivityRunsCard
        loading={history.isPending}
        runs={runs}
        selectedRunId={selected?.routeRunId ?? null}
        onSelect={(run) => setSelectedId((current) => (current === run.routeRunId ? null : run.routeRunId))}
        selectedDetail={
          selected ? (
            <>
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
                onExport={
                  selected.proofId && proof.data
                    ? () =>
                        downloadRouteProofV1(
                          routeProofExportV1({
                            proof: proof.data.proof,
                            lifecycle: proof.data.lifecycle,
                            events: proof.data.events,
                          }),
                        )
                    : null
                }
              />
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
            </>
          ) : null
        }
        hasMore={Boolean(history.data?.nextCursor)}
        onLoadMore={() => setCursor(history.data?.nextCursor ?? undefined)}
        unavailableReason={
          history.isError
            ? 'Route history could not be read on this server. This says nothing about what you have run.'
            : null
        }
      />

      {/* Below the wallet's own actions, where a ledger of what we spent on
          intelligence belongs. Its total and its summary sentence are still
          unexpanded; only the repeated rows fold. */}
      <ActivitySpendCard {...spend} />
    </ConsoleShell>
  );
}
