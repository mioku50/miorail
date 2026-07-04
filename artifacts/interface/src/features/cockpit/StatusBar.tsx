import { useStatus } from '@mioagent/api-client-react';
import { CHAIN_ENV, isMainnetReadonly } from '../../lib/chain';

export function StatusBar() {
  const { data: sd } = useStatus();

  const rpcProv = sd?.rpc?.provider || 'default';
  const balProv = sd?.tokenBalances?.provider || 'none';
  const priceProv = sd?.prices?.provider || 'none';
  const riskProv = sd?.risk?.provider || 'none';
  const appProv = sd?.approvals?.provider || 'none';
  const x402Status = sd?.x402?.status || 'simulated';

  return (
    <footer className="hidden md:flex h-[28px] border-t border-line bg-panel px-4 items-center justify-between text-[11px] shrink-0 select-none overflow-hidden">
      <div className="flex items-center gap-3 truncate">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-ok shadow-[0_0_4px_rgba(61,220,151,0.7)]" />
          <span className="text-ink-3 font-sans">RPC:</span>
          <span className="font-mono text-ink-2">{rpcProv}</span>
        </span>
        <span className="text-line">·</span>
        <span><span className="text-ink-3 font-sans">Balances:</span> <span className="font-mono text-ink-2">{balProv}</span></span>
        <span className="text-line">·</span>
        <span><span className="text-ink-3 font-sans">Prices:</span> <span className="font-mono text-ink-2">{priceProv}</span></span>
        <span className="text-line">·</span>
        <span><span className="text-ink-3 font-sans">Security:</span> <span className="font-mono text-ink-2">{riskProv}</span></span>
        <span className="text-line">·</span>
        <span><span className="text-ink-3 font-sans">Approvals:</span> <span className="font-mono text-ink-2">{appProv}</span></span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span><span className="text-ink-3 font-sans">x402:</span> <span className="font-mono text-ink-2">{x402Status}</span></span>
        <span className="text-line">·</span>
        <span className={`font-mono font-semibold ${isMainnetReadonly ? 'text-warn' : 'text-accent-2'}`}>
          {sd?.execution?.mode || CHAIN_ENV}
        </span>
      </div>
    </footer>
  );
}
