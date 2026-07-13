import { and, eq } from 'drizzle-orm';
import { db, preparedTransactionIntents } from '@mioagent/db';
import { stableSemanticHash, type NormalizedSemanticIntent } from './semanticIntent.js';
import type { SemanticDirectResult } from './semanticIntentRouting.js';

export interface TypedPendingAction {
  type: 'base_mcp_approval';
  actionId: string;
  intentHash: string;
  payloadHash: string;
  status: 'approval_required' | 'pending';
  expiresAt: string;
}
function preparedPayload(result: SemanticDirectResult): Record<string, unknown> {
  return {
    kind: result.kind,
    requestId: result.requestId || null,
    approvalUrl: result.approvalUrl || null,
    toolCalls: result.toolCalls.map((trace) => ({ toolName: trace.toolName, args: trace.args })),
  };
}

export async function storePreparedTransaction(input: {
  userId: string;
  walletAddress: string;
  normalizedIntent: NormalizedSemanticIntent;
  normalizedIntentHash: string;
  result: SemanticDirectResult;
}): Promise<TypedPendingAction | null> {
  const actionId = input.result.reservationActionId;
  const expiresAt = input.result.reservationExpiresAt;
  const state = input.result.approvalState;
  if (!actionId || !expiresAt || !['approval_required', 'pending'].includes(String(state || ''))) return null;
  const payload = preparedPayload(input.result);
  const payloadHash = stableSemanticHash(payload);
  await db.insert(preparedTransactionIntents).values({
    actionId,
    userId: input.userId,
    walletAddress: input.walletAddress.toLowerCase(),
    normalizedIntentHash: input.normalizedIntentHash,
    preparedPayloadHash: payloadHash,
    normalizedIntent: input.normalizedIntent,
    preparedPayload: payload,
    status: state === 'approval_required' ? 'approval_required' : 'pending',
    expiresAt: new Date(expiresAt),
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  return {
    type: 'base_mcp_approval',
    actionId,
    intentHash: input.normalizedIntentHash,
    payloadHash,
    status: state as 'approval_required' | 'pending',
    expiresAt,
  };
}

export async function updatePreparedTransactionStatus(input: {
  userId: string;
  actionId: string;
  status: 'pending' | 'completed' | 'rejected' | 'failed';
}): Promise<void> {
  await db.update(preparedTransactionIntents)
    .set({ status: input.status, updatedAt: new Date() })
    .where(and(
      eq(preparedTransactionIntents.actionId, input.actionId),
      eq(preparedTransactionIntents.userId, input.userId),
    ));
}
