import { useAccount } from 'wagmi';
import { Link } from 'wouter';
import { useStatus, useAutonomy, useResetAutonomy } from '@mioagent/api-client-react';
import { isMainnetReadonly } from '../../lib/chain';
import { X } from 'lucide-react';

function Dot({ status }: { status?: string }) {
  let bg = 'bg-ink-3 shadow-none';
  if (status === 'connected' || status === 'configured' || status === 'ok' || status === 'live') {
    bg = 'bg-ok shadow-[0_0_6px_rgba(61,220,151,0.6)]';
  } else if (status === 'stale' || status === 'partial' || status === 'simulated') {
    bg = 'bg-warn shadow-[0_0_6px_rgba(255,180,84,0.6)]';
  } else if (status === 'failed' || status === 'error' || status === 'blocked') {
    bg = 'bg-risk shadow-[0_0_6px_rgba(255,92,92,0.6)]';
  }
  return <span className={`w-2 h-2 rounded-full shrink-0 ${bg}`} />;
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="text-[11px] font-sans font-semibold uppercase tracking-[0.08em] text-ink-3 mb-2">
      {title}
    </div>
  );
}

interface OpsRailProps {
  onClose?: () => void;
}

export function OpsRail({ onClose }: OpsRailProps) {
  const { address, isConnected } = useAccount();
  const { data: sd } = useStatus();
  const { data: autonomyState } = useAutonomy();
  const resetAutonomy = useResetAutonomy();

  const shortAddr = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Disconnected';

  return (
    <aside className="w-[240px] min-w-[240px] shrink-0 border-r border-line bg-panel-2 flex flex-col gap-4 overflow-y-auto select-none h-full">
      {/* Drawer close button (visible only when used as drawer on mobile) */}
      {onClose && (
        <div className="flex items-center justify-between px-4 pt-4 lg:hidden">
          <span className="text-xs font-sans font-semibold text-ink-2 uppercase tracking-[0.08em]">Navigation</span>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] text-ink-3 hover:text-ink hover:bg-panel transition-colors"
            aria-label="Close navigation"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <div className="p-4 flex flex-col gap-4">
        {/* Network / Wallet Status */}
        <div>
          <SectionHeader title="Base Account" />
          <div className="bg-panel border border-line rounded-[var(--radius-md)] p-3 flex flex-col gap-2 shadow-[var(--shadow-card)]">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-2 font-sans">Status</span>
              <div className="flex items-center gap-1.5">
                <Dot status={isConnected ? 'connected' : 'disconnected'} />
                <span className={`text-xs font-sans font-medium ${isConnected ? 'text-ok' : 'text-warn'}`}>
                  {isConnected ? 'Connected' : 'Offline'}
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-2 font-sans">Address</span>
              <span className="text-xs text-ink font-mono">{shortAddr}</span>
            </div>
            <div className="flex items-center justify-between border-t border-line/50 pt-2">
              <span className="text-xs text-ink-2 font-sans">Chain</span>
              <span className="text-xs text-ink font-sans font-medium">Base (8453)</span>
            </div>
          </div>
        </div>

        {/* Provider Pipeline Status */}
        <div>
          <SectionHeader title="Providers" />
          <div className="bg-panel border border-line rounded-[var(--radius-md)] p-3 flex flex-col gap-2 shadow-[var(--shadow-card)]">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-2 font-sans">Token Balances</span>
              <div className="flex items-center gap-1.5">
                <Dot status={sd?.tokenBalances?.status} />
                <span className="text-xs text-ink font-sans font-medium">{sd?.tokenBalances?.provider || 'none'}</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-2 font-sans">Price Engine</span>
              <div className="flex items-center gap-1.5">
                <Dot status={sd?.prices?.status} />
                <span className="text-xs text-ink font-sans font-medium">{sd?.prices?.provider || 'none'}</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-2 font-sans">Security Risk</span>
              <div className="flex items-center gap-1.5">
                <Dot status={sd?.risk?.status} />
                <span className="text-xs text-ink font-sans font-medium">{sd?.risk?.provider || 'none'}</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-2 font-sans">base-mcp</span>
              <div className="flex items-center gap-1.5">
                <Dot status={sd?.baseMcp?.status} />
                <span className="text-xs text-ink font-sans font-medium">{sd?.baseMcp?.status || 'none'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Fuel State */}
        <div>
          <SectionHeader title="x402 Fuel" />
          <Link href="/fuel" className="block bg-panel border border-line rounded-[var(--radius-md)] p-3 hover:border-accent/40 hover:-translate-y-px transition-all duration-150 shadow-[var(--shadow-card)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-ink-2 font-sans">USDC Budget</span>
              <span className={`text-[10px] font-sans font-medium px-2 py-0.5 rounded-full ${sd?.x402?.status === 'configured' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}>
                {sd?.x402?.status === 'configured' ? 'live' : 'simulated'}
              </span>
            </div>
            <div className="text-xs font-sans font-medium text-ink-2 bg-panel-2 px-2 py-1.5 rounded-[var(--radius-sm)] border border-line my-1 text-center">
              No spend source wired
            </div>
            <div className="text-[10px] text-ink-3 mt-1 font-sans leading-tight">
              Micropayments simulated. Click to configure.
            </div>
          </Link>
        </div>

        {/* Autonomy State */}
        <div>
          <SectionHeader title="Autonomy" />
          <div className="bg-panel border border-line rounded-[var(--radius-md)] p-3 flex flex-col gap-2 shadow-[var(--shadow-card)]">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-2 font-sans">Session Key</span>
              <span className={`text-[10px] font-sans font-medium px-2 py-0.5 rounded-full ${
                autonomyState?.isStaleTestMemory || autonomyState?.sessionKey?.isStaleTestMemory
                  ? 'bg-warn-soft text-warn'
                  : autonomyState?.autonomy?.source === 'base-sepolia-contract' || autonomyState?.sessionKey?.source === 'base-sepolia-contract'
                    ? 'bg-ok-soft text-ok'
                    : autonomyState?.sessionKey?.status === 'configured'
                      ? 'bg-ok-soft text-ok'
                      : autonomyState?.sessionKey?.status === 'revoked' || autonomyState?.sessionKey?.status === 'inactive' || autonomyState?.sessionKey?.killSwitch
                        ? 'bg-risk-soft text-risk'
                        : 'bg-panel-2 text-ink-3'
              }`}>
                {autonomyState?.isStaleTestMemory || autonomyState?.sessionKey?.isStaleTestMemory
                  ? 'stale test memory'
                  : autonomyState?.autonomy?.source === 'base-sepolia-contract' || autonomyState?.sessionKey?.source === 'base-sepolia-contract'
                    ? 'testnet verified'
                    : autonomyState?.sessionKey?.status === 'revoked' || autonomyState?.sessionKey?.status === 'inactive' || autonomyState?.sessionKey?.killSwitch
                      ? 'revoked'
                      : autonomyState?.autonomy?.source === 'memory' || autonomyState?.sessionKey?.source === 'memory'
                        ? 'configured in app'
                        : 'missing'}
              </span>
            </div>
            {(autonomyState?.isStaleTestMemory || autonomyState?.sessionKey?.isStaleTestMemory) && (
              <button
                onClick={() => resetAutonomy.mutate()}
                disabled={resetAutonomy.isPending}
                className="w-full mt-1 text-[11px] font-medium bg-panel-2 text-ink-2 hover:text-ink border border-line py-1 rounded transition-colors"
              >
                {resetAutonomy.isPending ? 'Resetting...' : 'Reset Memory State'}
              </button>
            )}
            <div className="text-xs font-sans font-medium text-ink-2 bg-panel-2 px-2 py-1.5 rounded-[var(--radius-sm)] border border-line my-0.5 text-center">
              {autonomyState?.sessionKey?.status === 'configured'
                ? `Active limit: ${autonomyState.sessionKey.dailyLimitUsdc} USDC/day`
                : 'Session key not configured'}
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-xs text-ink-2 font-sans">Mode</span>
              <span className={`text-[10px] font-sans font-medium px-2 py-0.5 rounded-full ${isMainnetReadonly ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent-2'}`}>
                {isMainnetReadonly ? 'read-only' : 'execution'}
              </span>
            </div>
            <div className="text-[10px] text-ink-3 mt-0.5 font-sans leading-tight">
              {autonomyState?.sessionKey?.status === 'configured'
                ? 'Autonomy running in app memory.'
                : 'Kill switch active by default. Manual sign required.'}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
