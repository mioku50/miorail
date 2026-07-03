// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ApprovalAnalysisView({ approvalAnalysis }: { approvalAnalysis: any }) {
  return (
    <div className="flex flex-col gap-1.5 mt-2 border-t border-line pt-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Approval Summary</div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono">
          <span className="bg-panel-2 border border-line px-1.5 py-0.5 rounded">Total: {approvalAnalysis.totalApprovals}</span>
          {approvalAnalysis.unlimitedApprovals > 0 && (
            <span className="bg-warn-soft text-warn border border-warn/20 px-1.5 py-0.5 rounded font-bold">Unlimited: {approvalAnalysis.unlimitedApprovals}</span>
          )}
          {approvalAnalysis.riskySpenderApprovals > 0 && (
            <span className="bg-risk-soft text-risk border border-risk/20 px-1.5 py-0.5 rounded font-bold">Risky: {approvalAnalysis.riskySpenderApprovals}</span>
          )}
        </div>
      </div>
      <div className="text-xs font-medium text-ink bg-panel-2 p-2 rounded border border-line">{approvalAnalysis.summary}</div>
      {approvalAnalysis.findings && approvalAnalysis.findings.length > 0 && (
        <div className="flex flex-col gap-1.5 max-h-[200px] overflow-y-auto pr-1 mt-1">
          {approvalAnalysis.findings.map((f: any, fIdx: number) => {
            const fColor = f.riskLevel === 'critical' || f.riskLevel === 'high' ? 'bg-risk-soft text-risk border-risk/20' : f.riskLevel === 'medium' ? 'bg-warn-soft text-warn border-warn/20' : 'bg-ok-soft text-ok border-ok/20';
            return (
              <div key={fIdx} className="flex flex-col gap-1 bg-bg/80 border border-line rounded p-2 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-bold text-ink">
                    <span>{f.tokenSymbol}</span>
                    <span className="font-normal font-mono text-ink-3 text-[10px] truncate max-w-[140px]">→ {f.spenderLabel || f.spenderAddress}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {f.isUnlimited && (
                      <span className="bg-warn-soft text-warn border border-warn/30 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase">Unlimited</span>
                    )}
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${fColor}`}>{f.riskLevel}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between text-[10px] font-mono text-ink-3">
                  <span>Allowance: {f.allowanceFormatted}</span>
                </div>
                <div className="text-ink-2 text-[11px] leading-snug mt-0.5">
                  {f.reason} Consider reviewing this permission in a trusted wallet or revoke interface.
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
