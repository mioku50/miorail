interface AgentComposerProps {
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  isPending: boolean;
  errorMsg: string | null;
  onClearError: () => void;
}

export function AgentComposer({ input, setInput, onSend, isPending, errorMsg, onClearError }: AgentComposerProps) {
  return (
    <div className="p-3 border-t border-line bg-panel shrink-0 flex flex-col gap-2 shadow-sm">
      {errorMsg && (
        <div className="text-xs text-risk bg-risk-soft px-3 py-1.5 rounded-lg flex items-center justify-between">
          <span className="truncate">⚠️ {errorMsg}</span>
          <button onClick={onClearError} className="font-bold ml-2 hover:opacity-80">×</button>
        </div>
      )}
      <div className="relative flex items-end gap-2 bg-panel-2 border border-line rounded-xl p-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10 transition-all shadow-inner">
        <textarea
          id="agent-stream-input"
          rows={2}
          placeholder="Ask MioAgent to review your Base portfolio, flag risky tokens, or create a read-only recommendation..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={isPending}
          className="w-full bg-transparent border-0 resize-none text-[13px] text-ink placeholder:text-ink-3 focus:outline-none max-h-32 min-h-[44px] py-1 leading-relaxed"
          aria-label="Agent Stream Instruction Input"
        />
        <button
          onClick={onSend}
          disabled={!input.trim() || isPending}
          className={`shrink-0 h-9 px-3.5 rounded-lg font-semibold text-xs flex items-center justify-center gap-1.5 transition-all shadow-sm ${
            !input.trim() || isPending ? 'bg-line text-ink-3 cursor-not-allowed' : 'bg-accent text-white hover:bg-accent-2 cursor-pointer active:scale-[0.98]'
          }`}
          aria-label="Send message"
        >
          {isPending ? (
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span>Sending...</span>
            </span>
          ) : (
            <>
              <span>Send</span>
              <span>↑</span>
            </>
          )}
        </button>
      </div>
      <div className="text-[11px] text-ink-3 flex items-center gap-1.5 px-1 font-medium">
        <span className="text-ok shrink-0">🛡️</span>
        <span className="leading-snug">Read-only mode: MioAgent can create recommendations, but cannot execute mainnet transactions.</span>
      </div>
    </div>
  );
}
