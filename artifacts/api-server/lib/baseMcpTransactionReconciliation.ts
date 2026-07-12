import type { AutonomyPolicyRepository } from '@mioagent/autonomy';
import type { ToolAggregator } from '@mioagent/tools';
import {
  hasBaseMcpDurableProof,
  resolveBaseMcpApprovalLifecycle,
} from './baseMcpApprovalLifecycle.js';

type ChatMessageRecord = Record<string, any>;

export interface BaseMcpReconciliationResult {
  messages: ChatMessageRecord[];
  changed: boolean;
  polledCount: number;
  updatedCount: number;
  spentTodayUsdc: string;
  reservedTodayUsdc: string;
}

function isPendingBaseMcpMessage(message: ChatMessageRecord): boolean {
  const metadata = message.metadata;
  return message.role === 'assistant'
    && metadata
    && ['base_mcp_send', 'base_mcp_swap'].includes(metadata.directReadKind)
    && ['approval_required', 'pending'].includes(metadata.approvalState);
}

function terminalContent(kind: string, state: 'completed' | 'rejected' | 'failed'): string {
  const action = kind === 'base_mcp_swap' ? 'swap' : 'USDC transfer';
  if (state === 'completed') return `Base MCP confirms that the ${action} completed with durable transaction proof.`;
  if (state === 'rejected') return `The Base Account ${action} confirmation was rejected. The spending reservation was released.`;
  return `The Base MCP ${action} request failed or expired. The spending reservation was released.`;
}

export async function reconcileBaseMcpChatMessages(input: {
  messages: ChatMessageRecord[];
  tools: ToolAggregator;
  repository: AutonomyPolicyRepository;
  userId: string;
  now?: number;
}): Promise<BaseMcpReconciliationResult> {
  const now = input.now ?? Date.now();
  const messages: ChatMessageRecord[] = input.messages.map((message): ChatMessageRecord => ({
    ...message,
    ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
    ...(Array.isArray(message.toolCalls) ? { toolCalls: [...message.toolCalls] } : {}),
  }));
  let changed = false;
  let polledCount = 0;
  let updatedCount = 0;
  const reservations = input.repository.listReservationsByUser
    ? await input.repository.listReservationsByUser(input.userId).catch(() => [])
    : [];
  const claimedActionIds = new Set(
    messages
      .map((message) => message.metadata?.reservationActionId)
      .filter((actionId): actionId is string => typeof actionId === 'string'),
  );

  for (const message of messages) {
    if (!isPendingBaseMcpMessage(message)) continue;
    const metadata = message.metadata as Record<string, any>;
    if (typeof metadata.reservationActionId !== 'string') {
      const prefix = metadata.directReadKind === 'base_mcp_swap' ? 'base-mcp-swap:' : 'base-mcp-send:';
      const candidates = reservations.filter((reservation) =>
        reservation.actionId.startsWith(prefix)
        && ['reserved', 'expired'].includes(reservation.status)
        && !claimedActionIds.has(reservation.actionId));
      if (candidates.length !== 1) {
        metadata.errorCode = candidates.length > 1
          ? 'base_mcp_reservation_ambiguous'
          : 'base_mcp_reservation_missing';
        continue;
      }
      metadata.reservationActionId = candidates[0].actionId;
      metadata.reservationExpiresAt = new Date(candidates[0].expiresAt).toISOString();
      claimedActionIds.add(candidates[0].actionId);
      changed = true;
    }
    const actionId = metadata.reservationActionId as string;
    const expiresAt = typeof metadata.reservationExpiresAt === 'string'
      ? Date.parse(metadata.reservationExpiresAt)
      : Number.NaN;

    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      await input.repository.release(actionId, 'base_mcp_approval_expired');
      metadata.approvalState = 'failed';
      metadata.approvalTerminal = true;
      metadata.errorCode = 'base_mcp_approval_expired';
      message.content = terminalContent(metadata.directReadKind, 'failed');
      changed = true;
      updatedCount += 1;
      continue;
    }

    if (typeof metadata.requestId !== 'string' || !metadata.requestId) continue;
    const outcome = await resolveBaseMcpApprovalLifecycle({
      initialResult: { requestId: metadata.requestId },
      tools: input.tools,
      pollAttempts: 1,
    });
    polledCount += 1;
    changed = true;
    message.toolCalls = [...(message.toolCalls || []), ...outcome.toolCalls].slice(-20);
    if (outcome.approvalUrl) metadata.approvalUrl = outcome.approvalUrl;

    if (outcome.state === 'completed') {
      if (!hasBaseMcpDurableProof(outcome.proof)) {
        metadata.approvalState = 'pending';
        metadata.approvalTerminal = true;
        metadata.errorCode = 'base_mcp_durable_proof_missing';
        message.content = 'Base MCP reports completion, but durable transaction proof is not available yet. The spending reservation remains pending.';
        continue;
      }
      const settled = await input.repository.settle(actionId, {
        ...outcome.proof,
        confirmedAt: new Date(now).toISOString(),
      });
      if (!settled.success || settled.status !== 'settled') {
        metadata.approvalState = 'pending';
        metadata.errorCode = 'base_mcp_settlement_accounting_failed';
        continue;
      }
      metadata.approvalState = 'completed';
      metadata.approvalTerminal = true;
      metadata.transactionProof = outcome.proof;
      delete metadata.errorCode;
      message.content = terminalContent(metadata.directReadKind, 'completed');
      updatedCount += 1;
      continue;
    }

    if (outcome.state === 'rejected' || outcome.state === 'failed') {
      await input.repository.release(actionId, `base_mcp_${outcome.state}`);
      metadata.approvalState = outcome.state;
      metadata.approvalTerminal = true;
      metadata.errorCode = outcome.errorCode || `base_mcp_${outcome.state}`;
      message.content = terminalContent(metadata.directReadKind, outcome.state);
      updatedCount += 1;
      continue;
    }

    metadata.approvalState = outcome.state;
    if (outcome.errorCode) metadata.errorCode = outcome.errorCode;
  }

  const policy = await input.repository.getByUser(input.userId, 8453).catch(() => undefined);
  return {
    messages,
    changed,
    polledCount,
    updatedCount,
    spentTodayUsdc: String(policy?.spentToday ?? 0),
    reservedTodayUsdc: String(policy?.reservedToday ?? 0),
  };
}
