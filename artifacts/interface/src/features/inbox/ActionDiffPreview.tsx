import { isMainnetReadonly } from '../../lib/chain';
import { PortfolioAnalysisView } from './PortfolioAnalysisView';

// Extracted from the dense inline IIFE in the original ActionInbox card. F5
// (T12.5) expands this into the full risk-control center (planned calls,
// screening verdicts, simulation, execution status).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ActionDiffPreview({ action }: { action: any }) {
  const meta = action.metadata || {};
  const reason = meta.reason;
  const expectedEffect = meta.expectedEffect;
  const risk = meta.risk || 'medium';
  const chainMode = meta.chainMode || (isMainnetReadonly ? 'mainnet-readonly' : 'sepolia');
  const safetyState = meta.safetyState || (action.status === 'failed' ? 'blocked' : 'safe');
  const riskColor = risk === 'low' ? 'bg-ok-soft text-ok border-ok/20' : risk === 'high' ? 'bg-risk-soft text-risk border-risk/20' : 'bg-warn-soft text-warn border-warn/20';
  const safetyColor = safetyState === 'blocked' || safetyState === 'failed' ? 'bg-risk-soft text-risk border-risk/20' : 'bg-ok-soft text-ok border-ok/20';

  return (
    <div className="flex flex-col gap-2 bg-bg/50 border border-line rounded-lg p-3 text-xs mt-1">
      {reason && (
        <div>
          <span className="font-semibold text-ink-2">Reason: </span>
          <span className="text-ink-3">{reason}</span>
        </div>
      )}
      {expectedEffect && (
        <div>
          <span className="font-semibold text-ink-2">Expected Effect: </span>
          <span className="text-ink-3">{expectedEffect}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 mt-1">
        <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${riskColor}`}>Risk: {risk}</span>
        <span className="px-2 py-0.5 rounded text-[11px] font-medium border bg-panel text-ink-2 border-line">Chain: {chainMode}</span>
        <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${safetyColor}`}>Safety: {safetyState}</span>
      </div>
      <div className={`mt-1 font-medium px-2 py-1 rounded border text-[11px] w-fit ${(isMainnetReadonly || chainMode === 'mainnet-readonly' || chainMode === 'mainnet') ? 'bg-warn-soft text-warn border-warn/20' : 'bg-ok-soft text-ok border-ok/20'}`}>
        {(isMainnetReadonly || chainMode === 'mainnet-readonly' || chainMode === 'mainnet') ? 'Read-only recommendation (execution disabled on mainnet)' : 'Executable testnet recommendation'}
      </div>
      {meta.analysis && <PortfolioAnalysisView analysis={meta.analysis} chainMode={chainMode} />}
    </div>
  );
}
