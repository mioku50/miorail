import { useChatHistory, useActionsFeed } from '@mioagent/api-client-react';

export function HistoryPage() {
  const { data: chatData } = useChatHistory();
  const { data: actionsData } = useActionsFeed();
  const messages = chatData?.messages || [];
  const actions = actionsData?.actions || [];
  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">History</h2>
      <div className="flex gap-4">
        <div className="flex-1 bg-panel border border-line rounded-xl p-4">
          <h3 className="text-sm font-bold mb-3">Recent Messages</h3>
          <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto">
            {messages.map((m: any, i: number) => (
              <div key={i} className="text-sm p-2 bg-bg rounded border border-line">
                <div className="text-xs text-ink-3 mb-1 font-bold">{m.role} <span className="font-normal">{new Date(m.createdAt || Date.now()).toLocaleTimeString()}</span></div>
                {m.content}
              </div>
            ))}
            {messages.length === 0 && <div className="text-sm text-ink-3">No messages</div>}
          </div>
        </div>
        <div className="flex-1 bg-panel border border-line rounded-xl p-4">
          <h3 className="text-sm font-bold mb-3">Recent Actions</h3>
          <div className="flex flex-col gap-2.5 max-h-[400px] overflow-y-auto">
            {actions.map((a: any, i: number) => {
              const source = a.metadata?.createdBy || a.metadata?.source || 'system';
              const provider = a.metadata?.analysis?.provider || a.metadata?.provider || (a.kind === 'recommendation' ? 'moralis' : null);
              const statusBadge = a.status === 'executed' ? 'bg-green-soft text-green' : a.status === 'dismissed' ? 'bg-panel-2 text-ink-3' : a.status === 'failed' ? 'bg-red-soft text-red' : 'bg-amber-soft text-amber';

              return (
                <div key={i} className="text-sm p-3 bg-bg rounded-lg border border-line flex flex-col gap-1.5 shadow-sm">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-bold uppercase tracking-wider text-[11px] text-ink">{a.kind}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold capitalize ${statusBadge}`}>{a.status}</span>
                    </div>
                    <span className="text-[11px] text-ink-3 font-mono">{new Date(a.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="text-ink text-xs leading-relaxed font-medium">
                    {a.suggestedPrompt || a.metadata?.reason || 'Automated action'}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-ink-3 font-mono pt-1 border-t border-line/50">
                    <span>Source: <span className="text-ink-2 font-medium capitalize">{source}</span></span>
                    {provider && <span>Provider: <span className="text-ink-2 font-medium capitalize">{provider}</span></span>}
                  </div>
                </div>
              );
            })}
            {actions.length === 0 && <div className="text-sm text-ink-3 text-center py-6">No actions recorded in history yet</div>}
          </div>
        </div>
      </div>
    </main>
  );
}
