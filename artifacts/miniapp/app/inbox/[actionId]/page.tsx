"use client";
import { useParams } from "next/navigation";
import { useActionsFeed } from "@mioagent/api-client-react";
import { Card, StateBadge } from "@mioagent/ui";

// Deep-link target: /inbox/:actionId. Opens a specific action (e.g. from a
// scanner notification). Shares the data layer with the web interface.
export default function ActionDeepLink() {
  const params = useParams<{ actionId: string }>();
  const actionId = params.actionId;
  const { data, isLoading } = useActionsFeed();
  const action = (data?.actions || []).find((a) => a.id === actionId);

  return (
    <main className="min-h-screen bg-bg text-ink p-3 flex flex-col gap-3">
      <div className="text-[11px] font-mono uppercase tracking-wider text-ink-3">
        Action · {actionId?.slice(0, 10)}
      </div>
      {isLoading ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : !action ? (
        <Card className="p-4">
          <p className="text-sm text-ink-2">Action not found.</p>
        </Card>
      ) : (
        <Card className="p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold uppercase text-ink text-sm">{action.kind}</span>
            <StateBadge
              state={action.status === "executed" ? "live" : action.status === "failed" ? "failed" : "stale"}
              label={action.status}
            />
          </div>
          <p className="text-xs text-ink-2 mb-2">{action.suggestedPrompt}</p>
          <p className="text-[11px] font-mono text-ink-3">
            {action.metadata?.safetyState === "blocked" ? "Execution blocked (read-only)" : "See Action Inbox"}
          </p>
        </Card>
      )}
    </main>
  );
}
