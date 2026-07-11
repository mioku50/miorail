import { TokenFindingsView } from './TokenFindingsView';
import { ApprovalAnalysisView } from './ApprovalAnalysisView';
import { securityCoverageUi } from '../../lib/securityUi';

// Renders analysis.summary + portfolioSnapshot + token findings + next steps +
// approval analysis. Sub-views keep this file under the ~200-line view budget.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function PortfolioAnalysisView({
  analysis,
  chainMode,
  onRetrySecurity,
  isRetrying = false,
}: {
  analysis: any;
  chainMode: string;
  onRetrySecurity?: () => void;
  isRetrying?: boolean;
}) {
  const securityCoverage = securityCoverageUi(analysis);
  return (
    <div className="flex flex-col gap-3 bg-panel-2/50 border border-line rounded-lg p-3.5 text-xs mt-2">
      <div className="font-semibold text-ink leading-snug border-b border-line pb-2">📊 Portfolio Risk Analysis Summary</div>
      <div className="text-ink-2 leading-relaxed">{analysis.summary}</div>

      {securityCoverage.state !== 'complete' && (
        <div className="flex flex-col gap-2 rounded border border-warn/25 bg-warn-soft px-3 py-2.5 text-[11px] text-warn sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-semibold">{securityCoverage.label}</div>
            <div className="mt-0.5 text-ink-2">{securityCoverage.reason}</div>
          </div>
          {securityCoverage.retryable && onRetrySecurity && (
            <button
              type="button"
              onClick={onRetrySecurity}
              disabled={isRetrying}
              className="shrink-0 rounded-lg border border-warn/30 bg-panel px-3 py-1.5 font-semibold text-warn transition-colors hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRetrying ? 'Retrying checks…' : 'Retry contract checks'}
            </button>
          )}
        </div>
      )}

      {analysis.portfolioSnapshot && (
        <div className="flex flex-wrap gap-3 bg-bg p-2.5 rounded border border-line text-[11px]">
          {analysis.portfolioSnapshot.totalUsdValue && (
            <div>
              <span className="text-ink-3">Total Value: </span>
              <span className="font-semibold text-ink">${analysis.portfolioSnapshot.totalUsdValue}</span>
            </div>
          )}
          <div>
            <span className="text-ink-3">Total Tokens: </span>
            <span className="font-semibold text-ink">{analysis.portfolioSnapshot.tokenCount}</span>
          </div>
          <div>
            <span className="text-ink-3">Suspicious: </span>
            <span className={`font-semibold ${analysis.portfolioSnapshot.suspiciousTokenCount > 0 ? 'text-risk' : 'text-ok'}`}>{analysis.portfolioSnapshot.suspiciousTokenCount}</span>
          </div>
          <div>
            <span className="text-ink-3">Priced / Unpriced: </span>
            <span className="font-semibold text-ink">{analysis.portfolioSnapshot.pricedTokenCount} / {analysis.portfolioSnapshot.unpricedTokenCount}</span>
          </div>
          <div>
            <span className="text-ink-3">Security checked: </span>
            <span className="font-semibold text-ink">{analysis.portfolioSnapshot.securityCheckedTokenCount || 0}</span>
          </div>
          <div>
            <span className="text-ink-3">High-risk security flags: </span>
            <span className={`font-semibold ${(analysis.portfolioSnapshot.securityHighRiskCount || 0) > 0 ? 'text-risk' : 'text-ok'}`}>{analysis.portfolioSnapshot.securityHighRiskCount || 0}</span>
          </div>
          <div>
            <span className="text-ink-3">Contract checks: </span>
            <span className="font-semibold text-ink">
              {securityCoverage.state === 'unavailable'
                ? 'Unavailable'
                : securityCoverage.state === 'partial'
                  ? 'Incomplete'
                  : 'Complete'}
            </span>
          </div>
          {analysis.portfolioSnapshot.snapshotTimestamp && (
            <div className="ml-auto">
              <span className="text-ink-3">Snapshot: </span>
              <span className={`font-mono ${analysis.portfolioSnapshot.dataFreshness === 'stale' ? 'text-warn' : 'text-ink-3'}`}>
                {new Date(analysis.portfolioSnapshot.snapshotTimestamp).toLocaleString()}{analysis.portfolioSnapshot.dataFreshness === 'stale' ? ' (stale)' : ''}
              </span>
            </div>
          )}
        </div>
      )}

      {analysis.tokenFindings && analysis.tokenFindings.length > 0 && <TokenFindingsView findings={analysis.tokenFindings} chainMode={chainMode} />}

      {analysis.suggestedNextSteps && analysis.suggestedNextSteps.length > 0 && (
        <div className="flex flex-col gap-1 mt-1 border-t border-line pt-2">
          <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Suggested Next Steps</div>
          <ul className="list-disc list-inside space-y-1 text-ink-2 text-[11px]">
            {analysis.suggestedNextSteps.map((step: string, sIdx: number) => (
              <li key={sIdx}>{step}</li>
            ))}
          </ul>
        </div>
      )}

      {analysis.approvalAnalysis && <ApprovalAnalysisView approvalAnalysis={analysis.approvalAnalysis} />}
    </div>
  );
}
