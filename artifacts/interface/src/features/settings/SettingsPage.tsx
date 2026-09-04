import { useState } from 'react';
import { useLocation } from 'wouter';
import { useAccount } from 'wagmi';
import {
  BudgetPaymentsPanel,
  ConnectedAppsCard,
  ConsoleRightRail,
  ConsoleShell,
  SettingsScreen,
  adaptersFromStatusV1,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainUnavailableReasonV1,
  chainLabelV1,
  consoleSectionPathV1,
  deriveAdapterRowsV1,
  paidIntelligenceStateV1,
  paidIntelligenceViewV1,
  providerUnavailableCopyV1,
  useConsoleTheme,
  type ConnectedAppClientKindV1,
} from '@mioagent/ui';
import {
  useIntelligenceBudget,
  useIssueMcpHandoff,
  useMcpHandoffGrants,
  useRevokeMcpHandoff,
  useIntelligenceCharges,
  usePauseIntelligenceBudget,
  useResumeIntelligenceBudget,
  useRevokeIntelligenceBudget,
  useStatus,
  useUpdateIntelligenceBudget,
} from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';
import { useSpendPermissionGrant } from '@mioagent/wallet-actions';


// ---------------------------------------------------------------------------
// T70 §2/§3 — Settings.
//
// Budget & payments used to be a drawer opened from the left rail, and its
// summary — two usage bars and a limits row — was the largest block on the
// mobile drawer. Route adapters were a scrolling provider list under it. Both
// were in the way of a product whose first screen should be an opportunity.
//
// They are here now, intact. Nothing about the spending contract changed: this
// page reads the same projection and calls the same writes.
//
// T71 finished the half that was missing. "Enable paid evidence" now opens the
// user's Base Account, and the permission it signs is verified ON CHAIN before
// a budget exists. Miorail still never signs, and this page still holds no key.
// ---------------------------------------------------------------------------

/** The provider slots the status endpoint reports, and the word each one is
 * about. Named here so a server that stops reporting one drops it from the
 * list rather than showing a permanent failure for something it no longer has. */
const PROVIDER_SLOTS_V1 = [
  { key: 'prices', name: 'Prices', what: 'price' },
  { key: 'tokenBalances', name: 'Balances', what: 'balance' },
  { key: 'risk', name: 'Risk', what: 'risk' },
  { key: 'approvals', name: 'Approvals', what: 'approval' },
] as const;

function shortAddress(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

export function SettingsPage() {
  const [, navigate] = useLocation();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('settings');

  const paidIntelligenceOn = status.data?.productMigration?.paidIntelligence === true;
  const budget = useIntelligenceBudget({ enabled: paidIntelligenceOn });
  const charges = useIntelligenceCharges({ enabled: paidIntelligenceOn });
  const updateBudget = useUpdateIntelligenceBudget();
  const revokeBudget = useRevokeIntelligenceBudget();
  const pauseBudget = usePauseIntelligenceBudget();
  const resumeBudget = useResumeIntelligenceBudget();
  const grant = useSpendPermissionGrant();
  const budgetRecord = budget.data?.budget ?? null;

  const budgetChangeError = (() => {
    const error = updateBudget.error ?? revokeBudget.error;
    if (!error) return null;
    // Never the raw message: a server error can carry an endpoint, and an
    // endpoint can carry a key.
    return 'That change could not be saved. Nothing was charged and your permission is unchanged.';
  })();

  const adapterRows = deriveAdapterRowsV1(adaptersFromStatusV1(status.data ?? null));

  const paidState = paidIntelligenceStateV1({
    featureEnabled: paidIntelligenceOn,
    settleReady: status.data?.paidIntelligence?.settleReady === true,
    budget: budgetRecord,
    charges: charges.data?.charges ?? [],
  });
  const paidView = paidIntelligenceViewV1(paidState);

  // Connect Miorail to your AI. The minted key is held in component state for
  // exactly as long as the user is looking at it — never in the query cache,
  // because a credential in a cache outlives the moment it was shown.
  const grants = useMcpHandoffGrants();
  // Availability comes from the endpoint that knows, not from a guess at
  // /api/status: the grants route answers `mcp_private_disabled` when the
  // surface is off, and that is a different thing from a read that failed.
  const mcpDisabled = /mcp_private_disabled/.test(grants.error?.message ?? '');
  const mcpEnabled = !mcpDisabled;
  const [issuedKey, setIssuedKey] = useState<
    { token: string; tokenId: string; expiresAt: string; notice: string } | null
  >(null);
  const issueHandoff = useIssueMcpHandoff({
    onSuccess: (issued) => setIssuedKey(issued),
  });
  const revokeHandoff = useRevokeMcpHandoff();

  return (
    <ConsoleShell
      header={{
        crumb: ['Settings'],
        nav: nav.header,
        onNavigate: nav.navigate,
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        chainUnavailableReason: chainUnavailableReasonV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: Boolean(address) && status.data?.rpc?.status === 'connected',
        walletLabel: shortAddress(address),
      }}
      left={{
        nav: nav.rail,
        sessions: [],
        sessionCount: '0',
        proofs: [],
        proofCount: '0',
      }}
      footer={{
        adaptersLabel: adapterRows.summary,
        sourcesLabel: '—',
        spendLabel: paidView.label,
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      right={
        <ConsoleRightRail
          price={null}
          priceUnavailableReason={null}
          depth={null}
          depthUnavailableReason={null}
          evidenceFeed={[]}
          spend={null}
          freshness={[]}
        />
      }
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => navigate(consoleSectionPathV1('routes'))}
      onSelectSession={() => navigate(consoleSectionPathV1('routes'))}
      onSelectProof={() => navigate(consoleSectionPathV1('activity'))}
    >
      <SettingsScreen
        connectedApps={
          <ConnectedAppsCard
            available={mcpEnabled}
            unavailableReason={
              mcpEnabled
                ? null
                : 'The private MCP surface is switched off on this server, so there is nothing to connect to.'
            }
            grants={grants.data?.grants ?? []}
            loading={grants.isPending}
            // Never an empty list on failure: "could not read" and "you have
            // none" are the two states an owner must not confuse on this page.
            error={
              grants.error && !mcpDisabled
                ? 'Your connected apps could not be read right now. This is not a statement that you have none.'
                : issueHandoff.error
                  ? 'That key could not be issued. Nothing was connected.'
                  : revokeHandoff.error
                    ? 'That key could not be revoked. It is still connected.'
                    : null
            }
            permissions={grants.data?.permissions ?? null}
            oauth={grants.data?.oauth ?? null}
            issued={issuedKey}
            issuing={issueHandoff.isPending}
            revokingTokenId={revokeHandoff.isPending ? (revokeHandoff.variables?.tokenId ?? null) : null}
            onIssueTemporary={(clientKind: ConnectedAppClientKindV1) =>
              issueHandoff.mutate({ clientKind })
            }
            onRevoke={(tokenId: string) => revokeHandoff.mutate({ tokenId })}
            onDismissIssued={() => setIssuedKey(null)}
          />
        }
        // The one line the Advanced fold shows while it is closed, from the
        // same view the panel inside renders. A fold that said only "Advanced"
        // over a permission in `Paid, not delivered` would hide the one state
        // on this page where the user has lost money.
        budgetStatus={{ label: paidView.label, needsAttention: paidView.moneyAtRisk }}
        budget={
          <BudgetPaymentsPanel
            featureEnabled={paidIntelligenceOn}
            // T67X-A1: the flag says an operator wants paid routes; this says
            // the facilitator can actually settle one. They came apart in
            // production.
            settleReady={status.data?.paidIntelligence?.settleReady === true}
            budget={budgetRecord}
            charges={charges.data?.charges ?? []}
            chargesLoading={charges.isPending && paidIntelligenceOn}
            chargesUnavailableReason={charges.error ? 'Your charge history could not be read right now.' : null}
            technicalDetails={[
              { label: 'Settlement', value: status.data?.x402?.settleReady ? 'x402 · ready' : 'x402 · not ready' },
              { label: 'Network', value: status.data?.x402?.network ?? 'not reported' },
            ]}
            changePending={
              updateBudget.isPending ||
              revokeBudget.isPending ||
              pauseBudget.isPending ||
              resumeBudget.isPending ||
              grant.pending
            }
            changeError={budgetChangeError}
            onUpdateLimit={(limits) =>
              updateBudget.mutate({
                periodLimitUsdc: limits.monthlyLimitUsdc,
                maxPerCallUsdc: limits.maxPerRequestUsdc,
              })
            }
            onRevoke={() => revokeBudget.mutate()}
            onPause={() => pauseBudget.mutate()}
            onResume={() => resumeBudget.mutate()}
            // T71 — the real thing. The server says what to ask for, the user's
            // Base Account signs it, and the server verifies it on chain before
            // any budget exists. Miorail never signs.
            onEnablePaidEvidence={grant.enable}
            onboardingStatus={grant.status}
            onboardingDetail={grant.detail}
            onboardingConsent={grant.consent}
            onRetryVerification={grant.retryVerification}
            canRetryVerification={grant.canRetryVerification}
          />
        }
        adapters={adapterRows}
        adaptersUnavailableReason={
          status.error ? 'The server did not report its adapters, so none are listed. Nothing here is a statement about them.' : null
        }
        // Read straight from the server's own report. A provider this server
        // never mentions is absent from the list rather than listed as broken.
        providers={PROVIDER_SLOTS_V1.flatMap(({ key, name, what }) => {
          const provider = status.data?.[key];
          if (!provider) return [];
          return [
            {
              name,
              label:
                provider.status === 'connected'
                  ? `${provider.provider} · connected`
                  : providerUnavailableCopyV1(provider, what),
              tone: provider.status === 'connected' ? ('ok' as const) : ('off' as const),
            },
          ];
        })}
        providersUnavailableReason={null}
        network={[
          { label: 'Network', value: chainLabelV1(status.data?.chainId) },
          {
            label: 'RPC',
            value: status.data?.rpc?.status ?? 'unknown',
            tone: status.data?.rpc?.status === 'connected' ? 'ok' : 'off',
          },
          { label: 'Block', value: chainBlockNumberV1(status.data ?? null) ?? '—' },
          { label: 'Gas', value: chainGasLabelV1(status.data ?? null) ?? '—' },
        ]}
        technical={[
          { label: 'Chain env', value: status.data?.chainEnv ?? 'not reported' },
          { label: 'Chain id', value: status.data?.chainId ? String(status.data.chainId) : 'not reported' },
          { label: 'Paid intelligence', value: paidIntelligenceOn ? 'on' : 'off' },
          {
            label: 'B20 Discover',
            value: status.data?.productMigration?.b20ControlV1 === true ? 'on' : 'off',
          },
        ]}
      />
    </ConsoleShell>
  );
}
