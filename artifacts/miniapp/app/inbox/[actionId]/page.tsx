"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useActionsFeed } from "@mioagent/api-client-react";
import { Card, StateBadge } from "@mioagent/ui";

// Deep-link target: /inbox/:actionId. Opens a specific action (e.g. from a
// scanner notification). Shares the data layer with the web interface.

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

function RiskRail({ risk }: { risk?: string }) {
  const colour =
    risk === "critical" || risk === "high"
      ? "bg-risk"
      : risk === "medium"
      ? "bg-warn"
      : "bg-ok";
  return <div className={`w-[3px] self-stretch rounded-full shrink-0 ${colour}`} />;
}

export default function ActionDeepLink() {
  const params = useParams<{ actionId: string }>();
  const actionId = params.actionId;
  const { data, isLoading } = useActionsFeed();
  const action = (data?.actions || []).find((a) => a.id === actionId);

  const risk = (action?.metadata?.riskLevel as string | undefined) || "low";
  const riskVariant: "risk" | "warn" | "ok" =
    risk === "critical" || risk === "high"
      ? "risk"
      : risk === "medium"
      ? "warn"
      : "ok";

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      {/* Minimal back header */}
      <header
        className="sticky top-0 z-40 flex items-center gap-3 px-4 border-b border-line"
        style={{
          height: "56px",
          background: "rgba(14,18,38,0.75)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <Link
          href="/"
          className="text-ink-3 hover:text-ink text-[13px] transition-colors"
          aria-label="Back"
        >
          ‹ Back
        </Link>
        <span
          className="text-[13px] font-medium text-ink-3"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {actionId?.slice(0, 10)}…
        </span>
      </header>

      <main className="flex-1 w-full max-w-[480px] mx-auto px-4 py-4 flex flex-col gap-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {isLoading ? (
          <Card
            className="p-6 text-center"
            style={{ borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-card)" }}
          >
            <p className="text-sm text-ink-3">Loading…</p>
          </Card>
        ) : !action ? (
          <Card
            className="p-6 text-center"
            style={{ borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-card)" }}
          >
            <p className="text-2xl mb-2" aria-hidden="true">□</p>
            <p className="text-sm text-ink-2">Action not found.</p>
            <p className="text-[11px] text-ink-3 mt-1">It may have already been executed or expired.</p>
          </Card>
        ) : (
          <Card
            className="p-4"
            style={{ borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-card)" }}
          >
            {/* Title row with risk rail */}
            <div className="flex gap-3 mb-4">
              <RiskRail risk={risk} />
              <div className="flex-1 min-w-0">
                <div
                  className="text-[17px] font-semibold text-ink mb-1"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {action.kind.toUpperCase()}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <PillBadge label={risk} variant={riskVariant} />
                  <StateBadge
                    state={
                      action.status === "executed"
                        ? "live"
                        : action.status === "failed"
                        ? "failed"
                        : "stale"
                    }
                    label={action.status}
                  />
                </div>
              </div>
            </div>

            {/* Suggested prompt */}
            <div className="bg-panel-2 rounded-[var(--radius-md)] p-3 mb-3">
              <div className="text-[11px] text-ink-3 mb-1">Proposed action</div>
              <p className="text-[13px] text-ink-2 leading-relaxed">{action.suggestedPrompt}</p>
            </div>

            {/* Safety note */}
            <p
              className="text-[11px] text-ink-3"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {action.metadata?.safetyState === "blocked"
                ? "Execution blocked — read-only mode active."
                : "Review in Action Inbox before approving."}
            </p>
          </Card>
        )}
      </main>
    </div>
  );
}
