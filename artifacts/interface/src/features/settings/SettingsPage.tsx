import { useLocation } from 'wouter';
import { useAccount } from 'wagmi';
import {
  BudgetPaymentsPanel,
  ConnectedAppsSettingsV1,
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
  settingsStatusRowsV1,
  useConsoleTheme,
} from '@mioagent/ui';
import {
  useIntelligenceBudget,
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
  // Providers, network and the technical facts, read the same way the Base
  // App's Settings reads them.
  const statusRows = settingsStatusRowsV1(status.data ?? null);

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
      // Nothing here is a goal being analysed: an empty "No active analysis"
      // rail beside the settings was Routes AI's, not this page's.
      right={null}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => navigate(consoleSectionPathV1('routes'))}
      onSelectSession={() => navigate(consoleSectionPathV1('routes'))}
      onSelectProof={() => navigate(consoleSectionPathV1('activity'))}
    >
      <SettingsScreen
        // Connect Miorail to your AI: the same card, wired the same way, as
        // the Base App's Settings.
        connectedApps={<ConnectedAppsSettingsV1 />}
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
        providers={statusRows.providers}
        providersUnavailableReason={null}
        network={statusRows.network}
        technical={statusRows.technical}
      />
    </ConsoleShell>
  );
}
