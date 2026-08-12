import type { ToolAggregator, ToolDef } from '@mioagent/tools';
import {
  sanitizeStreamToolArgs,
  sanitizedToolErrorCode,
  type StreamToolTrace,
} from './streamReadRouting.js';

export type BaseMcpApprovalState =
  | 'approval_required'
  | 'pending'
  | 'completed'
  | 'rejected'
  | 'failed';

export interface BaseMcpApprovalSnapshot {
  approvalUrl?: string;
  requestId?: string;
  state?: BaseMcpApprovalState;
  proof?: BaseMcpDurableProof;
}

export interface BaseMcpDurableProof {
  txHash?: string;
  batchId?: string;
  receiptId?: string;
}

export interface BaseMcpApprovalOutcome extends BaseMcpApprovalSnapshot {
  state: BaseMcpApprovalState;
  toolCalls: StreamToolTrace[];
  errorCode?: string;
}

const URL_KEYS = new Set([
  'approvalurl', 'approval_url', 'approvallink', 'approval_link',
  'confirmationurl', 'confirmation_url', 'url', 'link',
]);
const REQUEST_ID_KEYS = new Set(['requestid', 'request_id', 'transactionid', 'transaction_id', 'id']);
const STATUS_KEYS = new Set(['status', 'state', 'requeststatus', 'request_status']);
const TX_HASH_KEYS = new Set(['txhash', 'tx_hash', 'transactionhash', 'transaction_hash']);
const BATCH_ID_KEYS = new Set(['batchid', 'batch_id']);
const RECEIPT_ID_KEYS = new Set(['receiptid', 'receipt_id']);

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4_096) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = [...String(value)]
    .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
    .join('')
    .trim();
  return normalized && normalized.length <= 200 ? normalized : undefined;
}

function safeTxHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value) ? value : undefined;
}

function mergeProof(current?: BaseMcpDurableProof, next?: BaseMcpDurableProof): BaseMcpDurableProof | undefined {
  const merged = {
    ...(current || {}),
    ...(next || {}),
  };
  return hasBaseMcpDurableProof(merged) ? merged : undefined;
}

export function hasBaseMcpDurableProof(proof?: BaseMcpDurableProof): boolean {
  return Boolean(proof?.txHash || proof?.batchId || proof?.receiptId);
}

export function normalizeBaseMcpApprovalState(value: unknown): BaseMcpApprovalState | undefined {
  if (typeof value !== 'string') return undefined;
  const status = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['approval_required', 'requires_approval', 'needs_approval', 'awaiting_approval'].includes(status)) return 'approval_required';
  if (['pending', 'submitted', 'processing', 'in_progress', 'queued'].includes(status)) return 'pending';
  // Base MCP returns `signed` after the Base Account approval is available.
  // For x402 this is the terminal approval state that unlocks the separate
  // complete_x402_request replay; leaving it as unknown strands paid requests.
  if (['completed', 'confirmed', 'success', 'succeeded', 'settled', 'signed'].includes(status)) return 'completed';
  if (['rejected', 'declined', 'cancelled', 'canceled'].includes(status)) return 'rejected';
  if (['failed', 'error', 'errored', 'expired'].includes(status)) return 'failed';
  return undefined;
}

export function extractBaseMcpApprovalSnapshot(value: unknown, depth = 0): BaseMcpApprovalSnapshot {
  if (depth > 10 || value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try {
      return extractBaseMcpApprovalSnapshot(JSON.parse(value), depth + 1);
    } catch {
      return {};
    }
  }
  if (Array.isArray(value)) {
    return value.reduce<BaseMcpApprovalSnapshot>(
      (current, item) => mergeBaseMcpApprovalSnapshots(current, extractBaseMcpApprovalSnapshot(item, depth + 1)),
      {},
    );
  }
  if (typeof value !== 'object') return {};

  let snapshot: BaseMcpApprovalSnapshot = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[\s-]+/g, '_');
    if (!snapshot.approvalUrl && URL_KEYS.has(normalizedKey)) snapshot.approvalUrl = safeHttpsUrl(item);
    if (!snapshot.requestId && REQUEST_ID_KEYS.has(normalizedKey)) snapshot.requestId = safeRequestId(item);
    if (!snapshot.state && STATUS_KEYS.has(normalizedKey)) snapshot.state = normalizeBaseMcpApprovalState(item);
    const proof: BaseMcpDurableProof = {};
    if (TX_HASH_KEYS.has(normalizedKey)) proof.txHash = safeTxHash(item);
    if (BATCH_ID_KEYS.has(normalizedKey)) proof.batchId = safeRequestId(item);
    if (RECEIPT_ID_KEYS.has(normalizedKey)) proof.receiptId = safeRequestId(item);
    snapshot.proof = mergeProof(snapshot.proof, proof);
    snapshot = mergeBaseMcpApprovalSnapshots(snapshot, extractBaseMcpApprovalSnapshot(item, depth + 1));
  }
  return snapshot;
}

export function mergeBaseMcpApprovalSnapshots(
  current: BaseMcpApprovalSnapshot,
  next: BaseMcpApprovalSnapshot,
): BaseMcpApprovalSnapshot {
  return {
    approvalUrl: next.approvalUrl || current.approvalUrl,
    requestId: next.requestId || current.requestId,
    state: next.state || current.state,
    proof: mergeProof(current.proof, next.proof),
  };
}

export interface SanitizedResponseShape {
  type: string;
  keys?: string[];
  children?: Record<string, SanitizedResponseShape>;
}

export function sanitizedBaseMcpResponseShape(value: unknown, depth = 0): SanitizedResponseShape {
  if (depth > 5) return { type: 'truncated' };
  if (typeof value === 'string') {
    if (value.length <= 100_000) {
      try {
        return sanitizedBaseMcpResponseShape(JSON.parse(value), depth + 1);
      } catch {
        // Only the scalar type is exposed; never log the string value.
      }
    }
    return { type: 'string' };
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      ...(value.length > 0 ? { children: { item: sanitizedBaseMcpResponseShape(value[0], depth + 1) } } : {}),
    };
  }
  if (!value || typeof value !== 'object') return { type: value === null ? 'null' : typeof value };
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 50);
  return {
    type: 'object',
    keys: entries.map(([key]) => key.slice(0, 120)),
    children: Object.fromEntries(entries.map(([key, item]) => [key.slice(0, 120), sanitizedBaseMcpResponseShape(item, depth + 1)])),
  };
}

function requestStatusTool(inventory: Array<{ providerId: string; tools: ToolDef[] }>): ToolDef | undefined {
  return inventory
    .filter((entry) => entry.providerId.startsWith('base-mcp'))
    .flatMap((entry) => entry.tools)
    .find((tool) => /^(?:get_request_status|getrequeststatus|request_status)$/i.test(tool.name));
}

function statusArgs(tool: ToolDef, requestId: string): Record<string, unknown> {
  const properties = (tool.inputSchema?.properties || {}) as Record<string, unknown>;
  const key = ['requestId', 'request_id', 'id'].find((candidate) => Object.prototype.hasOwnProperty.call(properties, candidate));
  return { [key || 'requestId']: requestId };
}

function boundedPollAttempts(): number {
  const configured = Number(process.env.BASE_MCP_STATUS_POLL_ATTEMPTS || 3);
  return Number.isFinite(configured) ? Math.max(1, Math.min(5, Math.floor(configured))) : 3;
}

function boundedPollIntervalMs(): number {
  const configured = Number(process.env.BASE_MCP_STATUS_POLL_INTERVAL_MS || 150);
  return Number.isFinite(configured) ? Math.max(0, Math.min(1_000, Math.floor(configured))) : 150;
}

export const baseMcpApprovalRuntime = {
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export async function resolveBaseMcpApprovalLifecycle(input: {
  initialResult: unknown;
  tools: ToolAggregator;
  pollAttempts?: number;
}): Promise<BaseMcpApprovalOutcome> {
  let snapshot = extractBaseMcpApprovalSnapshot(input.initialResult);
  const toolCalls: StreamToolTrace[] = [];
  let errorCode: string | undefined;

  if (snapshot.requestId && !['completed', 'rejected', 'failed'].includes(snapshot.state || '')) {
    const requestId = snapshot.requestId;
    const inventory = await input.tools.listProviderTools();
    const tool = requestStatusTool(inventory);
    if (tool) {
      const attempts = input.pollAttempts === undefined
        ? boundedPollAttempts()
        : Math.max(1, Math.min(5, Math.floor(input.pollAttempts)));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await baseMcpApprovalRuntime.wait(boundedPollIntervalMs());
        const args = statusArgs(tool, requestId);
        let called: { content: string; isError: boolean };
        try {
          called = await input.tools.callTool(tool.name, args);
        } catch {
          called = { content: JSON.stringify({ errorCode: 'base_mcp_status_failed' }), isError: true };
        }
        const callError = called.isError ? sanitizedToolErrorCode(called.content, 'base_mcp_status_failed') : undefined;
        toolCalls.push({
          toolName: tool.name,
          args: sanitizeStreamToolArgs(args) as Record<string, unknown>,
          result: { status: called.isError ? 'error' : 'success', ...(callError ? { errorCode: callError } : {}) },
          isError: called.isError,
        });
        if (called.isError) {
          errorCode = callError;
          break;
        }
        snapshot = mergeBaseMcpApprovalSnapshots(snapshot, extractBaseMcpApprovalSnapshot(called.content));
        if (['completed', 'rejected', 'failed'].includes(snapshot.state || '') || snapshot.approvalUrl) break;
      }
    }
  }

  const state = snapshot.state
    || (snapshot.approvalUrl ? 'approval_required' : snapshot.requestId ? 'pending' : 'failed');
  return {
    ...snapshot,
    state,
    toolCalls,
    ...(errorCode ? { errorCode } : {}),
  };
}
