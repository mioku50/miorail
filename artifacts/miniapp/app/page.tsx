"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useStatus, useActionsFeed, useChatHistory, useSendMessage } from "@mioagent/api-client-react";
import { Card, StateBadge, Button } from "@mioagent/ui";
import { WalletConnect } from "./components/WalletConnect";

// Reduced mobile IA: Autonomy status + kill, Action Inbox, Agent Stream.
// Shares the data layer (@mioagent/api-client-react) and UI (@mioagent/ui) with
// the web interface — no logic fork. Honest states only; no fixtures. Standard
// web app (no MiniKit): wallet context comes from the WagmiProvider + Base
// Account connector; no signing/execution from this UI (no-custody).

/** Miorail "M" mark — inline SVG, matches lib/ui/src/assets/miorail-mark.svg */
function MiorailMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
    >
      <path d="M 10 50 L 10 14" stroke="#4650F0" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M 10 14 L 32 36" stroke="#4650F0" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M 32 36 L 54 14" stroke="#4650F0" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M 54 14 L 54 50" stroke="#4650F0" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="10" y1="22" x2="2"  y2="18" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round" />
      <line x1="10" y1="30" x2="1"  y2="30" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round" />
      <line x1="10" y1="38" x2="2"  y2="42" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round" />
      <line x1="54" y1="22" x2="62" y2="18" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round" />
      <line x1="54" y1="30" x2="63" y2="30" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round" />
      <line x1="54" y1="38" x2="62" y2="42" stroke="#F06BDB" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Section header — font-display, icon slot */
function SectionTitle({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-3">
      <span className="text-ink-3 text-[13px] leading-none">{icon}</span>
      <span
        className="text-[15px] font-semibold text-ink leading-none"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {label}
      </span>
    </div>
  );
}

/** Risk rail — 3px left border coloured by risk level */
function RiskRail({ risk }: { risk?: string }) {
  const colour =
    risk === "critical" || risk === "high"
      ? "bg-risk"
      : risk === "medium"
      ? "bg-warn"
      : "bg-ok";
  return <div className={`w-[3px] self-stretch rounded-full shrink-0 ${colour}`} />;
}

/** Pill badge — 12% tint for risk/mode labels */
function PillBadge({ label, variant }: { label: string; variant?: "risk" | "warn" | "ok" | "accent" }) {
  const colour =
    variant === "risk"
      ? "bg-risk-soft text-risk"
      : variant === "warn"
      ? "bg-warn-soft text-warn"
      : variant === "ok"
      ? "bg-ok-soft text-ok"
      : "bg-accent-soft text-accent-2";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${colour}`}>
      {label}
    </span>
  );
}

/** Glow dot — live indicator */
function GlowDot({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${active ? "bg-ok shadow-[0_0_6px_2px_rgba(61,220,151,0.5)]" : "bg-ink-3"}`}
    />
  );
}

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
  // T19.1: derive from the explicit broadcast flag, NOT a generic `enabled`.
  // Autonomy = server-side broadcast capability, which is false in production
  // (mainnet-readonly). The user-confirmed Base Account flow is separate.
  const serverBroadcastEnabled = statusData?.execution?.serverBroadcastEnabled === true;
  const readOnly = !serverBroadcastEnabled;
  const autonomyActive = serverBroadcastEnabled;
  const executionMode = statusData?.execution?.mode ?? "—";

  const send = (text: string) => {
    if (!text.trim() || sendMessage.isPending) return;
    setInput("");
    sendMessage.mutate({ message: text, chainEnv });
  };

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      {/* ── Glass header ── sticky, 56px, backdrop-blur */}
      <header
        className="sticky top-0 z-40 flex items-center justify-between px-4 border-b border-line"
        style={{
          height: "56px",
          background: "rgba(14,18,38,0.75)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div
          className="flex items-center gap-2 font-bold text-[17px] text-ink leading-none"
          style={{ fontFamily: "var(--font-display)" }}
        >
          <MiorailMark size={28} />
          Miorail
        </div>
        <div className="flex items-center gap-2">
          <WalletConnect />
          <StateBadge state={readOnly ? "disabled" : "live"} label={chainEnv} />
        </div>
      </header>

      {/* ── Page body ── */}
      <main className="flex-1 w-full max-w-[480px] mx-auto px-4 py-4 flex flex-col gap-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">

        {/* ── Autonomy card ── */}
        <Card
          className="p-4"
          style={{ borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-card)" }}
        >
          <SectionTitle icon="⚡" label="Autonomy" />

          {/* Kill-switch pill toggle + glow status */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <GlowDot active={autonomyActive} />
              <span className="text-sm text-ink-2">
                {autonomyActive ? "Session active" : "No session key"}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setKillMsg(true)}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[13px] font-semibold bg-risk text-white hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              <span aria-hidden="true">⏻</span>
              Kill
            </button>
          </div>
          {killMsg && (
            <p className="text-[11px] text-ink-3 mt-1 mb-3">No active session key to revoke.</p>
          )}

          {/* Limits grid 2×2 */}
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Chain", value: chainEnv },
              { label: "Mode", value: executionMode },
              { label: "Server broadcast", value: serverBroadcastEnabled ? "yes" : "no" },
              { label: "User-confirmed", value: statusData?.execution?.userConfirmedEnabled ? "yes" : "no" },
            ].map(({ label, value }) => (
              <div key={label} className="bg-panel-2 rounded-[var(--radius-sm)] px-3 py-2">
                <div className="text-[11px] text-ink-3 mb-0.5">{label}</div>
                <div
                  className="text-[13px] text-ink font-medium"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {String(value)}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* ── Action Inbox ── */}
        <Card
          className="p-4"
          style={{ borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-card)" }}
        >
          <SectionTitle icon="📥" label={`Action Inbox (${actions.length})`} />
          {actions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 py-6 text-center">
              <span className="text-2xl" aria-hidden="true">□</span>
              <p className="text-sm text-ink-2">No pending actions</p>
              <p className="text-[11px] text-ink-3">When the agent proposes actions they appear here.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {actions.map((a) => {
                const risk = (a.metadata?.riskLevel as string | undefined) || "low";
                const riskVariant: "risk" | "warn" | "ok" =
                  risk === "critical" || risk === "high"
                    ? "risk"
                    : risk === "medium"
                    ? "warn"
                    : "ok";
                const mode = a.metadata?.safetyState === "blocked" ? "blocked" : a.status;
                return (
                  <Link
                    key={a.id}
                    href={`/actions/${a.id}`}
                    className="flex gap-2.5 bg-panel border border-line rounded-[var(--radius-md)] p-3 hover:border-accent/40 transition-colors"
                    style={{ textDecoration: "none" }}
                  >
                    <RiskRail risk={risk} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                        <PillBadge label={risk} variant={riskVariant} />
                        <PillBadge label={mode} variant="accent" />
                      </div>
                      <p
                        className="text-[13px] font-medium text-ink truncate"
                      >
                        {a.kind.toUpperCase()}
                      </p>
                      <p className="text-[11px] text-ink-2 line-clamp-2 mt-0.5">{a.suggestedPrompt}</p>
                    </div>
                    <span className="text-ink-3 text-xs self-center">›</span>
                  </Link>
                );
              })}
            </div>
          )}
        </Card>

        {/* ── Agent Stream ── */}
        <Card
          className="p-4 flex-1 flex flex-col"
          style={{ borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-card)" }}
        >
          <SectionTitle icon="💬" label="Agent Stream" />

          {/* Chat bubbles */}
          <div
            ref={streamRef}
            className="flex-1 flex flex-col gap-2 overflow-y-auto min-h-[160px] mb-3 pr-1"
          >
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1.5 py-8 text-center">
                <span className="text-2xl" aria-hidden="true">○</span>
                <p className="text-sm text-ink-2">No messages yet</p>
                <p className="text-[11px] text-ink-3">Ask Miorail about your Base wallet.</p>
              </div>
            ) : (
              messages.slice(-8).map((m, i) => (
                <div
                  key={i}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <span
                    className={`inline-block rounded-xl px-3 py-2 text-[13px] leading-snug max-w-[85%] ${
                      m.role === "user"
                        ? "bg-accent-soft text-ink border border-accent/30"
                        : "bg-panel-2 text-ink"
                    }`}
                  >
                    {m.content}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Input row — pill input + primary Send button */}
          <div className="flex gap-2 items-center">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send(input);
              }}
              placeholder="Ask Miorail…"
              className="flex-1 bg-panel-2 border border-line rounded-full px-4 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
            />
            <Button
              size="sm"
              onClick={() => send(input)}
              disabled={!input.trim() || sendMessage.isPending}
              className="rounded-full px-4"
            >
              {sendMessage.isPending ? "…" : "Send"}
            </Button>
          </div>
        </Card>
      </main>
    </div>
  );
}
