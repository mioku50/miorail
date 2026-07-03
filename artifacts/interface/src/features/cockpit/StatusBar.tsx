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
    <footer className="h-[28px] border-t border-line bg-panel px-3 flex items-center justify-between text-[11px] font-mono text-ink-3 shrink-0 select-none overflow-hidden">
      <div className="flex items-center gap-3 truncate">
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-ok" />
          <span className="text-ink-2">RPC:</span> {rpcProv}
        </span>
        <span>·</span>
        <span><span className="text-ink-2">Balances:</span> {balProv}</span>
        <span>·</span>
        <span><span className="text-ink-2">Prices:</span> {priceProv}</span>
        <span>·</span>
        <span><span className="text-ink-2">Security:</span> {riskProv}</span>
        <span>·</span>
        <span><span className="text-ink-2">Approvals:</span> {appProv}</span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span><span className="text-ink-2">x402:</span> {x402Status}</span>
        <span>·</span>
        <span className={isMainnetReadonly ? 'text-warn font-semibold' : 'text-accent font-semibold'}>
          {sd?.execution?.mode || CHAIN_ENV}
        </span>
      </div>
    </footer>
  );
}
