import { isMainnetReadonly } from '../../lib/chain';
import { securityFlagLabels, securityBadgeClass } from '../../lib/format';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function TokenFindingsView({ findings, chainMode }: { findings: any[]; chainMode: string }) {
  return (
    <div className="flex flex-col gap-1.5 mt-1">
      <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Token Findings ({findings.length})</div>
      <div className="flex flex-col gap-1.5 max-h-[240px] overflow-y-auto pr-1">
        {findings.map((finding: any, idx: number) => {
          const fRiskColor = finding.risk === 'low' ? 'bg-ok-soft text-ok border-ok/20' : finding.risk === 'high' ? 'bg-risk-soft text-risk border-risk/20' : 'bg-warn-soft text-warn border-warn/20';
          const securityFlags = securityFlagLabels(finding.security?.flags);
          const basescanLink = finding.address && finding.address !== 'native' && !finding.address.includes('native')
            ? `https://${(isMainnetReadonly || chainMode === 'mainnet-readonly' || chainMode === 'mainnet') ? '' : 'sepolia.'}basescan.org/token/${finding.address}`
            : null;

          return (
            <div key={idx} className="flex flex-col gap-1 bg-bg/80 border border-line rounded p-2.5 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-bold text-ink">
                  <span>{finding.symbol}</span>
                  {finding.balanceFormatted && (
                    <span className="font-normal font-mono text-ink-3">
                      ({finding.balanceFormatted}{finding.usdValue ? ` ~ $${finding.usdValue}` : ''})
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${fRiskColor}`}>{finding.risk}</span>
                  {finding.security && (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${securityBadgeClass(finding.security.status)}`}>Security: {finding.security.status}</span>
                  )}
                  {basescanLink && (
                    <a href={basescanLink} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-[10px]" onClick={(e) => e.stopPropagation()}>BaseScan ↗</a>
                  )}
                </div>
              </div>
              <div className="text-ink-2 text-[11px] leading-snug mt-0.5">{finding.reason}</div>
              {securityFlags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {securityFlags.map((label: string) => (
                    <span key={label} className="px-1.5 py-0.5 rounded bg-warn-soft text-warn border border-warn/20 text-[10px] font-semibold">{label}</span>
                  ))}
                </div>
              )}
              <div className="text-[10px] text-ink-3 font-mono mt-0.5">
                Suggested handling: <span className="text-ink-2 font-semibold">{finding.suggestedHandling}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
