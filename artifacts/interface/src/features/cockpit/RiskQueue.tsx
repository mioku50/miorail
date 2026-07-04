import { Link } from 'wouter';
import { useActionsFeed, useChatHistory } from '@mioagent/api-client-react';
import { isMainnetReadonly } from '../../lib/chain';
import { AlertTriangle } from 'lucide-react';

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="text-[11px] font-sans font-semibold uppercase tracking-[0.08em] text-ink-3">
        {title}
      </span>
      {count !== undefined && (
        <span className="bg-panel-2 px-2 py-0.5 rounded-full text-[10px] font-sans text-ink-2">
          {count}
        </span>
      )}
    </div>
  );
}

function RiskRail({ risk }: { risk: string }) {
  const color =
    risk === 'critical' || risk === 'high'
      ? 'bg-risk'
      : risk === 'medium'
      ? 'bg-warn'
      : 'bg-ok';
  return <div className={`w-[3px] self-stretch rounded-full shrink-0 ${color}`} />;
}

export function RiskQueue() {
  const { data: actionsData } = useActionsFeed();
  const { data: chatData } = useChatHistory();

  const allActions = actionsData?.actions || [];
  const pendingActions = allActions.filter((a: any) => a.status === 'pending');

  const messages = chatData?.messages || [];
  const recentToolCalls: any[] = [];
  for (let i = messages.length - 1; i >= 0 && recentToolCalls.length < 5; i--) {
    const msg = messages[i] as any;
    if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
      recentToolCalls.push(...msg.toolCalls);
    }
  }

  return (
    /* Desktop: fixed right sidebar. Mobile: inline section below main content (rendered by CockpitRoute) */
    <aside className="w-[300px] min-w-[300px] shrink-0 border-l border-line bg-panel-2 p-4 flex flex-col gap-4 overflow-y-auto select-none hidden lg:flex">
      <RiskQueueContent pendingActions={pendingActions} recentToolCalls={recentToolCalls} />
    </aside>
  );
}

// Separate exportable content so CockpitRoute can render it on mobile
export function RiskQueueContent({
  pendingActions,
  recentToolCalls,
}: {
  pendingActions: any[];
  recentToolCalls: any[];
}) {
  return (
    <>
      {/* Pending Actions Summary */}
      <div>
        <SectionHeader title="Risk Queue" count={pendingActions.length} />
        {pendingActions.length === 0 ? (
          <div className="bg-panel border border-line rounded-[var(--radius-md)] p-4 text-center flex flex-col items-center justify-center gap-2 shadow-[var(--shadow-card)]">
            <AlertTriangle size={20} className="text-ink-3" />
            <div className="text-xs font-sans font-medium text-ink-2">No autonomous queue yet</div>
            <div className="text-[10px] text-ink-3 font-sans leading-relaxed max-w-[200px]">
              When scanners or AI recommendations propose execution, actions appear here for screening.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-h-[380px] overflow-y-auto pr-1">
            {pendingActions.map((action: any) => {
              const risk = action.metadata?.riskLevel || 'low';
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
                  className="flex gap-2.5 bg-panel border border-line rounded-[var(--radius-md)] p-2.5 hover:border-accent/40 hover:-translate-y-px transition-all duration-150 shadow-[var(--shadow-card)]"
                >
                  <RiskRail risk={risk} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className={`text-[10px] font-sans font-medium px-2 py-0.5 rounded-full ${
                        risk === 'critical' || risk === 'high'
                          ? 'bg-risk-soft text-risk'
                          : risk === 'medium'
                          ? 'bg-warn-soft text-warn'
                          : 'bg-ok-soft text-ok'
                      }`}>
                        {risk} risk
                      </span>
                      <span className="text-[9px] text-ink-3 font-sans">
                        {isMainnetReadonly ? 'read-only' : 'blocked'}
                      </span>
                    </div>
                    <div className="font-sans font-semibold text-ink text-xs truncate mb-1">{title}</div>
                    <div className="flex items-center justify-between text-[10px] text-ink-3 font-sans">
                      <span>by: {createdBy}</span>
                      <span className="text-accent-2">review →</span>
                    </div>
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
          <div className="bg-panel border border-line rounded-[var(--radius-md)] p-3 text-center text-ink-3 font-sans text-[11px] italic shadow-[var(--shadow-card)]">
            No tool execution traces in memory.
          </div>
        ) : (
          <div className="bg-panel border border-line rounded-[var(--radius-md)] p-2.5 flex flex-col gap-2 max-h-[220px] overflow-y-auto shadow-[var(--shadow-card)]">
            {recentToolCalls.slice(0, 4).map((tc: any, idx: number) => (
              <div key={idx} className="flex flex-col gap-0.5 border-b border-line/50 pb-1.5 last:border-0 last:pb-0">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-sans font-semibold text-ink truncate max-w-[160px]">{tc.toolName || tc.name || 'tool_call'}</span>
                  <span className={tc.isError ? 'text-risk font-bold text-[10px] font-sans' : 'text-ok font-bold text-[10px] font-sans'}>
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

      {/* Navigation shortcuts */}
      <div className="mt-auto pt-2 flex flex-col gap-1.5 font-sans">
        <Link href="/actions" className="block text-center bg-accent-soft hover:bg-accent/20 text-accent-2 border border-accent/30 rounded-[var(--radius-md)] py-2 text-xs font-semibold transition-colors">
          Open Full Action Inbox →
        </Link>
        <Link href="/stream" className="block text-center bg-panel hover:bg-panel-2 text-ink-2 border border-line rounded-[var(--radius-md)] py-2 text-xs font-semibold transition-colors">
          Open Agent Stream / Chat →
        </Link>
      </div>
    </>
  );
}
