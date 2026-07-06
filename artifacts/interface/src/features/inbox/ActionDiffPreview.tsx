import { isMainnetReadonly } from '../../lib/chain';
import { StateBadge, type StateKind } from '@mioagent/ui';
import { PortfolioAnalysisView } from './PortfolioAnalysisView';

// The Inbox card as a risk-control center. Shows what would change before any
// confirmation: planned calls, security-screening verdicts, static-validation
// simulation, execution status, plus the portfolio analysis. Screening and
// simulation verdicts are read from metadata stored by /recommend + /chat;
// where the backend genuinely stored none, it renders honest empty states —
// never fabricated results.
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
  const execState: StateKind =
    executionStatus === 'blocked' ? 'failed'
    : executionStatus === 'executable' || executionStatus === 'user-confirmable' ? 'live'
    : 'disabled';

  // T19: screening + simulation verdicts are stored on the action by /recommend
  // and /chat (metadata.securityScreening / simulationResult). Surface them
  // honestly; fall back to "missing" only when the backend genuinely stored none.
  const screening = meta.securityScreening;
  const simulation = meta.simulationResult;

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
      <div className={`mt-1 font-medium px-2 py-1 rounded border text-[11px] w-fit ${isReadOnlyMode ? (executionStatus === 'user-confirmable' ? 'bg-ok-soft text-ok border-ok/20' : 'bg-warn-soft text-warn border-warn/20') : 'bg-ok-soft text-ok border-ok/20'}`}>
        {isReadOnlyMode
          ? (executionStatus === 'user-confirmable' ? 'Confirmable via Base Account' : 'Read-only recommendation')
          : 'Executable testnet recommendation'}
      </div>

      {/* Execution status */}
      <div className="flex items-center gap-2 mt-1">
        <span className="text-ink-3">Execution:</span>
        <StateBadge state={execState} label={executionStatus} />
      </div>

      {meta.actionType === 'revoke_approval' && (
        <div className="bg-panel border border-line rounded p-2.5 my-1 flex flex-col gap-1.5">
          <div className="font-semibold text-ink text-[12px]">
            Revoking spend access for {meta.tokenSymbol || 'Token'} to {meta.spenderLabel ? `${meta.spenderLabel} (${meta.spender})` : meta.spender}
          </div>
          {meta.allowanceBefore !== undefined && (
            <div className="text-ink-2 font-mono text-[11px]">
              <span className="text-ink-3">Allowance: </span>
              Current: {meta.allowanceBefore} {meta.tokenSymbol || ''} → After: {meta.allowanceAfter || '0'} {meta.tokenSymbol || ''}
            </div>
          )}
          {meta.method && (
            <div className="text-ink-2 font-mono text-[11px]">
              <span className="text-ink-3">Method: </span>
              {meta.method}
            </div>
          )}
          {meta.simulationLabel && (
            <div className="text-ink-2 text-[11px] italic">
              <span className="text-ink-3 not-italic font-medium">Simulation status: </span>
              {meta.simulationLabel}
            </div>
          )}
        </div>
      )}

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

      {/* Security screening — drain / unlimited-approval / exfil / prompt-injection verdicts */}
      <div className="flex items-center gap-2 mt-1">
        <span className="text-ink-3">Screening:</span>
        {screening ? (
          <StateBadge
            state={screening.allowed ? 'live' : 'failed'}
            label={screening.verdict ? String(screening.verdict).toLowerCase() : (screening.allowed ? 'passed' : 'blocked')}
            title={screening.reason ? `Action security screening: ${screening.reason}` : 'Action security screening verdict'}
          />
        ) : (
          <StateBadge
            state="missing"
            label="not screened"
            title="No screening verdict stored on this action."
          />
        )}
      </div>

      {/* Simulation — static structural validation (NOT a fork sim; no before/after) */}
      <div className="flex items-center gap-2 mt-1">
        <span className="text-ink-3">Simulation:</span>
        {simulation ? (
          <StateBadge
            state={simulation.success ? 'mock' : 'failed'}
            label={simulation.method === 'static-validation' ? 'static validation' : (simulation.success ? 'passed' : 'blocked')}
            title={simulation.method === 'static-validation'
              ? 'Static validation only: chain, call structure, instruction screening, and canonical-token checks. No fork simulation or before/after portfolio projection.'
              : (simulation.reason || simulation.error || 'Simulation verdict')}
          />
        ) : (
          <StateBadge state="missing" label="none" title="No simulation verdict stored on this action." />
        )}
      </div>

      {meta.analysis && <PortfolioAnalysisView analysis={meta.analysis} chainMode={chainMode} />}
    </div>
  );
}
