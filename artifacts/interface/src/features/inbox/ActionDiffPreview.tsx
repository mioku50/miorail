import { isMainnetReadonly } from '../../lib/chain';
import { StateBadge, type StateKind } from '@mioagent/ui';
import { PortfolioAnalysisView } from './PortfolioAnalysisView';

// The Inbox card as a risk-control center. Shows what would change before any
// Execute: planned calls, security-screening verdicts, simulation, execution
// status, plus the portfolio analysis. Where the backend provides no data
// (screening verdicts, simulation), it renders honest empty states — never
// fabricated results.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ActionDiffPreview({ action }: { action: any }) {
  const meta = action.metadata || {};
  const reason = meta.reason;
  const expectedEffect = meta.expectedEffect;
  const risk = meta.risk || 'medium';
  const chainMode = meta.chainMode || (isMainnetReadonly ? 'mainnet-readonly' : 'sepolia');
  const safetyState = meta.safetyState || (action.status === 'failed' ? 'blocked' : 'safe');
  const executionStatus = meta.executionStatus || (isMainnetReadonly ? 'read-only' : 'executable');
  const calls = action.executionPayload?.calls || [];
  const isReadOnlyMode = isMainnetReadonly || chainMode === 'mainnet-readonly' || chainMode === 'mainnet';

  const riskColor = risk === 'low' ? 'bg-ok-soft text-ok border-ok/20' : risk === 'high' ? 'bg-risk-soft text-risk border-risk/20' : 'bg-warn-soft text-warn border-warn/20';
  const safetyColor = safetyState === 'blocked' || safetyState === 'failed' ? 'bg-risk-soft text-risk border-risk/20' : 'bg-ok-soft text-ok border-ok/20';
  const execState: StateKind = executionStatus === 'blocked' ? 'failed' : executionStatus === 'executable' ? 'live' : 'disabled';

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
      <div className={`mt-1 font-medium px-2 py-1 rounded border text-[11px] w-fit ${isReadOnlyMode ? 'bg-warn-soft text-warn border-warn/20' : 'bg-ok-soft text-ok border-ok/20'}`}>
        {isReadOnlyMode ? 'Read-only recommendation (execution disabled on mainnet)' : 'Executable testnet recommendation'}
      </div>

      {/* Execution status */}
      <div className="flex items-center gap-2 mt-1">
        <span className="text-ink-3">Execution:</span>
        <StateBadge state={execState} label={executionStatus} />
      </div>

      {/* Planned calls (from executionPayload) */}
      <div className="mt-1">
        <div className="text-ink-3 mb-1">Planned calls ({calls.length})</div>
        {calls.length > 0 ? (
          <div className="flex flex-col gap-1">
            {calls.map((c: any, i: number) => (
              <div key={i} className="font-mono text-[11px] text-ink-2 bg-bg border border-line rounded px-2 py-1 break-all">
                <span className="text-ink-3">to:</span> {c.to}
                {c.value ? <span className="text-ink-3"> · value: {c.value}</span> : null}
                {c.data ? <span className="text-ink-3"> · data: {String(c.data).slice(0, 18)}{String(c.data).length > 18 ? '…' : ''}</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-ink-3 italic">{isReadOnlyMode ? 'Read-only — no calls planned.' : 'No calls planned.'}</div>
        )}
      </div>

      {/* Security screening — verdicts are not stored today (screenAction is dead code) */}
      <div className="flex items-center gap-2 mt-1">
        <span className="text-ink-3">Screening:</span>
        <StateBadge
          state="missing"
          label="not screened"
          title="screenAction() is not invoked by live action-creation paths, so drain / unlimited-approval / exfil / prompt-injection verdicts are not stored on the action."
        />
      </div>

      {/* Simulation — no before/after today (simulateTrade is an unused mock) */}
      <div className="flex items-center gap-2 mt-1">
        <span className="text-ink-3">Simulation:</span>
        <StateBadge state="missing" label="none" title="simulateTrade() is an unused mock; balance before/after is not available without a backend change." />
      </div>

      {meta.analysis && <PortfolioAnalysisView analysis={meta.analysis} chainMode={chainMode} />}
    </div>
  );
}
