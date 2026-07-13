import { and, eq, inArray } from 'drizzle-orm';
import { db, preparedTransactionIntents } from '@mioagent/db';
import { stableSemanticHash, type NormalizedSemanticIntent } from './semanticIntent.js';
import type { SemanticDirectResult } from './semanticIntentRouting.js';

export interface TypedPendingAction {
  type: 'base_mcp_approval' | 'baseapp_native';
  actionId: string;
  intentHash: string;
  payloadHash: string;
  status: 'approval_required' | 'pending';
  expiresAt: string;
}
function preparedPayload(result: SemanticDirectResult): Record<string, unknown> {
  if (result.preparedPayload) return result.preparedPayload;
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
  const native = !!input.result.actionId && !!input.result.actionExpiresAt && !!input.result.preparedPayload;
  const actionId = native ? input.result.actionId : input.result.reservationActionId;
  const expiresAt = native ? input.result.actionExpiresAt : input.result.reservationExpiresAt;
  const state = input.result.approvalState;
  if (!actionId || !expiresAt || (!native && !['approval_required', 'pending'].includes(String(state || '')))) return null;
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
    status: !native && state === 'approval_required' ? 'approval_required' : 'pending',
    expiresAt: new Date(expiresAt),
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  return {
    type: native ? 'baseapp_native' : 'base_mcp_approval',
    actionId,
    intentHash: input.normalizedIntentHash,
    payloadHash,
    status: !native && state === 'approval_required' ? 'approval_required' : 'pending',
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

/**
 * A wallet-session boundary invalidates every transaction that was prepared
 * for the old authenticated tenant. Completed/rejected records stay intact as
 * audit evidence; only executable states are retired.
 */
export async function invalidatePreparedTransactionsForUser(userId: string): Promise<void> {
  await db.update(preparedTransactionIntents)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(and(
      eq(preparedTransactionIntents.userId, userId),
      inArray(preparedTransactionIntents.status, ['pending', 'approval_required']),
    ));
}
