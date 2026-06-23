import { db } from '@mioagent/db';
import { actions } from '@mioagent/db/schema';
import { screenAction } from '@mioagent/security';
import { ulid } from 'ulidx';

export async function insertAction(userId: string, kind: string, instruction: string, tokens?: unknown[]) {
  // Security screening logic
  const screenResult = screenAction({ instruction });
  if (!screenResult.allowed) {
    throw new Error(`Action blocked by security screen: ${screenResult.reason}`);
  }

  const newAction = {
    id: ulid(),
    userId,
    kind,
    status: 'pending',
    suggestedPrompt: instruction,
    tokens: tokens || [],
    createdAt: new Date(),
    updatedAt: new Date()
  };

  await db.insert(actions).values(newAction);
  return newAction;
}
