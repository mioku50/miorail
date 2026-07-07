import { isProductionActionType } from "@mioagent/api-client-react";

type MiniAction = {
  status?: string;
  executionPayload?: {
    actionType?: string;
    calls?: unknown[];
  } | null;
  metadata?: Record<string, unknown> | null;
};

export function getRiskVariant(risk?: string): "risk" | "warn" | "ok" {
  if (risk === "critical" || risk === "high") return "risk";
  if (risk === "medium") return "warn";
  return "ok";
}

export function getStatusState(status?: string): "live" | "failed" | "stale" {
  if (status === "executed") return "live";
  if (status === "failed") return "failed";
  return "stale";
}

export function shouldShowConfirmButton(action?: MiniAction | null): boolean {
  if (!action || action.status !== "pending") return false;
  const calls = action.executionPayload?.calls || [];
  return calls.length > 0 && isProductionActionType(action.executionPayload?.actionType);
}

export function getPreflightBadge() {
  return {
    label: "Preflight validation — no fork simulation",
    title: "No fork simulation; only chain, call-structure, screening, canonical-token checks, and deterministic calldata projections.",
  };
}
