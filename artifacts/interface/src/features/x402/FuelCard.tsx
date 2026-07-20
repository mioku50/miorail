import { Link } from 'wouter';
import { useStatus } from '@mioagent/api-client-react';

// Honest state: the only real datum is useStatus().x402.status. Spend, balance,
// and the inference/tools breakdown have no backend yet. The rail card points
// to /fuel, which F4 (T12.4) expands. No fixture numbers.
export function FuelCard() {
  const { data: statusData } = useStatus();
  const status = statusData?.x402?.status;
  const isLive = status === 'connected' || status === 'configured';
  const isMissing = status === 'missing';
  const isUnavailable = status === 'facilitator_auth_required' || status === 'facilitator_auth_invalid' || status === 'facilitator_rate_limited' || status === 'facilitator_unreachable' || status === 'degraded';
  const label =
    isLive ? 'Connected' :
    status === 'facilitator_auth_required' ? 'Auth required' :
    status === 'facilitator_auth_invalid' ? 'Auth invalid' :
    status === 'facilitator_rate_limited' ? 'Rate limited' :
    status === 'facilitator_unreachable' ? 'Unavailable' :
    status === 'degraded' ? 'Degraded' :
    isMissing ? 'Not configured' :
    'Simulated';

  return (
    <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3">Intelligence Budget</div>
        <span className={`text-[10px] font-bold px-[7px] py-[2px] rounded-[6px] tracking-[.05em] border ${isLive ? 'text-ok bg-ok-soft border-ok/30' : isUnavailable ? 'text-warn bg-warn-soft border-warn/30' : 'text-ink-3 bg-panel-2 border-line'}`}>
          {label}
        </span>
      </div>
      <div className="text-[12px] text-ink-2 mb-3 leading-relaxed">
        No live spend data. Per-action pricing, the USDC balance, and the inference/tools breakdown appear once the backend exposes them.
      </div>
      <Link
        href="/fuel"
        className="block text-center text-[12px] font-semibold text-accent border border-accent/30 bg-accent-soft rounded-[10px] py-[9px] hover:bg-accent hover:text-white transition-colors"
      >
        Open Intelligence Budget →
      </Link>
    </div>
  );
}
