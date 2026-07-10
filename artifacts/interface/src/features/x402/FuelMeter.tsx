import { useState } from 'react';
import { base } from '@base-org/account';
import { useAccount } from 'wagmi';
import { useCreateX402FuelPermission, useStatus, useX402Fuel, useX402FuelOwner, useX402Ledger, useX402Pricing } from '@mioagent/api-client-react';
import { StateBadge } from '@mioagent/ui';
import { capabilityLabel, x402CapabilityState, type CapabilityState } from '../../lib/capabilityStatus';
import { DIAGNOSTICS_ENABLED } from '../../lib/diagnostics';

function Metric({ label, amount, sub }: { label: string; amount: string; sub: string }) {
  return (
    <div className="bg-panel-2 border border-line rounded-[var(--radius-md)] p-2.5">
      <div className="text-[10px] font-sans uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="text-[14px] font-mono font-bold text-ink truncate">{amount}</span>
        <span className="text-[11px] text-ink-3 font-mono truncate">{sub}</span>
      </div>
    </div>
  );
}

function shortHash(value?: string | null): string {
  if (!value) return '';
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function baseScanTxUrl(network?: string, txHash?: string | null): string | null {
  if (!txHash) return null;
  if (network === 'eip155:84532') return `https://sepolia.basescan.org/tx/${txHash}`;
  if (network === 'eip155:8453') return `https://basescan.org/tx/${txHash}`;
  return null;
}

function x402BlockedCopy(x402?: any): string {
  const reason = x402?.settleBlockedReason || x402?.errorCode || x402?.status;
  if (reason === 'facilitator_auth_missing' || reason === 'facilitator_auth_required') {
    return 'Premium action payments are waiting for operator authentication.';
  }
  if (reason === 'cdp_api_key_pair_incomplete') {
    return 'Premium action payments are unavailable until operator authentication is restored.';
  }
  if (reason === 'network_not_supported' || reason === 'unsupported_network_for_settlement') {
    return 'Premium action payments are not available on this network.';
  }
  if (reason === 'facilitator_rate_limited') return 'Premium action payments are temporarily limited. Try again later.';
  if (reason === 'facilitator_unreachable' || reason === 'facilitator_degraded') return 'Premium action payments are temporarily unavailable.';
  if (reason === 'x402_not_configured') return 'Premium action payments are not enabled.';
  return 'Premium action payments are not ready.';
}

function networkLabel(network?: string): string {
  if (network === 'eip155:8453') return 'Base Mainnet';
  if (network === 'eip155:84532') return 'Base Sepolia';
  return 'Not configured';
}

function buyerPayerCopy(payer?: any): { label: string; detail: string; ready: boolean } {
  if (!payer) return { label: 'unknown', detail: 'status not reported', ready: false };
  if (payer.status === 'ready') {
    return {
      label: payer.accountAddressPresent ? 'ready' : 'configured',
      detail: payer.accountAddressPresent ? 'CDP EVM payer available' : 'CDP config present, account resolves on first payment',
      ready: true,
    };
  }
  if (payer.status === 'missing_config') {
    return {
      label: 'missing config',
      detail: payer.missingConfig?.length ? `Missing ${payer.missingConfig.join(', ')}` : 'CDP payer env is incomplete',
      ready: false,
    };
  }
  if (payer.status === 'insufficient_usdc') {
    return { label: 'needs USDC', detail: 'CDP payer needs USDC float for outgoing x402 payments', ready: false };
  }
  return { label: 'unavailable', detail: payer.errorCode || 'CDP payer unavailable', ready: false };
}

export function FuelMeter() {
  const { address, isConnected } = useAccount();
  const { data: statusData } = useStatus();
  const { data: fuel } = useX402Fuel();
  const { data: fuelOwner, error: fuelOwnerError, isLoading: fuelOwnerLoading } = useX402FuelOwner({ enabled: isConnected });
  const { data: ledger } = useX402Ledger();
  const { data: pricing } = useX402Pricing();
  const createFuelPermission = useCreateX402FuelPermission();
  const [fuelBudget, setFuelBudget] = useState('10');
  const [fuelTtlHours, setFuelTtlHours] = useState('720');
  const [fuelActionMessage, setFuelActionMessage] = useState<string | null>(null);

  const x402 = statusData?.x402;
  const buyerPayer = fuel?.buyerPayer || x402?.buyerPayer;
  const payerCopy = buyerPayerCopy(buyerPayer);
  const settleReady = x402?.settleReady === true;
  const buyerFuelReady = settleReady && payerCopy.ready && fuel?.status === 'ready';
  const paymentRailState = x402CapabilityState(x402);
  const fuelCapabilityState: CapabilityState = buyerFuelReady
    ? 'active'
    : settleReady || paymentRailState === 'limited'
      ? 'limited'
      : 'off';
  const badgeState = fuelCapabilityState === 'active' ? 'live' : fuelCapabilityState === 'limited' ? 'stale' : 'missing';
  const badgeLabel = capabilityLabel(fuelCapabilityState);

  const permission = fuel?.activePermission;
  const fuelStatus =
    fuel?.status === 'ready' ? 'ready' :
    fuel?.status === 'missing_permission' ? 'permission required' :
    fuel?.status === 'permission_expired' ? 'expired' :
    fuel?.status === 'limit_exhausted' ? 'limit exhausted' :
    fuel?.status === 'permission_inactive' ? 'inactive' :
    'unavailable';

  const settledBuyerReceipts = ledger?.entries?.filter((entry) => entry.direction === 'outgoing_buyer_payment' && entry.status === 'settled') || [];
  const failedBuyerAttempts = ledger?.entries?.filter((entry) => entry.direction === 'outgoing_buyer_payment' && entry.status === 'failed') || [];
  const unreimbursedBuyerAttempts = failedBuyerAttempts.filter((entry) => Boolean(entry.txHash && !entry.fuelChargeTxHash));
  const sellerSmokeReceipts = ledger?.entries?.filter((entry) => entry.direction !== 'outgoing_buyer_payment') || [];
  const ownerUnavailable = fuelOwner?.status && fuelOwner.status !== 'ready';
  const createDisabled = !isConnected || fuelOwnerLoading || fuelOwner?.status !== 'ready' || createFuelPermission.isPending;

  async function handleCreateFuelPermission() {
    if (!isConnected) {
      setFuelActionMessage('Connect wallet first.');
      return;
    }
    if (!fuelOwner?.subscriptionOwner) {
      setFuelActionMessage(fuelOwnerError?.message || 'Subscription owner is not available.');
      return;
    }

    const budget = Number(fuelBudget);
    const ttl = Number(fuelTtlHours);
    if (!Number.isFinite(budget) || budget <= 0) {
      setFuelActionMessage('Enter a positive USDC budget.');
      return;
    }
    if (!Number.isFinite(ttl) || ttl < 1) {
      setFuelActionMessage('Enter a valid TTL in hours.');
      return;
    }

    const normalizedBudget = budget.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    const ttlHours = Math.max(1, Math.min(24 * 366, Math.floor(ttl)));
    const periodInDays = Math.max(1, Math.min(366, Math.ceil(ttlHours / 24)));

    try {
      setFuelActionMessage('Opening Base Account confirmation...');
      const subscription = await base.subscription.subscribe({
        recurringCharge: normalizedBudget,
        subscriptionOwner: fuelOwner.subscriptionOwner,
        periodInDays,
        testnet: false,
      });

      setFuelActionMessage('Saving confirmed spend permission...');
      await createFuelPermission.mutateAsync({
        id: subscription.id,
        subscriptionOwner: subscription.subscriptionOwner,
        subscriptionPayer: subscription.subscriptionPayer,
        recurringCharge: subscription.recurringCharge,
        periodInDays: subscription.periodInDays,
        limitUsdc: normalizedBudget,
        ttlHours,
      });
      setFuelActionMessage('USDC fuel permission is active.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFuelActionMessage(message || 'Fuel permission was not created.');
    }
  }

  return (
    <main className="flex-1 bg-bg p-5 flex flex-col gap-4 overflow-y-auto select-none pb-16 md:pb-5">
      <div className="flex items-center justify-between border-b border-line pb-4">
        <div>
          <h1 className="text-[20px] font-display font-bold text-ink tracking-[-0.02em]">Agent Fuel</h1>
          <p className="text-xs text-ink-3 mt-0.5 font-sans">
            A wallet allowance for premium inference, data, and tools.
          </p>
        </div>
        <StateBadge state={badgeState} label={badgeLabel} title="Agent fuel readiness" />
      </div>

      <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-card)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">Fuel account</div>
            <div className="text-sm font-sans font-bold text-ink mt-1">Spend Permission {fuelStatus}</div>
            <div className="text-[12px] text-ink-3 mt-1 max-w-[720px]">
              Read-only scans stay free. Fuel is used only for outgoing paid inference, premium data, MCP tools, and future execution.
            </div>
          </div>
          <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${fuel?.status === 'ready' ? 'text-ok bg-ok-soft border-ok/30' : 'text-warn bg-warn-soft border-warn/30'}`}>
            User allowance
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mt-4">
          <Metric label="Remaining fuel" amount={permission ? `${permission.remainingUsdc} USDC` : '-'} sub={permission ? 'permission balance' : 'no permission'} />
          <Metric label="Spent" amount={permission ? `${permission.spentUsdc} USDC` : '0 USDC'} sub={permission ? `limit ${permission.limitUsdc}` : 'no active spend'} />
          <Metric label="Permission" amount={permission ? shortHash(permission.id) : 'missing'} sub={permission ? networkLabel(`eip155:${permission.chainId}`) : 'not enabled'} />
          <Metric label="Reservations" amount={String(fuel?.pendingReservations?.length || 0)} sub="in flight" />
        </div>
        {!settleReady && (
          <div className="mt-3 text-[11px] text-warn bg-warn-soft border border-warn/20 rounded-[var(--radius-md)] px-3 py-2 font-sans">
            {x402BlockedCopy(x402)}
          </div>
        )}
        {settleReady && !payerCopy.ready && (
          <div className="mt-3 text-[11px] text-warn bg-warn-soft border border-warn/20 rounded-[var(--radius-md)] px-3 py-2 font-sans">
            Premium action payments are limited. Existing free scans remain available.
          </div>
        )}
        {!permission && (
          <div className="mt-4 flex flex-col gap-1 rounded-[var(--radius-md)] border border-accent/25 bg-accent-soft px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-bold text-ink">Enable a USDC fuel allowance</div>
              <div className="mt-0.5 text-[11px] text-ink-2">Choose a budget and lifetime below. Base Account asks for confirmation.</div>
            </div>
            <span className="text-[10px] font-semibold text-accent-2">No funds are held by Miorail</span>
          </div>
        )}
        <div className="mt-4 border-t border-line/60 pt-4">
          <div className="flex flex-col lg:flex-row lg:items-end gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1">
              <label className="block">
                <span className="text-[10px] font-sans uppercase tracking-[0.08em] text-ink-3">USDC budget</span>
                <input
                  value={fuelBudget}
                  onChange={(event) => setFuelBudget(event.target.value)}
                  inputMode="decimal"
                  className="mt-1 w-full bg-panel-2 border border-line rounded-[var(--radius-md)] px-3 py-2 text-sm font-mono font-bold text-ink outline-none focus:border-accent"
                  placeholder="10"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-sans uppercase tracking-[0.08em] text-ink-3">TTL hours</span>
                <input
                  value={fuelTtlHours}
                  onChange={(event) => setFuelTtlHours(event.target.value)}
                  inputMode="numeric"
                  className="mt-1 w-full bg-panel-2 border border-line rounded-[var(--radius-md)] px-3 py-2 text-sm font-mono font-bold text-ink outline-none focus:border-accent"
                  placeholder="720"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={handleCreateFuelPermission}
              disabled={createDisabled}
              className="h-[42px] px-4 rounded-[var(--radius-md)] border border-accent/50 bg-accent text-white text-xs font-sans font-bold disabled:opacity-50 disabled:cursor-not-allowed"
              title={isConnected ? 'Create a Base Account allowance for Agent Fuel' : 'Connect wallet first'}
            >
              Enable USDC fuel
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            <span className="font-mono bg-panel-2 border border-line rounded-full px-2 py-0.5">
              {isConnected ? `wallet ${shortHash(address)}` : 'wallet disconnected'}
            </span>
            <span className="font-mono bg-panel-2 border border-line rounded-full px-2 py-0.5">
              owner {fuelOwner?.subscriptionOwner ? shortHash(fuelOwner.subscriptionOwner) : fuelOwnerLoading ? 'loading' : 'unavailable'}
            </span>
            <span>Base Account confirmation creates the permission; Miorail stores only the subscription id.</span>
          </div>
          {(fuelActionMessage || ownerUnavailable || fuelOwnerError) && (
            <div className={`mt-2 text-[11px] rounded-[var(--radius-md)] px-3 py-2 border font-sans ${fuelActionMessage === 'USDC fuel permission is active.' ? 'text-ok bg-ok-soft border-ok/25' : 'text-warn bg-warn-soft border-warn/20'}`}>
              {fuelActionMessage ||
                (ownerUnavailable ? `Subscription owner ${fuelOwner?.status}: ${fuelOwner?.errorCode || fuelOwner?.missingConfig?.join(', ') || 'unavailable'}` : fuelOwnerError?.message)}
            </div>
          )}
        </div>
      </section>

      {DIAGNOSTICS_ENABLED && <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
        <div className="bg-panel border border-line rounded-[var(--radius-lg)] p-3.5 shadow-[var(--shadow-card)]">
          <div className="text-[10px] font-sans font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1">Settlement rail</div>
          <div className="text-sm font-sans font-bold text-ink">{settleReady ? 'Ready' : 'Blocked'}</div>
          <div className="text-[11px] text-ink-3 mt-2 border-t border-line/50 pt-2">{x402?.middlewareMode || 'unknown'} middleware, mock={String(Boolean(x402?.mockFacilitatorEnabled))}</div>
        </div>
        <div className="bg-panel border border-line rounded-[var(--radius-lg)] p-3.5 shadow-[var(--shadow-card)]">
          <div className="text-[10px] font-sans font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1">Network and asset</div>
          <div className="text-sm font-sans font-bold text-ink">{networkLabel(x402?.network)}</div>
          <div className="text-[11px] text-ink-3 mt-2 border-t border-line/50 pt-2 font-mono">{shortHash(x402?.asset || '') || 'asset missing'}</div>
        </div>
        <div className="bg-panel border border-line rounded-[var(--radius-lg)] p-3.5 shadow-[var(--shadow-card)]">
          <div className="text-[10px] font-sans font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1">Buyer payer</div>
          <div className={`text-sm font-sans font-bold ${payerCopy.ready ? 'text-ok' : 'text-warn'}`}>{payerCopy.label}</div>
          <div className="text-[11px] text-ink-3 mt-2 border-t border-line/50 pt-2 truncate" title={payerCopy.detail}>{payerCopy.detail}</div>
        </div>
        <div className="bg-panel border border-line rounded-[var(--radius-lg)] p-3.5 shadow-[var(--shadow-card)]">
          <div className="text-[10px] font-sans font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1">Builder Code</div>
          <div className="text-sm font-sans font-bold text-ink">{x402?.builderCodeConfigured ? 'Configured' : 'Missing'}</div>
          <div className="text-[11px] text-ink-3 mt-2 border-t border-line/50 pt-2">{x402?.builderCodeAttribution || 'unavailable'}</div>
        </div>
      </div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">Spend by category</div>
            <span className="text-[10px] font-mono bg-panel-2 px-2 py-0.5 rounded-full text-ink-3">{settledBuyerReceipts.length} settled receipts</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <Metric label="Inference" amount={`${fuel?.spendByCategory?.inference || ledger?.summary?.inferenceSpentUsdc || '0.0000'} USDC`} sub="paid LLM" />
            <Metric label="Premium data" amount={`${fuel?.spendByCategory?.premiumData || '0.0000'} USDC`} sub="deep scans" />
            <Metric label="MCP tools" amount={`${fuel?.spendByCategory?.mcpTool || ledger?.summary?.toolsSpentUsdc || '0.0000'} USDC`} sub="paid tools" />
            <Metric label="Execution" amount={`${fuel?.spendByCategory?.execution || '0.0000'} USDC`} sub="future gated" />
          </div>
        </section>

        <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">Pricing schedule</div>
            <span className="text-[10px] font-mono bg-panel-2 px-2 py-0.5 rounded-full text-ink-3">read-only free</span>
          </div>
          <div className="max-h-[190px] overflow-auto rounded-[var(--radius-md)] border border-line">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-panel-2 text-[10px] uppercase tracking-[0.06em] text-ink-3">
                <tr><th className="px-2.5 py-2 font-semibold">Category</th><th className="px-2.5 py-2 text-right font-semibold">Price</th></tr>
              </thead>
              <tbody>
                {pricing?.pricing?.map((p) => (
                  <tr key={p.actionType} className="border-t border-line">
                    <td className="px-2.5 py-2">
                      <div className="font-sans font-semibold text-ink">{p.label}</div>
                      <div className="mt-0.5 text-[10px] text-ink-3">{p.description}</div>
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-2 text-right font-mono font-bold text-accent-2">{p.priceUsdc} USDC</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">Paid activity</div>
          <span className="text-[10px] font-sans text-ink-3">Receipts save automatically</span>
        </div>
        {settledBuyerReceipts.length > 0 ? (
          <div className="space-y-1.5 max-h-[210px] overflow-y-auto">
            {settledBuyerReceipts.map((entry) => {
              const txUrl = baseScanTxUrl(entry.network, entry.txHash);
              return (
                <div key={entry.id} className="grid grid-cols-1 md:grid-cols-[1fr_120px_140px] gap-2 items-center bg-panel-2 p-2 rounded-[var(--radius-md)] border border-line text-xs">
                  <div className="min-w-0">
                    <div className="text-ink font-sans font-semibold truncate">{entry.actionType}</div>
                    <div className="text-[10px] text-ink-3 font-mono truncate">{entry.category || 'mcp_tool'} / {new Date(entry.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="font-mono text-ink font-bold">{entry.cost || '0'} USDC</div>
                  {txUrl ? (
                    <a href={txUrl} target="_blank" rel="noreferrer" className="font-mono text-accent-2 hover:text-accent truncate">{shortHash(entry.txHash)}</a>
                  ) : (
                    <span className="text-warn font-sans">proof pending</span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-ink-3 italic bg-panel-2 p-3 rounded-[var(--radius-md)] border border-line font-sans">
            No settled buyer fuel spend yet. Free read-only scans do not create fuel spend.
          </div>
        )}
      </section>

      <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-card)]">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">Failed buyer attempts</div>
            <div className="text-[12px] text-ink-3 mt-1 max-w-[760px]">
              Failed attempts never increase settled spend. An unreimbursed attempt means the paid resource has an x402 tx proof but the matching fuel charge proof is missing.
            </div>
          </div>
          <div className="flex gap-2 text-[10px] font-mono">
            <span className="bg-risk-soft border border-risk/25 rounded-full px-2 py-1 text-risk">
              {ledger?.summary?.failedBuyerAttemptsCount ?? failedBuyerAttempts.length} failed
            </span>
            <span className="bg-warn-soft border border-warn/25 rounded-full px-2 py-1 text-warn">
              {ledger?.summary?.unreimbursedBuyerAttemptsCount ?? unreimbursedBuyerAttempts.length} unreimbursed
            </span>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs mb-3">
          <Metric label="Failed attempt value" amount={`${ledger?.summary?.failedBuyerAttemptsUsdc || '0.0000'} USDC`} sub="not settled spend" />
          <Metric label="Unreimbursed payer value" amount={`${ledger?.summary?.unreimbursedBuyerAttemptsUsdc || '0.0000'} USDC`} sub="requires review" />
        </div>
        {failedBuyerAttempts.length > 0 ? (
          <div className="space-y-1.5 max-h-[180px] overflow-y-auto">
            {failedBuyerAttempts.map((entry) => {
              const txUrl = baseScanTxUrl(entry.network, entry.txHash);
              const unreimbursed = Boolean(entry.txHash && !entry.fuelChargeTxHash);
              return (
                <div key={entry.id} className="grid grid-cols-1 md:grid-cols-[1fr_120px_140px] gap-2 items-center bg-panel-2 p-2 rounded-[var(--radius-md)] border border-line text-xs">
                  <div className="min-w-0">
                    <div className="text-ink font-sans font-semibold truncate">{entry.actionType}</div>
                    <div className="text-[10px] text-ink-3 font-mono truncate">{entry.category || 'mcp_tool'} / {new Date(entry.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="font-mono text-ink font-bold">{entry.cost || '0'} USDC</div>
                  {txUrl ? (
                    <a href={txUrl} target="_blank" rel="noreferrer" className={`font-mono truncate ${unreimbursed ? 'text-risk' : 'text-accent-2'}`}>
                      {unreimbursed ? 'unreimbursed ' : ''}{shortHash(entry.txHash)}
                    </a>
                  ) : (
                    <span className="text-warn font-sans">no payment proof</span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-ink-3 italic bg-panel-2 p-3 rounded-[var(--radius-md)] border border-line font-sans">
            No failed buyer attempts.
          </div>
        )}
      </section>

      <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-card)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">Dev seller smoke</div>
            <div className="text-[12px] text-ink-3 mt-1 max-w-[760px]">
              `/api/x402/smoke-paid` remains a settlement rail diagnostic. It is not the product fuel path and is not counted as buyer spend.
            </div>
          </div>
          <span className="text-[10px] font-mono bg-panel-2 border border-line rounded-full px-2 py-1 text-ink-3">
            {sellerSmokeReceipts.length} historical
          </span>
        </div>
      </section>
    </main>
  );
}
