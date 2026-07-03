import { useAccount } from 'wagmi';
import { useExecuteAction, useDismissAction, useDeleteAction, useRegenerateAction } from '@mioagent/api-client-react';
import { useUiStore } from '../../lib/state';
import { isMainnetReadonly } from '../../lib/chain';
import { ActionDiffPreview } from './ActionDiffPreview';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ActionCardProps {
  action: any;
  onRefresh: () => void;
}

export function ActionCard({ action, onRefresh }: ActionCardProps) {
  const { address } = useAccount();
  const executeAction = useExecuteAction();
  const dismissAction = useDismissAction();
  const deleteAction = useDeleteAction();
  const regenerateAction = useRegenerateAction();
  const showToast = useUiStore((s) => s.showToast);

  const isPending = action.status === 'pending';
  const isExecuting = executeAction.isPending;
  const isDismissing = dismissAction.isPending;
  const isDeleting = deleteAction.isPending;
  const isRegenerating = regenerateAction.isPending;

  return (
    <div id={`action-${action.id}`} data-action-id={action.id} className={`bg-panel border rounded-xl shadow-sm p-[15px] flex flex-col gap-[10px] animate-in fade-in slide-in-from-bottom-2 ${action.status === 'failed' ? 'border-risk-soft' : 'border-line'}`}>
      <div className="flex items-start justify-between gap-[10px]">
        <div className="flex gap-[10px]">
          <div className={`w-[9px] h-[9px] rounded-full shrink-0 mt-[5px] ${action.status === 'executed' ? 'bg-ok' : action.status === 'pending' ? 'bg-warn' : 'bg-risk'}`}></div>
          <div>
            <h3 className="text-[15px] font-bold text-ink tracking-[-.01em] uppercase">{action.kind}</h3>
            <div className="font-mono text-[11px] text-ink-3 mt-1">
              Created by: {action.metadata?.createdBy === 'agent-stream' ? 'Agent Stream' : action.metadata?.createdBy === 'actions-builder' ? 'Actions Builder' : action.metadata?.createdBy === 'scanner' || action.kind === 'alert' || action.kind === 'recommendation' ? 'Scanner' : 'System'}
            </div>
          </div>
        </div>
        <span className="text-[11px] text-ink-3 flex items-center gap-1">⟳ {new Date(action.createdAt).toLocaleTimeString()}</span>
      </div>

      <div className="text-[13px] text-ink-2 leading-relaxed">{action.suggestedPrompt}</div>

      <ActionDiffPreview action={action} />

      {action.status === 'failed' && (
        <div className="flex items-center gap-[7px] text-[12px] font-bold text-risk bg-risk-soft px-[10px] py-[6px] rounded-[9px] mt-1 w-fit">🛡️ blocked by security</div>
      )}

      {action.tokens && action.tokens.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {action.tokens.map((t: string, i: number) => (
            <span key={i} className="font-mono text-[11px] bg-bg px-[8px] py-[3px] rounded-[7px] text-ink-2">{t}</span>
          ))}
        </div>
      )}

      {action.status === 'failed' ? (
        <div className="flex items-center gap-[7px] text-[12px] font-bold text-risk bg-risk-soft px-[10px] py-[6px] rounded-[9px] w-fit mt-1">🛡️ failed</div>
      ) : (
        <div className="flex gap-2 items-center flex-wrap mt-1">
          {(!isMainnetReadonly && action.metadata?.chainMode !== 'mainnet-readonly' && action.metadata?.chainMode !== 'mainnet' && action.calls && action.calls.length > 0) && (
            <span title={(isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') ? 'Mainnet execution is disabled in read-only mode.' : undefined} onClick={() => { if (isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') showToast('Mainnet execution is disabled in read-only mode.'); }}>
              <button
                onClick={() => {
                  if (isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') {
                    showToast('Mainnet execution is disabled in read-only mode.');
                    return;
                  }
                  executeAction.mutate({ actionId: action.id }, {
                    onSuccess: (data: any) => {
                      if (data?.success && data?.approvalUrl) {
                        window.open(data.approvalUrl, '_blank');
                      } else if (data?.error) {
                        if (data.error.includes('MCP') || data.error.includes('Approval provider') || data.error.includes('Backend failed')) {
                          showToast('Approval provider is not configured. Action was not executed.');
                        } else {
                          if (data.error.includes('Mainnet execution is disabled')) {
                            showToast(data.error);
                          } else {
                            showToast('Error: ' + data.error);
                          }
                        }
                      } else {
                        showToast('Approval provider is not configured. Action was not executed.');
                      }
                      onRefresh();
                    },
                    onError: (err: any) => {
                      showToast('Error: ' + err.message);
                      onRefresh();
                    },
                  });
                }}
                disabled={!isPending || isExecuting || isDismissing || isDeleting || isRegenerating || isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet'}
                className="bg-accent hover:bg-accent-2 text-white px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] shadow-[0_6px_16px_rgba(0,0,255,.28)] hover:-translate-y-[1px] hover:shadow-[0_10px_22px_rgba(0,0,255,.34)] transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ⚡ {isExecuting ? 'Executing...' : (isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') ? 'Read-only' : 'Execute'}
              </button>
            </span>
          )}
          {action.kind === 'recommendation' && (
            <button
              onClick={() => regenerateAction.mutate({ actionId: action.id, walletAddress: address, chainEnv: import.meta.env.VITE_CHAIN_ENV || 'mainnet-readonly' }, { onSuccess: () => { showToast('Recommendation analysis regenerated'); onRefresh(); } })}
              disabled={isExecuting || isDismissing || isDeleting || isRegenerating}
              className="bg-bg hover:bg-panel border border-line text-ink px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRegenerating ? 'Regenerating...' : 'Regenerate analysis'}
            </button>
          )}
          <button
            onClick={() => dismissAction.mutate({ actionId: action.id }, { onSuccess: () => onRefresh() })}
            disabled={!isPending || isExecuting || isDismissing || isDeleting || isRegenerating}
            className="bg-bg hover:bg-[#eceef7] text-ink-2 px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDismissing ? 'Dismissing...' : 'Dismiss'}
          </button>
          <button
            onClick={() => {
              if (confirm('Permanently delete this action?')) {
                deleteAction.mutate({ actionId: action.id }, { onSuccess: () => { showToast('Action deleted'); onRefresh(); } });
              }
            }}
            disabled={isExecuting || isDismissing || isDeleting || isRegenerating}
            className="bg-bg hover:bg-risk-soft text-risk px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  );
}
