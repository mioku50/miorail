import { useUiStore } from '../../lib/state';
import { StateBadge } from '@mioagent/ui';
import { useStatus, useAutonomy, useKillAutonomy } from '@mioagent/api-client-react';
import { RiskQueue } from './RiskQueue';

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel-2 border border-line rounded-lg p-2.5">
      <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <div className="text-[14px] font-mono font-bold text-ink mt-0.5 truncate">{value}</div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-3 mb-3">
      <span className="text-accent">▸</span>
      <span>{title}</span>
    </div>
  );
}

export function CockpitRoute() {
  const showToast = useUiStore((s) => s.showToast);
  const { data: sd } = useStatus();
  const { data: autonomyState } = useAutonomy();
  const killAutonomy = useKillAutonomy();

  const balancesLive = sd?.tokenBalances?.status === 'connected';
  const pricesLive = sd?.prices?.status === 'connected';
  const securityLive = sd?.risk?.status === 'connected';
  const anyProviderLive = balancesLive || pricesLive || securityLive;

  return (
    <div className="flex-1 flex overflow-hidden w-full h-full">
      {/* Center: Cockpit Canvas */}
      <main className="flex-1 bg-bg p-5 flex flex-col gap-4 overflow-y-auto select-none">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <h1 className="text-[18px] font-bold text-ink tracking-[-0.02em]">Autonomy Cockpit</h1>
            <p className="text-[12px] text-ink-3 mt-0.5">
              Mission control for automated execution, x402 fuel budgets, and contract risk boundaries.
            </p>
          </div>
          <StateBadge
            state={autonomyState?.autonomy?.source === 'base-sepolia-contract' || autonomyState?.sessionKey?.source === 'base-sepolia-contract' ? 'live' : autonomyState?.sessionKey?.status === 'configured' ? 'live' : autonomyState?.sessionKey?.status === 'revoked' || autonomyState?.sessionKey?.status === 'inactive' || autonomyState?.sessionKey?.killSwitch ? 'failed' : 'missing'}
            label={autonomyState?.autonomy?.source === 'base-sepolia-contract' || autonomyState?.sessionKey?.source === 'base-sepolia-contract' ? 'testnet verified' : autonomyState?.sessionKey?.status === 'revoked' || autonomyState?.sessionKey?.status === 'inactive' || autonomyState?.sessionKey?.killSwitch ? 'revoked' : autonomyState?.autonomy?.source === 'memory' || autonomyState?.sessionKey?.source === 'memory' ? 'configured in app' : 'missing'}
            title={autonomyState?.autonomy?.source === 'base-sepolia-contract' ? 'Verified on Base Sepolia contract' : autonomyState?.sessionKey?.status === 'configured' ? 'Session key configured in app memory' : 'No session key is active'}
          />
        </div>

        {/* What MioAgent can do now / What is blocked / What unlocks */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="bg-panel border border-line rounded-xl p-3.5 flex flex-col justify-between gap-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3 mb-1">What MioAgent Can Do Now</div>
              <div className="text-[11px] text-ink-2 leading-relaxed">
                Scan wallet token balances via Moralis, query prices via CoinGecko, evaluate token security via GoPlus, and generate risk recommendations.
              </div>
            </div>
            <div className="text-[10px] font-mono text-ok bg-ok-soft px-2 py-0.5 rounded border border-ok/20 w-fit">
              Status: Active & Live
            </div>
          </div>

          <div className="bg-panel border border-line rounded-xl p-3.5 flex flex-col justify-between gap-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3 mb-1">Blocked in Read-Only Mode</div>
              <div className="text-[11px] text-ink-2 leading-relaxed">
                Onchain execution is disabled on Base Mainnet. No revoke transactions or batched swaps can be broadcast until explicitly unlocked.
              </div>
            </div>
            <div className="text-[10px] font-mono text-warn bg-warn-soft px-2 py-0.5 rounded border border-warn/20 w-fit">
              Safety: 100% Read-Only
            </div>
          </div>

          <div className="bg-panel border border-line rounded-xl p-3.5 flex flex-col justify-between gap-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3 mb-1">Unlocks After x402 / Session Key</div>
              <div className="text-[11px] text-ink-2 leading-relaxed">
                Autonomous background execution within strict USDC daily limits, paid HTTP 402 data queries, and automated portfolio rebalancing.
              </div>
            </div>
            <div className="text-[10px] font-mono text-accent bg-accent-soft px-2 py-0.5 rounded border border-accent/20 w-fit">
              Next: Phase 7.4
            </div>
          </div>
        </section>

        {/* Cockpit Overview Architecture Card */}
        <section className="bg-panel border border-line rounded-xl p-4">
          <SectionHeader title="System Autonomy Engine" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="bg-panel-2 p-3 rounded-lg border border-line">
              <div className="font-semibold text-ink mb-1">1. Read-Only Intelligence</div>
              <p className="text-ink-3 text-[11px] leading-relaxed">
                Continuous scanning of wallet token balances, price deviations, and GoPlus contract security heuristics without holding keys.
              </p>
            </div>
            <div className="bg-panel-2 p-3 rounded-lg border border-line">
              <div className="font-semibold text-ink mb-1">2. Action Security & Simulation</div>
              <p className="text-ink-3 text-[11px] leading-relaxed">
                Every candidate action is pre-screened for drainers, prompt injection, unlimited approvals, and simulated before surfacing.
              </p>
            </div>
            <div className="bg-panel-2 p-3 rounded-lg border border-line">
              <div className="font-semibold text-ink mb-1">3. Autonomous Execution Gateway</div>
              <p className="text-ink-3 text-[11px] leading-relaxed">
                When unlocked, session keys enforce daily spend caps and whitelist targets over x402 micropayments.
              </p>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Session key status */}
          <section className="bg-panel border border-line rounded-xl p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <SectionHeader title="Session Key" />
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                  autonomyState?.autonomy?.source === 'base-sepolia-contract' || autonomyState?.sessionKey?.source === 'base-sepolia-contract'
                    ? 'bg-ok-soft text-ok border-ok/20 font-bold'
                    : autonomyState?.sessionKey?.status === 'configured'
                      ? 'bg-ok-soft text-ok border-ok/20 font-bold'
                      : autonomyState?.sessionKey?.status === 'revoked' || autonomyState?.sessionKey?.status === 'inactive' || autonomyState?.sessionKey?.killSwitch
                        ? 'bg-risk-soft text-risk border-risk/20 font-bold'
                        : 'bg-panel-2 text-ink-3 border-line'
                }`}>
                  {autonomyState?.autonomy?.source === 'base-sepolia-contract' || autonomyState?.sessionKey?.source === 'base-sepolia-contract'
                    ? 'testnet verified'
                    : autonomyState?.sessionKey?.status === 'revoked' || autonomyState?.sessionKey?.status === 'inactive' || autonomyState?.sessionKey?.killSwitch
                      ? 'revoked'
                      : autonomyState?.autonomy?.source === 'memory' || autonomyState?.sessionKey?.source === 'memory'
                        ? 'configured in app'
                        : 'missing'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <Metric label="Daily limit" value={autonomyState?.sessionKey?.dailyLimitUsdc ? `${autonomyState.sessionKey.dailyLimitUsdc} USDC` : 'Not set'} />
                <Metric label="Spent today" value={autonomyState?.sessionKey?.spentTodayUsdc ? `${autonomyState.sessionKey.spentTodayUsdc} USDC` : '0 USDC'} />
                <Metric label="Max / action" value={autonomyState?.sessionKey?.maxPerActionUsdc ? `${autonomyState.sessionKey.maxPerActionUsdc} USDC` : 'Not set'} />
                <Metric label="TTL" value={autonomyState?.sessionKey?.ttlSeconds ? `${autonomyState.sessionKey.ttlSeconds}s (${Math.round(autonomyState.sessionKey.ttlSeconds / 3600)}h)` : 'Inactive'} />
              </div>
            </div>
            <div className="mt-3 text-[11px] text-ink-3 font-mono border-t border-line/50 pt-2 flex justify-between">
              <span>Whitelist: <span className="text-ink-2">{autonomyState?.sessionKey?.whitelist?.length ? `${autonomyState.sessionKey.whitelist.length} contract(s)` : 'Not configured'}</span></span>
              <span>Scope: <span className="text-ink-2">{autonomyState?.sessionKey?.scope !== 'none' && autonomyState?.sessionKey?.scope ? autonomyState.sessionKey.scope : 'No spend scope wired'}</span></span>
            </div>
          </section>

          {/* Kill switch & Autonomy boundaries */}
          <div className="flex flex-col gap-4">
            <section className="bg-panel border border-line rounded-xl p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <SectionHeader title="Kill Switch" />
                  <div className="text-[11px] text-ink-3 leading-relaxed">
                    Revokes the active session key instantly. The agent will revert to manual confirmation on every transaction.
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (autonomyState?.sessionKey?.status === 'configured') {
                      killAutonomy.mutate(undefined, { onSuccess: () => showToast('Session key revoked.') });
                    } else {
                      showToast('No active session key to revoke.');
                    }
                  }}
                  disabled={killAutonomy.isPending}
                  className="shrink-0 px-4 py-2 rounded-lg bg-risk-soft text-risk font-bold text-xs border border-risk/30 hover:bg-risk hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  {killAutonomy.isPending ? 'Killing…' : '⏻ Kill'}
                </button>
              </div>
            </section>

            <section className="bg-panel border border-line rounded-xl p-4 flex-1">
              <SectionHeader title="Autonomy Boundaries" />
              <div className="grid grid-cols-3 gap-2.5 text-xs">
                <Metric label="Daily spend" value={autonomyState?.autonomy?.dailySpendLimit ? `${autonomyState.autonomy.dailySpendLimit} USDC` : 'No limit set'} />
                <Metric label="Max action" value={autonomyState?.autonomy?.maxActionSpend ? `${autonomyState.autonomy.maxActionSpend} USDC` : 'No limit set'} />
                <Metric label="Protocols" value={`${autonomyState?.autonomy?.whitelistedProtocolsCount || 0} whitelisted`} />
              </div>
            </section>
          </div>
        </div>

        {/* Next Autonomous Action & Setup Checklist */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section className="bg-panel border border-line rounded-xl p-4 flex flex-col">
            <SectionHeader title="Next Autonomous Action" />
            <div className="flex-1 flex items-center justify-center p-6 border border-dashed border-line rounded-lg bg-bg/50">
              <div className="text-center">
                <div className="text-[13px] font-medium text-ink-2">No autonomous queue yet</div>
                <div className="text-[11px] text-ink-3 mt-1 max-w-[280px]">
                  Scanners and automated action builders will queue their pre-screened transactions here.
                </div>
              </div>
            </div>
          </section>

          <section className="bg-panel-2 border border-line rounded-xl p-4">
            <SectionHeader title="Setup Checklist" />
            <div className="space-y-2 text-xs">
              <div className="flex items-start gap-2 bg-panel p-2.5 rounded border border-line">
                <span className={anyProviderLive ? "text-ok font-bold" : "text-warn font-bold"}>{anyProviderLive ? "☑" : "☐"}</span>
                <div>
                  <div className="font-semibold text-ink">1. Read-Only Providers Wired</div>
                  <div className="text-[11px] text-ink-3 mt-0.5">
                    {anyProviderLive ? `Active: ${[balancesLive && sd?.tokenBalances?.provider, pricesLive && sd?.prices?.provider, securityLive && sd?.risk?.provider].filter(Boolean).join(', ')}` : "No read-only providers connected (balances, prices, or security)."}
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2 bg-panel p-2.5 rounded border border-line opacity-80">
                <span className={autonomyState?.sessionKey?.status === 'configured' ? "text-ok font-bold" : "text-ink-3 font-bold"}>{autonomyState?.sessionKey?.status === 'configured' ? "☑" : "☐"}</span>
                <div>
                  <div className="font-semibold text-ink">2. Configure Session Key & Whitelist</div>
                  <div className="text-[11px] text-ink-3 mt-0.5">{autonomyState?.sessionKey?.status === 'configured' ? `Configured in app memory: ${autonomyState.sessionKey.dailyLimitUsdc} USDC daily limit.` : 'Assign daily USDC spend limits and approved contract targets.'}</div>
                </div>
              </div>
              <div className="flex items-start gap-2 bg-panel p-2.5 rounded border border-line opacity-80">
                <span className="text-ink-3 font-bold">☐</span>
                <div>
                  <div className="font-semibold text-ink">3. Enable Background Scanners</div>
                  <div className="text-[11px] text-ink-3 mt-0.5">Wire autonomous scanners to evaluate yield and rebalance signals.</div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Right: Risk Queue */}
      <RiskQueue />
    </div>
  );
}
