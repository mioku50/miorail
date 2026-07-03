import { Link } from 'wouter';
import { useActionsFeed, useChatHistory } from '@mioagent/api-client-react';
import { isMainnetReadonly } from '../../lib/chain';

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3 border-b border-line pb-1 mb-2">
      <div className="flex items-center gap-1.5">
        <span className="text-accent">▸</span>
        <span>{title}</span>
      </div>
      {count !== undefined && (
        <span className="bg-panel px-1.5 py-0.5 rounded border border-line text-ink-2 font-mono text-[9px]">
          {count}
        </span>
      )}
    </div>
  );
}

export function RiskQueue() {
  const { data: actionsData } = useActionsFeed();
  const { data: chatData } = useChatHistory();

  const allActions = actionsData?.actions || [];
  const pendingActions = allActions.filter((a: any) => a.status === 'pending');

  // Find recent tool calls from chat history if any exist
  const messages = chatData?.messages || [];
  const recentToolCalls: any[] = [];
  for (let i = messages.length - 1; i >= 0 && recentToolCalls.length < 5; i--) {
    const msg = messages[i] as any;
    if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
      recentToolCalls.push(...msg.toolCalls);
    }
  }

  return (
    <aside className="w-[300px] min-w-[300px] shrink-0 border-l border-line bg-panel-2 p-3 flex flex-col gap-4 overflow-y-auto font-mono text-xs select-none">
      {/* Pending Actions Summary */}
      <div>
        <SectionHeader title="Risk Queue" count={pendingActions.length} />
        {pendingActions.length === 0 ? (
          <div className="bg-panel border border-line rounded-lg p-4 text-center flex flex-col items-center justify-center gap-1">
            <div className="text-[12px] font-medium text-ink-2">No autonomous queue yet</div>
            <div className="text-[10px] text-ink-3 font-sans leading-tight max-w-[200px]">
              When scanners or AI recommendations propose execution, actions appear here for screening.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-h-[380px] overflow-y-auto pr-1">
            {pendingActions.map((action: any) => {
              const risk = action.metadata?.riskLevel || 'low';
              const riskColor =
                risk === 'critical' || risk === 'high'
                  ? 'bg-risk-soft text-risk border-risk/30'
                  : risk === 'medium'
                  ? 'bg-warn-soft text-warn border-warn/30'
                  : 'bg-ok-soft text-ok border-ok/30';

              const title =
                action.title ||
                action.metadata?.title ||
                action.metadata?.summary ||
                action.suggestedPrompt ||
                action.prompt ||
                (action.kind ? `${action.kind.toUpperCase()} Action` : 'Autonomous Action');
              const createdBy = action.createdBy || 'agent';

              return (
                <Link
                  key={action.id}
                  href={`/inbox/${action.id}`}
                  className="block bg-panel border border-line rounded-lg p-2.5 hover:border-accent/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${riskColor}`}>
                      {risk} risk
                    </span>
                    <span className="text-[9px] text-ink-3">
                      {isMainnetReadonly ? 'read-only' : 'blocked'}
                    </span>
                  </div>
                  <div className="font-sans font-semibold text-ink text-[12px] truncate mb-1">
                    {title}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-ink-3">
                    <span>by: {createdBy}</span>
                    <span className="text-accent font-sans">review →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Mini Agent Trace */}
      <div>
        <SectionHeader title="Latest Agent Trace" count={recentToolCalls.length} />
        {recentToolCalls.length === 0 ? (
          <div className="bg-panel border border-line rounded-lg p-3 text-center text-ink-3 font-sans text-[11px] italic">
            No tool execution traces in memory.
          </div>
        ) : (
          <div className="bg-panel border border-line rounded-lg p-2.5 flex flex-col gap-2 max-h-[220px] overflow-y-auto">
            {recentToolCalls.slice(0, 4).map((tc: any, idx: number) => (
              <div key={idx} className="flex flex-col gap-0.5 border-b border-line/50 pb-1.5 last:border-0 last:pb-0">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-bold text-ink truncate max-w-[160px]">{tc.toolName || tc.name || 'tool_call'}</span>
                  <span className={tc.isError ? 'text-risk font-bold text-[10px]' : 'text-ok font-bold text-[10px]'}>
                    {tc.isError ? '✕ failed' : '✓ ok'}
                  </span>
                </div>
                {tc.args || tc.arguments ? (
                  <div className="text-[10px] text-ink-3 font-mono truncate">
                    args: {typeof (tc.args || tc.arguments) === 'string' ? (tc.args || tc.arguments) : JSON.stringify(tc.args || tc.arguments)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Navigation Shortcuts */}
      <div className="mt-auto pt-2 flex flex-col gap-1.5 font-sans">
        <Link href="/actions" className="block text-center bg-accent/10 hover:bg-accent/20 text-accent border border-accent/30 rounded-lg py-1.5 text-xs font-semibold transition-colors">
          Open Full Action Inbox →
        </Link>
        <Link href="/stream" className="block text-center bg-panel hover:bg-panel-2 text-ink-2 border border-line rounded-lg py-1.5 text-xs font-semibold transition-colors">
          Open Agent Stream / Chat →
        </Link>
      </div>
    </aside>
  );
}
