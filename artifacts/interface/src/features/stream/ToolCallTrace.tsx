// F2 parity render of m.toolCalls. The backend chat route currently drops
// tool_call/tool_result events, so this is never populated in practice. F5
// (T12.5) expands it into expandable traces with an honest "no tool traces"
// empty state once the backend forwards tool events.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ToolCallTrace({ toolCalls }: { toolCalls?: any[] }) {
  if (!toolCalls || toolCalls.length === 0) return null;
  return (
    <div className="w-full bg-panel border border-line rounded-xl p-3 space-y-2 text-xs font-mono shadow-sm">
      {toolCalls.map((tc: any, idx: number) => (
        <div key={idx} className="flex items-center gap-2 text-ink-2">
          <span className="text-ok font-bold">✓</span>
          <span className="font-semibold text-ink">{tc.name}</span>
          <span className="text-ink-3 truncate">{JSON.stringify(tc.arguments)}</span>
        </div>
      ))}
    </div>
  );
}
