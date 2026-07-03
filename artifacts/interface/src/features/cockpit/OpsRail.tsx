import { useAccount } from 'wagmi';
import { Link } from 'wouter';
import { useStatus, useAutonomy } from '@mioagent/api-client-react';
import { isMainnetReadonly } from '../../lib/chain';

function Dot({ status }: { status?: string }) {
  let bg = 'bg-ink-3';
  if (status === 'connected' || status === 'configured' || status === 'ok' || status === 'live') bg = 'bg-ok';
  else if (status === 'stale' || status === 'partial' || status === 'simulated') bg = 'bg-warn';
  else if (status === 'failed' || status === 'error' || status === 'blocked') bg = 'bg-risk';
  return <span className={`w-2 h-2 rounded-full shrink-0 ${bg}`} />;
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3 border-b border-line pb-1 mb-2">
      <span className="text-accent">▸</span>
      <span>{title}</span>
    </div>
  );
}

export function OpsRail() {
  const { address, isConnected } = useAccount();
  const { data: sd } = useStatus();
  const { data: autonomyState } = useAutonomy();

  const shortAddr = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Disconnected';

  return (
    <aside className="w-[220px] min-w-[220px] shrink-0 border-r border-line bg-panel-2 p-3 flex flex-col gap-4 overflow-y-auto font-mono text-xs select-none">
      {/* Network / Wallet Status */}
      <div>
        <SectionHeader title="Base Account" />
        <div className="bg-panel border border-line rounded-lg p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-ink-2">Status</span>
            <div className="flex items-center gap-1.5">
              <Dot status={isConnected ? 'connected' : 'disconnected'} />
              <span className={`font-medium ${isConnected ? 'text-ok' : 'text-warn'}`}>
                {isConnected ? 'Connected' : 'Offline'}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-2">Address</span>
            <span className="text-ink font-mono">{shortAddr}</span>
          </div>
          <div className="flex items-center justify-between border-t border-line/50 pt-2">
            <span className="text-ink-2">Chain</span>
            <span className="text-ink font-medium">Base (8453)</span>
          </div>
        </div>
      </div>

      {/* Provider Pipeline Status */}
      <div>
        <SectionHeader title="Providers" />
        <div className="bg-panel border border-line rounded-lg p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-ink-2">Token Balances</span>
            <div className="flex items-center gap-1.5">
              <Dot status={sd?.tokenBalances?.status} />
              <span className="text-ink font-medium">{sd?.tokenBalances?.provider || 'none'}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-2">Price Engine</span>
            <div className="flex items-center gap-1.5">
              <Dot status={sd?.prices?.status} />
              <span className="text-ink font-medium">{sd?.prices?.provider || 'none'}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-2">Security Risk</span>
            <div className="flex items-center gap-1.5">
              <Dot status={sd?.risk?.status} />
              <span className="text-ink font-medium">{sd?.risk?.provider || 'none'}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-2">base-mcp</span>
            <div className="flex items-center gap-1.5">
              <Dot status={sd?.baseMcp?.status} />
              <span className="text-ink font-medium">{sd?.baseMcp?.status || 'none'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Fuel State */}
      <div>
        <SectionHeader title="x402 Fuel" />
        <Link href="/fuel" className="block bg-panel border border-line rounded-lg p-2.5 hover:border-accent/40 transition-colors">
          <div className="flex items-center justify-between mb-1">
            <span className="text-ink-2 text-[11px]">USDC Budget</span>
            <span className="text-[10px] bg-panel-2 px-1.5 py-0.5 rounded border border-line text-ink-3">
              {sd?.x402?.status === 'configured' ? 'live' : 'simulated'}
            </span>
          </div>
          <div className="text-[11px] font-medium text-ink-2 bg-panel-2 px-2 py-1.5 rounded border border-line my-1 text-center">
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
        <div className="bg-panel border border-line rounded-lg p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-ink-2 text-[11px]">Session Key</span>
            <span className={`text-[10px] font-bold bg-panel-2 border border-line px-1.5 py-0.5 rounded ${
              autonomyState?.sessionKey?.status === 'configured' ? 'text-ok border-ok/20' : 'text-ink-3'
            }`}>
              {autonomyState?.autonomy?.source === 'memory' || autonomyState?.sessionKey?.source === 'memory'
                ? 'configured in app'
                : autonomyState?.autonomy?.source === 'onchain'
                  ? 'onchain active'
                  : autonomyState?.sessionKey?.status === 'inactive'
                    ? 'inactive'
                    : 'unconfigured'}
            </span>
          </div>
          <div className="text-[11px] font-medium text-ink-2 bg-panel-2 px-2 py-1.5 rounded border border-line my-0.5 text-center">
            {autonomyState?.sessionKey?.status === 'configured' ? `Active limit: ${autonomyState.sessionKey.dailyLimitUsdc} USDC/day` : 'Session key not configured'}
          </div>
          <div className="flex items-center justify-between mt-0.5">
            <span className="text-ink-2 text-[11px]">Mode</span>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${isMainnetReadonly ? 'bg-warn-soft text-warn border-warn/30' : 'bg-accent-soft text-accent border-accent/30'}`}>
              {isMainnetReadonly ? 'read-only' : 'execution'}
            </span>
          </div>
          <div className="text-[10px] text-ink-3 mt-0.5 font-sans leading-tight">
            {autonomyState?.sessionKey?.status === 'configured' ? 'Autonomy running in app memory.' : 'Kill switch active by default. Manual sign required.'}
          </div>
        </div>
      </div>
    </aside>
  );
}
