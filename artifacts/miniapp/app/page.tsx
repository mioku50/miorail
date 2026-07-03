"use client";
import { useRef, useState } from "react";
import { useStatus, useActionsFeed, useChatHistory, useSendMessage } from "@mioagent/api-client-react";
import { Card, StateBadge, Button } from "@mioagent/ui";
import { WalletConnect } from "./components/WalletConnect";

// Reduced mobile IA: Autonomy status + kill, Action Inbox, Agent Stream.
// Shares the data layer (@mioagent/api-client-react) and UI (@mioagent/ui) with
// the web interface — no logic fork. Honest states only; no fixtures. Standard
// web app (no MiniKit): wallet context comes from the WagmiProvider + Base
// Account connector; no signing/execution from this UI (no-custody).
export default function Home() {
  const { data: statusData } = useStatus();
  const { data: actionsData } = useActionsFeed();
  const { data: chatData } = useChatHistory();
  const sendMessage = useSendMessage();
  const [input, setInput] = useState("");
  const [killMsg, setKillMsg] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  const messages = chatData?.messages || [];
  const actions = (actionsData?.actions || []).filter((a) => a.status === "pending").slice(0, 5);
  const chainEnv = statusData?.chainEnv || "mainnet-readonly";
  const readOnly = statusData?.execution?.mode === "read-only" || chainEnv === "mainnet-readonly";

  const send = (text: string) => {
    if (!text.trim() || sendMessage.isPending) return;
    setInput("");
    sendMessage.mutate({ message: text, chainEnv });
  };

  return (
    <main className="min-h-screen bg-bg text-ink flex flex-col gap-3 p-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-bold">
          <span className="w-6 h-6 rounded-md bg-accent text-white flex items-center justify-center text-xs font-bold">M</span>
          MioAgent
        </div>
        <div className="flex items-center gap-2">
          <WalletConnect />
          <StateBadge state={readOnly ? "disabled" : "live"} label={chainEnv} />
        </div>
      </header>

      <Card className="p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-ink-3">Autonomy</span>
          <StateBadge state="missing" label="off" />
        </div>
        <p className="text-xs text-ink-2 mb-2">No session key active — the agent waits for manual confirmation.</p>
        <Button variant="risk" size="sm" className="w-full" onClick={() => setKillMsg(true)}>
          ⏻ Kill switch
        </Button>
        {killMsg && <p className="text-[10px] text-ink-3 mt-1">No active session key to revoke.</p>}
      </Card>

      <Card className="p-3">
        <div className="text-[11px] font-mono uppercase tracking-wider text-ink-3 mb-2">Action Inbox ({actions.length})</div>
        {actions.length === 0 ? (
          <p className="text-xs text-ink-3 italic">No pending actions.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {actions.map((a) => (
              <div key={a.id} className="border border-line rounded-md p-2 text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold uppercase text-ink">{a.kind}</span>
                  <span className="font-mono text-[10px] text-ink-3">
                    {a.metadata?.safetyState === "blocked" ? "blocked" : a.status}
                  </span>
                </div>
                <p className="text-ink-2">{a.suggestedPrompt}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-3 flex-1 flex flex-col">
        <div className="text-[11px] font-mono uppercase tracking-wider text-ink-3 mb-2">Agent Stream</div>
        <div ref={streamRef} className="flex-1 flex flex-col gap-2 overflow-y-auto min-h-[160px] mb-2">
          {messages.length === 0 ? (
            <p className="text-xs text-ink-3 italic">Ask MioAgent about your Base wallet.</p>
          ) : (
            messages.slice(-8).map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : ""}>
                <span
                  className={`inline-block rounded-md px-2 py-1 text-xs ${
                    m.role === "user" ? "bg-accent text-white" : "bg-panel-2 text-ink"
                  }`}
                >
                  {m.content}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send(input);
            }}
            placeholder="Ask MioAgent…"
            className="flex-1 bg-panel-2 border border-line rounded-md px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent"
          />
          <Button size="sm" onClick={() => send(input)} disabled={!input.trim() || sendMessage.isPending}>
            {sendMessage.isPending ? "…" : "Send"}
          </Button>
        </div>
      </Card>
    </main>
  );
}
