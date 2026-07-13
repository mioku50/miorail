import { useAutonomy, useStatus } from '@mioagent/api-client-react';
import { CHAIN_ENV } from '../../lib/chain';
import { useNetworkLabel } from '../../lib/useNetworkLabel';
import { cockpitAutonomyPresentation } from '../../lib/autonomyUi';

export function StatusBar() {
  const { data: sd } = useStatus();
  const { data: autonomyState } = useAutonomy();
  const { label: executionLabel, readOnly } = useNetworkLabel();
  // T44: policy readiness is a SEPARATE status from the network capability
  // label — a mainnet user-confirmed runtime with no saved policy shows
  // "User-confirmed" next to a "Policy: Off" badge instead of a misleading
  // global "Read-only".
  const policyPresentation = cockpitAutonomyPresentation(autonomyState, {
    stale: Boolean(autonomyState?.isStaleTestMemory || autonomyState?.sessionKey?.isStaleTestMemory),
    expired: Boolean(
      autonomyState?.isExpiredMemory
        || autonomyState?.sessionKey?.isExpiredMemory
        || autonomyState?.status === 'expired'
        || autonomyState?.sessionKey?.status === 'expired',
    ),
  });
  const policyToneClass = policyPresentation.capability === 'active'
    ? 'text-ok'
    : policyPresentation.capability === 'limited'
      ? 'text-warn'
      : 'text-ink-3';

  const rpcProv = sd?.rpc?.provider || 'default';
  const balProv = sd?.tokenBalances?.provider || 'none';
  const priceProv = sd?.prices?.provider || 'none';
  const riskProv = sd?.risk?.provider || 'none';
  const appProv = sd?.approvals?.provider || 'none';
  const x402Status = sd?.x402?.settleReady ? 'settle-ready' : sd?.x402?.status || 'missing';

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
        <span><span className="text-ink-3 font-sans">Approval scanner:</span> <span className="font-mono text-ink-2">{appProv}</span></span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span><span className="text-ink-3 font-sans">x402:</span> <span className="font-mono text-ink-2">{x402Status}</span></span>
        <span className="text-line">·</span>
        <span title="Saved spending-policy readiness (separate from the network execution mode)">
          <span className="text-ink-3 font-sans">Policy:</span>{' '}
          <span className={`font-mono font-semibold ${policyToneClass}`}>{policyPresentation.label}</span>
        </span>
        <span className="text-line">·</span>
        <span className={`font-mono font-semibold ${readOnly ? 'text-warn' : 'text-accent-2'}`}>
          {executionLabel || CHAIN_ENV}
        </span>
      </div>
    </footer>
  );
}
