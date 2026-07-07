import { useAccount } from 'wagmi';
import { useCreateRecommendation } from '@mioagent/api-client-react';
import { useUiStore } from '../../lib/state';
import { isMainnetReadonly } from '../../lib/chain';

// T19.3: surfaces provider-discovered spend permissions and, for each active
// approval, offers a one-click "Revoke" that creates a confirmable
// revoke_approval action for any token (gated on the real allowance — see /recommend).
// When there are no approvals, shows an honest "nothing to revoke" state with
// a re-scan CTA instead of a fabricated list.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ApprovalAnalysisView({ approvalAnalysis }: { approvalAnalysis: any }) {
  const { address } = useAccount();
  const createAction = useCreateRecommendation();
  const showToast = useUiStore((s) => s.showToast);
  const chainEnv = import.meta.env.VITE_CHAIN_ENV || (isMainnetReadonly ? 'mainnet-readonly' : 'sepolia');

  const total = Number(approvalAnalysis.totalApprovals ?? 0);
  const scannerUnavailable =
    approvalAnalysis.scannerUnavailable === true ||
    ['budget_exhausted', 'rate_limited', 'temporarily_unavailable', 'auth_or_budget_issue'].includes(String(approvalAnalysis.status || ''));

  // T19.2: "Check spend permissions" — re-runs the approval scan so the user
  // can refresh this list. Works in read-only mode (no broadcast).
  const checkSpendPermissions = () => {
    createAction.mutate(
      { instruction: 'Scan my wallet for revokable spend permissions', walletAddress: address, chainEnv },
      {
        onSuccess: (res) => {
          if (!res?.success) {
            showToast(res?.error || 'No action created.');
            return;
          }
          showToast('Scanning spend permissions — results in Action Inbox');
        },
        onError: (e) => showToast('Failed to scan: ' + e.message),
      },
    );
  };

  // T19.3: create a confirmable revoke_approval for a specific spender and token.
  // The spender came from a real provider-discovered approval, so /recommend's
  // approval lookup will find it and encode approve(spender, 0).
  const revokeSpender = (spenderAddress: string, tokenSymbol?: string) => {
    createAction.mutate(
      { instruction: `revoke ${tokenSymbol || ''} approval for ${spenderAddress}`.replace(/\s+/g, ' ').trim(), walletAddress: address, chainEnv },
      {
        onSuccess: (res) => {
          if (!res?.success) {
            showToast(res?.error || 'Could not create revoke action.');
            return;
          }
          showToast(`Revoke ${tokenSymbol || 'approval'} ready to confirm in Action Inbox`);
        },
        onError: (e) => showToast('Failed to create revoke: ' + e.message),
      },
    );
  };

  return (
    <div className="flex flex-col gap-1.5 mt-2 border-t border-line pt-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Approval Summary</div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono">
          <span className="bg-panel-2 border border-line px-1.5 py-0.5 rounded">Total: {total}</span>
          {approvalAnalysis.unlimitedApprovals > 0 && (
            <span className="bg-warn-soft text-warn border border-warn/20 px-1.5 py-0.5 rounded font-bold">Unlimited: {approvalAnalysis.unlimitedApprovals}</span>
          )}
          {approvalAnalysis.riskySpenderApprovals > 0 && (
            <span className="bg-risk-soft text-risk border border-risk/20 px-1.5 py-0.5 rounded font-bold">Risky: {approvalAnalysis.riskySpenderApprovals}</span>
          )}
        </div>
      </div>

      {scannerUnavailable ? (
        <div className="flex flex-col gap-2 bg-warn-soft border border-warn/20 rounded p-2.5 text-[11px]">
          <div className="text-warn font-semibold">
            Approval scanner unavailable — Moralis CU limit reached. Try after reset or upgrade provider.
          </div>
          {approvalAnalysis.note && (
            <div className="text-warn/90 leading-snug">{approvalAnalysis.note}</div>
          )}
          <button
            onClick={checkSpendPermissions}
            disabled={createAction.isPending}
            className="self-start text-[11px] font-semibold text-warn bg-bg border border-warn/30 px-2.5 py-1 rounded-full hover:bg-warn/10 transition-colors disabled:opacity-50"
          >
            {createAction.isPending ? 'Scanning...' : 'Check spend permissions'}
          </button>
        </div>
      ) : total === 0 ? (
        // T19.3: honest empty state — no read-only recommendation is fabricated
        // for missing approvals; just tell the user there's nothing to revoke.
        <div className="flex flex-col gap-2 bg-bg/80 border border-line rounded p-2.5 text-[11px]">
          <div className="text-ink-2 font-medium">No active approvals found — nothing to revoke.</div>
          <button
            onClick={checkSpendPermissions}
            disabled={createAction.isPending}
            className="self-start text-[11px] font-semibold text-accent-2 bg-accent-soft border border-accent/30 px-2.5 py-1 rounded-full hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {createAction.isPending ? 'Scanning…' : '🔍 Check spend permissions'}
          </button>
        </div>
      ) : (
        <>
          <div className="text-xs font-medium text-ink bg-panel-2 p-2 rounded border border-line">{approvalAnalysis.summary}</div>
          {approvalAnalysis.findings && approvalAnalysis.findings.length > 0 && (
            <div className="flex flex-col gap-1.5 max-h-[200px] overflow-y-auto pr-1 mt-1">
              {approvalAnalysis.findings.map((f: any, fIdx: number) => {
                const fColor = f.riskLevel === 'critical' || f.riskLevel === 'high' ? 'bg-risk-soft text-risk border-risk/20' : f.riskLevel === 'medium' ? 'bg-warn-soft text-warn border-warn/20' : 'bg-ok-soft text-ok border-ok/20';
                const isZeroAllowance = !f.allowanceFormatted || f.allowanceFormatted === '0' || f.allowanceFormatted === '0.0' || f.allowanceFormatted === '0 USDC' || String(f.allowanceRaw) === '0';
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
                      {f.reason}
                    </div>
                    {isZeroAllowance ? (
                      <span className="self-start mt-0.5 text-[10px] font-semibold text-ok bg-ok-soft border border-ok/20 px-2 py-0.5 rounded">Already revoked / allowance is 0</span>
                    ) : (
                      <button
                        onClick={() => revokeSpender(f.spenderAddress, f.tokenSymbol)}
                        disabled={createAction.isPending}
                        className="self-start mt-0.5 text-[11px] font-semibold text-white bg-accent px-2.5 py-1 rounded-full hover:bg-accent-2 transition-colors disabled:opacity-50"
                        title={`Create a confirmable action to revoke the ${f.tokenSymbol || 'token'} approval for ${f.spenderAddress}`}
                      >
                        {createAction.isPending ? 'Preparing…' : 'Revoke'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <button
            onClick={checkSpendPermissions}
            disabled={createAction.isPending}
            className="self-start text-[11px] font-semibold text-accent-2 bg-accent-soft border border-accent/30 px-2.5 py-1 rounded-full hover:bg-accent/20 transition-colors disabled:opacity-50 mt-0.5"
          >
            {createAction.isPending ? 'Scanning…' : '🔍 Check spend permissions'}
          </button>
        </>
      )}
    </div>
  );
}
