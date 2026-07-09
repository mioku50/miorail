import { useStatus, useX402Fuel, useX402Ledger, useX402Pricing } from '@mioagent/api-client-react';
import { StateBadge } from '@mioagent/ui';

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
    return 'Facilitator auth is required before x402 settlement can run.';
  }
  if (reason === 'cdp_api_key_pair_incomplete') {
    return 'CDP API key pair is incomplete. Buyer fuel remains blocked until facilitator auth is configured.';
  }
  if (reason === 'network_not_supported' || reason === 'unsupported_network_for_settlement') {
    return 'The facilitator is reachable, but this x402 network is not supported for settlement.';
  }
  if (reason === 'facilitator_rate_limited') return 'x402 facilitator is rate-limited. Buyer payments fail closed until it recovers.';
  if (reason === 'facilitator_unreachable' || reason === 'facilitator_degraded') return 'x402 facilitator is unavailable or degraded.';
  if (reason === 'x402_not_configured') return 'x402 env is incomplete. Configure facilitator, payTo, and CAIP-2 network.';
  return 'x402 settlement is not ready.';
}

function networkLabel(network?: string): string {
  if (network === 'eip155:8453') return 'Base Mainnet';
  if (network === 'eip155:84532') return 'Base Sepolia';
  return 'Not configured';
}

export function FuelMeter() {
  const { data: statusData } = useStatus();
  const { data: fuel } = useX402Fuel();
  const { data: ledger } = useX402Ledger();
  const { data: pricing } = useX402Pricing();

  const x402 = statusData?.x402;
  const settleReady = x402?.settleReady === true;
  const badgeState = settleReady ? 'live' : x402?.status === 'missing' ? 'missing' : 'mock';
  const badgeLabel =
    settleReady ? 'buyer fuel ready' :
    x402?.status === 'facilitator_auth_required' ? 'auth required' :
    x402?.status === 'facilitator_auth_invalid' ? 'auth invalid' :
    x402?.status === 'facilitator_rate_limited' ? 'rate limited' :
    x402?.status === 'facilitator_unreachable' ? 'unreachable' :
    x402?.status === 'unsupported_network_for_settlement' ? 'network blocked' :
    x402?.status === 'degraded' ? 'degraded' :
    x402?.status === 'missing' ? 'not configured' :
    'simulated';

  const permission = fuel?.activePermission;
  const fuelStatus =
    fuel?.status === 'ready' ? 'ready' :
    fuel?.status === 'missing_permission' ? 'permission required' :
    fuel?.status === 'permission_expired' ? 'expired' :
    fuel?.status === 'limit_exhausted' ? 'limit exhausted' :
    fuel?.status === 'permission_inactive' ? 'inactive' :
    'unavailable';

  const buyerReceipts = ledger?.entries?.filter((entry) => entry.direction === 'outgoing_buyer_payment') || [];
  const sellerSmokeReceipts = ledger?.entries?.filter((entry) => entry.direction !== 'outgoing_buyer_payment') || [];

  return (
    <main className="flex-1 bg-bg p-5 flex flex-col gap-4 overflow-y-auto select-none pb-16 md:pb-5">
      <div className="flex items-center justify-between border-b border-line pb-4">
        <div>
          <h1 className="text-[20px] font-display font-bold text-ink tracking-[-0.02em]">x402 Buyer Fuel</h1>
          <p className="text-xs text-ink-3 mt-0.5 font-sans">
            Agent-paid outgoing resources backed by Base Account spend permissions.
          </p>
        </div>
        <StateBadge state={badgeState} label={badgeLabel} title="Source: /api/status x402.settleReady" />
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
            buyer mode
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mt-4">
          <Metric label="Remaining fuel" amount={permission ? `${permission.remainingUsdc} USDC` : '-'} sub={permission ? 'permission balance' : 'no permission'} />
          <Metric label="Spent" amount={permission ? `${permission.spentUsdc} USDC` : '0 USDC'} sub={permission ? `limit ${permission.limitUsdc}` : 'no active spend'} />
          <Metric label="Permission" amount={permission ? shortHash(permission.id) : 'missing'} sub={permission ? networkLabel(`eip155:${permission.chainId}`) : 'connect in autonomy'} />
          <Metric label="Reservations" amount={String(fuel?.pendingReservations?.length || 0)} sub="in flight" />
        </div>
        {!settleReady && (
          <div className="mt-3 text-[11px] text-warn bg-warn-soft border border-warn/20 rounded-[var(--radius-md)] px-3 py-2 font-sans">
            {x402BlockedCopy(x402)}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
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
          <div className="text-[10px] font-sans font-semibold uppercase tracking-[0.08em] text-ink-3 mb-1">Builder Code</div>
          <div className="text-sm font-sans font-bold text-ink">{x402?.builderCodeConfigured ? 'Configured' : 'Missing'}</div>
          <div className="text-[11px] text-ink-3 mt-2 border-t border-line/50 pt-2">{x402?.builderCodeAttribution || 'unavailable'}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">Spend by category</div>
            <span className="text-[10px] font-mono bg-panel-2 px-2 py-0.5 rounded-full text-ink-3">{buyerReceipts.length} buyer receipts</span>
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
          <div className="space-y-2 max-h-[170px] overflow-y-auto">
            {pricing?.pricing?.map((p) => (
              <div key={p.actionType} className="flex items-center justify-between gap-3 bg-panel-2 p-2 rounded-[var(--radius-md)] border border-line text-xs">
                <div className="min-w-0">
                  <div className="text-ink font-sans font-semibold truncate">{p.label}</div>
                  <div className="text-[10px] text-ink-3 truncate">{p.description}</div>
                </div>
                <span className="shrink-0 text-accent-2 font-mono font-bold">{p.priceUsdc} USDC</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="bg-panel border border-line rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-sans font-semibold tracking-[0.08em] uppercase text-ink-3">Buyer receipts</div>
          <span className="text-[10px] font-mono text-ink-3">source: x402_receipts</span>
        </div>
        {buyerReceipts.length > 0 ? (
          <div className="space-y-1.5 max-h-[210px] overflow-y-auto">
            {buyerReceipts.map((entry) => {
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
            No buyer fuel receipts yet. Free read-only scans do not create fuel spend.
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
