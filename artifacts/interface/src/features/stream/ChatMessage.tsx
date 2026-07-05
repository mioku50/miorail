import { useLocation } from 'wouter';
import { useUiStore } from '../../lib/state';
import { ToolCallTrace } from './ToolCallTrace';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ChatMessage({ m, networkLabel }: { m: any; networkLabel: string }) {
  const [, navigate] = useLocation();
  const showToast = useUiStore((s) => s.showToast);
  const focusAction = useUiStore((s) => s.focusAction);

  if (m.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1 animate-in fade-in slide-in-from-right-1">
        <div className="bg-accent text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-[13px] font-medium leading-relaxed max-w-[88%] shadow-sm break-words">
          {m.content}
        </div>
        <span className="text-[10px] text-ink-3 font-mono mr-1">User</span>
      </div>
    );
  }

  if (m.role === 'assistant') {
    const actionIdVal = m.actionId || m.metadata?.actionId;
    const meta = m.metadata || {};
    const riskVal = meta.risk || 'low';
    return (
      <div className="flex flex-col items-start gap-1 w-full animate-in fade-in slide-in-from-left-1">
        {m.content && (
          <div className="bg-panel border border-line rounded-2xl rounded-tl-sm px-4 py-3 text-[13px] text-ink font-normal leading-relaxed max-w-[92%] shadow-sm break-words mb-1.5">
            {m.content}
          </div>
        )}
        {actionIdVal && (
          <div className="w-full bg-panel border-2 border-accent/20 rounded-2xl p-4 shadow-md bg-gradient-to-br from-panel to-panel-2">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-line">
              <div className="flex items-center gap-1.5 text-xs font-bold text-ink">
                <span className="text-accent">⚡</span> Read-only recommendation created
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-accent-soft text-accent">New</span>
            </div>

            <div className="space-y-2 text-xs text-ink-2 mb-4">
              <div className="flex items-center justify-between">
                <span className="text-ink-3">Action ID</span>
                <span className="font-mono font-medium text-ink bg-bg px-1.5 py-0.5 rounded text-[11px]">{actionIdVal.slice(0, 10)}...</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-3">Source</span>
                <span className="font-medium text-ink">Agent Stream</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-3">Mode</span>
                <span className="font-mono text-ink">{networkLabel}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-3">Safety</span>
                <span className="font-medium text-risk flex items-center gap-1 bg-risk-soft px-2 py-0.5 rounded-full text-[11px]">🛡️ Execution blocked</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-3">Risk Level</span>
                <span className={`font-semibold px-2 py-0.5 rounded-full text-[11px] uppercase tracking-wide ${
                  riskVal === 'high' ? 'bg-risk-soft text-risk' : riskVal === 'medium' ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'
                }`}>
                  {riskVal}
                </span>
              </div>
            </div>

            <button
              onClick={() => {
                // T19.2: route to the canonical Action Inbox deep link (not the
                // Cockpit "/"). ActionsPage reads :actionId and focuses the card.
                navigate(`/actions/${actionIdVal}`);
                focusAction(actionIdVal);
                showToast('Focused Action Inbox recommendation');
              }}
              className="w-full py-2 px-3 bg-accent hover:bg-accent-2 text-white font-semibold text-xs rounded-xl shadow-sm transition-all flex items-center justify-center gap-1.5 cursor-pointer"
              aria-label="View in Action Inbox"
            >
              <span>View in Action Inbox</span>
              <span>→</span>
            </button>
          </div>
        )}
        <ToolCallTrace toolCalls={m.toolCalls} />
        <span className="text-[10px] text-ink-3 font-mono ml-1">Miorail</span>
      </div>
    );
  }
  return null;
}
