import { useAccount } from 'wagmi';
import { Link } from 'wouter';
import { useStatus } from '@mioagent/api-client-react';
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

  const shortAddr = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Disconnected';

  return (
    <aside className="w-[220px] min-w-[220px] shrink-0 border-r border-line bg-panel-2 p-3 flex flex-col gap-4 overflow-y-auto font-mono text-xs select-none">
      {/* Wallet State */}
      <div>
        <SectionHeader title="Wallet" />
        <div className="bg-panel border border-line rounded-lg p-2.5 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-ink-2 text-[11px]">Status</span>
            <div className="flex items-center gap-1.5">
              <Dot status={isConnected ? 'connected' : 'missing'} />
              <span className="text-[11px] font-medium text-ink">{isConnected ? 'connected' : 'offline'}</span>
            </div>
          </div>
          <div className="text-[11px] text-ink-2 truncate bg-panel-2 px-2 py-1 rounded border border-line mt-0.5">
            {shortAddr}
          </div>
        </div>
      </div>

      {/* Provider State */}
      <div>
        <SectionHeader title="Providers" />
        <div className="bg-panel border border-line rounded-lg p-2.5 flex flex-col gap-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-ink-2">balances</span>
            <div className="flex items-center gap-1.5">
              <Dot status={sd?.tokenBalances?.status} />
              <span className="text-ink font-medium">{sd?.tokenBalances?.provider || 'none'}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-2">prices</span>
            <div className="flex items-center gap-1.5">
              <Dot status={sd?.prices?.status} />
              <span className="text-ink font-medium">{sd?.prices?.provider || 'none'}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-2">security</span>
            <div className="flex items-center gap-1.5">
              <Dot status={sd?.risk?.status} />
              <span className="text-ink font-medium">{sd?.risk?.provider || 'none'}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-2">approvals</span>
            <div className="flex items-center gap-1.5">
              <Dot status={sd?.approvals?.status} />
              <span className="text-ink font-medium">{sd?.approvals?.provider || 'none'}</span>
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
          <div className="text-[14px] font-bold text-ink">
            — <span className="text-[11px] font-normal text-ink-3">USDC</span>
          </div>
          <div className="text-[10px] text-ink-3 mt-1 font-sans leading-tight">
            No live balance source wired. Click for details.
          </div>
        </Link>
      </div>

      {/* Autonomy State */}
      <div>
        <SectionHeader title="Autonomy" />
        <div className="bg-panel border border-line rounded-lg p-2.5 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-ink-2 text-[11px]">Session Key</span>
            <span className="text-[10px] font-bold bg-panel-2 border border-line px-1.5 py-0.5 rounded text-ink-3">
              OFF
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-2 text-[11px]">Mode</span>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${isMainnetReadonly ? 'bg-warn-soft text-warn border-warn/30' : 'bg-accent-soft text-accent border-accent/30'}`}>
              {isMainnetReadonly ? 'read-only' : 'execution'}
            </span>
          </div>
          <div className="text-[10px] text-ink-3 mt-0.5 font-sans leading-tight">
            Kill switch active by default. Manual sign required.
          </div>
        </div>
      </div>
    </aside>
  );
}
