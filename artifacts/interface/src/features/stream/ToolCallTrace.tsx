import { useState } from 'react';

// Expandable tool-call traces. The backend chat route currently drops
// tool_call / tool_result events, so this is empty in practice — it renders an
// honest "no tool traces recorded" state rather than fabricating calls. When the
// backend forwards tool events, each trace shows name / args / result / isError.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ToolCallTrace({ toolCalls }: { toolCalls?: any[] }) {
  const [open, setOpen] = useState(false);
  const hasTraces = !!toolCalls && toolCalls.length > 0;

  return (
    <div className="w-full bg-panel border border-line rounded-xl text-xs font-mono shadow-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-ink-2 hover:bg-bg/50 transition-colors"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5">
          <span className="text-ink-3">⟐</span> Tool traces{hasTraces ? ` (${toolCalls!.length})` : ''}
        </span>
        <span className="text-ink-3">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-line space-y-1.5">
          {hasTraces ? (
            toolCalls!.map((tc: any, idx: number) => (
              <div key={idx} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className={tc.isError ? 'text-risk font-bold' : 'text-ok font-bold'}>{tc.isError ? '✕' : '✓'}</span>
                  <span className="font-semibold text-ink">{tc.toolName || tc.name}</span>
                </div>
                {tc.args || tc.arguments ? <div className="text-ink-3 break-all">args: {JSON.stringify(tc.args || tc.arguments)}</div> : null}
                {tc.result !== undefined ? (
                  <div className="text-ink-3 break-all">result: {typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result)}</div>
                ) : null}
              </div>
            ))
          ) : (
            <div className="text-ink-3 italic">
              No tool traces recorded — the backend chat route drops tool_call / tool_result events today.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
