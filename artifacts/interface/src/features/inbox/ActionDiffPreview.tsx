import { isMainnetReadonly } from '../../lib/chain';
import { StateBadge, type StateKind } from '@mioagent/ui';
import { PortfolioAnalysisView } from './PortfolioAnalysisView';
import { useAccount } from 'wagmi';
import { useUiStore } from '../../lib/state';
import { LazyWalletConfirmButton } from './LazyWalletConfirmButton';
import { getRevokeExecutionNotice, parseExecutionPayload, shouldShowConfirmCta } from './actionDisplay';
// The zero-dependency subpath, not the @mioagent/wallet-actions barrel: this
// module is deliberately kept clear of `ox`, which is why the confirm button
// below is lazy.
import { builderCodeFromEnvV1 } from '@mioagent/route-domain/builder-code';

// T67X-B1: the same resolver the console uses, so the two wallet paths cannot
// end up attributing to different codes.
const BUILDER_CODE = builderCodeFromEnvV1({
  VITE_BASE_BUILDER_CODE: import.meta.env.VITE_BASE_BUILDER_CODE,
  VITE_BUILDER_CODE: import.meta.env.VITE_BUILDER_CODE,
});

// The Inbox card as a risk-control center. Shows what would change before any
// confirmation: planned calls, security-screening verdicts, preflight-validation
// simulation, execution status, plus the portfolio analysis. Screening and
// simulation verdicts are read from metadata stored by /recommend + /chat;
// where the backend genuinely stored none, it renders honest empty states —
// never fabricated results.
export function ActionDiffPreview({
  action,
  onRefresh,
  onRetrySecurity,
  isRetryingSecurity,
}: {
  action: any;
  onRefresh?: () => void;
  onRetrySecurity?: () => void;
  isRetryingSecurity?: boolean;
}) {
  const { address, isConnected } = useAccount();
  const showToast = useUiStore((s) => s.showToast);
  const meta = action.metadata || {};
  const reason = meta.reason;
  const expectedEffect = meta.expectedEffect;
  const risk = meta.risk || 'medium';
  const chainMode = meta.chainMode || (isMainnetReadonly ? 'mainnet-readonly' : 'sepolia');
  const safetyState = meta.safetyState || (action.status === 'failed' ? 'blocked' : 'safe');
  const executionStatus = action.status === 'executed'
    ? 'executed'
    : action.status === 'cancelled'
      ? 'cancelled'
      : action.status === 'failed'
        ? 'failed'
        : meta.executionStatus || (isMainnetReadonly ? 'read-only' : 'executable');
  const rawPayload = action.executionPayload;
  const payload = parseExecutionPayload(rawPayload);
  const calls = Array.isArray(payload?.calls) ? payload.calls : [];
  const showConfirmCta = shouldShowConfirmCta(action);
  const revokeExecutionNotice = getRevokeExecutionNotice(action);
  const isReadOnlyMode = isMainnetReadonly || chainMode === 'mainnet-readonly' || chainMode === 'mainnet';

  const riskColor = risk === 'low' ? 'bg-ok-soft text-ok border-ok/20' : risk === 'high' ? 'bg-risk-soft text-risk border-risk/20' : 'bg-warn-soft text-warn border-warn/20';
  const safetyColor = safetyState === 'blocked' || safetyState === 'failed' ? 'bg-risk-soft text-risk border-risk/20' : 'bg-ok-soft text-ok border-ok/20';
  const executionBannerColor = executionStatus === 'executed'
    ? 'bg-ok-soft text-ok border-ok/20'
    : isReadOnlyMode
      ? (executionStatus === 'user-confirmable' ? 'bg-ok-soft text-ok border-ok/20' : 'bg-warn-soft text-warn border-warn/20')
      : 'bg-ok-soft text-ok border-ok/20';
  const execState: StateKind =
    executionStatus === 'blocked' || executionStatus === 'failed' || executionStatus === 'cancelled' ? 'failed'
    : executionStatus === 'executable' || executionStatus === 'user-confirmable' ? 'live'
    : executionStatus === 'executed' ? 'live'
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
      <div className={`mt-1 font-medium px-2 py-1 rounded border text-[11px] w-fit ${executionBannerColor}`}>
        {executionStatus === 'executed'
          ? 'Completed in Base Account'
          : isReadOnlyMode
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
          {revokeExecutionNotice && (
            <div className="bg-ok-soft border border-ok/20 rounded px-2 py-1.5 text-[11px] text-ok flex flex-col gap-0.5">
              <span className="font-semibold">{revokeExecutionNotice.title}</span>
              {revokeExecutionNotice.txHash && (
                <a
                  href={revokeExecutionNotice.txHashUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 font-mono break-all"
                >
                  Tx: {revokeExecutionNotice.txHash}
                </a>
              )}
              {revokeExecutionNotice.batchId && (
                <span className="font-mono text-ok/90" title={revokeExecutionNotice.batchId}>
                  Batch: {revokeExecutionNotice.shortBatchId || revokeExecutionNotice.batchId}
                </span>
              )}
              {revokeExecutionNotice.stateOnlyLabel && <span>{revokeExecutionNotice.stateOnlyLabel}</span>}
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
              <span className="text-ink-3 not-italic font-medium">Preflight status: </span>
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

      {showConfirmCta && (
        <div className="mt-2 mb-1 flex flex-col gap-1.5 p-2.5 bg-panel border border-line rounded-lg shadow-sm">
          <div className="flex items-center gap-2 flex-wrap">
            {action.metadata?.preferredFirstAction === true && (
              <span className="text-[10px] font-semibold text-accent-2 bg-accent-soft px-2 py-0.5 rounded-full w-fit" title="Revoke approval is the safest first mainnet action — no funds move.">
                ★ Recommended first action
              </span>
            )}
            <span className="text-[10px] font-medium text-ink-3 bg-bg px-2 py-0.5 rounded-full w-fit border border-line" title="No fork sim or before/after portfolio projection; only chain, call-structure, screening, and canonical-token checks.">
              ⚠ Preflight validation — no fork simulation
            </span>
          </div>
          {!address || !isConnected ? (
            <button
              type="button"
              disabled
              className="w-full bg-panel-2 border border-line/80 text-ink-2 px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] opacity-80 cursor-not-allowed text-center shadow-sm flex items-center justify-center gap-1.5"
            >
              ⚡ Connect Wallet to confirm
            </button>
          ) : (
            <LazyWalletConfirmButton
              action={action}
              builderCode={BUILDER_CODE}
              className="w-full bg-accent hover:bg-accent-2 text-white px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] shadow-[0_6px_16px_rgba(0,0,255,.28)] hover:-translate-y-[1px] hover:shadow-[0_10px_22px_rgba(0,0,255,.34)] transition-all flex items-center justify-center gap-1.5"
              onConfirmed={({ status, txHash, error }) => {
                if (status === 'success') {
                  showToast(txHash ? `Confirmed onchain · ${txHash.slice(0, 10)}…` : 'Action verified');
                } else if (status === 'failed') {
                  showToast(error ?? 'Confirmation failed');
                }
                onRefresh?.();
              }}
            />
          )}
        </div>
      )}

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
            state={simulation.performed === false ? 'disabled' : simulation.success ? 'live' : 'failed'}
            label={simulation.performed === false ? 'not applicable' : simulation.method === 'preflight-validation' ? 'preflight validation' : (simulation.success ? 'passed' : 'blocked')}
            title={simulation.performed === false
              ? (simulation.reason || 'No transaction calls require simulation.')
              : simulation.method === 'preflight-validation'
              ? 'Preflight validation only: chain, call structure, instruction screening, canonical-token checks, and deterministic calldata projections. No fork simulation.'
              : (simulation.reason || simulation.error || 'Simulation verdict')}
          />
        ) : (
          <StateBadge state="missing" label="none" title="No simulation verdict stored on this action." />
        )}
      </div>

      {meta.analysis && (
        <PortfolioAnalysisView
          analysis={meta.analysis}
          chainMode={chainMode}
          onRetrySecurity={onRetrySecurity}
          isRetrying={isRetryingSecurity}
        />
      )}
    </div>
  );
}
