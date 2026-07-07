import { isProductionActionType } from "@mioagent/api-client-react";

type MiniAction = {
  status?: string;
  txHash?: string | null;
  batchId?: string | null;
  receipts?: unknown[] | null;
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

function getProof(action?: MiniAction | null): Record<string, unknown> | null {
  const metadata = action?.metadata || {};
  const proof = metadata.executionProof;
  if (proof && typeof proof === "object") return proof as Record<string, unknown>;
  const confirmation = metadata.confirmation;
  if (!confirmation || typeof confirmation !== "object") return null;
  const c = confirmation as Record<string, unknown>;
  return {
    type: "wallet_confirmation_receipt",
    txHash: c.txHash || action?.txHash || metadata.txHash || metadata.transactionHash,
    batchId: c.batchId || action?.batchId || metadata.batchId || metadata.callBatchId,
    receipts: c.receipts || action?.receipts || metadata.receipts,
    statusCode: c.statusCode,
    confirmedAt: c.confirmedAt,
    allowanceAfter: c.allowanceAfter || metadata.allowanceAfter,
    source: "metadata.confirmation",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function receiptTxHash(receipts: unknown): string | undefined {
  if (!Array.isArray(receipts)) return undefined;
  return receipts
    .map((receipt) => {
      if (!receipt || typeof receipt !== "object") return undefined;
      const r = receipt as Record<string, unknown>;
      return stringValue(r.transactionHash) || stringValue(r.txHash) || stringValue(r.hash);
    })
    .find(Boolean);
}

export function shortHash(value?: string | null, head = 10, tail = 6): string | null {
  if (!value) return null;
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function getRevokeExecutionNotice(action?: MiniAction | null): {
  title: string;
  txHash?: string;
  txHashUrl?: string;
  batchId?: string;
  shortBatchId?: string | null;
  stateOnlyLabel?: string;
} | null {
  if (!action || action.status !== "executed") return null;
  const metadata = action.metadata || {};
  const actionType = stringValue(metadata.actionType) || action.executionPayload?.actionType;
  if (actionType !== "revoke_approval") return null;
  const proof = getProof(action);
  const allowanceAfter = String(proof?.allowanceAfter ?? metadata.allowanceAfter ?? "");
  if (allowanceAfter !== "0") return null;

  const txHash =
    stringValue(proof?.txHash) ||
    stringValue(action.txHash) ||
    stringValue(metadata.txHash) ||
    stringValue(metadata.transactionHash) ||
    receiptTxHash(proof?.receipts || action.receipts || metadata.receipts);
  const batchId =
    stringValue(proof?.batchId) ||
    stringValue(action.batchId) ||
    stringValue(metadata.batchId) ||
    stringValue(metadata.callBatchId);

  return {
    title: "Revocation effective — allowance is now 0",
    ...(txHash ? { txHash, txHashUrl: `https://basescan.org/tx/${txHash}` } : {}),
    ...(batchId ? { batchId, shortBatchId: shortHash(batchId, 12, 8) } : {}),
    ...(!txHash ? { stateOnlyLabel: "State proof only — transaction hash was not captured" } : {}),
  };
}
